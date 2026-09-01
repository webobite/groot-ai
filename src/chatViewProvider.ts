import * as vscode from 'vscode';
import { VllmClient, ChatMessage } from './vllmClient';

/**
 * Webview provider for the Groot AI chat sidebar.
 * 
 * WHY Webview: VS Code's native tree views are great for file lists
 * but terrible for rich content like chat messages with code blocks,
 * markdown formatting, and streaming text. A webview gives us full
 * HTML/CSS/JS control inside the sidebar panel, which is how all
 * major AI extensions (Copilot Chat, Cody, Continue) build their UIs.
 * 
 * Communication between the extension (Node.js) and the webview
 * (browser sandbox) happens via message passing:
 *   - Extension → Webview: panel.webview.postMessage(msg)
 *   - Webview → Extension: vscode.postMessage(msg)
 */
export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'groot-ai.chatView';
  private webviewView?: vscode.WebviewView;
  private chatHistory: ChatMessage[] = [];
  private client: VllmClient;

  constructor(private readonly extensionUri: vscode.Uri) {
    this.client = new VllmClient();
  }

  /**
   * Called by VS Code when the sidebar panel becomes visible.
   * We set up the webview HTML and message handlers here.
   */
  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ) {
    this.webviewView = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };

    webviewView.webview.html = this.getWebviewHtml(webviewView.webview);

    // Handle messages from the webview
    webviewView.webview.onDidReceiveMessage(async (message) => {
      switch (message.type) {
        case 'sendMessage':
          await this.handleUserMessage(message.text);
          break;
        case 'clearChat':
          this.chatHistory = [];
          break;
        case 'insertCode':
          this.insertCodeInEditor(message.code);
          break;
        case 'copyCode':
          await vscode.env.clipboard.writeText(message.code);
          vscode.window.showInformationMessage('Code copied to clipboard');
          break;
      }
    });
  }

  /**
   * Send a message programmatically (from context menu commands).
   */
  async sendMessage(text: string) {
    if (this.webviewView) {
      // Make the sidebar visible
      this.webviewView.show?.(true);
      // Post the message to the webview to show in the UI
      this.webviewView.webview.postMessage({ type: 'userMessage', text });
    }
    await this.handleUserMessage(text);
  }

  /**
   * Clear chat history and UI.
   */
  clearChat() {
    this.chatHistory = [];
    this.webviewView?.webview.postMessage({ type: 'clearChat' });
  }

  /**
   * Core message handling: add user message to history, stream
   * the response from vLLM, and update the webview in real-time.
   */
  private async handleUserMessage(text: string) {
    // Add system prompt if this is the first message
    if (this.chatHistory.length === 0) {
      this.chatHistory.push({
        role: 'system',
        content: `You are Groot AI, an expert coding assistant. You help with code generation, debugging, refactoring, and explanation. Always provide clear, well-commented code. When showing code, use markdown code blocks with the appropriate language tag. Be concise but thorough.`,
      });
    }

    // Add user message
    this.chatHistory.push({ role: 'user', content: text });

    // Tell webview we're starting a response
    this.webviewView?.webview.postMessage({ type: 'responseStart' });

    try {
      const fullResponse = await this.client.chatCompletion(
        this.chatHistory,
        (token) => {
          // Stream each token to the webview
          this.webviewView?.webview.postMessage({
            type: 'responseToken',
            token,
          });
        }
      );

      // Add assistant response to history
      this.chatHistory.push({ role: 'assistant', content: fullResponse });

      // Signal completion
      this.webviewView?.webview.postMessage({ type: 'responseEnd' });
    } catch (err: any) {
      this.webviewView?.webview.postMessage({
        type: 'responseError',
        error: err.message || 'Failed to connect to inference server',
      });
    }
  }

  /**
   * Insert code from a chat response into the active editor.
   */
  private insertCodeInEditor(code: string) {
    const editor = vscode.window.activeTextEditor;
    if (editor) {
      editor.edit((editBuilder) => {
        editBuilder.insert(editor.selection.active, code);
      });
    } else {
      vscode.window.showWarningMessage('No active editor to insert code into');
    }
  }

  /**
   * Build the webview HTML.
   * 
   * WHY inline HTML: VS Code webviews are sandboxed iframes. External
   * resources require explicit CSP configuration and URI conversion.
   * For a self-contained chat UI, inlining everything is simpler and
   * more reliable. The HTML includes the full chat interface with:
   * - Message rendering with code block detection
   * - Streaming token display
   * - Copy/Insert buttons on code blocks
   * - Auto-scroll and keyboard shortcuts
   */
  private getWebviewHtml(webview: vscode.Webview): string {
    const nonce = getNonce();

    return /*html*/ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
  <style nonce="${nonce}">
    * { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background: var(--vscode-sideBar-background);
      display: flex;
      flex-direction: column;
      height: 100vh;
      overflow: hidden;
    }

    /* Header */
    .header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 8px 12px;
      border-bottom: 1px solid var(--vscode-panel-border);
      flex-shrink: 0;
    }
    .header h3 {
      font-size: 12px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      opacity: 0.8;
    }
    .status-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--vscode-testing-iconFailed);
    }
    .status-dot.connected {
      background: var(--vscode-testing-iconPassed);
    }

    /* Messages area */
    .messages {
      flex: 1;
      overflow-y: auto;
      padding: 12px;
    }
    .message {
      margin-bottom: 16px;
      animation: fadeIn 0.2s ease;
    }
    @keyframes fadeIn {
      from { opacity: 0; transform: translateY(4px); }
      to { opacity: 1; transform: translateY(0); }
    }
    .message-role {
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: 4px;
      color: var(--vscode-textLink-foreground);
    }
    .message.user .message-role {
      color: var(--vscode-terminal-ansiGreen);
    }
    .message-content {
      line-height: 1.5;
      white-space: pre-wrap;
      word-wrap: break-word;
    }
    .message-content p {
      margin-bottom: 8px;
    }

    /* Code blocks */
    .code-block-wrapper {
      position: relative;
      margin: 8px 0;
      border-radius: 6px;
      overflow: hidden;
      border: 1px solid var(--vscode-panel-border);
    }
    .code-block-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 4px 10px;
      background: var(--vscode-editor-background);
      border-bottom: 1px solid var(--vscode-panel-border);
      font-size: 11px;
      opacity: 0.7;
    }
    .code-block-actions button {
      background: none;
      border: none;
      color: var(--vscode-foreground);
      cursor: pointer;
      padding: 2px 8px;
      border-radius: 3px;
      font-size: 11px;
      opacity: 0.7;
    }
    .code-block-actions button:hover {
      background: var(--vscode-toolbar-hoverBackground);
      opacity: 1;
    }
    pre.code-block {
      background: var(--vscode-editor-background);
      padding: 12px;
      overflow-x: auto;
      font-family: var(--vscode-editor-font-family);
      font-size: var(--vscode-editor-font-size);
      line-height: 1.4;
      margin: 0;
    }

    /* Streaming cursor */
    .cursor {
      display: inline-block;
      width: 2px;
      height: 1em;
      background: var(--vscode-editorCursor-foreground);
      animation: blink 0.8s infinite;
      vertical-align: text-bottom;
    }
    @keyframes blink {
      0%, 50% { opacity: 1; }
      51%, 100% { opacity: 0; }
    }

    /* Thinking indicator */
    .thinking {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 0;
      color: var(--vscode-descriptionForeground);
      font-style: italic;
      font-size: 12px;
    }
    .thinking-dots span {
      animation: dot 1.4s infinite;
      opacity: 0;
    }
    .thinking-dots span:nth-child(2) { animation-delay: 0.2s; }
    .thinking-dots span:nth-child(3) { animation-delay: 0.4s; }
    @keyframes dot {
      0%, 60% { opacity: 0; }
      30% { opacity: 1; }
    }

    /* Input area */
    .input-area {
      border-top: 1px solid var(--vscode-panel-border);
      padding: 12px;
      flex-shrink: 0;
    }
    .input-wrapper {
      display: flex;
      gap: 8px;
      align-items: flex-end;
    }
    textarea {
      flex: 1;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border);
      border-radius: 6px;
      padding: 8px 12px;
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      resize: none;
      min-height: 38px;
      max-height: 150px;
      outline: none;
    }
    textarea:focus {
      border-color: var(--vscode-focusBorder);
    }
    textarea::placeholder {
      color: var(--vscode-input-placeholderForeground);
    }
    button.send-btn {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      border-radius: 6px;
      padding: 8px 14px;
      cursor: pointer;
      font-size: 14px;
      flex-shrink: 0;
      height: 38px;
    }
    button.send-btn:hover {
      background: var(--vscode-button-hoverBackground);
    }
    button.send-btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    /* Welcome screen */
    .welcome {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 100%;
      text-align: center;
      padding: 24px;
      opacity: 0.7;
    }
    .welcome h2 {
      font-size: 18px;
      margin-bottom: 8px;
    }
    .welcome p {
      font-size: 13px;
      margin-bottom: 16px;
      line-height: 1.5;
    }
    .welcome .shortcuts {
      font-size: 11px;
      opacity: 0.6;
    }

    /* Error state */
    .error-msg {
      background: var(--vscode-inputValidation-errorBackground);
      border: 1px solid var(--vscode-inputValidation-errorBorder);
      border-radius: 6px;
      padding: 8px 12px;
      font-size: 12px;
      margin-top: 8px;
    }
  </style>
</head>
<body>
  <div class="header">
    <h3>Groot AI</h3>
    <div class="status-dot" id="statusDot" title="Server disconnected"></div>
  </div>

  <div class="messages" id="messages">
    <div class="welcome" id="welcome">
      <h2>Groot AI</h2>
      <p>Your self-hosted AI coding assistant.<br>Ask me to write, explain, refactor, or debug code.</p>
      <div class="shortcuts">Cmd+Enter to send &bull; Cmd+Shift+G for inline completions</div>
    </div>
  </div>

  <div class="input-area">
    <div class="input-wrapper">
      <textarea
        id="input"
        placeholder="Ask Groot anything..."
        rows="1"
      ></textarea>
      <button class="send-btn" id="sendBtn" title="Send (Cmd+Enter)">&#9654;</button>
    </div>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const messagesEl = document.getElementById('messages');
    const welcomeEl = document.getElementById('welcome');
    const inputEl = document.getElementById('input');
    const sendBtn = document.getElementById('sendBtn');
    const statusDot = document.getElementById('statusDot');

    let isStreaming = false;
    let currentResponseEl = null;
    let currentResponseText = '';

    // Auto-resize textarea
    inputEl.addEventListener('input', () => {
      inputEl.style.height = 'auto';
      inputEl.style.height = Math.min(inputEl.scrollHeight, 150) + 'px';
    });

    // Send on Enter (Shift+Enter for newline)
    inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    });

    sendBtn.addEventListener('click', sendMessage);

    function sendMessage() {
      const text = inputEl.value.trim();
      if (!text || isStreaming) return;

      welcomeEl.style.display = 'none';
      addMessage('user', text);
      inputEl.value = '';
      inputEl.style.height = 'auto';

      vscode.postMessage({ type: 'sendMessage', text });
    }

    function addMessage(role, content) {
      const div = document.createElement('div');
      div.className = 'message ' + role;
      div.innerHTML =
        '<div class="message-role">' + (role === 'user' ? 'You' : 'Groot') + '</div>' +
        '<div class="message-content">' + renderContent(content) + '</div>';
      messagesEl.appendChild(div);
      scrollToBottom();
      return div;
    }

    function renderContent(text) {
      // Parse code blocks
      const parts = text.split(/(\\x60\\x60\\x60[\\s\\S]*?\\x60\\x60\\x60)/g);
      return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/\\n/g, '<br>');
    }

    /**
     * Render markdown-style content with code block support.
     * Detects \`\`\`lang ... \`\`\` blocks and wraps them with
     * copy/insert buttons.
     */
    function renderFinalContent(text) {
      const codeBlockRegex = /\`\`\`(\\w*)\\n([\\s\\S]*?)\`\`\`/g;
      let result = '';
      let lastIndex = 0;

      let match;
      while ((match = codeBlockRegex.exec(text)) !== null) {
        // Add text before code block
        const before = text.slice(lastIndex, match.index);
        result += escapeHtml(before).replace(/\\n/g, '<br>');

        const lang = match[1] || 'text';
        const code = match[2];
        const escapedCode = escapeHtml(code);
        const codeId = 'code-' + Math.random().toString(36).substr(2, 9);

        result += '<div class="code-block-wrapper">' +
          '<div class="code-block-header">' +
            '<span>' + lang + '</span>' +
            '<div class="code-block-actions">' +
              '<button onclick="copyCode(\\'' + codeId + '\\')">Copy</button>' +
              '<button onclick="insertCode(\\'' + codeId + '\\')">Insert</button>' +
            '</div>' +
          '</div>' +
          '<pre class="code-block" id="' + codeId + '">' + escapedCode + '</pre>' +
        '</div>';

        lastIndex = match.index + match[0].length;
      }

      // Add remaining text
      result += escapeHtml(text.slice(lastIndex)).replace(/\\n/g, '<br>');
      return result;
    }

    function escapeHtml(str) {
      return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
    }

    function scrollToBottom() {
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    // Handle messages from the extension
    window.addEventListener('message', (event) => {
      const msg = event.data;

      switch (msg.type) {
        case 'userMessage':
          welcomeEl.style.display = 'none';
          addMessage('user', msg.text);
          break;

        case 'responseStart':
          isStreaming = true;
          sendBtn.disabled = true;
          currentResponseText = '';
          const div = document.createElement('div');
          div.className = 'message assistant';
          div.innerHTML =
            '<div class="message-role">Groot</div>' +
            '<div class="message-content"><span class="cursor"></span></div>';
          messagesEl.appendChild(div);
          currentResponseEl = div.querySelector('.message-content');
          scrollToBottom();
          break;

        case 'responseToken':
          if (currentResponseEl) {
            currentResponseText += msg.token;
            // Show raw streaming text with cursor
            currentResponseEl.innerHTML =
              escapeHtml(currentResponseText).replace(/\\n/g, '<br>') +
              '<span class="cursor"></span>';
            scrollToBottom();
          }
          break;

        case 'responseEnd':
          isStreaming = false;
          sendBtn.disabled = false;
          if (currentResponseEl) {
            // Re-render with proper code block formatting
            currentResponseEl.innerHTML = renderFinalContent(currentResponseText);
          }
          currentResponseEl = null;
          inputEl.focus();
          break;

        case 'responseError':
          isStreaming = false;
          sendBtn.disabled = false;
          if (currentResponseEl) {
            currentResponseEl.innerHTML =
              '<div class="error-msg">Error: ' + escapeHtml(msg.error) +
              '<br><br>Make sure your inference server is running and the URL is correct in settings.</div>';
          }
          currentResponseEl = null;
          inputEl.focus();
          break;

        case 'clearChat':
          messagesEl.innerHTML = '';
          messagesEl.appendChild(welcomeEl);
          welcomeEl.style.display = 'flex';
          break;

        case 'serverStatus':
          statusDot.className = 'status-dot' + (msg.connected ? ' connected' : '');
          statusDot.title = msg.connected ? 'Server connected' : 'Server disconnected';
          break;
      }
    });

    // Code block actions
    window.copyCode = function(id) {
      const el = document.getElementById(id);
      if (el) {
        vscode.postMessage({ type: 'copyCode', code: el.textContent });
      }
    };

    window.insertCode = function(id) {
      const el = document.getElementById(id);
      if (el) {
        vscode.postMessage({ type: 'insertCode', code: el.textContent });
      }
    };

    // Focus input on load
    inputEl.focus();
  </script>
</body>
</html>`;
  }
}

function getNonce(): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
