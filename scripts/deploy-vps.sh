#!/usr/bin/env bash
set -euo pipefail

# OpenProphet VPS Deployment Script
# Deploys to sovereign VPS via SSH + Docker Compose

REMOTE_HOST="sovereign"
REMOTE_DIR="/opt/openprophet"
COMPOSE_FILE="docker-compose.prod.yml"
REPO_URL="https://github.com/RIPRODUCTIONS/OpenProphet.git"

echo "=== OpenProphet VPS Deploy ==="

# 1. Ensure remote directory exists
echo "[1/5] Setting up remote directory..."
ssh "$REMOTE_HOST" "mkdir -p $REMOTE_DIR"

# 2. Clone or pull latest code
echo "[2/5] Syncing code..."
ssh "$REMOTE_HOST" "
  if [ -d $REMOTE_DIR/.git ]; then
    cd $REMOTE_DIR && git pull --ff-only
  else
    git clone $REPO_URL $REMOTE_DIR
  fi
"

# 3. Copy .env (secrets never in git)
echo "[3/5] Syncing .env..."
if [ -f .env ]; then
  scp -q .env "$REMOTE_HOST:$REMOTE_DIR/.env"
  echo "  .env copied"
else
  echo "  WARNING: No .env file found locally. Create one on the VPS."
fi

# 4. Build and deploy
echo "[4/5] Building and starting containers..."
ssh "$REMOTE_HOST" "
  cd $REMOTE_DIR
  docker compose -f $COMPOSE_FILE pull freqtrade 2>/dev/null || true
  docker compose -f $COMPOSE_FILE build --quiet openprophet
  docker compose -f $COMPOSE_FILE up -d
"

# 5. Verify
echo "[5/5] Verifying deployment..."
sleep 10
ssh "$REMOTE_HOST" "
  echo '--- Container Status ---'
  docker compose -f $REMOTE_DIR/$COMPOSE_FILE ps
  echo ''
  echo '--- Health Checks ---'
  curl -sf http://localhost:3737/health && echo ' <- Agent Dashboard OK' || echo ' <- Agent Dashboard FAILED'
  curl -sf http://localhost:4534/health && echo ' <- Go Backend OK' || echo ' <- Go Backend FAILED'
  curl -sf http://localhost:8081/api/v1/ping && echo ' <- Freqtrade OK' || echo ' <- Freqtrade FAILED'
"

echo ""
echo "=== Deploy Complete ==="
echo "Agent Dashboard: http://$(ssh $REMOTE_HOST 'hostname -I | cut -d\" \" -f1'):3737"
echo "Go Backend:      http://$(ssh $REMOTE_HOST 'hostname -I | cut -d\" \" -f1'):4534"
echo "FreqUI:          http://$(ssh $REMOTE_HOST 'hostname -I | cut -d\" \" -f1'):8081"
