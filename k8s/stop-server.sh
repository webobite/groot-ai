#!/bin/bash
# stop-server.sh
# Scales vLLM to 0 replicas and releases the GPU node.
#
# Usage: ./k8s/stop-server.sh

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

echo "🌳 Groot AI — Stopping Server"
echo "============================="
echo ""

REPLICAS=$(kubectl get deployment "$GKE_DEPLOYMENT_NAME" -n "$GKE_NAMESPACE" \
  -o jsonpath='{.spec.replicas}' 2>/dev/null || echo "0")

if [ "$REPLICAS" = "0" ] || [ -z "$REPLICAS" ]; then
  echo "Server is already stopped (0 replicas)."
  exit 0
fi

kubectl scale deployment "$GKE_DEPLOYMENT_NAME" -n "$GKE_NAMESPACE" --replicas=0

echo ""
echo "Server scaled to 0. GPU node will be released in ~5-10 minutes."
echo "You're now only paying for the control plane (~\$5.50/day)."
echo ""
echo "To start again: ./k8s/port-forward.sh"
