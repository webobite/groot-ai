# Changelog

All notable changes to Groot AI will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-09-02

### Added

- Chat panel with streaming responses via Server-Sent Events (SSE)
- Inline code completions using Fill-in-the-Middle (FIM) with Tab to accept
- Context menu actions: Explain, Refactor, Generate Tests, Fix Errors
- GKE server controls: start/stop inference server from VS Code Command Palette
- Status bar indicator showing server state (online/offline/starting)
- Full Kubernetes deployment manifests for vLLM on GKE with NVIDIA L4 GPU
- Workload Identity integration (no static JSON keys)
- Secret Manager integration for HF token and API key
- Cluster autoscaler support (scale GPU nodes 0 to 1 on demand)
- `deploy.sh`, `port-forward.sh`, `stop-server.sh` operational scripts
- Environment-based configuration via `k8s/.env` with `envsubst` templating
- OpenAI-compatible API client supporting any vLLM-served model

### Infrastructure

- GKE Standard cluster with separate default and GPU node pools
- On-demand g2-standard-4 VMs with NVIDIA L4 (24GB VRAM)
- Init container pattern for fetching secrets from GCP Secret Manager
- Three-tier health probes: startup (21 min budget), liveness, readiness
- Recreate deployment strategy for single-GPU exclusivity
