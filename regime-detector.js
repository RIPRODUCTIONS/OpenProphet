/**
 * regime-detector.js — Market Regime Classification for OpenProphet
 *
 * Classifies market environment into regimes (bull/bear/chop/crash/recovery)
 * using price data, volatility, and breadth indicators. The AI agent calls
 * this at session start to adjust strategy selection.
 *
 * Pure math — no external dependencies.
 */

// ─── Constants ──────────────────────────────────────────────────────────────

const TRADING_DAYS_PER_YEAR = 252;
const LOG_RETURN_ANNUALIZER = Math.sqrt(TRADING_DAYS_PER_YEAR);
const MIN_BARS_REQUIRED = 200;

const VIX_PROXY_MULTIPLIER = 1.2;
const VIX_EXTREME_THRESHOLD = 30;
const HV_EXTREME_THRESHOLD = 0.40;

const VOL_LOW_CEILING = 0.12;
const VOL_NORMAL_CEILING = 0.20;
const VOL_HIGH_CEILING = 0.35;

const RSI_OVERSOLD = 30;
const RSI_OVERBOUGHT = 70;

const TREND_FLAT_THRESHOLD = 0.003; // ±0.3% from SMA counts as "at" the SMA
const ADX_WEAK = 20;
const ADX_STRONG = 40;

/** Strategy preset IDs — must match strategies/*.json */
const STRATEGY_IDS = {
  MOMENTUM: 'options-momentum',
  BALANCED: 'hybrid-balanced',
  CONSERVATIVE: 'options-conservative',
  GRID: 'crypto-grid',
  DCA: 'crypto-dca',
  SCALPER: 'crypto-scalper',
};

// ─── Utility Helpers ────────────────────────────────────────────────────────

/** @param {number} val @param {number} min @param {number} max @returns {number} */
function clamp(val, min, max) { return Math.max(min, Math.min(max, val)); }

/** @param {number} val @param {number} [decimals=2] @returns {number} */
function round(val, decimals = 2) { const f = 10 ** decimals; return Math.round(val * f) / f; }

/** @param {Array<{c: number}>} bars @returns {number[]} */
function closes(bars) { return bars.map((b) => b.c); }

/** @param {number[]} prices @returns {number[]} */
function logReturns(prices) {
  const out = [];
  for (let i = 1; i < prices.length; i++) out.push(Math.log(prices[i] / prices[i - 1]));
  return out;
}

/** @param {number[]} arr @returns {number} */
function mean(arr) { return arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : 0; }

/** @param {number[]} arr @returns {number} Population stddev. */
function stddev(arr) {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / arr.length);
}

/** @param {number} value @param {number[]} data @returns {number} 0–100 percentile rank */
function percentileRank(value, data) {
  if (!data.length) return 50;
  const sorted = [...data].sort((a, b) => a - b);
  let count = 0;
  for (const v of sorted) if (v < value) count++;
  return round((count / sorted.length) * 100);
}

// ─── Technical Indicator Calculations ───────────────────────────────────────

/**
 * Simple Moving Average of close prices.
 *
 * @param {Array<{c: number}>} bars - OHLCV bars
 * @param {number} period - lookback window
 * @returns {number} SMA value (most recent window)
 */
export function calculateSMA(bars, period) {
  if (bars.length < period) return NaN;
  const slice = bars.slice(-period);
  return round(mean(closes(slice)), 4);
}

/**
 * Relative Strength Index (Wilder's smoothed).
 *
 *   RSI = 100 - (100 / (1 + RS))
 *   RS  = smoothed avg gain / smoothed avg loss
 *
 * @param {Array<{c: number}>} bars - OHLCV bars (need period + 1 minimum)
 * @param {number} [period=14]
 * @returns {number} RSI value 0–100
 */
export function calculateRSI(bars, period = 14) {
  const prices = closes(bars);
  if (prices.length < period + 1) return NaN;

  const deltas = [];
  for (let i = 1; i < prices.length; i++) {
    deltas.push(prices[i] - prices[i - 1]);
  }

  // Seed: simple average of first `period` changes
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 0; i < period; i++) {
    if (deltas[i] > 0) avgGain += deltas[i];
    else avgLoss += Math.abs(deltas[i]);
  }
  avgGain /= period;
  avgLoss /= period;

  // Wilder smoothing for the rest
  for (let i = period; i < deltas.length; i++) {
    const gain = deltas[i] > 0 ? deltas[i] : 0;
    const loss = deltas[i] < 0 ? Math.abs(deltas[i]) : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return round(100 - 100 / (1 + rs));
}

/**
 * MACD — Moving Average Convergence/Divergence.
 *
 * Uses EMA(fast) - EMA(slow) for the MACD line, then EMA(signal) of that.
 *
 * @param {Array<{c: number}>} bars
 * @param {number} [fast=12]
 * @param {number} [slow=26]
 * @param {number} [signalPeriod=9]
 * @returns {{ macd: number, signal: number, histogram: number }}
 */
export function calculateMACD(bars, fast = 12, slow = 26, signalPeriod = 9) {
  const prices = closes(bars);
  if (prices.length < slow + signalPeriod) {
    return { macd: NaN, signal: NaN, histogram: NaN };
  }

  const emaFast = calcEMA(prices, fast);
  const emaSlow = calcEMA(prices, slow);

  // Align: both arrays end at the same bar; trim to shorter length
  const len = Math.min(emaFast.length, emaSlow.length);
  const macdLine = [];
  for (let i = 0; i < len; i++) {
    const fi = emaFast.length - len + i;
    const si = emaSlow.length - len + i;
    macdLine.push(emaFast[fi] - emaSlow[si]);
  }

  const signalLine = calcEMA(macdLine, signalPeriod);
  const macd = macdLine[macdLine.length - 1];
  const sig = signalLine[signalLine.length - 1];

  return {
    macd: round(macd, 4),
    signal: round(sig, 4),
    histogram: round(macd - sig, 4),
  };
}

/** EMA helper. Seed with SMA, then smooth. @returns {number[]} */
function calcEMA(data, period) {
  if (data.length < period) return [];
  const k = 2 / (period + 1);
  let ema = mean(data.slice(0, period));
  const result = [ema];
  for (let i = period; i < data.length; i++) { ema = data[i] * k + ema * (1 - k); result.push(ema); }
  return result;
}

/**
 * Average Directional Index — trend strength (0–100). Wilder smoothed +DI/-DI.
 * @param {Array<{h: number, l: number, c: number}>} bars
 * @param {number} [period=14]
 * @returns {number}
 */
export function calculateADX(bars, period = 14) {
  if (bars.length < period * 2 + 1) return NaN;
  const trList = [], plusDM = [], minusDM = [];

  for (let i = 1; i < bars.length; i++) {
    const curr = bars[i], prev = bars[i - 1];
    trList.push(Math.max(curr.h - curr.l, Math.abs(curr.h - prev.c), Math.abs(curr.l - prev.c)));
    const upMove = curr.h - prev.h, downMove = prev.l - curr.l;
    plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0);
  }

  const smooth = (arr) => {
    const out = [arr.slice(0, period).reduce((a, b) => a + b, 0)];
    for (let i = period; i < arr.length; i++) out.push(out[out.length - 1] - out[out.length - 1] / period + arr[i]);
    return out;
  };
  const sTR = smooth(trList), sPDM = smooth(plusDM), sMDM = smooth(minusDM);

  const dxValues = [];
  for (let i = 0; i < sTR.length; i++) {
    if (sTR[i] === 0) { dxValues.push(0); continue; }
    const pdi = (sPDM[i] / sTR[i]) * 100, mdi = (sMDM[i] / sTR[i]) * 100;
    const sum = pdi + mdi;
    dxValues.push(sum === 0 ? 0 : (Math.abs(pdi - mdi) / sum) * 100);
  }
  if (dxValues.length < period) return NaN;

  let adx = mean(dxValues.slice(0, period));
  for (let i = period; i < dxValues.length; i++) adx = (adx * (period - 1) + dxValues[i]) / period;
  return round(clamp(adx, 0, 100));
}

/**
 * Annualized realized volatility from log returns.
 * @param {Array<{c: number}>} bars
 * @param {number} [period=20]
 * @returns {number} Decimal (e.g., 0.25 = 25%)
 */
export function calculateVolatility(bars, period = 20) {
  const prices = closes(bars);
  if (prices.length < period + 1) return NaN;
  const recent = prices.slice(-(period + 1));
  const returns = logReturns(recent);
  return round(stddev(returns) * LOG_RETURN_ANNUALIZER, 4);
}

// ─── Signal Builders ────────────────────────────────────────────────────────

/** Build trend signals from bars. */
function buildTrendSignals(bars) {
  const price = bars[bars.length - 1].c;
  const sma20 = calculateSMA(bars, 20);
  const sma50 = calculateSMA(bars, 50);
  const sma200 = calculateSMA(bars, 200);
  const adx = calculateADX(bars, 14);

  const pctAbove20 = (price - sma20) / sma20;
  const pctAbove50 = (price - sma50) / sma50;
  const pctAbove200 = (price - sma200) / sma200;

  // Direction: use SMA20 slope over last 5 bars
  const sma20_5ago = calculateSMA(bars.slice(0, -5), 20);
  let direction = 'flat';
  if (!isNaN(sma20_5ago)) {
    const slope = (sma20 - sma20_5ago) / sma20_5ago;
    if (slope > TREND_FLAT_THRESHOLD) direction = 'up';
    else if (slope < -TREND_FLAT_THRESHOLD) direction = 'down';
  }

  // Trend strength: ADX mapped to 0–100
  const strength = isNaN(adx) ? 50 : round(clamp(adx, 0, 100));

  return {
    sma20: round(pctAbove20, 4),
    sma50: round(pctAbove50, 4),
    sma200: round(pctAbove200, 4),
    direction,
    strength,
  };
}

/** Build volatility signals. */
function buildVolatilitySignals(bars, vixLevel) {
  const currentVol = calculateVolatility(bars, 20);

  // VIX: use provided value or proxy from HV
  const effectiveVix = vixLevel ?? round(currentVol * 100 * VIX_PROXY_MULTIPLIER);

  // Vol regime classification
  let volRegime = 'normal';
  if (currentVol < VOL_LOW_CEILING) volRegime = 'low';
  else if (currentVol > VOL_HIGH_CEILING) volRegime = 'extreme';
  else if (currentVol > VOL_NORMAL_CEILING) volRegime = 'high';

  // VIX percentile: compute rolling 20-day HV for each window over history
  const hvHistory = [];
  for (let i = 21; i <= bars.length; i++) {
    const slice = bars.slice(i - 21, i);
    const hv = calculateVolatility(slice, 20);
    if (!isNaN(hv)) hvHistory.push(hv);
  }
  const vixPercentile = percentileRank(currentVol, hvHistory);

  // Vol trend: compare current 20d vol to 60d vol
  const vol60 = calculateVolatility(bars, 60);
  let volTrend = 'stable';
  if (!isNaN(vol60)) {
    const ratio = currentVol / vol60;
    if (ratio > 1.15) volTrend = 'expanding';
    else if (ratio < 0.85) volTrend = 'contracting';
  }

  return {
    currentVol: round(currentVol, 4),
    volRegime,
    vixLevel: effectiveVix,
    vixPercentile,
    volTrend,
  };
}

/** Build momentum signals. */
function buildMomentumSignals(bars) {
  const price = bars[bars.length - 1].c;
  const rsi14 = calculateRSI(bars, 14);
  const macd = calculateMACD(bars);

  let rsiZone = 'neutral';
  if (rsi14 <= RSI_OVERSOLD) rsiZone = 'oversold';
  else if (rsi14 >= RSI_OVERBOUGHT) rsiZone = 'overbought';

  let macdSignal = 'neutral';
  if (!isNaN(macd.histogram)) {
    if (macd.histogram > 0 && macd.macd > 0) macdSignal = 'bullish';
    else if (macd.histogram < 0 && macd.macd < 0) macdSignal = 'bearish';
  }

  const priceAt = (n) => (bars.length > n ? bars[bars.length - 1 - n].c : NaN);
  const pctChange = (n) => {
    const prev = priceAt(n);
    return isNaN(prev) ? 0 : round((price - prev) / prev, 4);
  };

  return {
    rsi14: round(rsi14),
    rsiZone,
    macdSignal,
    priceChange5d: pctChange(5),
    priceChange20d: pctChange(20),
    priceChange60d: pctChange(60),
  };
}

/** Build breadth signals from advance/decline data. */
function buildBreadthSignals(advancers, decliners) {
  if (advancers == null || decliners == null || decliners === 0) {
    return { advanceDeclineRatio: 0, breadthSignal: 'unknown' };
  }

  const ratio = round(advancers / decliners, 2);
  let breadthSignal = 'weak';
  if (ratio > 1.5) breadthSignal = 'strong';
  else if (ratio > 0.9 && ratio < 1.1) breadthSignal = 'diverging';
  else if (ratio >= 1.1) breadthSignal = 'strong';

  return { advanceDeclineRatio: ratio, breadthSignal };
}

// ─── Regime Classification Engine ───────────────────────────────────────────

/** Score each regime by signal alignment. Highest weighted score wins. */
function classifyRegime(trend, vol, momentum, breadth) {
  const scores = { bull: 0, bear: 0, chop: 0, crash: 0, recovery: 0 };

  // ── BULL signals ──
  if (trend.sma20 > 0) scores.bull += 15;
  if (trend.sma50 > 0) scores.bull += 15;
  if (trend.sma200 > 0) scores.bull += 10;
  if (trend.direction === 'up') scores.bull += 10;
  if (trend.strength > ADX_STRONG) scores.bull += 5;
  if (momentum.rsi14 >= 50 && momentum.rsi14 <= 70) scores.bull += 10;
  if (momentum.macdSignal === 'bullish') scores.bull += 10;
  if (vol.volRegime === 'low' || vol.volRegime === 'normal') scores.bull += 10;
  if (momentum.priceChange20d > 0.02) scores.bull += 5;
  if (breadth.breadthSignal === 'strong') scores.bull += 10;

  // ── BEAR signals ──
  if (trend.sma20 < 0) scores.bear += 15;
  if (trend.sma50 < 0) scores.bear += 15;
  if (trend.sma200 < 0) scores.bear += 10;
  if (trend.direction === 'down') scores.bear += 10;
  if (momentum.rsi14 >= 30 && momentum.rsi14 <= 50) scores.bear += 10;
  if (momentum.macdSignal === 'bearish') scores.bear += 10;
  if (vol.volRegime === 'normal' || vol.volRegime === 'high') scores.bear += 5;
  if (momentum.priceChange20d < -0.02) scores.bear += 10;
  if (breadth.breadthSignal === 'weak') scores.bear += 5;

  // ── CHOP signals ──
  if (Math.abs(trend.sma20) < 0.01) scores.chop += 15;
  if (Math.abs(trend.sma50) < 0.01) scores.chop += 10;
  if (trend.direction === 'flat') scores.chop += 15;
  if (trend.strength < ADX_WEAK) scores.chop += 15;
  if (momentum.rsi14 >= 40 && momentum.rsi14 <= 60) scores.chop += 10;
  if (vol.volRegime === 'normal') scores.chop += 5;
  if (Math.abs(momentum.priceChange20d) < 0.02) scores.chop += 10;
  if (momentum.macdSignal === 'neutral') scores.chop += 10;

  // ── CRASH signals (weighted higher — false negatives are costlier) ──
  if (trend.sma200 < -0.05) scores.crash += 20;
  if (vol.volRegime === 'extreme') scores.crash += 25;
  if (vol.vixLevel > VIX_EXTREME_THRESHOLD) scores.crash += 20;
  if (momentum.rsi14 < RSI_OVERSOLD) scores.crash += 15;
  if (momentum.priceChange5d < -0.05) scores.crash += 15;
  if (momentum.priceChange20d < -0.10) scores.crash += 10;
  if (vol.volTrend === 'expanding') scores.crash += 5;
  if (breadth.breadthSignal === 'weak') scores.crash += 5;

  // ── RECOVERY signals ──
  if (trend.sma200 < 0 && trend.sma50 > -0.02) scores.recovery += 10;
  if (trend.sma20 > 0 && trend.sma50 < 0) scores.recovery += 15;
  if (trend.direction === 'up' && trend.sma200 < 0) scores.recovery += 10;
  if (vol.volTrend === 'contracting') scores.recovery += 15;
  if (vol.volRegime === 'high' || vol.volRegime === 'normal') scores.recovery += 5;
  if (momentum.rsi14 > 40 && momentum.rsi14 < 60) scores.recovery += 10;
  if (momentum.macdSignal === 'bullish' && trend.sma200 < 0) scores.recovery += 15;
  if (momentum.priceChange5d > 0.02) scores.recovery += 10;

  // Find winner — highest score
  const [best, bestScore] = Object.entries(scores).reduce(
    (max, entry) => (entry[1] > max[1] ? entry : max), ['chop', 0],
  );
  return { regime: best, confidence: clamp(Math.round(bestScore), 0, 100) };
}

/** Map regime → strategy recommendation with reasoning. */
function buildRecommendation(regime, confidence, signals) {
  const recs = {
    bull: {
      strategyRecommendation: '📈 Bullish regime — favor momentum strategies, long bias. Consider options-momentum for leveraged upside or hybrid-balanced for diversified exposure.',
      suggestedStrategyId: confidence > 70 ? STRATEGY_IDS.MOMENTUM : STRATEGY_IDS.BALANCED,
      reasoning: `Market trending up: price above major SMAs (20/50/200), RSI ${signals.momentum.rsi14} in healthy range, volatility ${signals.volatility.volRegime}. Trend strength: ${signals.trend.strength}/100.`,
    },
    bear: {
      strategyRecommendation: '📉 Bearish regime — defensive posture. Protective puts, covered calls, reduce position sizes. Avoid naked long exposure.',
      suggestedStrategyId: STRATEGY_IDS.CONSERVATIVE,
      reasoning: `Market trending down: price below major SMAs, RSI ${signals.momentum.rsi14}, MACD ${signals.momentum.macdSignal}. 20d change: ${(signals.momentum.priceChange20d * 100).toFixed(1)}%. Use conservative options strategies.`,
    },
    chop: {
      strategyRecommendation: '↔️ Choppy/range-bound — no clear trend. Grid trading or reduce size. Avoid trend-following strategies.',
      suggestedStrategyId: confidence > 60 ? STRATEGY_IDS.GRID : STRATEGY_IDS.BALANCED,
      reasoning: `No directional trend: ADX-like strength ${signals.trend.strength}/100, RSI ${signals.momentum.rsi14} mid-range, SMAs converging. Range-bound strategies preferred.`,
    },
    crash: {
      strategyRecommendation: '🚨 CRASH — extreme volatility detected. HALT new positions, move to cash. Wait for recovery signals before re-entry.',
      suggestedStrategyId: STRATEGY_IDS.CONSERVATIVE,
      reasoning: `Crisis conditions: VIX ${signals.volatility.vixLevel}, realized vol ${(signals.volatility.currentVol * 100).toFixed(1)}%, RSI ${signals.momentum.rsi14} (oversold), 5d change ${(signals.momentum.priceChange5d * 100).toFixed(1)}%. Capital preservation is priority.`,
    },
    recovery: {
      strategyRecommendation: '🔄 Recovery forming — scale in slowly via DCA. Volatility still elevated but contracting. Small positions, confirm trend before full deployment.',
      suggestedStrategyId: STRATEGY_IDS.DCA,
      reasoning: `Early recovery: price reclaiming SMA50, vol ${signals.volatility.volTrend}, RSI ${signals.momentum.rsi14} rising from depressed levels. Dollar-cost average back in.`,
    },
  };

  return recs[regime] || recs.chop;
}

// ─── Main Detection Function ────────────────────────────────────────────────

/**
 * Detect the current market regime from SPY bars and optional indicators.
 * @param {{ spyBars: Array, vixLevel?: number, advancers?: number, decliners?: number }} params
 * @returns {{ regime: string, confidence: number, signals: object, strategyRecommendation: string, suggestedStrategyId: string, reasoning: string }}
 */
export function detectRegime(params) {
  const { spyBars, vixLevel = null, advancers, decliners } = params;

  if (!spyBars || !Array.isArray(spyBars)) {
    throw new Error('spyBars is required and must be an array of OHLCV bars');
  }
  if (spyBars.length < MIN_BARS_REQUIRED) {
    throw new Error(
      `Need at least ${MIN_BARS_REQUIRED} bars for regime detection, got ${spyBars.length}`,
    );
  }

  const trend = buildTrendSignals(spyBars);
  const volatility = buildVolatilitySignals(spyBars, vixLevel);
  const momentum = buildMomentumSignals(spyBars);
  const breadth = buildBreadthSignals(advancers, decliners);

  const signals = { trend, volatility, momentum, breadth };

  const { regime, confidence } = classifyRegime(trend, volatility, momentum, breadth);
  const recommendation = buildRecommendation(regime, confidence, signals);

  return {
    regime,
    confidence,
    signals,
    ...recommendation,
  };
}

// ─── Regime History Tracker ─────────────────────────────────────────────────

/**
 * Analyze past regime detections for transition patterns.
 * @param {Array<{ date: string, regime: string }>} regimeResults
 * @returns {{ currentRegime: string, daysSinceChange: number, regimeChanges: Array, dominantRegime30d: string }}
 */
export function getRegimeHistory(regimeResults) {
  if (!regimeResults || !regimeResults.length) {
    return {
      currentRegime: 'unknown',
      daysSinceChange: 0,
      regimeChanges: [],
      dominantRegime30d: 'unknown',
    };
  }

  const sorted = [...regimeResults].sort(
    (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime(),
  );

  const currentRegime = sorted[sorted.length - 1].regime;

  // Find regime changes
  const regimeChanges = [];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].regime !== sorted[i - 1].regime) {
      regimeChanges.push({
        date: sorted[i].date,
        from: sorted[i - 1].regime,
        to: sorted[i].regime,
      });
    }
  }

  // Days since last change
  let daysSinceChange = sorted.length;
  if (regimeChanges.length > 0) {
    const lastChange = new Date(regimeChanges[regimeChanges.length - 1].date);
    const now = new Date(sorted[sorted.length - 1].date);
    daysSinceChange = Math.round((now - lastChange) / (1000 * 60 * 60 * 24));
  }

  // Dominant regime over last 30 entries
  const last30 = sorted.slice(-30);
  const counts = {};
  for (const r of last30) {
    counts[r.regime] = (counts[r.regime] || 0) + 1;
  }
  let dominantRegime30d = 'unknown';
  let maxCount = 0;
  for (const [regime, count] of Object.entries(counts)) {
    if (count > maxCount) {
      maxCount = count;
      dominantRegime30d = regime;
    }
  }

  return { currentRegime, daysSinceChange, regimeChanges, dominantRegime30d };
}

// ─── MCP Tool Integration ───────────────────────────────────────────────────

/** MCP tool definition for detect_market_regime. @returns {object} */
export function getRegimeToolDefinition() {
  return {
    name: 'detect_market_regime',
    description:
      'Detect current market regime (bull/bear/chop/crash/recovery) using technical analysis of SPY. Returns trend, volatility, momentum signals and strategy recommendation. Call at start of each trading session.',
    inputSchema: {
      type: 'object',
      properties: {
        spy_bars: {
          type: 'array',
          description: 'SPY daily OHLCV bars from get_historical_bars (200+ days). Each: {t, o, h, l, c, v}',
        },
        vix_level: { type: 'number', description: 'Current VIX value (optional — estimated from realized vol if omitted)' },
        advancers: { type: 'number', description: 'NYSE advancing issues count (optional)' },
        decliners: { type: 'number', description: 'NYSE declining issues count (optional)' },
      },
      required: [],
    },
  };
}

/**
 * Handle MCP tool call for detect_market_regime. Returns guidance if spy_bars missing.
 * @param {object} args
 * @returns {{ content: Array<{type: string, text: string}>, isError?: boolean }}
 */
export function handleRegimeToolCall(args) {
  try {
    if (!args.spy_bars || !Array.isArray(args.spy_bars) || args.spy_bars.length === 0) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                error: 'spy_bars required',
                guidance:
                  'Call get_historical_bars first with symbol="SPY", timeframe="1Day", limit=252 to get ~1 year of daily bars, then pass the result as spy_bars.',
                example:
                  'Step 1: get_historical_bars({ symbol: "SPY", timeframe: "1Day", limit: 252 })\nStep 2: detect_market_regime({ spy_bars: <result from step 1> })',
              },
              null,
              2,
            ),
          },
        ],
        isError: true,
      };
    }

    const result = detectRegime({
      spyBars: args.spy_bars,
      vixLevel: args.vix_level ?? null,
      advancers: args.advancers,
      decliners: args.decliners,
    });

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  } catch (err) {
    return {
      content: [
        {
          type: 'text',
          text: `Error detecting regime: ${err.message}`,
        },
      ],
      isError: true,
    };
  }
}
