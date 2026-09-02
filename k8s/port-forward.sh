#!/bin/bash
# port-forward.sh
# Quick access to vLLM from your Mac during development.
#
# Usage: ./k8s/port-forward.sh
# Then hit: http://localhost:8000/v1/chat/completions

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$SCRIPT_DIR/.env"

if [ ! -f "$ENV_FILE" ]; then
  echo "ERROR: $ENV_FILE not found. Run: cp k8s/.env.example k8s/.env"
  exit 1
fi

set -a
source "$ENV_FILE"
set +a

echo "🌳 Groot AI — Port Forward to vLLM"
echo "=================================="
echo ""

# Check if the deployment is running
REPLICAS=$(kubectl get deployment "$GKE_DEPLOYMENT_NAME" -n "$GKE_NAMESPACE" \
  -o jsonpath='{.spec.replicas}' 2>/dev/null || echo "0")

if [ "$REPLICAS" = "0" ] || [ -z "$REPLICAS" ]; then
  echo "Server is scaled to 0. Starting it..."
  kubectl scale deployment "$GKE_DEPLOYMENT_NAME" -n "$GKE_NAMESPACE" --replicas=1
  echo "Waiting for pod to be ready (this may take a few minutes)..."
  kubectl wait --for=condition=ready pod -l app=groot,component=inference \
    -n "$GKE_NAMESPACE" --timeout=600s
fi

echo ""
echo "vLLM is running. Starting port forward..."
echo ""
echo "API available at: http://localhost:${VLLM_PORT}"
echo "  Health:      http://localhost:${VLLM_PORT}/health"
echo "  Chat:        http://localhost:${VLLM_PORT}/v1/chat/completions"
echo "  Completions: http://localhost:${VLLM_PORT}/v1/completions"
echo ""
echo "Press Ctrl+C to stop."
echo ""

kubectl port-forward svc/"$GKE_DEPLOYMENT_NAME" -n "$GKE_NAMESPACE" "${VLLM_PORT}:80"
