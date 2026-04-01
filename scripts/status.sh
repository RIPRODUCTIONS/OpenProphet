#!/usr/bin/env bash
# Health check all OpenProphet components
# Usage: ./scripts/status.sh

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

# ── Resolve paths ─────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PID_DIR="$PROJECT_ROOT/data/pids"

# ── Load env for API connectivity checks ──────────────────────────────────────
if [[ -f "$PROJECT_ROOT/.env" ]]; then
    set -a
    # shellcheck disable=SC1091
    source "$PROJECT_ROOT/.env"
    set +a
fi

ALPACA_API_KEY="${ALPACA_API_KEY:-${ALPACA_PUBLIC_KEY:-}}"
BOT_PORT="${TRADING_BOT_PORT:-4534}"
AGENT_PORT="${AGENT_PORT:-3737}"

# ── Helpers ───────────────────────────────────────────────────────────────────
pid_alive() { kill -0 "$1" 2>/dev/null; }

process_uptime() {
    local pid="$1"
    ps -o etime= -p "$pid" 2>/dev/null | xargs
}

status_icon() {
    case "$1" in
        up)   echo -e "${GREEN}●${NC}" ;;
        down) echo -e "${RED}●${NC}" ;;
        warn) echo -e "${YELLOW}●${NC}" ;;
        dim)  echo -e "${DIM}○${NC}" ;;
    esac
}

# ── Gather process status ────────────────────────────────────────────────────
go_status="down"
go_pid_display="—"
go_pid_raw=""
go_uptime="—"
go_health="—"

agent_status="down"
agent_pid_display="—"
agent_pid_raw=""
agent_uptime="—"
agent_health="—"

# Go backend — check new PID location, fallback to legacy
for pid_file in "$PID_DIR/go-backend.pid" "$PROJECT_ROOT/trading_bot.pid"; do
    if [[ -f "$pid_file" ]]; then
        go_pid_raw=$(<"$pid_file")
        if pid_alive "$go_pid_raw"; then
            go_status="up"
            go_pid_display="$go_pid_raw"
            go_uptime=$(process_uptime "$go_pid_raw")
            [[ "$pid_file" == *"trading_bot.pid" ]] && go_pid_display="$go_pid_raw (legacy)"

            health_resp=$(curl -sf --max-time 3 "http://localhost:$BOT_PORT/health" 2>/dev/null || echo "")
            if echo "$health_resp" | grep -q '"healthy"'; then
                go_health="${GREEN}healthy${NC}"
            elif [[ -n "$health_resp" ]]; then
                go_health="${YELLOW}degraded${NC}"
                go_status="warn"
            else
                go_health="${YELLOW}no response${NC}"
                go_status="warn"
            fi
            break
        else
            go_pid_display="$go_pid_raw (dead)"
        fi
    fi
done

# Agent server
if [[ -f "$PID_DIR/agent-server.pid" ]]; then
    agent_pid_raw=$(<"$PID_DIR/agent-server.pid")
    if pid_alive "$agent_pid_raw"; then
        agent_status="up"
        agent_pid_display="$agent_pid_raw"
        agent_uptime=$(process_uptime "$agent_pid_raw")

        agent_resp=$(curl -sf --max-time 3 "http://localhost:$AGENT_PORT/" 2>/dev/null || echo "")
        if [[ -n "$agent_resp" ]]; then
            agent_health="${GREEN}healthy${NC}"
        else
            agent_health="${YELLOW}no response${NC}"
            agent_status="warn"
        fi
    else
        agent_pid_display="$agent_pid_raw (dead)"
    fi
fi

# ── Banner ────────────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}OpenProphet System Status${NC}"
echo -e "${DIM}$(date '+%Y-%m-%d %H:%M:%S')${NC}"
echo ""

# ── Process table ─────────────────────────────────────────────────────────────
printf "${BOLD}  %-24s %-8s %-16s %-14s %s${NC}\n" "Service" "Status" "PID" "Uptime" "Health"
echo "  ─────────────────────────────────────────────────────────────────────────"

printf "  $(status_icon $go_status) %-22s %-8s %-16s %-14s %b\n" \
    "Go Backend" "$go_status" "$go_pid_display" "$go_uptime" "$go_health"

printf "  $(status_icon $agent_status) %-22s %-8s %-16s %-14s %b\n" \
    "Agent Server" "$agent_status" "$agent_pid_display" "$agent_uptime" "$agent_health"

printf "  $(status_icon dim) %-22s %-8s %-16s %-14s %s\n" \
    "MCP Server" "stdio" "—" "—" "on-demand"

echo ""

# ── Alpaca API connectivity ───────────────────────────────────────────────────
echo -e "${BOLD}  Alpaca API${NC}"
echo "  ─────────────────────────────────────────────────────────────────────────"

alpaca_endpoint="${ALPACA_ENDPOINT:-https://paper-api.alpaca.markets}"

if [[ -n "$ALPACA_API_KEY" && -n "${ALPACA_SECRET_KEY:-}" ]]; then
    account_resp=$(curl -sf --max-time 5 \
        -H "APCA-API-KEY-ID: $ALPACA_API_KEY" \
        -H "APCA-API-SECRET-KEY: $ALPACA_SECRET_KEY" \
        "$alpaca_endpoint/v2/account" 2>/dev/null || echo "")

    if [[ -n "$account_resp" ]]; then
        # Parse JSON fields without jq dependency
        parse_field() {
            echo "$account_resp" | grep -o "\"$1\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" | head -1 | sed 's/.*:.*"\(.*\)"/\1/'
        }

        acct_status=$(parse_field "status")
        cash=$(parse_field "cash")
        buying_power=$(parse_field "buying_power")
        portfolio_value=$(parse_field "portfolio_value")
        equity=$(parse_field "equity")
        acct_id=$(parse_field "account_number")

        if [[ "$acct_status" == "ACTIVE" ]]; then
            echo -e "  $(status_icon up) Connected to ${DIM}$alpaca_endpoint${NC}"
        else
            echo -e "  $(status_icon warn) Status: ${YELLOW}$acct_status${NC}"
        fi

        echo ""
        echo -e "  ${BOLD}Account${NC} ${DIM}$acct_id${NC}"
        printf "    Cash:              \$%s\n" "$cash"
        printf "    Buying Power:      \$%s\n" "$buying_power"
        printf "    Portfolio Value:   \$%s\n" "$portfolio_value"
        printf "    Equity:            \$%s\n" "$equity"
    else
        echo -e "  $(status_icon down) ${RED}Connection failed${NC} — $alpaca_endpoint"
        echo -e "    ${DIM}Check credentials and network connectivity.${NC}"
    fi
else
    echo -e "  $(status_icon down) ${RED}No credentials${NC} — ALPACA_PUBLIC_KEY / ALPACA_SECRET_KEY not set"
fi

echo ""

# ── Trading activity today ────────────────────────────────────────────────────
echo -e "${BOLD}  Today's Activity${NC}"
echo "  ─────────────────────────────────────────────────────────────────────────"

today=$(date '+%Y-%m-%d')

# Decisive actions today
action_dir="$PROJECT_ROOT/decisive_actions"
if [[ -d "$action_dir" ]]; then
    today_actions=$(find "$action_dir" -name "${today}*" -type f 2>/dev/null | wc -l | tr -d ' ')
    echo "    Decisive actions:    $today_actions"
else
    echo -e "    Decisive actions:    ${DIM}—${NC}"
fi

# Activity log for today
activity_file="$PROJECT_ROOT/activity_logs/activity_${today}.json"
if [[ -f "$activity_file" ]]; then
    echo -e "    Activity log:        ${GREEN}exists${NC} ($(du -h "$activity_file" | awk '{print $1}'))"
else
    echo -e "    Activity log:        ${DIM}none yet${NC}"
fi

# Live data from Go backend (if running)
if [[ "$go_status" == "up" ]]; then
    orders_resp=$(curl -sf --max-time 3 "http://localhost:$BOT_PORT/api/v1/orders" 2>/dev/null || echo "")
    if [[ -n "$orders_resp" && "$orders_resp" != "null" ]]; then
        order_count=$(echo "$orders_resp" | grep -o '"id"' | wc -l | tr -d ' ')
        echo "    Open orders:         $order_count"
    else
        echo -e "    Open orders:         ${DIM}0${NC}"
    fi

    positions_resp=$(curl -sf --max-time 3 "http://localhost:$BOT_PORT/api/v1/positions" 2>/dev/null || echo "")
    if [[ -n "$positions_resp" && "$positions_resp" != "null" ]]; then
        pos_count=$(echo "$positions_resp" | grep -o '"symbol"' | wc -l | tr -d ' ')
        echo "    Open positions:      $pos_count"
    else
        echo -e "    Open positions:      ${DIM}0${NC}"
    fi
fi

echo ""

# ── Log file health ──────────────────────────────────────────────────────────
echo -e "${BOLD}  Logs${NC}"
echo "  ─────────────────────────────────────────────────────────────────────────"

check_log() {
    local label="$1"
    local path="$2"
    if [[ -f "$path" ]]; then
        local size
        size=$(du -h "$path" | awk '{print $1}')
        local mtime
        if [[ "$(uname)" == "Darwin" ]]; then
            mtime=$(stat -f '%Sm' -t '%Y-%m-%d %H:%M:%S' "$path" 2>/dev/null || echo "?")
        else
            mtime=$(stat -c '%y' "$path" 2>/dev/null | cut -d. -f1 || echo "?")
        fi
        printf "    %-22s %6s   last write: %s\n" "$label" "$size" "$mtime"
    else
        printf "    %-22s ${DIM}%s${NC}\n" "$label" "not found"
    fi
}

check_log "trading_bot.log" "$PROJECT_ROOT/trading_bot.log"
check_log "agent-out.log" "$PROJECT_ROOT/logs/agent-out.log"
check_log "agent-error.log" "$PROJECT_ROOT/logs/agent-error.log"

# Check for recent errors in agent error log
if [[ -f "$PROJECT_ROOT/logs/agent-error.log" ]]; then
    err_lines=$(wc -l < "$PROJECT_ROOT/logs/agent-error.log" | tr -d ' ')
    if [[ "$err_lines" -gt 0 ]]; then
        recent_err=$(tail -1 "$PROJECT_ROOT/logs/agent-error.log" 2>/dev/null | head -c 120)
        if [[ -n "$recent_err" ]]; then
            echo ""
            echo -e "    ${RED}Last error:${NC} ${DIM}${recent_err}${NC}"
        fi
    fi
fi

echo ""
