# Contributing to Groot AI

Thanks for your interest in contributing! This guide will help you get set up and explain the process for submitting changes.

## Development Setup

### Prerequisites

- Node.js 18+
- pnpm (`npm install -g pnpm`)
- VS Code 1.128+
- (Optional) A GKE cluster with vLLM deployed — see [README.md](README.md) for infrastructure setup

### Getting Started

```bash
# Clone the repository
git clone https://github.com/webobite/groot-ai.git
cd groot-ai

# Install dependencies
pnpm install

# Start the development watcher
pnpm run watch
```

Then press **F5** in VS Code to launch the Extension Development Host with your changes loaded.

### Project Structure

```
src/
├── extension.ts              # Entry point — registers all commands and providers
├── vllmClient.ts             # OpenAI-compatible HTTP client for vLLM
├── chatViewProvider.ts       # Webview panel for chat with streaming
├── inlineCompletionProvider.ts  # FIM-based inline code suggestions
└── serverControl.ts          # kubectl scale + status bar integration

k8s/                          # Kubernetes deployment manifests (envsubst templates)
```

### Building

```bash
pnpm run compile        # Type-check + lint + build
pnpm run package        # Production build (minified)
pnpm run lint           # ESLint only
pnpm run check-types    # TypeScript type-check only
```

### Testing

```bash
pnpm run test           # Run tests in VS Code test runner
```

## How to Contribute

### Reporting Bugs

Open an issue with:
- VS Code version and OS
- Steps to reproduce
- Expected vs actual behavior
- Relevant logs from the Output panel (select "Groot AI" from the dropdown)

### Suggesting Features

Open an issue with the `enhancement` label. Describe the use case and why it would be valuable.

### Submitting Changes

1. Fork the repository and create a branch from `main`:
   ```bash
   git checkout -b feature/your-feature-name
   ```

2. Make your changes. Follow the existing code style — the project uses TypeScript with ESLint.

3. Make sure everything builds cleanly:
   ```bash
   pnpm run compile
   ```

4. Commit with a clear message:
   ```bash
   git commit -m "Add support for custom system prompts in chat"
   ```

5. Push and open a Pull Request against `main`.

### Code Style

- TypeScript strict mode
- Document **why**, not what — the code shows what; comments explain the reasoning
- Keep the extension lightweight — no heavy dependencies (we use Node's built-in `http`/`https` instead of `axios` or `node-fetch`)
- All user-facing strings should be clear and jargon-free

### Areas Where Help Is Welcome

- **Model support** — Testing with other vLLM-compatible models (CodeLlama, DeepSeek-Coder, StarCoder2)
- **Streaming improvements** — Better handling of partial SSE chunks
- **Webview UI** — Chat panel styling, markdown rendering, code highlighting
- **Tests** — Unit tests for the vLLM client, integration tests for the extension
- **Documentation** — Guides for deploying on AWS EKS, Azure AKS, or bare-metal GPU servers
- **Alternative backends** — Support for Ollama, llama.cpp server, or TGI as inference backends

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
