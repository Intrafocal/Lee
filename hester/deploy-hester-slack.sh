#!/bin/bash

# Deploy Hester Slack Bot to GKE
#
# GKE Autopilot in the `hester` namespace provides:
# - Persistent pods (no cold starts like Cloud Run)
# - Cross-namespace Redis access to coefficiency namespace
# - Workload Identity for GCP KMS access
# - Socket Mode WebSocket stays connected
#
# Usage:
#   ./deploy-hester-slack.sh              # Build and deploy
#   ./deploy-hester-slack.sh --build-only # Just build the image
#   ./deploy-hester-slack.sh --skip-build # Deploy without rebuilding
#   ./deploy-hester-slack.sh --dry-run    # Show what would be deployed

set -e

# =============================================================================
# Configuration
# =============================================================================

PROJECT_ID=${PROJECT_ID:-"lucky-era-468301-f6"}
SERVICE_NAME="hester-slack"
NAMESPACE="hester"
IMAGE_NAME="gcr.io/${PROJECT_ID}/${SERVICE_NAME}"

# Build context - script expects to run from repo root
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
BUILD_CONTEXT="$REPO_ROOT"
DOCKERFILE="lee/hester/Dockerfile.slack"
K8S_DIR="$REPO_ROOT/infrastructure/k8s/hester"

# =============================================================================
# Parse Arguments
# =============================================================================

BUILD_ONLY=false
DRY_RUN=false
SKIP_BUILD=false

while [[ $# -gt 0 ]]; do
    case $1 in
        --build-only)
            BUILD_ONLY=true
            shift
            ;;
        --dry-run)
            DRY_RUN=true
            shift
            ;;
        --skip-build)
            SKIP_BUILD=true
            shift
            ;;
        --project)
            PROJECT_ID="$2"
            IMAGE_NAME="gcr.io/${PROJECT_ID}/${SERVICE_NAME}"
            shift 2
            ;;
        *)
            echo "Unknown option: $1"
            echo "Usage: $0 [--build-only] [--dry-run] [--skip-build] [--project PROJECT]"
            exit 1
            ;;
    esac
done

# =============================================================================
# Validation
# =============================================================================

echo "🔍 Validating configuration..."

# Check required tools
for cmd in gcloud docker kubectl; do
    if ! command -v $cmd &> /dev/null; then
        echo "❌ $cmd not found. Please install it."
        exit 1
    fi
done

# Check Dockerfile exists
if [ ! -f "$REPO_ROOT/$DOCKERFILE" ]; then
    echo "❌ Dockerfile not found at $REPO_ROOT/$DOCKERFILE"
    exit 1
fi

# Check K8s manifests exist
if [ ! -d "$K8S_DIR" ]; then
    echo "❌ K8s manifests not found at $K8S_DIR"
    exit 1
fi

echo "   Repo root: $REPO_ROOT"
echo "   Namespace: $NAMESPACE"

# Verify kubectl context
CURRENT_CONTEXT=$(kubectl config current-context 2>/dev/null || echo "none")
echo "   K8s context: $CURRENT_CONTEXT"

if [[ "$CURRENT_CONTEXT" != *"gke_"* ]]; then
    echo "⚠️  Current context doesn't look like GKE. Make sure you're connected to the right cluster."
    if [ "$DRY_RUN" = false ]; then
        read -p "   Continue anyway? [y/N] " -n 1 -r
        echo
        if [[ ! $REPLY =~ ^[Yy]$ ]]; then
            exit 1
        fi
    fi
fi

# =============================================================================
# Build Image
# =============================================================================

if [ "$SKIP_BUILD" = false ]; then
    echo ""
    echo "🔨 Building Docker image..."
    echo "   Image: $IMAGE_NAME"
    echo "   Dockerfile: $DOCKERFILE"

    if [ "$DRY_RUN" = true ]; then
        echo "   [DRY RUN] Would build and push image"
    else
        # Configure docker for GCR
        gcloud auth configure-docker gcr.io --quiet

        # Build with buildx for amd64 (GKE requirement)
        docker buildx build \
            --platform linux/amd64 \
            -f "$REPO_ROOT/$DOCKERFILE" \
            -t "$IMAGE_NAME:latest" \
            -t "$IMAGE_NAME:$(git rev-parse --short HEAD)" \
            --push \
            "$BUILD_CONTEXT"

        echo "✅ Image pushed to $IMAGE_NAME"
    fi
fi

if [ "$BUILD_ONLY" = true ]; then
    echo ""
    echo "✅ Build complete (--build-only specified)"
    exit 0
fi

# =============================================================================
# Deploy to GKE
# =============================================================================

echo ""
echo "🚀 Deploying to GKE..."
echo "   Namespace: $NAMESPACE"
echo "   Deployment: $SERVICE_NAME"

if [ "$DRY_RUN" = true ]; then
    echo ""
    echo "[DRY RUN] Would apply:"
    echo "   kubectl apply -f $K8S_DIR/"
    echo "   kubectl rollout restart deployment/$SERVICE_NAME -n $NAMESPACE"
else
    # Ensure namespace exists
    kubectl get namespace $NAMESPACE &>/dev/null || kubectl create namespace $NAMESPACE

    # Apply K8s manifests
    kubectl apply -f "$K8S_DIR/"

    # Restart deployment to pick up new image
    kubectl rollout restart deployment/$SERVICE_NAME -n $NAMESPACE

    # Wait for rollout
    echo ""
    echo "⏳ Waiting for rollout..."
    kubectl rollout status deployment/$SERVICE_NAME -n $NAMESPACE --timeout=120s
fi

# =============================================================================
# Post-Deploy Verification
# =============================================================================

if [ "$DRY_RUN" = false ]; then
    echo ""
    echo "🔍 Checking pod status..."

    # Get pod info
    POD_STATUS=$(kubectl get pods -n $NAMESPACE -l app=$SERVICE_NAME -o jsonpath='{.items[0].status.phase}' 2>/dev/null || echo "Unknown")
    POD_NAME=$(kubectl get pods -n $NAMESPACE -l app=$SERVICE_NAME -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || echo "none")

    if [ "$POD_STATUS" = "Running" ]; then
        echo "✅ Pod is running: $POD_NAME"
    else
        echo "⚠️  Pod status: $POD_STATUS"
        echo "   Check logs: kubectl logs -n $NAMESPACE -l app=$SERVICE_NAME"
    fi

    # Check for Socket Mode connection in logs
    echo ""
    echo "🔍 Checking Slack connection..."
    sleep 5
    if kubectl logs -n $NAMESPACE -l app=$SERVICE_NAME --tail=20 2>/dev/null | grep -q "Bolt app is running"; then
        echo "✅ Slack Socket Mode connected"
    else
        echo "⚠️  Waiting for Slack connection..."
    fi

    echo ""
    echo "📊 Deployment Summary"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "Namespace:   $NAMESPACE"
    echo "Deployment:  $SERVICE_NAME"
    echo "Image:       $IMAGE_NAME:latest"
    echo "Pod:         $POD_NAME"
    echo "Status:      $POD_STATUS"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

    echo ""
    echo "📋 Useful Commands"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "View logs:     kubectl logs -n $NAMESPACE -l app=$SERVICE_NAME -f"
    echo "Pod status:    kubectl get pods -n $NAMESPACE"
    echo "Describe:      kubectl describe deployment/$SERVICE_NAME -n $NAMESPACE"
    echo "Restart:       kubectl rollout restart deployment/$SERVICE_NAME -n $NAMESPACE"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

    echo ""
    echo "✅ Deployment complete!"
fi
