# Groot AI

A self-hosted AI code assistant for VS Code, powered by [vLLM](https://github.com/vllm-project/vllm) running on Google Kubernetes Engine. Think of it as your own private Copilot — you control the model, the infrastructure, and the data.

Groot AI serves **Qwen2.5-Coder-7B-Instruct** on an NVIDIA L4 GPU, exposing an OpenAI-compatible API that the VS Code extension connects to for chat, inline code completions, and context-menu actions (explain, refactor, generate tests, fix errors). Infrastructure scales to zero when you're not coding, so you only pay for GPU time you actually use.

---

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│  VS Code                                                     │
│  ┌────────────────────┐  ┌─────────────────────────────┐     │
│  │  Chat Panel        │  │  Inline Completions (FIM)   │     │
│  │  (Streaming SSE)   │  │  (Tab to accept)            │     │
│  └────────┬───────────┘  └──────────────┬──────────────┘     │
│           │   /v1/chat/completions      │  /v1/completions   │
│           └─────────────┬───────────────┘                    │
│                         │  Authorization: Bearer <api-key>   │
│  ┌──────────────────────▼───────────────────────────────┐    │
│  │  Server Control (kubectl scale 0↔1)                  │    │
│  │  Status Bar: ✓ online │ ○ offline │ ⟳ starting       │    │
│  └──────────────────────────────────────────────────────┘    │
└──────────────────────────┬───────────────────────────────────┘
                           │
              kubectl port-forward :8000
                           │
┌──────────────────────────▼───────────────────────────────────┐
│  GKE Cluster (groot-cluster)                                 │
│                                                              │
│  ┌─ Namespace: groot-inference ────────────────────────────┐ │
│  │                                                         │ │
│  │  ServiceAccount (Workload Identity → GCP SA)            │ │
│  │                                                         │ │
│  │  ┌─ Deployment: groot-vllm ──────────────────────────┐  │ │
│  │  │                                                    │  │ │
│  │  │  Init Container        Main Container              │  │ │
│  │  │  ┌──────────────┐      ┌───────────────────────┐   │  │ │
│  │  │  │ Fetch secrets│─────▶│ vLLM + Qwen2.5-Coder  │   │  │ │
│  │  │  │ from Secret  │      │ NVIDIA L4 GPU (24GB)  │   │  │ │
│  │  │  │ Manager      │      │ FP16 · 16K context    │   │  │ │
│  │  │  └──────────────┘      └───────────────────────┘   │  │ │
│  │  │                                                    │  │ │
│  │  │  Volumes: /dev/shm (2Gi) · /local-cache (20Gi)    │  │ │
│  │  └────────────────────────────────────────────────────┘  │ │
│  │                                                         │ │
│  │  Service (ClusterIP) :80 → :8000                        │ │
│  └─────────────────────────────────────────────────────────┘ │
│                                                              │
│  Node Pools:                                                 │
│    default-pool  ─ e2-medium (control-plane workloads)       │
│    gpu-pool      ─ g2-standard-4 + L4 (autoscale 0→1)       │
└──────────────────────────────────────────────────────────────┘
         │
         │  Workload Identity (no static keys)
         ▼
┌──────────────────────────────────────────────────────────────┐
│  GCP Services                                                │
│    Secret Manager ─ HF token, API key                        │
│    GCS Bucket     ─ Model cache (optional)                   │
│    IAM            ─ GCP SA with least-privilege roles         │
└──────────────────────────────────────────────────────────────┘
```

---

## Prerequisites

Before you begin, make sure you have:

1. **Google Cloud account** with billing enabled and a project created.
2. **gcloud CLI** — [install guide](https://cloud.google.com/sdk/docs/install). After installing, run `gcloud auth login` and `gcloud config set project YOUR_PROJECT_ID`.
3. **kubectl** — installed automatically with `gcloud components install kubectl`, or via your package manager.
4. **Node.js 18+** and **pnpm** — for building the VS Code extension.
5. **VS Code 1.128+** — the extension uses APIs from this version.
6. **Hugging Face account** — create an access token at [huggingface.co/settings/tokens](https://huggingface.co/settings/tokens) (read access is sufficient).
7. **GPU quota** — your project needs at least 1 `GPUS_ALL_REGIONS` quota and 1 `NVIDIA_L4_GPUS` quota in your chosen region. Request increases at [IAM & Admin → Quotas](https://console.cloud.google.com/iam-admin/quotas). Approval is usually same-day.

---

## GCP Infrastructure Setup

This section walks through creating everything from scratch. If you already have a GKE cluster, skip to [Deploy vLLM](#deploy-vllm).

### 1. Enable Required APIs

```bash
gcloud services enable \
  container.googleapis.com \
  secretmanager.googleapis.com \
  iam.googleapis.com \
  storage.googleapis.com
```

### 2. Create a GCP Service Account

This service account is what the Kubernetes pods use (via Workload Identity) to access Secret Manager and GCS. No JSON key files needed.

```bash
export PROJECT_ID=$(gcloud config get-value project)

# Create the service account
gcloud iam service-accounts create groot-gke-sa \
  --display-name="Groot GKE Service Account"

# Grant least-privilege roles
gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:groot-gke-sa@${PROJECT_ID}.iam.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor"

gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:groot-gke-sa@${PROJECT_ID}.iam.gserviceaccount.com" \
  --role="roles/storage.objectUser"
```

### 3. Store Secrets

```bash
# Hugging Face token
echo -n "hf_YOUR_TOKEN_HERE" | \
  gcloud secrets create groot-hf-token --data-file=-

# API key for vLLM (generate something strong)
echo -n "$(openssl rand -hex 32)" | \
  gcloud secrets create groot-api-key --data-file=-

# Save the API key locally — you'll need it for VS Code settings
gcloud secrets versions access latest --secret=groot-api-key
```

### 4. Create GCS Bucket (Optional Model Cache)

```bash
gcloud storage buckets create gs://groot-model-cache-${PROJECT_ID} \
  --location=us-central1 \
  --uniform-bucket-level-access
```

### 5. Create GKE Cluster

```bash
# Create the cluster with a small default node pool
gcloud container clusters create groot-cluster \
  --zone=us-central1-a \
  --num-nodes=1 \
  --machine-type=e2-medium \
  --workload-pool="${PROJECT_ID}.svc.id.goog" \
  --addons=GcsFuseCsiDriver \
  --release-channel=regular

# Bind Workload Identity: K8s SA → GCP SA
gcloud iam service-accounts add-iam-policy-binding \
  groot-gke-sa@${PROJECT_ID}.iam.gserviceaccount.com \
  --role="roles/iam.workloadIdentityUser" \
  --member="serviceAccount:${PROJECT_ID}.svc.id.goog[groot-inference/groot-inference-sa]"
```

### 6. Add GPU Node Pool

```bash
gcloud container node-pools create gpu-pool \
  --cluster=groot-cluster \
  --zone=us-central1-a \
  --machine-type=g2-standard-4 \
  --accelerator=type=nvidia-l4,count=1 \
  --num-nodes=0 \
  --enable-autoscaling \
  --min-nodes=0 \
  --max-nodes=1 \
  --node-taints="nvidia.com/gpu=present:NoSchedule" \
  --scopes="https://www.googleapis.com/auth/cloud-platform"
```

**Why autoscale 0→1?** When no pods need a GPU, the node pool scales to zero and you stop paying for the GPU VM entirely. When you deploy or scale the vLLM pod to 1 replica, the autoscaler provisions a GPU node automatically (takes 2-3 minutes).

**Why the taint?** The `NoSchedule` taint prevents non-GPU workloads from accidentally landing on the expensive GPU node. Only pods with a matching toleration (like our vLLM deployment) can be scheduled there.

### 7. Get Cluster Credentials

```bash
gcloud container clusters get-credentials groot-cluster \
  --zone=us-central1-a
```

---

## Deploy vLLM

### 1. Configure Environment

```bash
cp k8s/.env.example k8s/.env
```

Edit `k8s/.env` with your actual values:

```bash
GCP_PROJECT_ID=your-project-id
GCP_SA_EMAIL=groot-gke-sa@your-project-id.iam.gserviceaccount.com
GCS_MODEL_CACHE_BUCKET=groot-model-cache-your-project-id
# ... adjust other values as needed
```

### 2. Deploy

```bash
./k8s/deploy.sh
```

This script uses `envsubst` to render the Kubernetes YAML templates with your `.env` values, then applies them via `kubectl`. On first deploy, the autoscaler will provision a GPU node (2-3 min), pull the vLLM container image, and start loading model weights into GPU VRAM (~5 min for 14GB in FP16). Total cold-start: roughly 5-8 minutes.

### 3. Watch Progress

```bash
# Watch pod status
kubectl get pods -n groot-inference -w

# Once the pod is Running, watch vLLM logs
kubectl logs -n groot-inference -l app=groot -c vllm -f
```

You'll see vLLM download the model weights on first launch, then print:
```
INFO:     Uvicorn running on http://0.0.0.0:8000
```

### 4. Connect via Port Forward

```bash
./k8s/port-forward.sh
```

This script checks if the deployment is scaled to 0 and starts it if needed, then sets up `kubectl port-forward` so the API is available at `http://localhost:8000`.

### 5. Test the API

```bash
curl http://localhost:8000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $(gcloud secrets versions access latest --secret=groot-api-key)" \
  -d '{
    "model": "Qwen/Qwen2.5-Coder-7B-Instruct",
    "messages": [{"role": "user", "content": "Write a Python function to reverse a string"}],
    "max_tokens": 256
  }'
```

---

## VS Code Extension Setup

### 1. Build and Install

```bash
# Install dependencies
pnpm install

# Build the extension
pnpm run compile

# Package as .vsix
pnpm run package
npx @vscode/vsce package --no-dependencies

# Install in VS Code
code --install-extension groot-ai-0.1.0.vsix
```

### 2. Configure Settings

Open VS Code settings (Cmd+, on Mac) and search for "Groot AI":

| Setting | Default | Description |
|---|---|---|
| `groot-ai.serverUrl` | `http://localhost:8000` | vLLM server URL |
| `groot-ai.modelName` | `Qwen/Qwen2.5-Coder-7B-Instruct` | Model name on the server |
| `groot-ai.apiKey` | *(empty)* | API key from Secret Manager |
| `groot-ai.maxTokens` | `2048` | Max tokens per response |
| `groot-ai.temperature` | `0.1` | Sampling temperature |
| `groot-ai.inlineCompletionsEnabled` | `true` | Enable tab-to-accept completions |
| `groot-ai.inlineCompletionDebounceMs` | `500` | Debounce delay before triggering completions |
| `groot-ai.gke.projectId` | *(empty)* | GCP project ID (for server controls) |
| `groot-ai.gke.clusterName` | `groot-cluster` | GKE cluster name |
| `groot-ai.gke.zone` | `us-central1-a` | Cluster zone |
| `groot-ai.gke.deploymentName` | `groot-vllm` | K8s deployment name |
| `groot-ai.gke.namespace` | `groot-inference` | K8s namespace |

**Required:** Set `groot-ai.apiKey` to the API key you stored in Secret Manager:

```bash
gcloud secrets versions access latest --secret=groot-api-key
```

### 3. Features

**Chat Panel** — Open the Groot AI sidebar to chat with the model. Responses stream in real-time via Server-Sent Events.

**Inline Completions** — As you type, Groot suggests code completions using Fill-in-the-Middle (FIM). Press Tab to accept. Toggle with Cmd+Shift+G.

**Context Menu** — Select code, right-click, and choose from: Explain Code, Refactor Code, Generate Tests, Fix Errors.

**Server Controls** — Start/stop the GPU server directly from VS Code via the Command Palette:
- `Groot AI: Start Inference Server` — scales to 1 replica, polls until ready
- `Groot AI: Stop Inference Server` — scales to 0, releases the GPU node
- `Groot AI: Check Server Status` — shows current state in status bar

---

## Daily Workflow

```
Morning:  ./k8s/port-forward.sh     # Starts server + port forward
          (wait ~5 min for cold start on first use of the day)

Code:     Open VS Code — chat, inline completions, context actions all work

Evening:  ./k8s/stop-server.sh       # Scale to 0, GPU released in ~5 min
          (or use Groot AI: Stop Server from the Command Palette)
```

If you leave the server running overnight, it costs roughly $0.70/hr for the L4 GPU node. Scaling to zero drops GPU costs to $0. The GKE control plane and default node pool cost about $5.50/day regardless.

---

## Project Structure

```
groot-ai/
├── k8s/                          # Kubernetes deployment
│   ├── .env.example              # Template — copy to .env
│   ├── .env                      # Your config (gitignored)
│   ├── deploy.sh                 # Render templates + kubectl apply
│   ├── port-forward.sh           # Start server + port forward
│   ├── stop-server.sh            # Scale to 0 replicas
│   ├── namespace-sa.yaml         # Namespace + Workload Identity SA
│   ├── deployment.yaml           # vLLM pod spec (init container + GPU)
│   ├── service.yaml              # Internal ClusterIP service
│   └── service-external.yaml     # External LoadBalancer (optional)
├── src/
│   ├── extension.ts              # Extension entry point
│   ├── vllmClient.ts             # OpenAI-compatible API client
│   ├── chatViewProvider.ts       # Webview chat panel with streaming
│   ├── inlineCompletionProvider.ts  # FIM-based code completions
│   └── serverControl.ts          # kubectl scale + status bar
├── resources/                    # Icons and webview assets
├── package.json                  # Extension manifest + configuration
├── tsconfig.json                 # TypeScript configuration
├── esbuild.js                    # Build script
└── .gitignore
```

---

## Cost Breakdown

All prices are approximate (us-central1, as of 2025). Check [GCP pricing](https://cloud.google.com/compute/vm-instance-pricing) for current rates.

| Resource | Cost | When |
|---|---|---|
| GKE control plane | ~$2.40/day ($73/mo) | Always (while cluster exists) |
| Default node pool (e2-medium) | ~$1.00/day ($30/mo) | Always (1 node minimum) |
| GPU node (g2-standard-4 + L4) | ~$0.70/hr ($16.80/day) | Only while server is running |
| External LoadBalancer | ~$0.60/day ($18/mo) | Only if deployed |
| GCS bucket | ~$0.02/mo per GB | Negligible |
| Secret Manager | Free tier | 6 secret versions free/mo |

**Typical monthly cost with daily use (8 hrs/day, weekdays only):**
- Always-on: $73 + $30 = $103/mo
- GPU (8hrs × 22 days × $0.70): ~$123/mo
- **Total: ~$226/mo**

**Cost-saving tips:**
- Delete the cluster when not actively developing (`gcloud container clusters delete groot-cluster --zone=us-central1-a`). Recreate it with `deploy.sh` when you resume.
- Don't deploy the external LoadBalancer unless you're demoing — port-forward is free.
- Always run `./k8s/stop-server.sh` when done coding for the day.

---

## Troubleshooting

### Pod stuck in Pending

The GPU node pool is likely scaling from 0. This takes 2-3 minutes. Check autoscaler events:

```bash
kubectl describe pod -n groot-inference -l app=groot | grep -A5 Events
```

If you see `FailedScheduling: Insufficient nvidia.com/gpu`, wait 1-2 minutes for the NVIDIA driver daemonset to install on the new node.

### Startup probe failures / pod restarting

The model download (14GB) takes about 5 minutes on first launch. The startup probe allows 21 minutes. Check logs:

```bash
kubectl logs -n groot-inference -l app=groot -c vllm --tail=50
```

If you see download progress, it's working — just slow. If the pod keeps restarting, the startup probe budget may be exhausted. Delete and reapply:

```bash
kubectl delete deployment groot-vllm -n groot-inference
# Wait 30 seconds
./k8s/deploy.sh app
```

### "Insufficient quota" errors

You need GPU quota in your GCP project. Check and request increases:

```bash
# Check current GPU quotas
gcloud compute regions describe us-central1 \
  --format="table(quotas.metric,quotas.limit,quotas.usage)" \
  | grep -i gpu
```

Request increases for `GPUS_ALL_REGIONS` and `NVIDIA_L4_GPUS` at [Quotas page](https://console.cloud.google.com/iam-admin/quotas).

### Extension can't connect to server

1. Make sure port-forward is running: `./k8s/port-forward.sh`
2. Test manually: `curl http://localhost:8000/health`
3. Check VS Code settings: `groot-ai.serverUrl` should be `http://localhost:8000`
4. Check API key: `groot-ai.apiKey` must match what's in Secret Manager

### Autoscaler won't provision a node after failures

After repeated failures, the autoscaler enters a backoff period. Reset it:

```bash
kubectl delete deployment groot-vllm -n groot-inference
sleep 30
./k8s/deploy.sh app
```

### Checking server status from the terminal

```bash
# Replica count
kubectl get deployment groot-vllm -n groot-inference

# Pod status and node assignment
kubectl get pods -n groot-inference -o wide

# Live logs
kubectl logs -n groot-inference -l app=groot -c vllm -f

# GPU node status
kubectl get nodes -l cloud.google.com/gke-accelerator=nvidia-l4
```

---

## Key Design Decisions

**Why vLLM?** It's the fastest open-source inference engine for LLMs, with PagedAttention for efficient memory management. It exposes an OpenAI-compatible API out of the box, so the extension code works with both self-hosted and OpenAI endpoints without changes.

**Why Qwen2.5-Coder-7B-Instruct?** It's the best code-focused model that fits in a single L4 GPU (24GB VRAM). The model needs 14GB in FP16, leaving room for KV cache and overhead. It supports Fill-in-the-Middle (FIM) for inline completions, which many larger models don't.

**Why GKE instead of a plain VM?** Cluster autoscaler gives us 0→1 GPU scaling with no custom scripts. Workload Identity eliminates JSON key files. The declarative YAML makes the setup reproducible. And it's a portfolio piece that demonstrates real production infrastructure skills.

**Why Recreate strategy instead of RollingUpdate?** A single GPU can only run one vLLM instance. RollingUpdate would try to start a new pod before killing the old one, which would fail because there's no second GPU. Recreate kills first, then starts.

**Why local ephemeral storage for model downloads?** GCS Fuse writes are extremely slow (FUSE overhead + network roundtrip per block). Downloading 14GB through GCS Fuse took 10+ minutes and timed out. Local emptyDir downloads at full network speed (~5 min). The trade-off: if the pod restarts, it re-downloads. Worth it for reliable startups.

**Why an init container for secrets?** Workload Identity doesn't inject secrets into environment variables — it only gives the pod an identity. The init container uses `gcloud` to fetch secrets from Secret Manager and writes them to a shared volume. The main container reads them at startup. No static credentials anywhere.

---

## License

MIT
