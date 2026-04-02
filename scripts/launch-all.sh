#!/usr/bin/env bash
# ╔═══════════════════════════════════════════════════════════════════╗
# ║  OpenProphet / OpenClaw — Unified Launcher                      ║
# ║  Start, stop, and monitor all trading components.                ║
# ╚═══════════════════════════════════════════════════════════════════╝

set -euo pipefail

# ── Paths ───────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PID_DIR="$PROJECT_ROOT/data/pids"
LOG_DIR="$PROJECT_ROOT/logs"
FREQTRADE_WORKSPACE="$PROJECT_ROOT/freqtrade_workspace"

# ── Ports (match start.sh defaults) ────────────────────────────────
GO_PORT="${TRADING_BOT_PORT:-4534}"
AGENT_PORT="${AGENT_PORT:-3737}"
MCP_PORT="${MCP_PORT:-0}"  # MCP uses stdio, no port — kept for reference
FREQTRADE_PORT="${FREQTRADE_PORT:-8080}"

# ── Colors ──────────────────────────────────────────────────────────
if [[ -t 1 ]]; then
  RED='\033[0;31m'
  GREEN='\033[0;32m'
  YELLOW='\033[1;33m'
  BLUE='\033[0;34m'
  CYAN='\033[0;36m'
  BOLD='\033[1m'
  DIM='\033[2m'
  RESET='\033[0m'
else
  RED='' GREEN='' YELLOW='' BLUE='' CYAN='' BOLD='' DIM='' RESET=''
fi

# ── Logging helpers ─────────────────────────────────────────────────
info()  { echo -e "${BLUE}ℹ${RESET}  $*"; }
ok()    { echo -e "${GREEN}✔${RESET}  $*"; }
warn()  { echo -e "${YELLOW}⚠${RESET}  $*"; }
fail()  { echo -e "${RED}✖${RESET}  $*"; }
header(){ echo -e "\n${BOLD}${CYAN}── $* ──${RESET}"; }

# ── Ensure directories exist ───────────────────────────────────────
mkdir -p "$PID_DIR" "$LOG_DIR"

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Prerequisite checks
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
check_prerequisites() {
  header "Prerequisite checks"
  local ok_count=0
  local fail_count=0

  # Node.js
  if command -v node &>/dev/null; then
    ok "Node.js $(node --version)"
    ((ok_count++))
  else
    fail "Node.js not found"; ((fail_count++))
  fi

  # Go
  if command -v go &>/dev/null; then
    ok "Go $(go version | awk '{print $3}')"
    ((ok_count++))
  else
    fail "Go not found"; ((fail_count++))
  fi

  # Go binary
  if [[ -x "$PROJECT_ROOT/prophet-trader" ]]; then
    ok "prophet-trader binary exists"
    ((ok_count++))
  else
    warn "prophet-trader binary not found — will attempt to build"
  fi

  # Node modules
  if [[ -d "$PROJECT_ROOT/node_modules" ]]; then
    ok "node_modules present"
    ((ok_count++))
  else
    fail "node_modules missing — run npm install"; ((fail_count++))
  fi

  # TradingAgents venv (optional)
  local ta_venv="$HOME/WORKSPACE/Active_Projects/TradingAgents/.venv"
  if [[ -d "$ta_venv" ]]; then
    ok "TradingAgents venv found"
  else
    warn "TradingAgents venv not found (multi-agent bridge will run degraded)"
  fi

  # .env file
  if [[ -f "$PROJECT_ROOT/.env" ]]; then
    ok ".env file present"
    ((ok_count++))
  else
    warn ".env file not found — some services may fail"
  fi

  echo ""
  if (( fail_count > 0 )); then
    fail "${fail_count} critical prerequisite(s) missing. Fix before launching."
    return 1
  fi

  ok "All critical prerequisites satisfied (${ok_count} checks passed)"
  return 0
}

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Process management helpers
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

# Check if a PID is alive
is_alive() {
  local pid="$1"
  kill -0 "$pid" 2>/dev/null
}

# Read PID from file, return 0 if alive
read_pid() {
  local name="$1"
  local pidfile="$PID_DIR/${name}.pid"
  if [[ -f "$pidfile" ]]; then
    local pid
    pid=$(cat "$pidfile" 2>/dev/null)
    if [[ -n "$pid" ]] && is_alive "$pid"; then
      echo "$pid"
      return 0
    fi
    # Stale PID file — clean up
    rm -f "$pidfile"
  fi
  return 1
}

# Write PID to file
write_pid() {
  local name="$1"
  local pid="$2"
  echo "$pid" > "$PID_DIR/${name}.pid"
}

# Wait for a port to accept connections (up to N seconds)
wait_for_port() {
  local port="$1"
  local timeout="${2:-15}"
  local elapsed=0
  while (( elapsed < timeout )); do
    if nc -z 127.0.0.1 "$port" 2>/dev/null; then
      return 0
    fi
    sleep 1
    ((elapsed++))
  done
  return 1
}

# Graceful kill: SIGTERM → wait → SIGKILL
graceful_kill() {
  local pid="$1"
  local name="${2:-process}"

  if ! is_alive "$pid"; then
    return 0
  fi

  kill "$pid" 2>/dev/null
  local waited=0
  while (( waited < 5 )); do
    if ! is_alive "$pid"; then
      return 0
    fi
    sleep 1
    ((waited++))
  done

  # Escalate
  warn "Force-killing $name (PID $pid)"
  kill -9 "$pid" 2>/dev/null || true
  sleep 0.5
}

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Component launchers
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

start_go_backend() {
  header "Go Backend (prophet-trader)"

  # Already running?
  local existing_pid
  if existing_pid=$(read_pid "go-backend"); then
    ok "Already running (PID $existing_pid)"
    return 0
  fi

  # Build if binary missing
  if [[ ! -x "$PROJECT_ROOT/prophet-trader" ]]; then
    info "Building prophet-trader …"
    (cd "$PROJECT_ROOT" && go build -o prophet-trader ./cmd/bot) || {
      fail "Go build failed"; return 1
    }
    ok "Binary built"
  fi

  # Launch
  local logfile="$LOG_DIR/go-backend.log"
  "$PROJECT_ROOT/prophet-trader" \
    >> "$logfile" 2>&1 &
  local pid=$!
  write_pid "go-backend" "$pid"

  # Health check
  info "Waiting for port $GO_PORT …"
  if wait_for_port "$GO_PORT" 15; then
    ok "Go backend started (PID $pid, port $GO_PORT)"
  else
    warn "Go backend started (PID $pid) but port $GO_PORT not responding yet"
  fi
}

start_mcp_server() {
  header "MCP Server (mcp-server.js)"

  local existing_pid
  if existing_pid=$(read_pid "mcp-server"); then
    ok "Already running (PID $existing_pid)"
    return 0
  fi

  local logfile="$LOG_DIR/mcp-server.log"
  node "$PROJECT_ROOT/mcp-server.js" \
    >> "$logfile" 2>&1 &
  local pid=$!
  write_pid "mcp-server" "$pid"

  # MCP uses stdio — just verify process is alive after a beat
  sleep 2
  if is_alive "$pid"; then
    ok "MCP server started (PID $pid)"
  else
    fail "MCP server exited immediately — check $logfile"
    return 1
  fi
}

start_agent_dashboard() {
  header "Agent Dashboard (agent/server.js)"

  local existing_pid
  if existing_pid=$(read_pid "agent-server"); then
    ok "Already running (PID $existing_pid)"
    return 0
  fi

  local logfile="$LOG_DIR/agent-server.log"
  node "$PROJECT_ROOT/agent/server.js" \
    >> "$logfile" 2>&1 &
  local pid=$!
  write_pid "agent-server" "$pid"

  info "Waiting for port $AGENT_PORT …"
  if wait_for_port "$AGENT_PORT" 10; then
    ok "Agent dashboard started (PID $pid, port $AGENT_PORT)"
  else
    warn "Agent dashboard started (PID $pid) but port $AGENT_PORT not responding yet"
  fi
}

start_freqtrade() {
  header "Freqtrade (dry-run)"

  local existing_pid
  if existing_pid=$(read_pid "freqtrade"); then
    ok "Already running (PID $existing_pid)"
    return 0
  fi

  if ! command -v freqtrade &>/dev/null; then
    # Check for freqtrade in common venv locations
    local ft_bin=""
    for candidate in \
      "$FREQTRADE_WORKSPACE/.venv/bin/freqtrade" \
      "$PROJECT_ROOT/.venv/bin/freqtrade" \
      "$HOME/.local/bin/freqtrade"; do
      if [[ -x "$candidate" ]]; then
        ft_bin="$candidate"
        break
      fi
    done

    if [[ -z "$ft_bin" ]]; then
      fail "freqtrade binary not found — skipping"
      return 1
    fi
  else
    ft_bin="freqtrade"
  fi

  local logfile="$LOG_DIR/freqtrade.log"
  local ft_config="$FREQTRADE_WORKSPACE/config.json"

  if [[ ! -f "$ft_config" ]]; then
    fail "Freqtrade config not found at $ft_config — skipping"
    return 1
  fi

  $ft_bin trade \
    --dry-run \
    --config "$ft_config" \
    --strategy-path "$FREQTRADE_WORKSPACE/strategies" \
    --userdir "$FREQTRADE_WORKSPACE" \
    --logfile "$logfile" \
    >> "$logfile" 2>&1 &
  local pid=$!
  write_pid "freqtrade" "$pid"

  sleep 3
  if is_alive "$pid"; then
    ok "Freqtrade dry-run started (PID $pid, port $FREQTRADE_PORT)"
  else
    fail "Freqtrade exited immediately — check $logfile"
    return 1
  fi
}

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# --status
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

show_status() {
  header "OpenProphet Component Status"
  echo -e "  ${DIM}$(date '+%Y-%m-%d %H:%M:%S')${RESET}\n"

  local components=("go-backend:Go Backend:$GO_PORT" \
                     "mcp-server:MCP Server:-" \
                     "agent-server:Agent Dashboard:$AGENT_PORT" \
                     "freqtrade:Freqtrade:$FREQTRADE_PORT")

  printf "  ${BOLD}%-18s %-8s %-8s %-8s %s${RESET}\n" \
    "COMPONENT" "STATUS" "PID" "PORT" "HEALTH"
  printf "  %-18s %-8s %-8s %-8s %s\n" \
    "─────────────────" "──────" "──────" "──────" "──────"

  for entry in "${components[@]}"; do
    IFS=':' read -r name label port <<< "$entry"
    local pid="" status="" health=""

    if pid=$(read_pid "$name"); then
      status="${GREEN}● up${RESET}"

      # HTTP health check for services with ports
      if [[ "$port" != "-" ]]; then
        local health_url="http://127.0.0.1:${port}/health"
        if curl -sf --max-time 2 "$health_url" &>/dev/null; then
          health="${GREEN}healthy${RESET}"
        elif curl -sf --max-time 2 "http://127.0.0.1:${port}/" &>/dev/null; then
          health="${YELLOW}responding${RESET}"
        else
          health="${YELLOW}no http${RESET}"
        fi
      else
        health="${DIM}n/a${RESET}"
      fi
    else
      pid="-"
      status="${RED}● down${RESET}"
      health="${DIM}-${RESET}"
    fi

    printf "  %-18s %-18b %-8s %-8s %b\n" \
      "$label" "$status" "$pid" "$port" "$health"
  done

  echo ""

  # Log file summary
  header "Log Files"
  for logfile in "$LOG_DIR"/*.log; do
    [[ -f "$logfile" ]] || continue
    local fname size modified
    fname=$(basename "$logfile")
    size=$(du -h "$logfile" 2>/dev/null | awk '{print $1}')
    modified=$(stat -f '%Sm' -t '%H:%M:%S' "$logfile" 2>/dev/null || stat -c '%y' "$logfile" 2>/dev/null | cut -d. -f1)
    printf "  %-24s %6s  ${DIM}last modified %s${RESET}\n" "$fname" "$size" "$modified"
  done

  echo ""
}

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# --stop
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

stop_all() {
  header "Stopping all OpenProphet components"

  # Stop in reverse dependency order
  local components=("freqtrade" "agent-server" "mcp-server" "go-backend")
  local labels=("Freqtrade" "Agent Dashboard" "MCP Server" "Go Backend")
  local stopped=0

  for i in "${!components[@]}"; do
    local name="${components[$i]}"
    local label="${labels[$i]}"
    local pid

    if pid=$(read_pid "$name"); then
      info "Stopping ${label} (PID $pid) …"
      graceful_kill "$pid" "$label"
      rm -f "$PID_DIR/${name}.pid"
      ok "${label} stopped"
      ((stopped++))
    else
      echo -e "  ${DIM}${label}: not running${RESET}"
    fi
  done

  echo ""
  if (( stopped > 0 )); then
    ok "Stopped $stopped component(s)"
  else
    info "No components were running"
  fi
}

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# --start (main launch sequence)
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

start_all() {
  local with_freqtrade="$1"

  echo -e "${BOLD}${CYAN}"
  echo "  ╔═══════════════════════════════════════════╗"
  echo "  ║       OpenProphet — Unified Launcher      ║"
  echo "  ╚═══════════════════════════════════════════╝"
  echo -e "${RESET}"

  check_prerequisites || exit 1

  local failures=0

  start_go_backend    || ((failures++))
  start_mcp_server    || ((failures++))
  start_agent_dashboard || ((failures++))

  if [[ "$with_freqtrade" == "true" ]]; then
    start_freqtrade || ((failures++))
  fi

  # ── Summary ────────────────────────────────────────────────────
  echo ""
  header "Launch Summary"

  if (( failures > 0 )); then
    warn "$failures component(s) had issues — check logs in $LOG_DIR/"
  else
    ok "All components launched successfully"
  fi

  echo ""
  show_status
}

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# CLI argument parsing
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

usage() {
  cat <<EOF
${BOLD}Usage:${RESET} $(basename "$0") [OPTIONS]

${BOLD}Options:${RESET}
  ${GREEN}--start${RESET}         Launch all components (default if no flag given)
  ${GREEN}--stop${RESET}          Stop all running components gracefully
  ${GREEN}--status${RESET}        Show status of all components
  ${GREEN}--freqtrade${RESET}     Also start Freqtrade in dry-run mode
  ${GREEN}--restart${RESET}       Stop then start all components
  ${GREEN}-h, --help${RESET}      Show this help

${BOLD}Components managed:${RESET}
  • Go Backend        (prophet-trader, port $GO_PORT)
  • MCP Server        (mcp-server.js, stdio)
  • Agent Dashboard   (agent/server.js, port $AGENT_PORT)
  • Freqtrade         (dry-run, port $FREQTRADE_PORT) ${DIM}[optional]${RESET}

${BOLD}Examples:${RESET}
  $(basename "$0")                  # Start all (except Freqtrade)
  $(basename "$0") --freqtrade      # Start all including Freqtrade
  $(basename "$0") --status         # Check what's running
  $(basename "$0") --stop           # Graceful shutdown
  $(basename "$0") --restart        # Stop + start
EOF
}

main() {
  local action="start"
  local with_freqtrade="false"

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --start)      action="start" ;;
      --stop)       action="stop" ;;
      --status)     action="status" ;;
      --restart)    action="restart" ;;
      --freqtrade)  with_freqtrade="true" ;;
      -h|--help)    usage; exit 0 ;;
      *)
        fail "Unknown option: $1"
        usage
        exit 1
        ;;
    esac
    shift
  done

  cd "$PROJECT_ROOT"

  case "$action" in
    start)    start_all "$with_freqtrade" ;;
    stop)     stop_all ;;
    status)   show_status ;;
    restart)
      stop_all
      echo ""
      sleep 2
      start_all "$with_freqtrade"
      ;;
  esac
}

main "$@"
