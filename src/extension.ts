import * as vscode from 'vscode';
import { ChatViewProvider } from './chatViewProvider';
import { InlineCompletionProvider } from './inlineCompletionProvider';
import { ServerControl } from './serverControl';

/**
 * Extension entry point.
 * 
 * VS Code calls activate() when any activation event fires.
 * We registered "onStartupFinished" in package.json, which means
 * this runs after VS Code has fully loaded — not on every window
 * open, but early enough that the sidebar and completions are ready
 * when the user needs them.
 * 
 * Every disposable (commands, providers, UI elements) is pushed
 * into context.subscriptions so VS Code cleans them up automatically
 * when the extension deactivates.
 */
export function activate(context: vscode.ExtensionContext) {
  console.log('Groot AI: Extension activated');

  // --- Chat Sidebar ---
  const chatProvider = new ChatViewProvider(context.extensionUri);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      ChatViewProvider.viewType,
      chatProvider,
      { webviewOptions: { retainContextWhenHidden: true } }
    )
  );

  // --- Inline Completions ---
  const inlineProvider = new InlineCompletionProvider();
  context.subscriptions.push(
    vscode.languages.registerInlineCompletionItemProvider(
      { pattern: '**' },  // All file types
      inlineProvider
    )
  );

  // --- Server Control ---
  const serverControl = new ServerControl();
  context.subscriptions.push(serverControl);

  // --- Register Commands ---

  // Chat commands
  context.subscriptions.push(
    vscode.commands.registerCommand('groot-ai.sendMessage', () => {
      // Triggered via keybinding — the webview handles the actual send
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('groot-ai.newChat', () => {
      chatProvider.clearChat();
    })
  );

  // Context menu commands — grab selected code and send to chat
  context.subscriptions.push(
    vscode.commands.registerCommand('groot-ai.explainCode', () => {
      sendSelectedCodeToChat(chatProvider, 'Explain this code in detail. What does it do, and why?');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('groot-ai.refactorCode', () => {
      sendSelectedCodeToChat(chatProvider, 'Refactor this code to be cleaner, more readable, and follow best practices. Show the improved version.');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('groot-ai.generateTests', () => {
      sendSelectedCodeToChat(chatProvider, 'Generate comprehensive unit tests for this code. Include edge cases.');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('groot-ai.fixErrors', () => {
      sendSelectedCodeToChat(chatProvider, 'Find and fix any bugs or errors in this code. Explain what was wrong.');
    })
  );

  // Server control commands
  context.subscriptions.push(
    vscode.commands.registerCommand('groot-ai.startServer', () => {
      serverControl.startServer();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('groot-ai.stopServer', () => {
      serverControl.stopServer();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('groot-ai.serverStatus', () => {
      serverControl.checkStatus();
    })
  );

  // Toggle inline completions
  let inlineEnabled = vscode.workspace
    .getConfiguration('groot-ai')
    .get<boolean>('inlineCompletionsEnabled', true);

  context.subscriptions.push(
    vscode.commands.registerCommand('groot-ai.toggleInlineCompletion', () => {
      inlineEnabled = !inlineEnabled;
      vscode.workspace
        .getConfiguration('groot-ai')
        .update('inlineCompletionsEnabled', inlineEnabled, vscode.ConfigurationTarget.Global);
      vscode.window.showInformationMessage(
        `Groot AI: Inline completions ${inlineEnabled ? 'enabled' : 'disabled'}`
      );
    })
  );

  // --- Initial health check ---
  // Run a quiet health check on startup to set the status bar indicator
  setTimeout(() => serverControl.checkStatus(), 5000);
}

/**
 * Grab selected text from the active editor and send it
 * to the chat sidebar with a prompt prefix.
 */
function sendSelectedCodeToChat(chatProvider: ChatViewProvider, prompt: string) {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showWarningMessage('No active editor');
    return;
  }

  const selection = editor.selection;
  const selectedText = editor.document.getText(selection);

  if (!selectedText) {
    vscode.window.showWarningMessage('No code selected');
    return;
  }

  const language = editor.document.languageId;
  const message = `${prompt}\n\n\`\`\`${language}\n${selectedText}\n\`\`\``;

  chatProvider.sendMessage(message);
}

export function deactivate() {
  console.log('Groot AI: Extension deactivated');
}
