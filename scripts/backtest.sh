#!/usr/bin/env bash
# OpenProphet Backtester — wrapper around backtest/cli.js
# Usage: ./scripts/backtest.sh --strategy <id> --symbol <SYM> --start <date> --end <date> [options]
#        ./scripts/backtest.sh --strategy <id> --data-file <path> [options]

set -euo pipefail

# ── Colors ────────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
BOLD='\033[1m'
DIM='\033[2m'
NC='\033[0m'

# ── Resolve paths ─────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CLI="$PROJECT_ROOT/backtest/cli.js"

if [[ ! -f "$CLI" ]]; then
    echo -e "${RED}Error: backtest/cli.js not found at $CLI${NC}" >&2
    exit 1
fi

# ── Pass-through mode ─────────────────────────────────────────────────────────
# All arguments are forwarded directly to the Node CLI.
# Supports: --strategy, --symbol, --start, --end, --capital, --data-file,
#           --timeframe, --port, --pretty, --help

if [[ $# -eq 0 || "$1" == "-h" || "$1" == "--help" ]]; then
    echo -e "${BOLD}OpenProphet Backtester${NC}"
    echo -e "${DIM}Wrapper around backtest/cli.js — all flags passed through.${NC}"
    echo ""
    node "$CLI" --help
    exit 0
fi

echo -e "${BOLD}OpenProphet Backtester${NC}"
echo -e "${DIM}────────────────────────────────────────────────────────────${NC}"
echo -e "${CYAN}[info]${NC}  Running: node backtest/cli.js $*"
echo ""

node "$CLI" "$@"
