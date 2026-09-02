#!/bin/bash
# deploy.sh — Render templates and apply to GKE
#
# Usage: ./k8s/deploy.sh [component]
#
# Components:
#   all        — Apply everything (default)
#   namespace  — Namespace + ServiceAccount only
#   app        — Deployment + internal Service
#   external   — External LoadBalancer Service
#
# Prerequisites:
#   1. Copy k8s/.env.example to k8s/.env and fill in values
#   2. gcloud auth login
#   3. kubectl configured for your cluster

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$SCRIPT_DIR/.env"
RENDERED_DIR="$SCRIPT_DIR/.rendered"

# ── Check .env exists ──────────────────────────────────────
if [ ! -f "$ENV_FILE" ]; then
  echo "ERROR: $ENV_FILE not found"
  echo "Run: cp k8s/.env.example k8s/.env"
  echo "Then fill in your values."
  exit 1
fi

# ── Load environment variables ─────────────────────────────
set -a
source "$ENV_FILE"
set +a

echo "🌳 Groot AI — Deploying to GKE"
echo "==============================="
echo "Project:    $GCP_PROJECT_ID"
echo "Cluster:    $GKE_CLUSTER_NAME ($GCP_ZONE)"
echo "Namespace:  $GKE_NAMESPACE"
echo "Model:      $VLLM_MODEL"
echo ""

# ── Create rendered output directory ───────────────────────
mkdir -p "$RENDERED_DIR"

# ── Render templates with envsubst ─────────────────────────
# envsubst replaces ${VAR} placeholders with values from .env
render() {
  local template="$1"
  local output="$RENDERED_DIR/$(basename "$template")"
  envsubst < "$template" > "$output"
  echo "  Rendered: $(basename "$template")"
}

echo "Rendering templates..."
render "$SCRIPT_DIR/namespace-sa.yaml"
render "$SCRIPT_DIR/deployment.yaml"
render "$SCRIPT_DIR/service.yaml"
render "$SCRIPT_DIR/service-external.yaml"
echo ""

# ── Apply based on component argument ──────────────────────
COMPONENT="${1:-all}"

apply_namespace() {
  echo "Applying namespace + service account..."
  kubectl apply -f "$RENDERED_DIR/namespace-sa.yaml"
}

apply_app() {
  echo "Applying deployment + service..."
  kubectl apply -f "$RENDERED_DIR/service.yaml"
  kubectl apply -f "$RENDERED_DIR/deployment.yaml"
}

apply_external() {
  echo "Applying external LoadBalancer service..."
  kubectl apply -f "$RENDERED_DIR/service-external.yaml"
}

case "$COMPONENT" in
  all)
    apply_namespace
    apply_app
    echo ""
    echo "✅ Core deployment applied!"
    echo ""
    echo "To also expose externally (+\$18/month):"
    echo "  ./k8s/deploy.sh external"
    ;;
  namespace)
    apply_namespace
    ;;
  app)
    apply_app
    ;;
  external)
    apply_external
    echo ""
    echo "External IP provisioning... check with:"
    echo "  kubectl get svc ${GKE_DEPLOYMENT_NAME}-external -n ${GKE_NAMESPACE}"
    ;;
  *)
    echo "Unknown component: $COMPONENT"
    echo "Usage: ./k8s/deploy.sh [all|namespace|app|external]"
    exit 1
    ;;
esac

echo ""
echo "Watch pods: kubectl get pods -n $GKE_NAMESPACE -w"
echo "View logs:  kubectl logs -n $GKE_NAMESPACE -l app=groot -c vllm -f"
