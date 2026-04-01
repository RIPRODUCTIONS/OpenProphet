#!/usr/bin/env node

/**
 * OpenProphet Backtest CLI
 *
 * Usage:
 *   node backtest/cli.js --strategy options-conservative --symbol AAPL --start 2025-01-01 --end 2025-12-31 --capital 10000
 *   node backtest/cli.js --strategy crypto-scalper --data-file backtest/sample-data/AAPL-2025.json
 *   node backtest/cli.js --strategy options-conservative --symbols AAPL,MSFT,GOOG --start 2025-01-01 --end 2025-06-01
 *   node backtest/cli.js --strategy options-conservative --symbol SPY --start 2025-01-01 --end 2025-06-01 --direct
 */

import { parseArgs } from 'node:util';
import {
  loadStrategy,
  loadBarsFromFile,
  fetchBarsFromAPI,
  fetchBarsFromAlpaca,
  normaliseBars,
  runBacktest,
  formatReport,
  aggregateResults,
} from './engine.js';

const { values: args } = parseArgs({
  options: {
    strategy: { type: 'string', short: 's' },
    symbol: { type: 'string' },
    symbols: { type: 'string' },
    start: { type: 'string' },
    end: { type: 'string' },
    capital: { type: 'string', short: 'c', default: '10000' },
    'data-file': { type: 'string', short: 'f' },
    timeframe: { type: 'string', default: '1Day' },
    port: { type: 'string', default: '4534' },
    direct: { type: 'boolean', default: false },
    pretty: { type: 'boolean', default: false },
    report: { type: 'boolean', default: false },
    verbose: { type: 'boolean', short: 'v', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
  strict: true,
  allowPositionals: false,
});

if (args.help) {
  console.log(`OpenProphet Backtest CLI

Usage:
  node backtest/cli.js --strategy <id> --symbol <SYM> --start <date> --end <date> [options]
  node backtest/cli.js --strategy <id> --symbols <SYM1,SYM2,...> --start <date> --end <date> [options]
  node backtest/cli.js --strategy <id> --data-file <path> [options]

Options:
  --strategy, -s   Strategy preset ID (required)
                   Available: options-conservative, options-momentum,
                   crypto-scalper, crypto-dca, crypto-grid, hybrid-balanced
  --symbol         Ticker symbol (e.g. AAPL, SPY, BTC/USDT)
  --symbols        Comma-separated tickers (e.g. AAPL,MSFT,GOOG)
                   Runs independent backtest per ticker, then aggregates
  --start          Start date, ISO format (e.g. 2025-01-01)
  --end            End date, ISO format (e.g. 2025-12-31)
  --capital, -c    Starting capital in USD (default: 10000)
  --data-file, -f  Path to local JSON bars file (skips API call)
  --timeframe      Bar timeframe (default: 1Day)
  --port           Go backend port (default: 4534)
  --direct         Fetch bars directly from Alpaca API (no Go backend needed)
                   Requires ALPACA_PUBLIC_KEY/ALPACA_SECRET_KEY in env
  --report         Output a formatted text report instead of JSON
  --verbose, -v    Include trade log in report output
  --pretty         Pretty-print JSON output
  --help, -h       Show this help

Examples:
  # Backtest against live API
  node backtest/cli.js --strategy options-conservative --symbol AAPL --start 2025-01-01 --end 2025-06-01

  # Multi-ticker backtest with formatted report
  node backtest/cli.js --strategy options-conservative --symbols AAPL,MSFT,GOOG --start 2025-01-01 --end 2025-06-01 --report

  # Direct Alpaca fetch (no Go backend)
  node backtest/cli.js --strategy options-conservative --symbol SPY --start 2025-01-01 --end 2025-06-01 --direct

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

// Resolve ticker list: --symbols takes priority, falls back to --symbol
const symbolList = args.symbols
  ? args.symbols.split(',').map((s) => s.trim()).filter(Boolean)
  : args.symbol
    ? [args.symbol]
    : [];

const hasDataFile = !!args['data-file'];
const hasAPIArgs = symbolList.length > 0 && args.start && args.end;

if (!hasDataFile && !hasAPIArgs) {
  console.error('Error: provide either --data-file OR (--symbol/--symbols, --start, --end)');
  process.exit(1);
}

// ── Parse capital early ──────────────────────────────────────────────────────

const capital = parseFloat(args.capital);
if (isNaN(capital) || capital <= 0) {
  console.error('Error: --capital must be a positive number');
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

// ── Choose fetch function ────────────────────────────────────────────────────

const fetchFn = args.direct
  ? (sym) => fetchBarsFromAlpaca(sym, args.start, args.end, args.timeframe)
  : (sym) => fetchBarsFromAPI(sym, args.start, args.end, args.timeframe, parseInt(args.port, 10));

// ── Run backtest(s) ──────────────────────────────────────────────────────────

/** Run backtest for a single symbol with its own copy of strategy. */
async function backtestSymbol(sym) {
  // Deep-clone strategy so per-symbol mutations don't leak
  const strat = JSON.parse(JSON.stringify(strategy));
  if (!strat.symbols) strat.symbols = {};
  if (!strat.symbols.primary) strat.symbols.primary = [];
  strat.symbols.primary[0] = sym;

  let bars;
  if (hasDataFile) {
    bars = loadBarsFromFile(args['data-file']);
  } else {
    bars = await fetchFn(sym);
  }

  if (bars.length === 0) {
    console.error(`Warning: No valid bar data for ${sym}, skipping`);
    return null;
  }

  return runBacktest({ strategy: strat, bars, capital });
}

try {
  if (hasDataFile) {
    // File mode: single backtest (backward-compatible)
    let bars = loadBarsFromFile(args['data-file']);
    if (bars.length === 0) {
      console.error('No valid bar data found');
      process.exit(1);
    }

    // Override strategy symbol if provided via CLI
    if (symbolList.length > 0) {
      if (!strategy.symbols) strategy.symbols = {};
      if (!strategy.symbols.primary) strategy.symbols.primary = [];
      strategy.symbols.primary[0] = symbolList[0];
    }

    const results = runBacktest({ strategy, bars, capital });
    outputResults(results, false);
  } else if (symbolList.length === 1) {
    // Single ticker API mode (backward-compatible)
    const result = await backtestSymbol(symbolList[0]);
    if (!result) {
      console.error('No valid bar data found');
      process.exit(1);
    }
    outputResults(result, false);
  } else {
    // Multi-ticker mode
    const results = [];
    for (const sym of symbolList) {
      const result = await backtestSymbol(sym);
      if (result) results.push(result);
    }

    if (results.length === 0) {
      console.error('No valid bar data found for any symbol');
      process.exit(1);
    }

    outputResults(results, true);
  }
} catch (err) {
  console.error(`Failed to run backtest: ${err.message}`);
  process.exit(1);
}

// ── Output ───────────────────────────────────────────────────────────────────

function outputResults(results, isMulti) {
  if (args.report) {
    console.log(formatReport(results, { verbose: args.verbose }));
  } else {
    // JSON output — for multi-ticker, wrap in summary object
    let output;
    if (isMulti) {
      const agg = aggregateResults(results);
      output = { summary: agg, results };
    } else {
      output = results;
    }
    const indent = args.pretty ? 2 : undefined;
    console.log(JSON.stringify(output, null, indent));
  }
}
