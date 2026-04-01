/**
 * perf-analytics.js — Performance analytics engine for OpenProphet trading system.
 *
 * Aggregates trade data into comprehensive metrics the AI agent queries
 * to evaluate its own performance and adjust strategy. Decoupled from
 * data sources — accepts trade arrays, returns structured analytics.
 *
 * @module perf-analytics
 */

// ─── Constants ──────────────────────────────────────────────────────────────

const TRADING_DAYS_PER_YEAR = 252;
const DEFAULT_RISK_FREE_RATE = 0.05;
const DEFAULT_STARTING_EQUITY = 100_000;
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// ─── Type Definitions ───────────────────────────────────────────────────────

/**
 * @typedef {Object} Trade
 * @property {string}  symbol
 * @property {'buy'|'sell'} side
 * @property {number}  entryPrice
 * @property {number}  exitPrice
 * @property {number}  qty
 * @property {number}  pnl         - Realized P&L in dollars
 * @property {string}  date        - ISO date string (YYYY-MM-DD or full ISO)
 * @property {string}  [strategy]  - Strategy name if tagged
 */

/**
 * @typedef {Object} EquityPoint
 * @property {string} date
 * @property {number} equity
 * @property {number} dailyPnl
 * @property {number} cumulativePnl
 */

/**
 * @typedef {Object} DrawdownPeriod
 * @property {string} start
 * @property {string} end
 * @property {number} depth - Peak-to-trough percentage
 */

/**
 * @typedef {Object} DrawdownResult
 * @property {number}           maxDrawdownPct
 * @property {number}           maxDrawdownDollars
 * @property {DrawdownPeriod[]} drawdownPeriods
 */

/**
 * @typedef {Object} BucketMetrics
 * @property {number} trades
 * @property {number} pnl
 * @property {number} winRate
 */

// ─── Helpers ────────────────────────────────────────────────────────────────

/** @param {number} n */
const round2 = (n) => Math.round(n * 100) / 100;

/** Parse date string, throw on invalid. @param {string} s @returns {Date} */
function parseDate(s) {
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) throw new Error(`Invalid date: ${s}`);
  return d;
}

/** @param {string} s @returns {string} YYYY-MM-DD */
function toDateKey(s) { return parseDate(s).toISOString().slice(0, 10); }

/** @param {string} s @returns {string} "2026-W13" */
function toWeekKey(s) {
  const d = parseDate(s);
  const jan1 = new Date(d.getFullYear(), 0, 1);
  const week = Math.ceil(((d - jan1) / 86_400_000 + 1 + jan1.getDay()) / 7);
  return `${d.getFullYear()}-W${String(week).padStart(2, '0')}`;
}

/** @param {string} s @returns {string} "2026-03" */
function toMonthKey(s) { return parseDate(s).toISOString().slice(0, 7); }

/** @param {string} s @returns {number} 0-23 */
function toHour(s) { return parseDate(s).getHours(); }

/** @param {string} s @returns {string} "Mon", "Tue", etc. */
function toDayOfWeek(s) { return DAY_NAMES[parseDate(s).getDay()]; }

/** Return % for a trade based on entry→exit and side. @param {Trade} t */
function tradeReturnPct(t) {
  if (!t.entryPrice || t.entryPrice === 0) return 0;
  const dir = t.side === 'sell' ? -1 : 1;
  return dir * ((t.exitPrice - t.entryPrice) / t.entryPrice) * 100;
}

/** Sample standard deviation. @param {number[]} v */
function stddev(v) {
  if (v.length < 2) return 0;
  const m = v.reduce((s, x) => s + x, 0) / v.length;
  return Math.sqrt(v.reduce((s, x) => s + (x - m) ** 2, 0) / (v.length - 1));
}

/** Downside deviation — stddev of sub-target returns. @param {number[]} v @param {number} target */
function downsideDeviation(v, target = 0) {
  const neg = v.filter((x) => x < target).map((x) => (x - target) ** 2);
  if (neg.length === 0) return 0;
  return Math.sqrt(neg.reduce((s, x) => s + x, 0) / v.length);
}

/** Format USD. @param {number} n */
const usd = (n) => {
  const abs = Math.abs(n);
  const fmt = abs >= 1000
    ? `$${abs.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`
    : `$${abs.toFixed(2)}`;
  return n < 0 ? `-${fmt}` : fmt;
};

/** Format percent with sign. @param {number} n */
const pct = (n) => `${n >= 0 ? '+' : ''}${n.toFixed(1)}%`;

/**
 * Generic groupBy.
 * @template T
 * @param {T[]} arr
 * @param {(item: T) => string} keyFn
 * @returns {Map<string, T[]>}
 */
function groupBy(arr, keyFn) {
  const map = new Map();
  for (const item of arr) {
    const k = keyFn(item);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(item);
  }
  return map;
}

/** Aggregate bucket metrics from trades. @param {Trade[]} trades @returns {BucketMetrics} */
function bucketMetrics(trades) {
  const wins = trades.filter((t) => t.pnl > 0).length;
  return {
    trades: trades.length,
    pnl: round2(trades.reduce((s, t) => s + t.pnl, 0)),
    winRate: trades.length > 0 ? round2(wins / trades.length) : 0,
  };
}

/** Group trades by keyFn and return { [key]: BucketMetrics }. */
function groupAndMetrics(trades, keyFn) {
  const out = {};
  for (const [k, group] of groupBy(trades, keyFn)) out[k] = bucketMetrics(group);
  return out;
}

/** Group trades into time buckets. @returns {{ [key: string]: { pnl: number, trades: number, winRate: number } }} */
function bucketByTime(trades, keyFn) {
  const out = {};
  for (const [k, group] of groupBy(trades, keyFn)) {
    const wins = group.filter((t) => t.pnl > 0).length;
    out[k] = {
      pnl: round2(group.reduce((s, t) => s + t.pnl, 0)),
      trades: group.length,
      winRate: round2(wins / group.length),
    };
  }
  return out;
}

// ─── Core Analytics ─────────────────────────────────────────────────────────

/**
 * Calculate the Sharpe Ratio from daily returns.
 * Annualized: (mean_daily * 252 - riskFreeRate) / (stddev * sqrt(252))
 *
 * @param {number[]} returns        - Daily returns as decimals (0.01 = 1%)
 * @param {number}   [riskFreeRate] - Annual risk-free rate (default 0.05)
 * @returns {number}
 */
export function calculateSharpeRatio(returns, riskFreeRate = DEFAULT_RISK_FREE_RATE) {
  if (returns.length < 2) return 0;
  const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
  const sd = stddev(returns);
  if (sd === 0) return 0;
  return round2((mean * TRADING_DAYS_PER_YEAR - riskFreeRate) / (sd * Math.sqrt(TRADING_DAYS_PER_YEAR)));
}

/**
 * Calculate the Sortino Ratio from daily returns.
 * Same as Sharpe but denominator uses only downside deviation.
 *
 * @param {number[]} returns        - Daily returns as decimals
 * @param {number}   [riskFreeRate] - Annual risk-free rate (default 0.05)
 * @returns {number}
 */
export function calculateSortinoRatio(returns, riskFreeRate = DEFAULT_RISK_FREE_RATE) {
  if (returns.length < 2) return 0;
  const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
  const dd = downsideDeviation(returns);
  if (dd === 0) return 0;
  return round2((mean * TRADING_DAYS_PER_YEAR - riskFreeRate) / (dd * Math.sqrt(TRADING_DAYS_PER_YEAR)));
}

/**
 * Calculate maximum drawdown from an equity curve array.
 * Tracks running peak and measures trough depth.
 *
 * @param {number[]} equityCurve - Equity values over time
 * @returns {DrawdownResult}
 */
export function calculateMaxDrawdown(equityCurve) {
  if (equityCurve.length === 0) {
    return { maxDrawdownPct: 0, maxDrawdownDollars: 0, drawdownPeriods: [] };
  }
  let peak = equityCurve[0], peakIdx = 0, maxDDPct = 0, maxDDDollars = 0;
  const periods = [];
  let inDD = false, ddStart = 0, ddPeakPct = 0;

  for (let i = 0; i < equityCurve.length; i++) {
    const val = equityCurve[i];
    if (val >= peak) {
      if (inDD) {
        periods.push({ start: String(ddStart), end: String(i - 1), depth: round2(ddPeakPct) });
        inDD = false;
      }
      peak = val;
      peakIdx = i;
    } else {
      const ddPct = ((peak - val) / peak) * 100;
      const ddDol = peak - val;
      if (!inDD) { inDD = true; ddStart = peakIdx; ddPeakPct = 0; }
      ddPeakPct = Math.max(ddPeakPct, ddPct);
      if (ddPct > maxDDPct) { maxDDPct = ddPct; maxDDDollars = ddDol; }
    }
  }
  if (inDD) {
    periods.push({ start: String(ddStart), end: String(equityCurve.length - 1), depth: round2(ddPeakPct) });
  }
  return { maxDrawdownPct: round2(maxDDPct), maxDrawdownDollars: round2(maxDDDollars), drawdownPeriods: periods };
}

/**
 * Generate a daily equity curve from trades.
 *
 * @param {Trade[]}  trades
 * @param {number}   [startingEquity] - Default $100,000
 * @returns {EquityPoint[]}
 */
export function generateEquityCurve(trades, startingEquity = DEFAULT_STARTING_EQUITY) {
  if (trades.length === 0) return [];
  const dailyPnl = new Map();
  for (const t of trades) {
    const k = toDateKey(t.date);
    dailyPnl.set(k, (dailyPnl.get(k) || 0) + t.pnl);
  }
  const dates = [...dailyPnl.keys()].sort();
  const curve = [];
  let equity = startingEquity, cumPnl = 0;
  for (const date of dates) {
    const pnl = round2(dailyPnl.get(date));
    equity = round2(equity + pnl);
    cumPnl = round2(cumPnl + pnl);
    curve.push({ date, equity, dailyPnl: pnl, cumulativePnl: cumPnl });
  }
  return curve;
}

// ─── Streaks ────────────────────────────────────────────────────────────────

/**
 * Calculate win/loss streaks from chronologically sorted trades.
 * @param {Trade[]} trades
 * @returns {{ currentStreak: { type: 'win'|'loss', count: number }, longestWinStreak: number, longestLossStreak: number }}
 */
function calculateStreaks(trades) {
  let longestWin = 0, longestLoss = 0, curWin = 0, curLoss = 0;
  for (const t of trades) {
    if (t.pnl > 0) { curWin++; curLoss = 0; longestWin = Math.max(longestWin, curWin); }
    else if (t.pnl < 0) { curLoss++; curWin = 0; longestLoss = Math.max(longestLoss, curLoss); }
    // break-even: no streak change
  }
  const currentStreak = curWin > 0
    ? { type: /** @type {const} */ ('win'), count: curWin }
    : { type: /** @type {const} */ ('loss'), count: curLoss };
  return { currentStreak, longestWinStreak: longestWin, longestLossStreak: longestLoss };
}

// ─── Main Performance Metrics ───────────────────────────────────────────────

/**
 * Calculate comprehensive performance metrics from an array of trades.
 *
 * @param {Trade[]} trades
 * @returns {Object} Full metrics — see module docs for shape
 */
export function calculatePerformanceMetrics(trades) {
  if (trades.length === 0) return emptyMetrics();

  const sorted = [...trades].sort((a, b) => parseDate(a.date) - parseDate(b.date));

  // ── Core ──
  const winners = sorted.filter((t) => t.pnl > 0);
  const losers = sorted.filter((t) => t.pnl < 0);
  const grossWins = winners.reduce((s, t) => s + t.pnl, 0);
  const grossLosses = Math.abs(losers.reduce((s, t) => s + t.pnl, 0));
  const winRate = winners.length / sorted.length;

  const winPcts = winners.map(tradeReturnPct);
  const lossPcts = losers.map(tradeReturnPct);
  const avgWinPct = winPcts.length > 0 ? winPcts.reduce((s, v) => s + v, 0) / winPcts.length : 0;
  const avgLossPct = lossPcts.length > 0 ? Math.abs(lossPcts.reduce((s, v) => s + v, 0) / lossPcts.length) : 0;

  const profitFactor = grossLosses === 0
    ? (grossWins > 0 ? Infinity : 0)
    : grossWins / grossLosses;

  const totalPnl = sorted.reduce((s, t) => s + t.pnl, 0);
  const expectancy = totalPnl / sorted.length;
  const allPcts = sorted.map(tradeReturnPct);
  const expectancyPct = allPcts.reduce((s, v) => s + v, 0) / allPcts.length;

  // ── Risk ──
  const curve = generateEquityCurve(sorted);
  const eqVals = curve.map((p) => p.equity);
  const dd = calculateMaxDrawdown(eqVals);

  const dailyReturns = [];
  for (let i = 1; i < curve.length; i++) {
    const prev = curve[i - 1].equity;
    if (prev !== 0) dailyReturns.push((curve[i].equity - prev) / prev);
  }
  const sharpe = calculateSharpeRatio(dailyReturns);
  const sortino = calculateSortinoRatio(dailyReturns);

  const totalDays = Math.max(1, (parseDate(sorted.at(-1).date) - parseDate(sorted[0].date)) / 86_400_000);
  const startEq = curve.length > 0 ? curve[0].equity - curve[0].dailyPnl : DEFAULT_STARTING_EQUITY;
  const totalRetPct = ((eqVals.at(-1) - startEq) / startEq) * 100;
  const annReturn = (totalRetPct / totalDays) * 365;
  const calmar = dd.maxDrawdownPct > 0 ? round2(annReturn / dd.maxDrawdownPct) : 0;

  const ddDurations = dd.drawdownPeriods.map((p) => Number(p.end) - Number(p.start) + 1);
  const avgDDDuration = ddDurations.length > 0
    ? round2(ddDurations.reduce((s, d) => s + d, 0) / ddDurations.length)
    : 0;

  // ── Streaks ──
  const streaks = calculateStreaks(sorted);

  // ── Time Buckets ──
  const daily = bucketByTime(sorted, (t) => toDateKey(t.date));
  const weekly = bucketByTime(sorted, (t) => toWeekKey(t.date));
  const monthly = bucketByTime(sorted, (t) => toMonthKey(t.date));

  let bestDay = { date: '', pnl: -Infinity };
  let worstDay = { date: '', pnl: Infinity };
  for (const [date, data] of Object.entries(daily)) {
    if (data.pnl > bestDay.pnl) bestDay = { date, pnl: data.pnl };
    if (data.pnl < worstDay.pnl) worstDay = { date, pnl: data.pnl };
  }
  if (bestDay.pnl === -Infinity) bestDay = { date: '', pnl: 0 };
  if (worstDay.pnl === Infinity) worstDay = { date: '', pnl: 0 };

  // ── Category Buckets ──
  const bySymbol = groupAndMetrics(sorted, (t) => t.symbol);
  const byStrategy = groupAndMetrics(sorted, (t) => t.strategy || 'untagged');
  const bySide = groupAndMetrics(sorted, (t) => t.side);
  const byDayOfWeek = groupAndMetrics(sorted, (t) => toDayOfWeek(t.date));
  const byHour = groupAndMetrics(sorted, (t) => String(toHour(t.date)));

  // Attach sharpe per strategy
  for (const [strat, group] of groupBy(sorted, (t) => t.strategy || 'untagged')) {
    const sc = generateEquityCurve(group);
    const sr = [];
    for (let i = 1; i < sc.length; i++) {
      const prev = sc[i - 1].equity;
      if (prev !== 0) sr.push((sc[i].equity - prev) / prev);
    }
    if (byStrategy[strat]) byStrategy[strat].sharpe = calculateSharpeRatio(sr);
  }

  return {
    totalTrades: sorted.length, winners: winners.length, losers: losers.length,
    winRate: round2(winRate), avgWinPct: round2(avgWinPct), avgLossPct: round2(avgLossPct),
    profitFactor: profitFactor === Infinity ? Infinity : round2(profitFactor),
    expectancy: round2(expectancy), expectancyPct: round2(expectancyPct),
    sharpeRatio: sharpe, sortinoRatio: sortino,
    maxDrawdownPct: dd.maxDrawdownPct, maxDrawdownDollars: dd.maxDrawdownDollars,
    calmarRatio: calmar, avgDrawdownDuration: avgDDDuration,
    currentStreak: streaks.currentStreak,
    longestWinStreak: streaks.longestWinStreak, longestLossStreak: streaks.longestLossStreak,
    daily, weekly, monthly, bestDay, worstDay,
    bySymbol, byStrategy, bySide, byDayOfWeek, byHour,
  };
}

/** Return an empty metrics skeleton for zero-trade input. */
function emptyMetrics() {
  return {
    totalTrades: 0, winners: 0, losers: 0, winRate: 0,
    avgWinPct: 0, avgLossPct: 0, profitFactor: 0, expectancy: 0, expectancyPct: 0,
    sharpeRatio: 0, sortinoRatio: 0,
    maxDrawdownPct: 0, maxDrawdownDollars: 0, calmarRatio: 0, avgDrawdownDuration: 0,
    currentStreak: { type: 'win', count: 0 },
    longestWinStreak: 0, longestLossStreak: 0,
    daily: {}, weekly: {}, monthly: {},
    bestDay: { date: '', pnl: 0 }, worstDay: { date: '', pnl: 0 },
    bySymbol: {}, byStrategy: {}, bySide: {}, byDayOfWeek: {}, byHour: {},
  };
}

// ─── Report Generation ──────────────────────────────────────────────────────

/**
 * Generate a human-readable performance report string.
 *
 * @param {Trade[]}  trades
 * @param {number}   [startingEquity] - Default $100,000
 * @returns {string}
 */
export function generatePerformanceReport(trades, startingEquity = DEFAULT_STARTING_EQUITY) {
  if (trades.length === 0) return '═══ PERFORMANCE REPORT ═══\nNo trades to analyze.';

  const m = calculatePerformanceMetrics(trades);
  const curve = generateEquityCurve(trades, startingEquity);
  const curEq = curve.length > 0 ? curve.at(-1).equity : startingEquity;
  const retPct = ((curEq - startingEquity) / startingEquity) * 100;

  const sorted = [...trades].sort((a, b) => parseDate(a.date) - parseDate(b.date));
  const firstDate = toDateKey(sorted[0].date);
  const lastDate = toDateKey(sorted.at(-1).date);
  const daySpan = Math.max(1, Math.round((parseDate(lastDate) - parseDate(firstDate)) / 86_400_000));

  const symEntries = Object.entries(m.bySymbol).sort(([, a], [, b]) => b.pnl - a.pnl);
  const topPerf = symEntries.filter((s) => s[1].pnl > 0).slice(0, 3)
    .map(([s, d]) => `${s} (${usd(d.pnl)})`).join(', ') || '(none)';
  const worstPerf = symEntries.filter((s) => s[1].pnl < 0).slice(-3).reverse()
    .map(([s, d]) => `${s} (${usd(d.pnl)})`).join(', ') || '(none)';

  const streakStr = m.currentStreak.count > 0
    ? `${m.currentStreak.count}-trade ${m.currentStreak.type} streak`
    : 'No active streak';
  const pfStr = m.profitFactor === Infinity ? '∞' : m.profitFactor.toFixed(2);

  return [
    '═══ PERFORMANCE REPORT ═══',
    `Period: ${firstDate} to ${lastDate} (${daySpan} days)`,
    `Starting Equity: ${usd(startingEquity)} → Current: ${usd(curEq)} (${pct(retPct)})`,
    '',
    `Win Rate:      ${(m.winRate * 100).toFixed(1)}% (${m.winners}W / ${m.losers}L)`,
    `Profit Factor: ${pfStr}`,
    `Expectancy:    ${m.expectancy >= 0 ? '+' : ''}${usd(m.expectancy)}/trade`,
    `Sharpe Ratio:  ${m.sharpeRatio.toFixed(2)}`,
    `Sortino Ratio: ${m.sortinoRatio.toFixed(2)}`,
    `Max Drawdown:  ${pct(-m.maxDrawdownPct)} (${usd(m.maxDrawdownDollars)})`,
    '',
    `Best Day:  +${usd(m.bestDay.pnl)} (${m.bestDay.date})`,
    `Worst Day: ${usd(m.worstDay.pnl)} (${m.worstDay.date})`,
    `Current:   ${streakStr}`,
    '',
    `Top Performers: ${topPerf}`,
    `Worst: ${worstPerf}`,
  ].join('\n');
}

// ─── MCP Tool Integration ───────────────────────────────────────────────────

/**
 * Return the MCP tool definition for the performance report tool.
 * @returns {Object}
 */
export function getPerformanceToolDefinition() {
  return {
    name: 'get_performance_report',
    description:
      'Get comprehensive trading performance analytics: win rate, Sharpe ratio, drawdown, ' +
      'P&L curve, performance by symbol/strategy/time. Use to evaluate and improve trading decisions.',
    inputSchema: {
      type: 'object',
      properties: {
        period: {
          type: 'string',
          description: "Time period: 'today', 'week', 'month', 'quarter', 'year', 'all'",
        },
        strategy: { type: 'string', description: 'Filter by strategy name' },
        symbol: { type: 'string', description: 'Filter by symbol' },
        format: {
          type: 'string',
          enum: ['summary', 'detailed', 'json'],
          description: 'Output format',
        },
      },
    },
  };
}

/**
 * Get start-of-period Date for a filter string.
 * @param {string} period
 * @returns {Date}
 */
function periodStartDate(period) {
  const now = new Date();
  const d = new Date(now);
  switch (period) {
    case 'today':   d.setHours(0, 0, 0, 0); return d;
    case 'week':    d.setDate(d.getDate() - 7); d.setHours(0, 0, 0, 0); return d;
    case 'month':   d.setMonth(d.getMonth() - 1); d.setHours(0, 0, 0, 0); return d;
    case 'quarter': d.setMonth(d.getMonth() - 3); d.setHours(0, 0, 0, 0); return d;
    case 'year':    d.setFullYear(d.getFullYear() - 1); d.setHours(0, 0, 0, 0); return d;
    default:        return new Date(0); // 'all' or unknown
  }
}

/**
 * MCP handler for get_performance_report.
 * Filters trades by period/strategy/symbol, runs analytics, returns formatted.
 *
 * @param {{ period?: string, strategy?: string, symbol?: string, format?: string }} args
 * @param {Trade[]}  trades
 * @param {number}   [startingEquity] - Default $100,000
 * @returns {{ content: { type: string, text: string }[], isError?: boolean }}
 */
export function handlePerformanceToolCall(args, trades, startingEquity = DEFAULT_STARTING_EQUITY) {
  try {
    let filtered = [...trades];

    // Period filter
    if (args.period && args.period !== 'all') {
      const cutoff = periodStartDate(args.period);
      filtered = filtered.filter((t) => parseDate(t.date) >= cutoff);
    }
    // Strategy filter
    if (args.strategy) {
      const s = args.strategy.toLowerCase();
      filtered = filtered.filter((t) => (t.strategy || '').toLowerCase() === s);
    }
    // Symbol filter
    if (args.symbol) {
      const s = args.symbol.toUpperCase();
      filtered = filtered.filter((t) => t.symbol.toUpperCase() === s);
    }

    if (filtered.length === 0) {
      return {
        content: [{
          type: 'text',
          text: `No trades found (period: ${args.period || 'all'}, strategy: ${args.strategy || 'any'}, symbol: ${args.symbol || 'any'}).`,
        }],
      };
    }

    const format = args.format || 'summary';

    // JSON format — raw metrics object
    if (format === 'json') {
      const metrics = calculatePerformanceMetrics(filtered);
      return { content: [{ type: 'text', text: JSON.stringify(metrics, null, 2) }] };
    }

    // Detailed format — report + breakdowns
    if (format === 'detailed') {
      const metrics = calculatePerformanceMetrics(filtered);
      const report = generatePerformanceReport(filtered, startingEquity);
      const curve = generateEquityCurve(filtered, startingEquity);

      const sections = [
        report, '',
        '─── BY SYMBOL ───',
        ...Object.entries(metrics.bySymbol).sort(([, a], [, b]) => b.pnl - a.pnl)
          .map(([s, d]) => `  ${s.padEnd(6)} ${String(d.trades).padStart(3)} trades  ${usd(d.pnl).padStart(10)}  WR: ${(d.winRate * 100).toFixed(0)}%`),
        '',
        '─── BY STRATEGY ───',
        ...Object.entries(metrics.byStrategy).sort(([, a], [, b]) => b.pnl - a.pnl)
          .map(([s, d]) => `  ${s.padEnd(14)} ${String(d.trades).padStart(3)} trades  ${usd(d.pnl).padStart(10)}  WR: ${(d.winRate * 100).toFixed(0)}%  Sharpe: ${(d.sharpe ?? 0).toFixed(2)}`),
        '',
        '─── BY DAY OF WEEK ───',
        ...['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].map((day) => {
          const d = metrics.byDayOfWeek[day];
          return d
            ? `  ${day}  ${String(d.trades).padStart(3)} trades  ${usd(d.pnl).padStart(10)}  WR: ${(d.winRate * 100).toFixed(0)}%`
            : `  ${day}  —  no trades`;
        }),
        '',
        '─── EQUITY CURVE (last 10) ───',
        ...curve.slice(-10).map((p) =>
          `  ${p.date}  ${usd(p.equity).padStart(10)}  day: ${p.dailyPnl >= 0 ? '+' : ''}${usd(p.dailyPnl)}`),
      ];
      return { content: [{ type: 'text', text: sections.join('\n') }] };
    }

    // Summary format (default)
    return { content: [{ type: 'text', text: generatePerformanceReport(filtered, startingEquity) }] };
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Error generating performance report: ${err.message}` }],
      isError: true,
    };
  }
}

// ─── Default Export ─────────────────────────────────────────────────────────

export default {
  calculatePerformanceMetrics,
  calculateSharpeRatio,
  calculateSortinoRatio,
  calculateMaxDrawdown,
  generateEquityCurve,
  generatePerformanceReport,
  getPerformanceToolDefinition,
  handlePerformanceToolCall,
};
