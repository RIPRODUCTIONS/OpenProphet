#!/usr/bin/env bash
# Live monitoring dashboard for OpenProphet
# Usage: ./scripts/monitor.sh [--errors-only]
#
# Tails combined logs from Go backend and agent server.
# Ctrl+C to exit cleanly.

set -euo pipefail

# ── Colors ────────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
MAGENTA='\033[0;35m'
BOLD='\033[1m'
DIM='\033[2m'
NC='\033[0m'

# ── Resolve paths ─────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

GO_LOG="$PROJECT_ROOT/trading_bot.log"
AGENT_LOG="$PROJECT_ROOT/logs/agent-out.log"
AGENT_ERR="$PROJECT_ROOT/logs/agent-error.log"

ERRORS_ONLY=false
[[ "${1:-}" == "--errors-only" ]] && ERRORS_ONLY=true

# ── Ensure log files exist (tail -f needs them) ──────────────────────────────
mkdir -p "$PROJECT_ROOT/logs"
for f in "$GO_LOG" "$AGENT_LOG" "$AGENT_ERR"; do
    [[ -f "$f" ]] || touch "$f"
done

# ── Cleanup on exit ──────────────────────────────────────────────────────────
TAIL_PIDS=()

cleanup() {
    for pid in "${TAIL_PIDS[@]}"; do
        kill "$pid" 2>/dev/null || true
    done
    echo ""
    echo -e "${DIM}Monitor stopped.${NC}"
}
trap cleanup EXIT

# ── Banner ────────────────────────────────────────────────────────────────────
clear
echo -e "${BOLD}OpenProphet Live Monitor${NC}  ${DIM}(Ctrl+C to exit)${NC}"
if $ERRORS_ONLY; then
    echo -e "${DIM}Filtering: errors only${NC}"
fi
echo -e "${DIM}────────────────────────────────────────────────────────────────${NC}"
echo -e "  ${BLUE}■${NC} Go Backend    ${GREEN}■${NC} Agent Server    ${RED}■${NC} Errors    ${MAGENTA}■${NC} Trades"
echo -e "${DIM}────────────────────────────────────────────────────────────────${NC}"
echo ""

# ── Colorize function ─────────────────────────────────────────────────────────
# Reads stdin line-by-line, applies color based on content and source prefix.
colorize() {
    local prefix="$1"
    local color="$2"

    while IFS= read -r line; do
        # Error/fatal — always show, always red
        if echo "$line" | grep -qiE '(error|fatal|panic|exception|FAIL)'; then
            echo -e "${RED}${prefix}${NC} ${RED}${line}${NC}"
        # Warnings
        elif echo "$line" | grep -qiE '(warn|warning)'; then
            echo -e "${YELLOW}${prefix}${NC} ${YELLOW}${line}${NC}"
        # Trade activity — highlighted
        elif echo "$line" | grep -qiE '(buy|sell|order|trade|executed|filled|position)'; then
            echo -e "${color}${prefix}${NC} ${MAGENTA}${BOLD}${line}${NC}"
        # Heartbeat/health — dimmed
        elif echo "$line" | grep -qiE '(heartbeat|ping|health|alive)'; then
            echo -e "${color}${prefix}${NC} ${DIM}${line}${NC}"
        # Normal log line
        else
            if ! $ERRORS_ONLY; then
                echo -e "${color}${prefix}${NC} ${line}"
            fi
        fi
    done
}

# ── Tail each log with colored prefix ─────────────────────────────────────────

# Go backend stdout/stderr
tail -n 0 -f "$GO_LOG" 2>/dev/null | colorize "[go]   " "$BLUE" &
TAIL_PIDS+=($!)

# Agent server stdout
tail -n 0 -f "$AGENT_LOG" 2>/dev/null | colorize "[agent]" "$GREEN" &
TAIL_PIDS+=($!)

# Agent server stderr (always shown — these are errors)
tail -n 0 -f "$AGENT_ERR" 2>/dev/null | colorize "[err]  " "$RED" &
TAIL_PIDS+=($!)

# Block until Ctrl+C
wait
