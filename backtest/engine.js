/**
 * OpenProphet Backtest Engine
 *
 * Loads a strategy JSON, fetches (or reads) historical bars, and simulates
 * trading through them chronologically. Outputs metrics as JSON.
 *
 * Designed to work standalone (--data-file) or against the Go backend.
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STRATEGIES_DIR = resolve(__dirname, '..', 'strategies');

// ─── Technical Indicators ────────────────────────────────────────────────────

/**
 * Simple Moving Average over `period` bars.
 * Returns array same length as input; first (period-1) entries are null.
 */
export function sma(values, period) {
  const out = [];
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    out.push(i >= period - 1 ? sum / period : null);
  }
  return out;
}

/**
 * Wilder-smoothed RSI. Returns array same length as input.
 */
export function rsi(closes, period = 14) {
  const out = [null];
  let avgGain = 0;
  let avgLoss = 0;

  for (let i = 1; i < closes.length; i++) {
    const delta = closes[i] - closes[i - 1];
    if (i <= period) {
      if (delta > 0) avgGain += delta;
      else avgLoss -= delta;

      if (i === period) {
        avgGain /= period;
        avgLoss /= period;
        out.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss));
      } else {
        out.push(null);
      }
    } else {
      avgGain = (avgGain * (period - 1) + Math.max(delta, 0)) / period;
      avgLoss = (avgLoss * (period - 1) + Math.max(-delta, 0)) / period;
      out.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss));
    }
  }
  return out;
}

/**
 * MACD line (fast EMA - slow EMA). Returns array same length as input.
 */
export function macd(closes, fast = 12, slow = 26) {
  const emaFast = ema(closes, fast);
  const emaSlow = ema(closes, slow);
  return closes.map((_, i) =>
    emaFast[i] != null && emaSlow[i] != null ? emaFast[i] - emaSlow[i] : null,
  );
}

function ema(values, period) {
  const out = [];
  const k = 2 / (period + 1);
  let prev = null;
  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) {
      out.push(null);
    } else if (prev == null) {
      // Seed with SMA of first `period` values
      let sum = 0;
      for (let j = i - period + 1; j <= i; j++) sum += values[j];
      prev = sum / period;
      out.push(prev);
    } else {
      prev = values[i] * k + prev * (1 - k);
      out.push(prev);
    }
  }
  return out;
}

// ─── Normalise Bars ──────────────────────────────────────────────────────────

/**
 * Accept bars in any format the Go backend might return (Alpaca-style short
 * keys, Go-style capitalised keys, or our internal format) and normalise
 * to a flat array sorted chronologically.
 */
export function normaliseBars(raw) {
  const list = Array.isArray(raw) ? raw : raw?.bars ?? raw?.data ?? [];

  const bars = list
    .map((b) => ({
      timestamp: b.t ?? b.Timestamp ?? b.timestamp ?? '',
      open: parseFloat(b.o ?? b.Open ?? b.open ?? 0),
      high: parseFloat(b.h ?? b.High ?? b.high ?? 0),
      low: parseFloat(b.l ?? b.Low ?? b.low ?? 0),
      close: parseFloat(b.c ?? b.Close ?? b.close ?? 0),
      volume: parseFloat(b.v ?? b.Volume ?? b.volume ?? 0),
    }))
    .filter((b) => b.close > 0);

  bars.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  return bars;
}

// ─── Strategy Rule Extraction ────────────────────────────────────────────────

/**
 * Read a strategy JSON and extract the parameters the engine cares about.
 * Handles all 6 strategy shapes in the repo.
 */
export function extractRules(strategy) {
  const rules = strategy.rules ?? {};
  const rg = strategy.riskGuard ?? {};

  // Stop-loss: different strategies store it differently
  let stopLoss = rules.stopLoss ?? rules.options?.stopLoss ?? rules.crypto?.stopLoss ?? 0.35;
  if (typeof stopLoss !== 'number') stopLoss = 0.35;

  // Profit targets
  let takeProfitPct;
  const pt = rules.profitTarget ?? rules.options?.profitTarget ?? rules.crypto?.profitTarget;
  if (pt) {
    takeProfitPct = pt.hardExit ?? pt.stretch ?? pt.target ?? pt.strongClose ?? 0.50;
  } else {
    takeProfitPct = 0.50;
  }

  // Technical confirmations needed
  const tc = rules.technicalConfirmations ?? {};
  const requiredConfirmations =
    tc.required === 'all' ? 99 : typeof tc.required === 'number' ? tc.required : 2;
  const signals = tc.signals ?? ['rsi', 'macd', 'price_action'];

  // RSI thresholds
  const rsiOversold = rules.rsiThresholds?.oversold ?? 30;
  const rsiOverbought = rules.rsiThresholds?.overbought ?? 70;

  // Position sizing
  const maxPositionPct = (rg.maxPositionPct ?? 30) / 100;

  return {
    stopLoss,
    takeProfitPct,
    requiredConfirmations,
    signals,
    rsiOversold,
    rsiOverbought,
    maxPositionPct,
  };
}

// ─── Signal Generation ───────────────────────────────────────────────────────

/**
 * Count how many technical confirmations are met for a BUY at bar index `i`.
 */
export function countBuySignals(i, indicators, rules) {
  let count = 0;
  const { rsiValues, macdValues, sma20, closes } = indicators;

  for (const signal of rules.signals) {
    switch (signal) {
      case 'rsi':
      case 'rsi_extreme':
        if (rsiValues[i] != null && rsiValues[i] < rules.rsiOversold) count++;
        break;
      case 'macd':
      case 'macd_multi_timeframe':
        if (
          macdValues[i] != null &&
          macdValues[i - 1] != null &&
          macdValues[i] > 0 &&
          macdValues[i - 1] <= 0
        )
          count++;
        break;
      case 'price_action':
        if (sma20[i] != null && closes[i] > sma20[i]) count++;
        break;
      case 'volume_spike':
        // Handled externally — always grant if present in signal list
        count++;
        break;
    }
  }
  return count;
}

/**
 * Check if any EXIT condition is met at bar index `i`.
 */
export function shouldExit(i, entryPrice, indicators, rules) {
  const { closes, rsiValues } = indicators;
  const price = closes[i];

  // Stop-loss: price dropped by stopLoss % from entry (highest priority)
  if (price <= entryPrice * (1 - rules.stopLoss)) {
    return { reason: 'stop-loss', price };
  }

  // Take-profit: price rose by takeProfitPct % from entry (check before RSI)
  if (price >= entryPrice * (1 + rules.takeProfitPct)) {
    return { reason: 'take-profit', price };
  }

  // RSI overbought exit (only when NOT already at take-profit level)
  if (rsiValues[i] != null && rsiValues[i] > rules.rsiOverbought) {
    return { reason: 'rsi-overbought', price };
  }

  return null;
}

// ─── Core Backtest Engine ────────────────────────────────────────────────────

/**
 * Run a backtest simulation.
 *
 * @param {object} opts
 * @param {object} opts.strategy  - Parsed strategy JSON
 * @param {Array}  opts.bars      - Normalised bar array
 * @param {number} opts.capital   - Starting capital (default 10000)
 * @returns {object} Results with metrics and trade log
 */
export function runBacktest({ strategy, bars, capital = 10_000 }) {
  if (!bars || bars.length === 0) {
    return {
      symbol: strategy?.symbols?.primary?.[0] ?? 'UNKNOWN',
      strategy: strategy?.id ?? 'unknown',
      startDate: null,
      endDate: null,
      initialCapital: capital,
      finalCapital: capital,
      totalReturn: 0,
      totalPnL: 0,
      sharpeRatio: 0,
      maxDrawdown: 0,
      winRate: 0,
      avgWin: 0,
      avgLoss: 0,
      totalTrades: 0,
      trades: [],
      error: bars ? undefined : 'No bar data provided',
    };
  }

  const rules = extractRules(strategy);
  const closes = bars.map((b) => b.close);

  // Pre-compute indicators (need at least 26 bars for MACD)
  const WARMUP = 26;
  const rsiValues = rsi(closes, 14);
  const macdValues = macd(closes, 12, 26);
  const sma20 = sma(closes, 20);
  const indicators = { rsiValues, macdValues, sma20, closes };

  let cash = capital;
  let shares = 0;
  let entryPrice = 0;
  let entryIndex = -1;
  const trades = [];
  const equityCurve = [capital];

  const startIndex = Math.min(WARMUP, bars.length);

  for (let i = startIndex; i < bars.length; i++) {
    const price = closes[i];

    if (shares === 0) {
      // ── Check BUY signals ──
      const signalCount = countBuySignals(i, indicators, rules);
      if (signalCount >= rules.requiredConfirmations) {
        // Position sizing: use maxPositionPct of current capital
        const maxSpend = cash * rules.maxPositionPct;
        shares = Math.floor(maxSpend / price);
        if (shares > 0) {
          entryPrice = price;
          entryIndex = i;
          cash -= shares * price;
        }
      }
    } else {
      // ── Check EXIT conditions ──
      const exit = shouldExit(i, entryPrice, indicators, rules);
      if (exit) {
        const pnl = (exit.price - entryPrice) * shares;
        trades.push({
          entryDate: bars[entryIndex].timestamp,
          exitDate: bars[i].timestamp,
          entryPrice,
          exitPrice: exit.price,
          shares,
          pnl,
          returnPct: ((exit.price - entryPrice) / entryPrice) * 100,
          reason: exit.reason,
          holdBars: i - entryIndex,
        });
        cash += shares * exit.price;
        shares = 0;
      }
    }

    // Track equity curve (mark-to-market)
    equityCurve.push(cash + shares * price);
  }

  // Close any open position at last bar
  if (shares > 0) {
    const lastPrice = closes[closes.length - 1];
    const pnl = (lastPrice - entryPrice) * shares;
    trades.push({
      entryDate: bars[entryIndex].timestamp,
      exitDate: bars[bars.length - 1].timestamp,
      entryPrice,
      exitPrice: lastPrice,
      shares,
      pnl,
      returnPct: ((lastPrice - entryPrice) / entryPrice) * 100,
      reason: 'end-of-data',
      holdBars: bars.length - 1 - entryIndex,
    });
    cash += shares * lastPrice;
    shares = 0;
  }

  // ── Compute metrics ────────────────────────────────────────────────────
  const finalCapital = cash;
  const totalPnL = finalCapital - capital;
  const totalReturn = (totalPnL / capital) * 100;

  // Win/loss stats
  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl <= 0);
  const winRate = trades.length > 0 ? (wins.length / trades.length) * 100 : 0;
  const avgWin = wins.length > 0 ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length : 0;
  const avgLoss = losses.length > 0 ? losses.reduce((s, t) => s + t.pnl, 0) / losses.length : 0;

  // Max drawdown from equity curve
  let peak = equityCurve[0];
  let maxDrawdown = 0;
  for (const equity of equityCurve) {
    if (equity > peak) peak = equity;
    const dd = peak > 0 ? ((peak - equity) / peak) * 100 : 0;
    if (dd > maxDrawdown) maxDrawdown = dd;
  }

  // Sharpe ratio (annualised, assuming 252 trading days)
  const TRADING_DAYS = 252;
  const returns = [];
  for (let i = 1; i < equityCurve.length; i++) {
    returns.push((equityCurve[i] - equityCurve[i - 1]) / equityCurve[i - 1]);
  }
  const meanReturn = returns.length > 0 ? returns.reduce((a, b) => a + b, 0) / returns.length : 0;
  const stdReturn =
    returns.length > 1
      ? Math.sqrt(returns.reduce((s, r) => s + (r - meanReturn) ** 2, 0) / (returns.length - 1))
      : 0;
  const sharpeRatio = stdReturn > 0 ? (meanReturn / stdReturn) * Math.sqrt(TRADING_DAYS) : 0;

  return {
    symbol: strategy?.symbols?.primary?.[0] ?? 'UNKNOWN',
    strategy: strategy?.id ?? 'unknown',
    startDate: bars[0].timestamp,
    endDate: bars[bars.length - 1].timestamp,
    barsProcessed: bars.length,
    initialCapital: capital,
    finalCapital: round2(finalCapital),
    totalReturn: round2(totalReturn),
    totalPnL: round2(totalPnL),
    sharpeRatio: round2(sharpeRatio),
    maxDrawdown: round2(maxDrawdown),
    winRate: round2(winRate),
    avgWin: round2(avgWin),
    avgLoss: round2(avgLoss),
    totalTrades: trades.length,
    trades: trades.map((t) => ({
      ...t,
      pnl: round2(t.pnl),
      returnPct: round2(t.returnPct),
      entryPrice: round2(t.entryPrice),
      exitPrice: round2(t.exitPrice),
    })),
  };
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

// ─── Data Loading ────────────────────────────────────────────────────────────

/**
 * Load bars from a local JSON file.
 */
export function loadBarsFromFile(filePath) {
  const raw = JSON.parse(readFileSync(resolve(filePath), 'utf-8'));
  return normaliseBars(raw);
}

/**
 * Fetch bars from the Go backend API.
 */
export async function fetchBarsFromAPI(symbol, start, end, timeframe = '1Day', port = 4534) {
  const url = `http://localhost:${port}/api/v1/market/bars/${symbol}?start=${start}&end=${end}&timeframe=${timeframe}`;
  const resp = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!resp.ok) {
    throw new Error(`API returned ${resp.status}: ${await resp.text()}`);
  }
  const raw = await resp.json();
  return normaliseBars(raw);
}

/**
 * Load a strategy JSON by ID from the strategies/ directory.
 */
export function loadStrategy(strategyId) {
  const filePath = resolve(STRATEGIES_DIR, `${strategyId}.json`);
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch (err) {
    throw new Error(
      `Strategy "${strategyId}" not found at ${filePath}. ` +
        `Available: options-conservative, options-momentum, crypto-scalper, crypto-dca, crypto-grid, hybrid-balanced`,
    );
  }
}
