import * as vscode from 'vscode';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

/**
 * Controls the GKE inference server (start/stop) directly from VS Code.
 * 
 * HOW IT WORKS:
 * Instead of SSHing into a server, we use `kubectl` to scale the
 * Kubernetes deployment up (replicas=1) or down (replicas=0).
 * Scaling to 0 releases the GPU node back to GKE's autoscaler,
 * which terminates the Spot VM — so you stop paying within minutes.
 * Scaling to 1 triggers the autoscaler to provision a new GPU node,
 * pull the container image, and start serving. This takes 3-7 minutes
 * depending on image caching.
 * 
 * PREREQUISITES:
 * - gcloud CLI installed and authenticated
 * - kubectl installed
 * - GKE cluster credentials fetched:
 *   gcloud container clusters get-credentials <cluster> --zone <zone>
 */
export class ServerControl {
  private statusBarItem: vscode.StatusBarItem;
  private isChecking = false;

  constructor() {
    // Create a status bar item on the bottom bar
    this.statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      100
    );
    this.statusBarItem.command = 'groot-ai.serverStatus';
    this.setStatus('unknown');
    this.statusBarItem.show();
  }

  private getConfig() {
    const config = vscode.workspace.getConfiguration('groot-ai');
    return {
      projectId: config.get<string>('gke.projectId', ''),
      clusterName: config.get<string>('gke.clusterName', 'groot-cluster'),
      zone: config.get<string>('gke.zone', 'us-central1-a'),
      deploymentName: config.get<string>('gke.deploymentName', 'groot-vllm'),
      namespace: config.get<string>('gke.namespace', 'groot-inference'),
    };
  }

  /**
   * Scale the deployment to 1 replica, which triggers:
   * 1. GKE cluster autoscaler provisions a GPU node (if none available)
   * 2. Node pulls the vLLM container image
   * 3. vLLM loads model weights into GPU VRAM
   * 4. Server starts accepting requests
   * 
   * Total cold-start time: ~3-7 min (GPU provisioning + model loading)
   */
  async startServer(): Promise<void> {
    const config = this.getConfig();

    if (!config.projectId) {
      const input = await vscode.window.showInputBox({
        prompt: 'Enter your GCP Project ID',
        placeHolder: 'groot-dev',
      });
      if (input) {
        await vscode.workspace
          .getConfiguration('groot-ai')
          .update('gke.projectId', input, vscode.ConfigurationTarget.Global);
      } else {
        return;
      }
    }

    this.setStatus('starting');

    try {
      // Ensure we have the right cluster credentials
      await this.runCommand(
        `gcloud container clusters get-credentials ${config.clusterName} ` +
        `--zone ${config.zone} --project ${config.projectId}`
      );

      // Scale up the deployment
      await this.runCommand(
        `kubectl scale deployment ${config.deploymentName} ` +
        `--replicas=1 -n ${config.namespace}`
      );

      vscode.window.showInformationMessage(
        'Groot: Inference server starting... This takes 3-7 minutes for GPU provisioning and model loading.'
      );

      // Start polling for readiness
      this.pollUntilReady();
    } catch (err: any) {
      this.setStatus('error');
      vscode.window.showErrorMessage(`Groot: Failed to start server — ${err.message}`);
    }
  }

  /**
   * Scale the deployment to 0 replicas.
   * The GKE autoscaler will drain and remove the GPU node,
   * stopping all GPU charges within a few minutes.
   */
  async stopServer(): Promise<void> {
    const config = this.getConfig();

    const confirm = await vscode.window.showWarningMessage(
      'Stop the Groot inference server? This will terminate the GPU node and save costs.',
      'Stop Server',
      'Cancel'
    );

    if (confirm !== 'Stop Server') {
      return;
    }

    this.setStatus('stopping');

    try {
      await this.runCommand(
        `kubectl scale deployment ${config.deploymentName} ` +
        `--replicas=0 -n ${config.namespace}`
      );

      this.setStatus('offline');
      vscode.window.showInformationMessage(
        'Groot: Server stopped. GPU node will be released shortly.'
      );
    } catch (err: any) {
      this.setStatus('error');
      vscode.window.showErrorMessage(`Groot: Failed to stop server — ${err.message}`);
    }
  }

  /**
   * Check current server status by querying the deployment replicas
   * and hitting the health endpoint.
   */
  async checkStatus(): Promise<void> {
    if (this.isChecking) return;
    this.isChecking = true;

    const config = this.getConfig();

    try {
      // Check deployment replica count
      const { stdout } = await this.runCommand(
        `kubectl get deployment ${config.deploymentName} -n ${config.namespace} ` +
        `-o jsonpath='{.status.readyReplicas}'`
      );

      const readyReplicas = parseInt(stdout.replace(/'/g, ''), 10);

      if (isNaN(readyReplicas) || readyReplicas === 0) {
        this.setStatus('offline');
        vscode.window.showInformationMessage('Groot: Server is offline');
      } else {
        this.setStatus('online');
        vscode.window.showInformationMessage(
          `Groot: Server is online (${readyReplicas} replica${readyReplicas > 1 ? 's' : ''} ready)`
        );
      }
    } catch {
      // kubectl not configured or cluster unreachable — try HTTP health check
      try {
        const serverUrl = vscode.workspace
          .getConfiguration('groot-ai')
          .get<string>('serverUrl', 'http://localhost:8000');

        const { VllmClient } = await import('./vllmClient.js');
        const client = new VllmClient();
        const health = await client.healthCheck();

        if (health.ok) {
          this.setStatus('online');
          vscode.window.showInformationMessage(
            `Groot: Server is online. Models: ${health.models?.join(', ')}`
          );
        } else {
          this.setStatus('offline');
          vscode.window.showInformationMessage('Groot: Server is offline');
        }
      } catch {
        this.setStatus('offline');
      }
    } finally {
      this.isChecking = false;
    }
  }

  /**
   * Poll the server every 30 seconds until it responds.
   * Called after startServer to give the user feedback
   * when the cold start finishes.
   */
  private async pollUntilReady(maxAttempts = 20): Promise<void> {
    const { VllmClient } = await import('./vllmClient.js');
    const client = new VllmClient();

    for (let i = 0; i < maxAttempts; i++) {
      await new Promise((resolve) => setTimeout(resolve, 30000));

      const health = await client.healthCheck();
      if (health.ok) {
        this.setStatus('online');
        vscode.window.showInformationMessage(
          'Groot: Inference server is ready! Models: ' + (health.models?.join(', ') || 'unknown')
        );
        return;
      }
    }

    this.setStatus('error');
    vscode.window.showWarningMessage(
      'Groot: Server did not become ready after 10 minutes. Check GKE console for issues.'
    );
  }

  private setStatus(status: 'unknown' | 'online' | 'offline' | 'starting' | 'stopping' | 'error') {
    const icons: Record<string, string> = {
      unknown: '$(question)',
      online: '$(check)',
      offline: '$(circle-slash)',
      starting: '$(sync~spin)',
      stopping: '$(sync~spin)',
      error: '$(error)',
    };
    const colors: Record<string, string | undefined> = {
      online: 'statusBarItem.prominentForeground',
      error: 'statusBarItem.errorForeground',
    };

    this.statusBarItem.text = `${icons[status]} Groot`;
    this.statusBarItem.tooltip = `Groot AI Server: ${status}`;
    this.statusBarItem.backgroundColor = status === 'error'
      ? new vscode.ThemeColor('statusBarItem.errorBackground')
      : undefined;
  }

  private runCommand(cmd: string): Promise<{ stdout: string; stderr: string }> {
    return execAsync(cmd, { timeout: 30000 });
  }

  dispose() {
    this.statusBarItem.dispose();
  }
}
