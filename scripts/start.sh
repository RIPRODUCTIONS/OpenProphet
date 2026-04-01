#!/usr/bin/env bash
# Start all OpenProphet trading services
# Usage: ./scripts/start.sh [--paper|--live] [--no-agent]

set -euo pipefail

# ── Colors ────────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
DIM='\033[2m'
NC='\033[0m'

# ── Resolve project root (scripts/ lives one level below) ────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PID_DIR="$PROJECT_ROOT/data/pids"
LOG_DIR="$PROJECT_ROOT/logs"

# ── Defaults ──────────────────────────────────────────────────────────────────
TRADING_MODE="paper"
START_AGENT=true
AUTO_START=false
START_DELAY=30

# ── Parse args ────────────────────────────────────────────────────────────────
for arg in "$@"; do
    case "$arg" in
        --paper)       TRADING_MODE="paper" ;;
        --live)        TRADING_MODE="live" ;;
        --no-agent)    START_AGENT=false ;;
        --auto-start)  AUTO_START=true ;;
        --start-delay=*)  START_DELAY="${arg#*=}" ;;
        -h|--help)
            echo "Usage: $0 [--paper|--live] [--no-agent] [--auto-start] [--start-delay=N]"
            echo "  --paper        Use Alpaca paper trading (default)"
            echo "  --live         Use Alpaca live trading (REAL MONEY)"
            echo "  --no-agent     Start only the Go backend, skip agent server"
            echo "  --auto-start   Auto-start agent heartbeat after startup delay"
            echo "  --start-delay=N  Seconds to wait before auto-start (default: 30)"
            exit 0
            ;;
        *)
            echo -e "${RED}Unknown argument: $arg${NC}" >&2
            exit 1
            ;;
    esac
done

# ── Banner ────────────────────────────────────────────────────────────────────
echo ""
echo -e "${BLUE}╔══════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║${BOLD}       OpenProphet Trading System              ${NC}${BLUE}║${NC}"
echo -e "${BLUE}║${DIM}       Mode: ${TRADING_MODE}                            ${NC}${BLUE}║${NC}"
echo -e "${BLUE}╚══════════════════════════════════════════════╝${NC}"
echo ""

# ── Live mode safety gate ─────────────────────────────────────────────────────
if [[ "$TRADING_MODE" == "live" ]]; then
    echo -e "${RED}${BOLD}⚠  WARNING: LIVE TRADING MODE — REAL MONEY AT RISK${NC}"
    echo -en "${YELLOW}Type 'yes' to confirm: ${NC}"
    read -r confirm
    if [[ "$confirm" != "yes" ]]; then
        echo -e "${RED}Aborted.${NC}"
        exit 1
    fi
    echo ""
fi

# ── Helpers ───────────────────────────────────────────────────────────────────
info()  { echo -e "${CYAN}[info]${NC}  $*"; }
ok()    { echo -e "${GREEN}[ok]${NC}    $*"; }
warn()  { echo -e "${YELLOW}[warn]${NC}  $*"; }
fail()  { echo -e "${RED}[fail]${NC}  $*"; }

pid_alive() {
    local pid="$1"
    kill -0 "$pid" 2>/dev/null
}

check_stale_pid() {
    local pid_file="$1"
    local label="$2"
    if [[ -f "$pid_file" ]]; then
        local pid
        pid=$(<"$pid_file")
        if pid_alive "$pid"; then
            fail "$label already running (PID $pid). Run ./scripts/stop.sh first."
            return 1
        else
            warn "Stale PID file for $label (PID $pid not running). Cleaning up."
            rm -f "$pid_file"
        fi
    fi
    return 0
}

# ── Preflight checks ─────────────────────────────────────────────────────────
info "Running preflight checks..."

# Go
if ! command -v go &>/dev/null; then
    fail "Go is not installed. Install from https://go.dev/dl/"
    exit 1
fi
ok "Go $(go version | awk '{print $3}' | sed 's/go//')"

# Node
if ! command -v node &>/dev/null; then
    fail "Node.js is not installed."
    exit 1
fi
ok "Node $(node --version)"

# .env
if [[ ! -f "$PROJECT_ROOT/.env" ]]; then
    fail ".env file not found. Copy .env.example and fill in your keys."
    exit 1
fi

# Load .env
set -a
# shellcheck disable=SC1091
source "$PROJECT_ROOT/.env"
set +a

# Required keys
REQUIRED_KEYS=(ALPACA_PUBLIC_KEY ALPACA_SECRET_KEY)
missing=()
for key in "${REQUIRED_KEYS[@]}"; do
    if [[ -z "${!key:-}" ]]; then
        missing+=("$key")
    fi
done
if [[ ${#missing[@]} -gt 0 ]]; then
    fail "Missing required .env keys: ${missing[*]}"
    exit 1
fi
ok ".env loaded (${#REQUIRED_KEYS[@]} required keys present)"

# Ensure ALPACA_API_KEY is set (Go backend reads this)
export ALPACA_API_KEY="${ALPACA_API_KEY:-$ALPACA_PUBLIC_KEY}"

# Set trading mode environment
if [[ "$TRADING_MODE" == "live" ]]; then
    export ALPACA_BASE_URL="https://api.alpaca.markets"
    export ALPACA_PAPER="false"
else
    export ALPACA_BASE_URL="https://paper-api.alpaca.markets"
    export ALPACA_PAPER="true"
fi

# Ensure directories
mkdir -p "$PID_DIR" "$LOG_DIR" "$PROJECT_ROOT/data"

# ── Check for already-running processes ───────────────────────────────────────
check_stale_pid "$PID_DIR/go-backend.pid" "Go backend" || exit 1
if $START_AGENT; then
    check_stale_pid "$PID_DIR/agent-server.pid" "Agent server" || exit 1
fi

# Also check legacy PID file
if [[ -f "$PROJECT_ROOT/trading_bot.pid" ]]; then
    legacy_pid=$(<"$PROJECT_ROOT/trading_bot.pid")
    if pid_alive "$legacy_pid"; then
        warn "Legacy trading_bot.pid exists (PID $legacy_pid). Stop it first or remove the file."
        exit 1
    else
        rm -f "$PROJECT_ROOT/trading_bot.pid"
    fi
fi

echo ""

# ── Build Go binary ──────────────────────────────────────────────────────────
cd "$PROJECT_ROOT"

if [[ ! -f ./prophet_bot ]] || [[ ./cmd/bot/main.go -nt ./prophet_bot ]]; then
    info "Building Go binary..."
    if go build -o prophet_bot ./cmd/bot 2>&1; then
        ok "Binary built: prophet_bot"
    else
        fail "Go build failed."
        exit 1
    fi
else
    ok "Binary up to date: prophet_bot"
fi

echo ""

# ── Start Go backend ─────────────────────────────────────────────────────────
info "Starting Go trading backend (port ${TRADING_BOT_PORT:-4534})..."

nohup ./prophet_bot >> "$PROJECT_ROOT/trading_bot.log" 2>&1 &
GO_PID=$!
echo "$GO_PID" > "$PID_DIR/go-backend.pid"

# Wait for health check (up to 15s)
HEALTH_URL="http://localhost:${TRADING_BOT_PORT:-4534}/health"
health_ok=false
for i in $(seq 1 15); do
    if curl -sf "$HEALTH_URL" >/dev/null 2>&1; then
        health_ok=true
        break
    fi
    sleep 1
done

if $health_ok; then
    ok "Go backend healthy (PID $GO_PID, port ${TRADING_BOT_PORT:-4534})"
else
    if pid_alive "$GO_PID"; then
        warn "Go backend running (PID $GO_PID) but health check not responding."
        warn "Check trading_bot.log for details."
    else
        fail "Go backend exited. Check trading_bot.log:"
        tail -5 "$PROJECT_ROOT/trading_bot.log" 2>/dev/null | while IFS= read -r line; do
            echo -e "  ${DIM}$line${NC}"
        done
        rm -f "$PID_DIR/go-backend.pid"
        exit 1
    fi
fi

echo ""

# ── Start Agent server ────────────────────────────────────────────────────────
if $START_AGENT; then
    AGENT_PORT="${AGENT_PORT:-3737}"
    info "Starting agent server (port $AGENT_PORT)..."

    AGENT_FLAGS=""
    if $AUTO_START; then
        if [[ "$TRADING_MODE" == "live" ]]; then
            AGENT_FLAGS="--live-auto-start --start-delay=$START_DELAY --health-check"
        else
            AGENT_FLAGS="--auto-start --start-delay=$START_DELAY --health-check"
        fi
        info "Auto-start enabled (delay: ${START_DELAY}s)"
    fi

    nohup node agent/server.js $AGENT_FLAGS >> "$LOG_DIR/agent-out.log" 2>> "$LOG_DIR/agent-error.log" &
    AGENT_PID=$!
    echo "$AGENT_PID" > "$PID_DIR/agent-server.pid"

    # Wait for agent health (up to 10s)
    agent_ok=false
    for i in $(seq 1 10); do
        if curl -sf "http://localhost:$AGENT_PORT/" >/dev/null 2>&1; then
            agent_ok=true
            break
        fi
        sleep 1
    done

    if $agent_ok; then
        ok "Agent server healthy (PID $AGENT_PID, port $AGENT_PORT)"
    else
        if pid_alive "$AGENT_PID"; then
            warn "Agent server running (PID $AGENT_PID) but not responding yet."
        else
            fail "Agent server exited. Check logs/agent-error.log"
            rm -f "$PID_DIR/agent-server.pid"
        fi
    fi
else
    info "Skipping agent server (--no-agent)"
fi

echo ""

# ── Status summary ────────────────────────────────────────────────────────────
printf "${BOLD}%-24s %-12s %-10s %-8s${NC}\n" "  Service" "Status" "PID" "Port"
echo "  ─────────────────────────────────────────────────────"

# Go backend row
if pid_alive "$GO_PID"; then
    printf "  %-22s ${GREEN}%-12s${NC} %-10s %-8s\n" "Go Backend" "running" "$GO_PID" "${TRADING_BOT_PORT:-4534}"
else
    printf "  %-22s ${RED}%-12s${NC} %-10s %-8s\n" "Go Backend" "stopped" "—" "—"
fi

# Agent row
if $START_AGENT; then
    if [[ -n "${AGENT_PID:-}" ]] && pid_alive "$AGENT_PID"; then
        printf "  %-22s ${GREEN}%-12s${NC} %-10s %-8s\n" "Agent Server" "running" "$AGENT_PID" "${AGENT_PORT:-3737}"
    else
        printf "  %-22s ${RED}%-12s${NC} %-10s %-8s\n" "Agent Server" "stopped" "—" "—"
    fi
else
    printf "  %-22s ${DIM}%-12s${NC} %-10s %-8s\n" "Agent Server" "skipped" "—" "—"
fi

# MCP server (always stdio, never managed here)
printf "  %-22s ${DIM}%-12s${NC} %-10s %-8s\n" "MCP Server" "on-demand" "—" "stdio"

echo "  ─────────────────────────────────────────────────────"
echo -e "  Mode: ${YELLOW}${TRADING_MODE}${NC}    Dashboard: ${CYAN}http://localhost:${AGENT_PORT:-3737}${NC}"
echo ""
echo -e "${DIM}  Logs:  trading_bot.log, logs/agent-out.log${NC}"
echo -e "${DIM}  Stop:  ./scripts/stop.sh${NC}"
echo ""
