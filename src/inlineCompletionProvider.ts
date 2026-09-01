import * as vscode from 'vscode';
import { VllmClient } from './vllmClient';

/**
 * Provides inline (ghost text) code completions, similar to GitHub Copilot.
 * 
 * HOW IT WORKS:
 * 1. User types code and pauses (debounce period, default 500ms)
 * 2. We grab text before and after the cursor (prefix/suffix)
 * 3. Send to vLLM's /v1/completions endpoint with FIM (fill-in-middle) format
 * 4. The suggestion appears as gray ghost text at the cursor
 * 5. User presses Tab to accept, or keeps typing to dismiss
 * 
 * WHY DEBOUNCE: Without it, we'd fire a request on every keystroke.
 * That's wasteful (most keystrokes are mid-word) and creates a
 * thundering herd on your GPU. 500ms is the sweet spot — fast enough
 * to feel responsive, slow enough to avoid unnecessary requests.
 */
export class InlineCompletionProvider implements vscode.InlineCompletionItemProvider {
  private client: VllmClient;
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;
  private lastRequestId = 0;

  constructor() {
    this.client = new VllmClient();
  }

  async provideInlineCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    context: vscode.InlineCompletionContext,
    token: vscode.CancellationToken
  ): Promise<vscode.InlineCompletionItem[] | undefined> {
    // Check if inline completions are enabled in settings
    const config = vscode.workspace.getConfiguration('groot-ai');
    if (!config.get<boolean>('inlineCompletionsEnabled', true)) {
      return undefined;
    }

    // Don't trigger on deletion or when manually invoked without changes
    if (context.triggerKind === vscode.InlineCompletionTriggerKind.Invoke) {
      // Manual invocation — proceed immediately
    }

    // Cancel any pending debounce
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    // Track this request so stale responses are discarded
    const requestId = ++this.lastRequestId;
    const debounceMs = config.get<number>('inlineCompletionDebounceMs', 500);

    // Debounce: wait for the user to stop typing
    await new Promise<void>((resolve) => {
      this.debounceTimer = setTimeout(resolve, debounceMs);
    });

    // If a newer request came in while we were waiting, bail out
    if (requestId !== this.lastRequestId || token.isCancellationRequested) {
      return undefined;
    }

    // Gather context: text before and after the cursor
    // We limit to ~2000 chars each to keep the request fast
    const prefixRange = new vscode.Range(
      new vscode.Position(Math.max(0, position.line - 50), 0),
      position
    );
    const suffixRange = new vscode.Range(
      position,
      new vscode.Position(Math.min(document.lineCount - 1, position.line + 20), 0)
    );

    const prefix = document.getText(prefixRange);
    const suffix = document.getText(suffixRange);
    const language = document.languageId;

    // Skip if there's very little context (user just opened an empty file)
    if (prefix.trim().length < 5) {
      return undefined;
    }

    try {
      const completion = await this.client.inlineCompletion(prefix, suffix, language);

      // Check again for cancellation or staleness
      if (requestId !== this.lastRequestId || token.isCancellationRequested) {
        return undefined;
      }

      if (!completion || completion.trim().length === 0) {
        return undefined;
      }

      return [
        new vscode.InlineCompletionItem(
          completion,
          new vscode.Range(position, position)
        ),
      ];
    } catch {
      // Silently fail — inline completions should never interrupt the user
      return undefined;
    }
  }
}
