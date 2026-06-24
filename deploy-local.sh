#!/usr/bin/env bash
# ── ORCH Local Deploy Script ─────────────────────────────────────
# Pushes local agent-core changes to VPS and triggers rebuild.
# Usage: bash deploy-local.sh
#
# Requires:
#   - SSH key at ~/.ssh/pv.key
#   - VPS IP (default: 51.170.134.197)
#   - Deploy secret in VPS_ORCH_SECRET env var

set -e

VPS_IP="${VPS_ORCH_IP:-51.170.134.197}"
VPS_USER="ubuntu"
DEPLOY_SECRET="${VPS_ORCH_SECRET:-5ff0c3799ae68d1fff3e6dd85d55c82f}"
LOCAL_AGENT_DIR="$(cd "$(dirname "$0")/agent-core" && pwd)"
VPS_AGENT_DIR="/home/ubuntu/orch/agent-core"
SSH_KEY="$HOME/.ssh/pv.key"
SSH_CMD="ssh -i $SSH_KEY -o StrictHostKeyChecking=accept-new"

echo "=== ORCH Local Deploy ==="
echo "  VPS:      $VPS_USER@$VPS_IP"
echo "  Local:    $LOCAL_AGENT_DIR"
echo "  Remote:   $VPS_AGENT_DIR"

# Step 1: Rsync agent-core files to VPS
echo ""
echo "[1/3] Syncing agent-core to VPS..."
rsync -avz --delete \
  -e "$SSH_CMD" \
  --exclude='__pycache__' \
  --exclude='*.pyc' \
  --exclude='.git' \
  "$LOCAL_AGENT_DIR/" \
  "$VPS_USER@$VPS_IP:$VPS_AGENT_DIR/"

# Step 2: SSH into VPS to rebuild
echo ""
echo "[2/3] Rebuilding agent-core on VPS..."
$SSH_CMD "$VPS_USER@$VPS_IP" "cd ~/orch && git add -A && git commit --allow-empty -m 'Deploy from local' 2>/dev/null; docker compose up -d --build agent-core 2>&1" | tail -5

# Step 3: Health check
echo ""
echo "[3/3] Health check..."
sleep 2
$SSH_CMD "$VPS_USER@$VPS_IP" "curl -sf http://localhost:8000/api/health" | python3 -m json.tool 2>/dev/null || echo "Health check: FAILED"

echo ""
echo "=== Deploy complete ==="
