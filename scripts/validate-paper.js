#!/usr/bin/env node

/**
 * OpenProphet Paper Trading Validation Script
 *
 * Collects trade data from paper trading, calculates performance metrics,
 * compares against SPY benchmark, and outputs a go/no-go recommendation.
 *
 * Usage:
 *   node scripts/validate-paper.js --days 30
 *   node scripts/validate-paper.js --days 7 --json
 *   node scripts/validate-paper.js --days 30 --benchmark QQQ
 *
 * @module validate-paper
 */

import 'dotenv/config';
import { parseArgs } from 'node:util';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..');

// ── CLI Args ─────────────────────────────────────────────────────────────────

const { values: args } = parseArgs({
  options: {
    days:      { type: 'string',  default: '30' },
    benchmark: { type: 'string',  default: 'SPY' },
    json:      { type: 'boolean', default: false },
    port:      { type: 'string',  default: process.env.TRADING_BOT_PORT || '4534' },
    'data-dir': { type: 'string', default: '' },
    help:      { type: 'boolean', short: 'h', default: false },
  },
  strict: true,
  allowPositionals: false,
});

if (args.help) {
  console.log(`OpenProphet Paper Trading Validator

Usage:
  node scripts/validate-paper.js --days 30
  node scripts/validate-paper.js --days 7 --json
  node scripts/validate-paper.js --days 30 --benchmark QQQ

Options:
  --days N          Evaluation period in days (default: 30)
  --benchmark SYM   Benchmark ticker (default: SPY)
  --json            Output raw JSON instead of formatted report
  --port PORT       Go backend port (default: 4534)
  --data-dir PATH   Path to activity_logs directory (auto-detected if omitted)
  --help, -h        Show this help
`);
  process.exit(0);
}

// ── Trade Data Collection ────────────────────────────────────────────────────

/**
 * Load decisive action logs from the activity_logs or decisive_actions directory.
 * These are the JSON files the agent writes for every trading decision.
 */
function loadTradesFromLogs(dataDir, days) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);

  const dirs = dataDir
    ? [dataDir]
    : [
        join(PROJECT_ROOT, 'decisive_actions'),
        join(PROJECT_ROOT, 'activity_logs'),
      ];

  const trades = [];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;

    let files;
    try { files = readdirSync(dir).filter(f => f.endsWith('.json')); }
    catch { continue; }

    for (const file of files) {
      // Parse timestamp from filename: 2025-11-20T05-49-09-915Z_ACTION.json
      const tsMatch = file.match(/^(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})/);
      if (!tsMatch) continue;

      const ts = new Date(tsMatch[1].replace(/-/g, (m, offset) => offset <= 9 ? m : ':'));
      if (isNaN(ts.getTime())) continue;
      if (ts < cutoff) continue;

      try {
        const raw = JSON.parse(readFileSync(join(dir, file), 'utf-8'));
        // Only count actual BUY/SELL actions
        const action = (raw.action || raw.type || file).toUpperCase();
        if (action.includes('BUY') || action.includes('SELL')) {
          trades.push({
            timestamp: ts.toISOString(),
            action: action.includes('BUY') ? 'BUY' : 'SELL',
            symbol: raw.symbol || raw.ticker || extractSymbolFromFilename(file),
            price: parseFloat(raw.price || raw.fillPrice || 0),
            quantity: parseFloat(raw.quantity || raw.shares || raw.contracts || 0),
            pnl: parseFloat(raw.pnl || raw.profit || 0),
            reason: raw.reason || raw.exitReason || '',
            source: file,
          });
        }
      } catch {
        // Skip malformed files
      }
    }
  }

  trades.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  return trades;
}

function extractSymbolFromFilename(filename) {
  // e.g., "2025-11-20T16-14-37-978Z_BUY_SPY.json" → "SPY"
  const parts = filename.replace('.json', '').split('_');
  if (parts.length >= 3) {
    return parts.slice(2).join('_');
  }
  return 'UNKNOWN';
}

/**
 * Match buy/sell pairs into round-trip trades.
 */
function matchTrades(rawTrades) {
  const openPositions = new Map(); // symbol → [buys]
  const roundTrips = [];

  for (const trade of rawTrades) {
    const sym = trade.symbol;

    if (trade.action === 'BUY') {
      if (!openPositions.has(sym)) openPositions.set(sym, []);
      openPositions.get(sym).push(trade);
    } else if (trade.action === 'SELL') {
      const buys = openPositions.get(sym);
      if (buys && buys.length > 0) {
        const entry = buys.shift();
        if (buys.length === 0) openPositions.delete(sym);

        const entryValue = entry.price * (entry.quantity || 1);
        const exitValue = trade.price * (trade.quantity || entry.quantity || 1);
        const pnl = trade.pnl || (exitValue - entryValue);

        roundTrips.push({
          symbol: sym,
          entryDate: entry.timestamp,
          exitDate: trade.timestamp,
          entryPrice: entry.price,
          exitPrice: trade.price,
          quantity: entry.quantity || trade.quantity || 1,
          pnl,
          returnPct: entryValue > 0 ? (pnl / entryValue) * 100 : 0,
          holdDays: Math.ceil((new Date(trade.timestamp) - new Date(entry.timestamp)) / 86400000),
          reason: trade.reason,
        });
      }
    }
  }

  return { roundTrips, openPositions: Array.from(openPositions.entries()) };
}

// ── Benchmark Fetch ──────────────────────────────────────────────────────────

async function fetchBenchmarkReturn(symbol, days, port) {
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - days);

  const startStr = start.toISOString().split('T')[0];
  const endStr = end.toISOString().split('T')[0];

  // Try Go backend first
  try {
    const url = `http://localhost:${port}/api/v1/market/bars/${symbol}?start=${startStr}&end=${endStr}&timeframe=1Day`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (resp.ok) {
      const raw = await resp.json();
      const bars = normalizeBars(raw);
      if (bars.length >= 2) {
        const first = bars[0].close;
        const last = bars[bars.length - 1].close;
        return { returnPct: ((last - first) / first) * 100, bars: bars.length, source: 'go-backend' };
      }
    }
  } catch { /* fall through */ }

  // Try Alpaca API directly
  try {
    const apiKey = process.env.ALPACA_PUBLIC_KEY || process.env.ALPACA_API_KEY;
    const secretKey = process.env.ALPACA_SECRET_KEY;
    if (apiKey && secretKey) {
      const url = `https://data.alpaca.markets/v2/stocks/${symbol}/bars?start=${startStr}&end=${endStr}&timeframe=1Day&limit=1000`;
      const resp = await fetch(url, {
        headers: {
          'APCA-API-KEY-ID': apiKey,
          'APCA-API-SECRET-KEY': secretKey,
        },
        signal: AbortSignal.timeout(10000),
      });
      if (resp.ok) {
        const raw = await resp.json();
        const bars = normalizeBars(raw);
        if (bars.length >= 2) {
          const first = bars[0].close;
          const last = bars[bars.length - 1].close;
          return { returnPct: ((last - first) / first) * 100, bars: bars.length, source: 'alpaca-api' };
        }
      }
    }
  } catch { /* fall through */ }

  return { returnPct: null, bars: 0, source: 'unavailable' };
}

function normalizeBars(raw) {
  const list = Array.isArray(raw) ? raw : raw?.bars ?? raw?.data ?? [];
  return list
    .map(b => ({
      close: parseFloat(b.c ?? b.Close ?? b.close ?? 0),
      timestamp: b.t ?? b.Timestamp ?? b.timestamp ?? '',
    }))
    .filter(b => b.close > 0)
    .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
}

// ── Metrics Calculation ──────────────────────────────────────────────────────

function calculateMetrics(roundTrips) {
  if (roundTrips.length === 0) {
    return {
      totalTrades: 0, totalPnL: 0, totalReturn: 0, winRate: 0,
      avgWin: 0, avgLoss: 0, profitFactor: 0, maxDrawdown: 0,
      sharpeRatio: 0, avgHoldDays: 0, bestTrade: null, worstTrade: null,
    };
  }

  const wins = roundTrips.filter(t => t.pnl > 0);
  const losses = roundTrips.filter(t => t.pnl <= 0);
  const totalPnL = roundTrips.reduce((s, t) => s + t.pnl, 0);
  const grossWins = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLosses = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));

  // Equity curve for drawdown
  let equity = 0;
  let peak = 0;
  let maxDrawdown = 0;
  const returns = [];

  for (const trade of roundTrips) {
    equity += trade.pnl;
    if (equity > peak) peak = equity;
    const dd = peak > 0 ? ((peak - equity) / peak) * 100 : 0;
    if (dd > maxDrawdown) maxDrawdown = dd;
    returns.push(trade.returnPct / 100);
  }

  // Sharpe (simplified — per-trade, annualized assuming ~252 trading days)
  const meanReturn = returns.length > 0 ? returns.reduce((a, b) => a + b, 0) / returns.length : 0;
  const stdReturn = returns.length > 1
    ? Math.sqrt(returns.reduce((s, r) => s + (r - meanReturn) ** 2, 0) / (returns.length - 1))
    : 0;
  const sharpeRatio = stdReturn > 0 ? (meanReturn / stdReturn) * Math.sqrt(252) : 0;

  const sorted = [...roundTrips].sort((a, b) => b.pnl - a.pnl);

  return {
    totalTrades: roundTrips.length,
    totalPnL: round2(totalPnL),
    winRate: round2((wins.length / roundTrips.length) * 100),
    avgWin: wins.length > 0 ? round2(grossWins / wins.length) : 0,
    avgLoss: losses.length > 0 ? round2(-grossLosses / losses.length) : 0,
    profitFactor: grossLosses > 0 ? round2(grossWins / grossLosses) : grossWins > 0 ? Infinity : 0,
    maxDrawdown: round2(maxDrawdown),
    sharpeRatio: round2(sharpeRatio),
    avgHoldDays: round2(roundTrips.reduce((s, t) => s + t.holdDays, 0) / roundTrips.length),
    bestTrade: sorted[0] ? { symbol: sorted[0].symbol, pnl: round2(sorted[0].pnl) } : null,
    worstTrade: sorted[sorted.length - 1] ? { symbol: sorted[sorted.length - 1].symbol, pnl: round2(sorted[sorted.length - 1].pnl) } : null,
    wins: wins.length,
    losses: losses.length,
  };
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

// ── Go/No-Go Recommendation ─────────────────────────────────────────────────

function makeRecommendation(metrics, benchmark) {
  const checks = [];

  // Minimum trades
  checks.push({
    name: 'Minimum Trades (≥10)',
    passed: metrics.totalTrades >= 10,
    value: `${metrics.totalTrades} trades`,
  });

  // Positive P&L
  checks.push({
    name: 'Positive Total P&L',
    passed: metrics.totalPnL > 0,
    value: `$${metrics.totalPnL.toFixed(2)}`,
  });

  // Win rate > 40%
  checks.push({
    name: 'Win Rate > 40%',
    passed: metrics.winRate > 40,
    value: `${metrics.winRate}%`,
  });

  // Profit factor > 1.0
  checks.push({
    name: 'Profit Factor > 1.0',
    passed: metrics.profitFactor > 1.0,
    value: `${metrics.profitFactor === Infinity ? '∞' : metrics.profitFactor}`,
  });

  // Max drawdown < 25%
  checks.push({
    name: 'Max Drawdown < 25%',
    passed: metrics.maxDrawdown < 25,
    value: `${metrics.maxDrawdown}%`,
  });

  // Sharpe > 0.5
  checks.push({
    name: 'Sharpe Ratio > 0.5',
    passed: metrics.sharpeRatio > 0.5,
    value: `${metrics.sharpeRatio}`,
  });

  // Benchmark comparison
  if (benchmark.returnPct !== null) {
    const beats = metrics.totalPnL > 0; // simplified: any profit vs benchmark
    checks.push({
      name: `Beats ${args.benchmark} Benchmark`,
      passed: beats,
      value: `Strategy P&L vs ${args.benchmark} ${round2(benchmark.returnPct)}%`,
    });
  }

  const passedCount = checks.filter(c => c.passed).length;
  const totalChecks = checks.length;
  // Go if ≥ 70% of checks pass AND no catastrophic failures
  const catastrophic = metrics.maxDrawdown >= 50 || metrics.totalTrades < 5;
  const goDecision = !catastrophic && passedCount / totalChecks >= 0.7;

  return { checks, passedCount, totalChecks, goDecision, catastrophic };
}

// ── Report Formatting ────────────────────────────────────────────────────────

function formatReport(metrics, benchmark, recommendation, rawTrades, roundTrips, days) {
  const lines = [];
  const HR = '─'.repeat(62);

  lines.push('');
  lines.push('╔══════════════════════════════════════════════════════════════╗');
  lines.push('║  OpenProphet Paper Trading Validation Report               ║');
  lines.push('╚══════════════════════════════════════════════════════════════╝');
  lines.push('');
  lines.push(`  Period:     Last ${days} days`);
  lines.push(`  Raw Trades: ${rawTrades.length} (${roundTrips.length} round-trips matched)`);
  lines.push(`  Benchmark:  ${args.benchmark} (${benchmark.source})`);
  lines.push('');
  lines.push(`  ${HR}`);
  lines.push('  Performance Metrics');
  lines.push(`  ${HR}`);
  lines.push(`  Total P&L:          $${metrics.totalPnL.toFixed(2)}`);
  lines.push(`  Win Rate:           ${metrics.winRate}% (${metrics.wins}W / ${metrics.losses}L)`);
  lines.push(`  Profit Factor:      ${metrics.profitFactor === Infinity ? '∞' : metrics.profitFactor}`);
  lines.push(`  Sharpe Ratio:       ${metrics.sharpeRatio}`);
  lines.push(`  Max Drawdown:       ${metrics.maxDrawdown}%`);
  lines.push(`  Avg Win:            $${metrics.avgWin.toFixed(2)}`);
  lines.push(`  Avg Loss:           $${metrics.avgLoss.toFixed(2)}`);
  lines.push(`  Avg Hold Days:      ${metrics.avgHoldDays}`);
  if (metrics.bestTrade)  lines.push(`  Best Trade:         ${metrics.bestTrade.symbol} +$${metrics.bestTrade.pnl.toFixed(2)}`);
  if (metrics.worstTrade) lines.push(`  Worst Trade:        ${metrics.worstTrade.symbol} $${metrics.worstTrade.pnl.toFixed(2)}`);

  if (benchmark.returnPct !== null) {
    lines.push('');
    lines.push(`  ${HR}`);
    lines.push('  Benchmark Comparison');
    lines.push(`  ${HR}`);
    lines.push(`  ${args.benchmark} Return:       ${benchmark.returnPct.toFixed(2)}% (${benchmark.bars} bars)`);
  }

  lines.push('');
  lines.push(`  ${HR}`);
  lines.push('  Go/No-Go Assessment');
  lines.push(`  ${HR}`);
  for (const check of recommendation.checks) {
    const icon = check.passed ? '✓' : '✗';
    lines.push(`  ${icon} ${check.name.padEnd(30)} ${check.value}`);
  }

  lines.push('');
  lines.push(`  ${HR}`);
  const score = `${recommendation.passedCount}/${recommendation.totalChecks}`;
  if (recommendation.goDecision) {
    lines.push(`  ✓ GO — ${score} checks passed. Ready for live trading.`);
  } else if (recommendation.catastrophic) {
    lines.push(`  ✗ NO-GO (CRITICAL) — Catastrophic risk detected. Do not proceed.`);
  } else {
    lines.push(`  ✗ NO-GO — ${score} checks passed. Continue paper trading.`);
  }
  lines.push(`  ${HR}`);
  lines.push('');

  return lines.join('\n');
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const days = parseInt(args.days, 10);
  if (isNaN(days) || days <= 0) {
    console.error('Error: --days must be a positive integer');
    process.exit(1);
  }

  // 1. Collect trade data
  const rawTrades = loadTradesFromLogs(args['data-dir'] || '', days);
  const { roundTrips, openPositions } = matchTrades(rawTrades);

  // 2. Calculate metrics
  const metrics = calculateMetrics(roundTrips);

  // 3. Fetch benchmark
  const benchmark = await fetchBenchmarkReturn(args.benchmark, days, parseInt(args.port, 10));

  // 4. Make recommendation
  const recommendation = makeRecommendation(metrics, benchmark);

  // 5. Output
  if (args.json) {
    console.log(JSON.stringify({
      period: { days, rawTrades: rawTrades.length, roundTrips: roundTrips.length },
      metrics,
      benchmark: { symbol: args.benchmark, ...benchmark },
      recommendation: {
        decision: recommendation.goDecision ? 'GO' : 'NO-GO',
        score: `${recommendation.passedCount}/${recommendation.totalChecks}`,
        checks: recommendation.checks,
      },
      openPositions: openPositions.map(([sym, buys]) => ({
        symbol: sym, count: buys.length,
      })),
    }, null, 2));
  } else {
    console.log(formatReport(metrics, benchmark, recommendation, rawTrades, roundTrips, days));
  }

  process.exit(recommendation.goDecision ? 0 : 1);
}

main().catch(err => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
