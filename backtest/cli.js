#!/usr/bin/env node

/**
 * OpenProphet Backtest CLI
 *
 * Usage:
 *   node backtest/cli.js --strategy options-conservative --symbol AAPL --start 2025-01-01 --end 2025-12-31 --capital 10000
 *   node backtest/cli.js --strategy crypto-scalper --data-file backtest/sample-data/AAPL-2025.json
 */

import { parseArgs } from 'node:util';
import {
  loadStrategy,
  loadBarsFromFile,
  fetchBarsFromAPI,
  normaliseBars,
  runBacktest,
} from './engine.js';

const { values: args } = parseArgs({
  options: {
    strategy: { type: 'string', short: 's' },
    symbol: { type: 'string' },
    start: { type: 'string' },
    end: { type: 'string' },
    capital: { type: 'string', short: 'c', default: '10000' },
    'data-file': { type: 'string', short: 'f' },
    timeframe: { type: 'string', default: '1Day' },
    port: { type: 'string', default: '4534' },
    pretty: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
  strict: true,
  allowPositionals: false,
});

if (args.help) {
  console.log(`OpenProphet Backtest CLI

Usage:
  node backtest/cli.js --strategy <id> --symbol <SYM> --start <date> --end <date> [options]
  node backtest/cli.js --strategy <id> --data-file <path> [options]

Options:
  --strategy, -s   Strategy preset ID (required)
                   Available: options-conservative, options-momentum,
                   crypto-scalper, crypto-dca, crypto-grid, hybrid-balanced
  --symbol         Ticker symbol (e.g. AAPL, SPY, BTC/USDT)
  --start          Start date, ISO format (e.g. 2025-01-01)
  --end            End date, ISO format (e.g. 2025-12-31)
  --capital, -c    Starting capital in USD (default: 10000)
  --data-file, -f  Path to local JSON bars file (skips API call)
  --timeframe      Bar timeframe (default: 1Day)
  --port           Go backend port (default: 4534)
  --pretty         Pretty-print JSON output
  --help, -h       Show this help

Examples:
  # Backtest against live API
  node backtest/cli.js --strategy options-conservative --symbol AAPL --start 2025-01-01 --end 2025-06-01

  # Backtest with local data file (no backend needed)
  node backtest/cli.js --strategy options-momentum --data-file backtest/sample-data/AAPL-2025.json

  # Via npm script
  npm run backtest -- --strategy crypto-scalper --symbol BTC/USDT --start 2025-01-01 --end 2025-06-01
`);
  process.exit(0);
}

// ── Validate required args ───────────────────────────────────────────────────

if (!args.strategy) {
  console.error('Error: --strategy is required');
  process.exit(1);
}

const hasDataFile = !!args['data-file'];
const hasAPIArgs = args.symbol && args.start && args.end;

if (!hasDataFile && !hasAPIArgs) {
  console.error('Error: provide either --data-file OR (--symbol, --start, --end)');
  process.exit(1);
}

// ── Load strategy ────────────────────────────────────────────────────────────

let strategy;
try {
  strategy = loadStrategy(args.strategy);
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

// ── Load bars ────────────────────────────────────────────────────────────────

let bars;
try {
  if (hasDataFile) {
    bars = loadBarsFromFile(args['data-file']);
  } else {
    bars = await fetchBarsFromAPI(
      args.symbol,
      args.start,
      args.end,
      args.timeframe,
      parseInt(args.port, 10),
    );
  }
} catch (err) {
  console.error(`Failed to load bar data: ${err.message}`);
  process.exit(1);
}

if (bars.length === 0) {
  console.error('No valid bar data found');
  process.exit(1);
}

// ── Run backtest ─────────────────────────────────────────────────────────────

const capital = parseFloat(args.capital);
if (isNaN(capital) || capital <= 0) {
  console.error('Error: --capital must be a positive number');
  process.exit(1);
}

// Override strategy symbol if provided via CLI
if (args.symbol) {
  if (!strategy.symbols) strategy.symbols = {};
  if (!strategy.symbols.primary) strategy.symbols.primary = [];
  strategy.symbols.primary[0] = args.symbol;
}

const results = runBacktest({ strategy, bars, capital });
const indent = args.pretty ? 2 : undefined;
console.log(JSON.stringify(results, null, indent));
