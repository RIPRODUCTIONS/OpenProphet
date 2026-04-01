#!/usr/bin/env bash
# Graceful shutdown of all OpenProphet trading services
# Usage: ./scripts/stop.sh [--force]

set -euo pipefail

# ── Colors ────────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
DIM='\033[2m'
NC='\033[0m'

# ── Resolve paths ─────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PID_DIR="$PROJECT_ROOT/data/pids"

FORCE=false
[[ "${1:-}" == "--force" ]] && FORCE=true

# ── Helpers ───────────────────────────────────────────────────────────────────
info()  { echo -e "${CYAN}[info]${NC}  $*"; }
ok()    { echo -e "${GREEN}[ok]${NC}    $*"; }
warn()  { echo -e "${YELLOW}[warn]${NC}  $*"; }
fail()  { echo -e "${RED}[fail]${NC}  $*"; }

pid_alive() {
    kill -0 "$1" 2>/dev/null
}

# Graceful stop: SIGTERM → wait → SIGKILL if stubborn
stop_process() {
    local label="$1"
    local pid_file="$2"

    if [[ ! -f "$pid_file" ]]; then
        info "$label — no PID file, nothing to stop."
        return 0
    fi

    local pid
    pid=$(<"$pid_file")

    if ! pid_alive "$pid"; then
        warn "$label — PID $pid already dead. Cleaning stale PID file."
        rm -f "$pid_file"
        return 0
    fi

    info "Stopping $label (PID $pid)..."

    if $FORCE; then
        kill -9 "$pid" 2>/dev/null || true
        ok "$label killed (SIGKILL)."
        rm -f "$pid_file"
        return 0
    fi

    # Graceful: SIGTERM first
    kill -15 "$pid" 2>/dev/null || true

    # Wait up to 5 seconds for clean exit
    for i in $(seq 1 5); do
        if ! pid_alive "$pid"; then
            ok "$label stopped gracefully (${i}s)."
            rm -f "$pid_file"
            return 0
        fi
        sleep 1
    done

    # Still alive — escalate to SIGKILL
    warn "$label did not exit after 5s. Sending SIGKILL..."
    kill -9 "$pid" 2>/dev/null || true
    sleep 1

    if ! pid_alive "$pid"; then
        ok "$label killed."
    else
        fail "$label (PID $pid) could not be killed. Check manually."
    fi

    rm -f "$pid_file"
}

# ── Banner ────────────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}Stopping OpenProphet services...${NC}"
echo ""

# ── Stop agent server first (depends on Go backend) ──────────────────────────
stop_process "Agent Server" "$PID_DIR/agent-server.pid"

# ── Stop Go backend ──────────────────────────────────────────────────────────
stop_process "Go Backend" "$PID_DIR/go-backend.pid"

# ── Handle legacy PID file in project root ────────────────────────────────────
if [[ -f "$PROJECT_ROOT/trading_bot.pid" ]]; then
    stop_process "Go Backend (legacy)" "$PROJECT_ROOT/trading_bot.pid"
fi

# ── Verify nothing lingering on ports ─────────────────────────────────────────
echo ""
for port in 4534 3737; do
    pid_on_port=$(lsof -ti :"$port" 2>/dev/null || true)
    if [[ -n "$pid_on_port" ]]; then
        warn "Port $port still has process(es): $pid_on_port"
        if $FORCE; then
            echo "$pid_on_port" | while IFS= read -r p; do
                kill -9 "$p" 2>/dev/null || true
            done
            ok "Force-killed process(es) on port $port."
        else
            warn "Run with --force to kill, or investigate manually."
        fi
    fi
done

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
remaining_pids=$(find "$PID_DIR" -name '*.pid' 2>/dev/null | wc -l | tr -d ' ')
if [[ "$remaining_pids" -eq 0 ]]; then
    echo -e "${GREEN}${BOLD}All services stopped. Clean shutdown.${NC}"
else
    echo -e "${YELLOW}${BOLD}${remaining_pids} PID file(s) remain in $PID_DIR${NC}"
fi
echo ""
