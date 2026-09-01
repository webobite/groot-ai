import * as vscode from 'vscode';
import * as https from 'https';
import * as http from 'http';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface CompletionRequest {
  model: string;
  messages: ChatMessage[];
  max_tokens: number;
  temperature: number;
  stream: boolean;
  stop?: string[];
}

export interface CompletionChunk {
  choices: Array<{
    delta: { content?: string; role?: string };
    finish_reason: string | null;
  }>;
}

/**
 * OpenAI-compatible API client for vLLM inference server.
 * 
 * WHY OpenAI-compatible: vLLM exposes the same /v1/chat/completions
 * and /v1/completions endpoints as OpenAI's API. This means:
 * 1. You can swap between self-hosted and OpenAI without code changes
 * 2. Any OpenAI SDK or library works out of the box
 * 3. The streaming format (SSE with data: JSON lines) is identical
 */
export class VllmClient {
  private getConfig() {
    const config = vscode.workspace.getConfiguration('groot-ai');
    return {
      serverUrl: config.get<string>('serverUrl', 'http://localhost:8000'),
      modelName: config.get<string>('modelName', 'Qwen/Qwen2.5-Coder-7B-Instruct'),
      apiKey: config.get<string>('apiKey', ''),
      maxTokens: config.get<number>('maxTokens', 2048),
      temperature: config.get<number>('temperature', 0.1),
    };
  }

  /**
   * Check if the vLLM server is reachable and responding.
   * Hits the /v1/models endpoint which lists available models.
   */
  async healthCheck(): Promise<{ ok: boolean; models?: string[]; error?: string }> {
    const { serverUrl, apiKey } = this.getConfig();
    try {
      const response = await this.httpRequest(`${serverUrl}/v1/models`, {
        method: 'GET',
        headers: apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {},
      });
      const data = JSON.parse(response);
      const models = data.data?.map((m: any) => m.id) || [];
      return { ok: true, models };
    } catch (err: any) {
      return { ok: false, error: err.message };
    }
  }

  /**
   * Send a chat completion request with streaming.
   * 
   * WHY streaming: Without streaming, the user stares at a blank screen
   * for 5-30 seconds while the model generates the full response. With
   * streaming (Server-Sent Events), tokens appear as they're generated,
   * giving immediate feedback. vLLM sends each token as a JSON chunk
   * prefixed with "data: " followed by the chunk JSON.
   * 
   * The onToken callback fires for each token, allowing the webview
   * to update in real-time.
   */
  async chatCompletion(
    messages: ChatMessage[],
    onToken: (token: string) => void,
    cancellation?: vscode.CancellationToken
  ): Promise<string> {
    const config = this.getConfig();
    const url = `${config.serverUrl}/v1/chat/completions`;

    const body: CompletionRequest = {
      model: config.modelName,
      messages,
      max_tokens: config.maxTokens,
      temperature: config.temperature,
      stream: true,
    };

    return new Promise((resolve, reject) => {
      const parsedUrl = new URL(url);
      const transport = parsedUrl.protocol === 'https:' ? https : http;
      let fullResponse = '';

      const req = transport.request(
        {
          hostname: parsedUrl.hostname,
          port: parsedUrl.port,
          path: parsedUrl.pathname,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(config.apiKey ? { 'Authorization': `Bearer ${config.apiKey}` } : {}),
          },
        },
        (res) => {
          if (res.statusCode !== 200) {
            let errorBody = '';
            res.on('data', (chunk) => (errorBody += chunk));
            res.on('end', () => reject(new Error(`Server returned ${res.statusCode}: ${errorBody}`)));
            return;
          }

          let buffer = '';

          res.on('data', (chunk: Buffer) => {
            buffer += chunk.toString();

            // Process complete SSE lines from the buffer
            const lines = buffer.split('\n');
            // Keep the last incomplete line in the buffer
            buffer = lines.pop() || '';

            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed || trimmed.startsWith(':')) continue;
              if (trimmed === 'data: [DONE]') continue;
              if (!trimmed.startsWith('data: ')) continue;

              try {
                const json: CompletionChunk = JSON.parse(trimmed.slice(6));
                const content = json.choices[0]?.delta?.content;
                if (content) {
                  fullResponse += content;
                  onToken(content);
                }
              } catch {
                // Skip malformed chunks — this happens occasionally
                // with network buffering, and is safe to ignore
              }
            }
          });

          res.on('end', () => resolve(fullResponse));
          res.on('error', reject);
        }
      );

      // Handle cancellation (user clicks stop)
      if (cancellation) {
        cancellation.onCancellationRequested(() => {
          req.destroy();
          resolve(fullResponse);
        });
      }

      req.on('error', reject);
      req.write(JSON.stringify(body));
      req.end();
    });
  }

  /**
   * Non-streaming completion for inline code suggestions.
   * Uses /v1/completions (not chat) for fill-in-the-middle (FIM).
   * 
   * WHY FIM: Chat completions work on full conversations, but for
   * inline code completion you need "fill in the middle" — given
   * code before and after the cursor, predict what goes in between.
   * vLLM supports this through the standard completions endpoint
   * with a specially formatted prompt.
   */
  async inlineCompletion(
    prefix: string,
    suffix: string,
    language: string
  ): Promise<string> {
    const config = this.getConfig();
    const url = `${config.serverUrl}/v1/completions`;

    // FIM format for Qwen2.5-Coder
    const prompt = `<|fim_prefix|>${prefix}<|fim_suffix|>${suffix}<|fim_middle|>`;

    const body = {
      model: config.modelName,
      prompt,
      max_tokens: 256,
      temperature: 0.0,  // Deterministic for completions
      stop: ['\n\n', '<|fim_pad|>', '<|endoftext|>'],
      stream: false,
    };

    try {
      const response = await this.httpRequest(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(config.apiKey ? { 'Authorization': `Bearer ${config.apiKey}` } : {}),
        },
        body: JSON.stringify(body),
      });

      const data = JSON.parse(response);
      return data.choices?.[0]?.text?.trim() || '';
    } catch {
      return '';
    }
  }

  /**
   * Simple HTTP request helper. We use Node's built-in http/https
   * instead of fetch() because VS Code's extension host doesn't
   * always have fetch available in older versions, and we want
   * maximum compatibility.
   */
  private httpRequest(
    url: string,
    options: { method: string; headers?: Record<string, string>; body?: string }
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const parsedUrl = new URL(url);
      const transport = parsedUrl.protocol === 'https:' ? https : http;

      const req = transport.request(
        {
          hostname: parsedUrl.hostname,
          port: parsedUrl.port,
          path: parsedUrl.pathname + parsedUrl.search,
          method: options.method,
          headers: options.headers,
        },
        (res) => {
          let data = '';
          res.on('data', (chunk) => (data += chunk));
          res.on('end', () => {
            if (res.statusCode && res.statusCode >= 400) {
              reject(new Error(`HTTP ${res.statusCode}: ${data}`));
            } else {
              resolve(data);
            }
          });
          res.on('error', reject);
        }
      );

      req.on('error', reject);
      if (options.body) {
        req.write(options.body);
      }
      req.end();
    });
  }
}
