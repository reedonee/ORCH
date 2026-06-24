#!/usr/bin/env bash
# ── ORCH VPS Bootstrap — runs once on a fresh Oracle Ubuntu 22.04/24.04 instance ──
set -euo pipefail

echo "=== ORCH VPS Bootstrap ==="

# ── 1. Firewall (UFW) ────────────────────────────────────────
echo "[1/5] Configuring firewall..."
sudo ufw --force reset
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow 22/tcp      # SSH
sudo ufw allow 80/tcp      # HTTP (Caddy ACME)
sudo ufw allow 443/tcp     # HTTPS
sudo ufw --force enable
echo "  ✓ Firewall active"

# ── 2. Install Docker ─────────────────────────────────────────
echo "[2/5] Installing Docker..."
if ! command -v docker &>/dev/null; then
    curl -fsSL https://get.docker.com | sudo bash
    sudo usermod -aG docker "$USER"
    echo "  ✓ Docker installed (log out/in for group)"
else
    echo "  ✓ Docker already installed"
fi

if ! command -v docker compose &>/dev/null; then
    sudo apt-get update && sudo apt-get install -y docker-compose-plugin
fi
echo "  ✓ Docker Compose installed"

# ── 3. Clone or copy project ─────────────────────────────────
echo "[3/5] Setting up project..."
PROJECT_DIR="$HOME/orch-server"
mkdir -p "$PROJECT_DIR"

# If you're deploying via git:
# git clone https://github.com/YOUR_ORG/orch-server.git "$PROJECT_DIR"
# cd "$PROJECT_DIR"

# If copying files manually via SCP, they should already be in place.
# Structure expected:
#   $PROJECT_DIR/docker-compose.yml
#   $PROJECT_DIR/Caddyfile
#   $PROJECT_DIR/agent-core/Dockerfile
#   $PROJECT_DIR/agent-core/main.py
#   $PROJECT_DIR/agent-core/voice.py
#   $PROJECT_DIR/agent-core/llm.py
#   $PROJECT_DIR/agent-core/memory.py
#   $PROJECT_DIR/agent-core/requirements.txt

cd "$PROJECT_DIR"

# ── 4. Create .env from template ──────────────────────────────
echo "[4/5] Creating configuration..."
if [ ! -f .env ]; then
    cat > .env << 'ENVEOF'
# ORCH VPS Configuration
DOMAIN=orch.yourdomain.com
MODEL=qwen2.5-coder:7b
WHISPER_MODEL=base
LOG_LEVEL=info
ENVEOF
    echo "  ✓ .env created — edit DOMAIN in $PROJECT_DIR/.env"
else
    echo "  ✓ .env exists"
fi

# ── 5. Launch stack ───────────────────────────────────────────
echo "[5/5] Starting services..."
docker compose up -d --build
echo "  ✓ Stack deployed"

echo ""
echo "=== Bootstrap complete ==="
echo "Monitor: docker compose logs -f"
echo "Health:  curl http://localhost:8000/health"
echo ""
echo "Next steps:"
echo "  1. Edit $PROJECT_DIR/.env with your domain"
echo "  2. Edit $PROJECT_DIR/Caddyfile with your domain"
echo "  3. Open Oracle Cloud firewall ports 80 & 443"
echo "  4. Point your domain's A record to this VPS IP"
echo "  5. Run: docker compose restart caddy"
