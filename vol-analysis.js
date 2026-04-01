/**
 * vol-analysis.js — Options Volatility Analysis Module
 *
 * Analytical layer for the OpenProphet trading system. Computes IV rank,
 * IV percentile, historical volatility, vol premium, skew, and term structure
 * from options chain data and historical price bars.
 *
 * No external dependencies — pure math.
 *
 * Data formats (from Go backend):
 *   Chain: [{ strike, type, bid, ask, implied_volatility, delta, open_interest, expiration }]
 *   Bars:  [{ t (timestamp), o, h, l, c, v }]
 */

// ─── Constants ───────────────────────────────────────────────────────────────

const TRADING_DAYS_PER_YEAR = 252;
const DEFAULT_HV_PERIOD = 20;
const ATM_DELTA_MIN = 0.40;
const ATM_DELTA_MAX = 0.60;
const TARGET_WING_DELTA = 0.25;
const WING_DELTA_TOLERANCE = 0.10;
const SKEW_NEUTRAL_THRESHOLD = 3.0;
const IV_RANK_HIGH = 80;
const IV_RANK_LOW = 20;
const VOL_PREMIUM_HIGH_PCT = 20;
const VOL_PREMIUM_LOW_PCT = -10;
const SKEW_FEAR_THRESHOLD = 10;
const TERM_STRUCTURE_FLAT_THRESHOLD = 1.5;

// ─── Core Calculations ──────────────────────────────────────────────────────

/**
 * Calculate IV Rank: where current IV sits within its 52-week range.
 *
 *   IV Rank = (Current IV - 52wk Low) / (52wk High - 52wk Low) * 100
 *
 * @param {number} currentIV - Current implied volatility (e.g. 28.5)
 * @param {number[]} ivHistory - Array of historical IV values (daily, 252+ ideal)
 * @returns {number} IV rank 0–100, clamped
 */
export function calculateIVRank(currentIV, ivHistory) {
  if (!ivHistory || ivHistory.length === 0) {
    return -1;
  }

  const validIVs = ivHistory.filter((v) => typeof v === 'number' && v > 0);
  if (validIVs.length === 0) return -1;

  const low = Math.min(...validIVs);
  const high = Math.max(...validIVs);
  const range = high - low;

  if (range === 0) return 50; // flat IV history — neutral

  const rank = ((currentIV - low) / range) * 100;
  return clamp(rank, 0, 100);
}

/**
 * Calculate IV Percentile: percentage of historical days where IV was lower.
 *
 *   IV Percentile = (# days IV < current) / total days * 100
 *
 * @param {number} currentIV - Current implied volatility
 * @param {number[]} ivHistory - Array of historical IV values
 * @returns {number} IV percentile 0–100
 */
export function calculateIVPercentile(currentIV, ivHistory) {
  if (!ivHistory || ivHistory.length === 0) {
    return -1;
  }

  const validIVs = ivHistory.filter((v) => typeof v === 'number' && v > 0);
  if (validIVs.length === 0) return -1;

  const daysBelow = validIVs.filter((iv) => iv < currentIV).length;
  return (daysBelow / validIVs.length) * 100;
}

/**
 * Calculate realized (historical) volatility from daily close prices.
 *
 * Method: annualized standard deviation of log returns.
 *   1. log returns = ln(close[i] / close[i-1])
 *   2. stddev of returns
 *   3. annualize: stddev * sqrt(252) * 100
 *
 * @param {Array<{t: string|number, o: number, h: number, l: number, c: number, v: number}>} bars
 *   Historical price bars from the Go backend's /market/bars/:symbol endpoint.
 * @param {number} [period=20] - Lookback period in trading days
 * @returns {number} Annualized historical volatility as a percentage, or -1 if insufficient data
 */
export function calculateHistoricalVol(bars, period = DEFAULT_HV_PERIOD) {
  if (!bars || bars.length < period + 1) {
    return -1;
  }

  // Sort chronologically — earliest first
  const sorted = [...bars].sort((a, b) => toTimestamp(a.t) - toTimestamp(b.t));

  // Use the most recent `period + 1` bars to get `period` returns
  const recentBars = sorted.slice(-(period + 1));
  const logReturns = [];

  for (let i = 1; i < recentBars.length; i++) {
    const prev = recentBars[i - 1].c;
    const curr = recentBars[i].c;

    if (prev <= 0 || curr <= 0) continue;
    logReturns.push(Math.log(curr / prev));
  }

  if (logReturns.length < 2) return -1;

  const std = stddev(logReturns);
  return std * Math.sqrt(TRADING_DAYS_PER_YEAR) * 100;
}

/**
 * Analyze put/call skew from an options chain.
 *
 * Compares IV of puts vs calls at similar delta levels to detect
 * directional fear or greed in the market.
 *
 * @param {Array<{strike: number, type: string, bid: number, ask: number,
 *   implied_volatility: number, delta: number, open_interest: number,
 *   expiration: string}>} chain - Options chain from the Go backend
 * @returns {{
 *   putCallRatio: number,
 *   skewDirection: 'put_heavy' | 'call_heavy' | 'neutral',
 *   skew25Delta: number,
 *   atmPutIV: number,
 *   atmCallIV: number,
 *   wing25PutIV: number,
 *   wing25CallIV: number
 * }}
 */
export function analyzeSkew(chain) {
  const result = {
    putCallRatio: 1.0,
    skewDirection: /** @type {'put_heavy' | 'call_heavy' | 'neutral'} */ ('neutral'),
    skew25Delta: 0,
    atmPutIV: 0,
    atmCallIV: 0,
    wing25PutIV: 0,
    wing25CallIV: 0,
  };

  if (!chain || chain.length === 0) return result;

  const puts = chain.filter((o) => o.type === 'put' && isValidOption(o));
  const calls = chain.filter((o) => o.type === 'call' && isValidOption(o));

  if (puts.length === 0 || calls.length === 0) return result;

  // ATM options: delta nearest ±0.50
  const atmPut = findClosestByDelta(puts, -0.50);
  const atmCall = findClosestByDelta(calls, 0.50);

  if (atmPut) result.atmPutIV = atmPut.implied_volatility;
  if (atmCall) result.atmCallIV = atmCall.implied_volatility;

  // ATM put/call IV ratio
  if (result.atmCallIV > 0) {
    result.putCallRatio = round(result.atmPutIV / result.atmCallIV, 4);
  }

  // 25-delta wings: OTM puts near -0.25 delta, OTM calls near +0.25 delta
  const wing25Put = findClosestByDelta(puts, -TARGET_WING_DELTA, WING_DELTA_TOLERANCE);
  const wing25Call = findClosestByDelta(calls, TARGET_WING_DELTA, WING_DELTA_TOLERANCE);

  if (wing25Put) result.wing25PutIV = wing25Put.implied_volatility;
  if (wing25Call) result.wing25CallIV = wing25Call.implied_volatility;

  // 25-delta skew: put IV minus call IV (positive = puts more expensive)
  if (result.wing25PutIV > 0 && result.wing25CallIV > 0) {
    result.skew25Delta = round(result.wing25PutIV - result.wing25CallIV, 2);
  } else if (result.atmPutIV > 0 && result.atmCallIV > 0) {
    // Fall back to ATM skew if wings unavailable
    result.skew25Delta = round(result.atmPutIV - result.atmCallIV, 2);
  }

  // Classify direction
  if (result.skew25Delta > SKEW_NEUTRAL_THRESHOLD) {
    result.skewDirection = 'put_heavy';
  } else if (result.skew25Delta < -SKEW_NEUTRAL_THRESHOLD) {
    result.skewDirection = 'call_heavy';
  } else {
    result.skewDirection = 'neutral';
  }

  return result;
}

/**
 * Analyze term structure across multiple expiration chains.
 *
 * Compares near-term vs far-term IV to detect contango (normal)
 * or backwardation (fear/events).
 *
 * @param {Array<Array<{strike: number, type: string, bid: number, ask: number,
 *   implied_volatility: number, delta: number, open_interest: number,
 *   expiration: string}>>} chains - Array of option chains, one per expiration
 * @returns {{
 *   shape: 'contango' | 'backwardation' | 'flat',
 *   nearTermIV: number,
 *   farTermIV: number,
 *   spread: number,
 *   expirations: Array<{expiration: string, atmIV: number}>
 * }}
 */
export function analyzeTermStructure(chains) {
  const result = {
    shape: /** @type {'contango' | 'backwardation' | 'flat'} */ ('flat'),
    nearTermIV: 0,
    farTermIV: 0,
    spread: 0,
    expirations: /** @type {Array<{expiration: string, atmIV: number}>} */ ([]),
  };

  if (!chains || chains.length < 2) return result;

  // Calculate ATM IV per expiration and sort by date
  const expiryIVs = [];

  for (const chain of chains) {
    if (!chain || chain.length === 0) continue;

    const atmIV = computeATMImpliedVol(chain);
    if (atmIV <= 0) continue;

    // Pull expiration from first option in chain
    const expiration = chain[0].expiration;
    expiryIVs.push({ expiration, atmIV });
  }

  if (expiryIVs.length < 2) return result;

  // Sort by expiration date (earliest first)
  expiryIVs.sort((a, b) => new Date(a.expiration).getTime() - new Date(b.expiration).getTime());

  result.expirations = expiryIVs;
  result.nearTermIV = round(expiryIVs[0].atmIV, 2);
  result.farTermIV = round(expiryIVs[expiryIVs.length - 1].atmIV, 2);
  result.spread = round(result.farTermIV - result.nearTermIV, 2);

  // Classify shape
  if (result.spread > TERM_STRUCTURE_FLAT_THRESHOLD) {
    result.shape = 'contango';
  } else if (result.spread < -TERM_STRUCTURE_FLAT_THRESHOLD) {
    result.shape = 'backwardation';
  } else {
    result.shape = 'flat';
  }

  return result;
}

// ─── Main Analysis ──────────────────────────────────────────────────────────

/**
 * Full volatility analysis combining IV rank, percentile, HV, skew,
 * term structure, and signal generation.
 *
 * @param {Array<{strike: number, type: string, bid: number, ask: number,
 *   implied_volatility: number, delta: number, open_interest: number,
 *   expiration: string}>} chainData - Options chain from get_options_chain
 * @param {Array<{t: string|number, o: number, h: number, l: number,
 *   c: number, v: number}>} historicalBars - Daily bars from get_historical_bars (252+ ideal)
 * @param {Object} [options]
 * @param {number[]} [options.ivHistory] - Historical IV values for rank/percentile
 * @param {Array<Array>} [options.additionalChains] - Extra expiry chains for term structure
 * @param {string} [options.symbol] - Underlying ticker for display
 * @returns {{
 *   symbol: string,
 *   ivRank: number,
 *   ivPercentile: number,
 *   currentIV: number,
 *   historicalVol: number,
 *   volPremium: number,
 *   volPremiumPct: number,
 *   skew: Object,
 *   termStructure: Object,
 *   recommendation: string,
 *   signals: string[],
 *   dataQuality: Object,
 *   timestamp: string
 * }}
 */
export function analyzeVolatility(chainData, historicalBars, options = {}) {
  const { ivHistory = [], additionalChains = [], symbol = 'UNKNOWN' } = options;

  // Track data quality for the agent
  const dataQuality = {
    hasChainData: Boolean(chainData && chainData.length > 0),
    hasHistoricalBars: Boolean(historicalBars && historicalBars.length > 0),
    hasIVHistory: Boolean(ivHistory && ivHistory.length > 0),
    barCount: historicalBars?.length ?? 0,
    ivHistoryCount: ivHistory?.length ?? 0,
    chainSize: chainData?.length ?? 0,
    warnings: /** @type {string[]} */ ([]),
  };

  if (dataQuality.barCount > 0 && dataQuality.barCount < TRADING_DAYS_PER_YEAR) {
    dataQuality.warnings.push(
      `Only ${dataQuality.barCount} bars provided; 252+ recommended for accurate HV`,
    );
  }
  if (dataQuality.ivHistoryCount > 0 && dataQuality.ivHistoryCount < TRADING_DAYS_PER_YEAR) {
    dataQuality.warnings.push(
      `Only ${dataQuality.ivHistoryCount} IV history points; 252+ recommended for IV rank`,
    );
  }

  // Current ATM implied vol from chain
  const currentIV = chainData ? computeATMImpliedVol(chainData) : -1;

  // Historical / realized volatility
  const historicalVol = calculateHistoricalVol(historicalBars);

  // IV Rank & Percentile
  let ivRank = -1;
  let ivPercentile = -1;

  if (ivHistory && ivHistory.length > 0 && currentIV > 0) {
    ivRank = round(calculateIVRank(currentIV, ivHistory), 1);
    ivPercentile = round(calculateIVPercentile(currentIV, ivHistory), 1);
  } else if (currentIV > 0 && historicalBars && historicalBars.length >= TRADING_DAYS_PER_YEAR) {
    // Estimate IV history from HV at rolling windows if no explicit IV history
    const estimatedIVHistory = estimateIVFromBars(historicalBars);
    if (estimatedIVHistory.length > 0) {
      ivRank = round(calculateIVRank(currentIV, estimatedIVHistory), 1);
      ivPercentile = round(calculateIVPercentile(currentIV, estimatedIVHistory), 1);
      dataQuality.warnings.push('IV rank/percentile estimated from HV — pass iv_history for accuracy');
    }
  }

  // Vol premium: IV - HV
  let volPremium = 0;
  let volPremiumPct = 0;
  if (currentIV > 0 && historicalVol > 0) {
    volPremium = round(currentIV - historicalVol, 2);
    volPremiumPct = round((volPremium / historicalVol) * 100, 1);
  }

  // Skew analysis
  const skew = analyzeSkew(chainData);

  // Term structure (include primary chain + any additional expiry chains)
  const allChains = additionalChains.length > 0
    ? [chainData, ...additionalChains].filter(Boolean)
    : [];
  const termStructure = analyzeTermStructure(allChains);

  // Generate signals and recommendation
  const signals = generateSignals({ ivRank, ivPercentile, volPremiumPct, skew, termStructure });
  const recommendation = buildRecommendation({
    symbol,
    ivRank,
    currentIV,
    historicalVol,
    volPremium,
    volPremiumPct,
    skew,
    termStructure,
    signals,
  });

  return {
    symbol,
    ivRank,
    ivPercentile,
    currentIV: round(currentIV, 2),
    historicalVol: round(historicalVol, 2),
    volPremium,
    volPremiumPct,
    skew: {
      putCallRatio: skew.putCallRatio,
      skewDirection: skew.skewDirection,
      skew25Delta: skew.skew25Delta,
    },
    termStructure: {
      shape: termStructure.shape,
      nearTermIV: termStructure.nearTermIV,
      farTermIV: termStructure.farTermIV,
      spread: termStructure.spread,
    },
    recommendation,
    signals,
    dataQuality,
    timestamp: new Date().toISOString(),
  };
}

// ─── Signal Generation ──────────────────────────────────────────────────────

/**
 * Generate actionable trading signals from vol analysis metrics.
 *
 * @param {Object} metrics
 * @param {number} metrics.ivRank
 * @param {number} metrics.ivPercentile
 * @param {number} metrics.volPremiumPct
 * @param {Object} metrics.skew
 * @param {Object} metrics.termStructure
 * @returns {string[]} Array of signal strings
 */
function generateSignals({ ivRank, ivPercentile, volPremiumPct, skew, termStructure }) {
  const signals = [];

  // IV Rank signals
  if (ivRank >= 0) {
    if (ivRank > IV_RANK_HIGH) {
      signals.push(
        `IV_HIGH: IV Rank ${round(ivRank, 0)} — options expensive. ` +
        `Favor selling strategies (covered calls, iron condors, credit spreads)`,
      );
    } else if (ivRank < IV_RANK_LOW) {
      signals.push(
        `IV_LOW: IV Rank ${round(ivRank, 0)} — options cheap. ` +
        `Favor buying strategies (long calls/puts, debit spreads, straddles)`,
      );
    }
  }

  // Vol premium signals
  if (volPremiumPct !== 0) {
    if (volPremiumPct > VOL_PREMIUM_HIGH_PCT) {
      signals.push(
        `VOL_PREMIUM: IV exceeds HV by ${round(volPremiumPct, 0)}%. ` +
        `Mean reversion likely — sell premium`,
      );
    } else if (volPremiumPct < VOL_PREMIUM_LOW_PCT) {
      signals.push(
        `VOL_DISCOUNT: IV ${round(Math.abs(volPremiumPct), 0)}% below HV. ` +
        `Unusual — consider buying protection or long vol`,
      );
    }
  }

  // Skew signals
  if (skew && skew.skew25Delta !== 0) {
    if (skew.skew25Delta > SKEW_FEAR_THRESHOLD) {
      signals.push(
        `SKEW_FEAR: 25-delta put/call skew ${round(skew.skew25Delta, 1)}%. ` +
        `Market pricing significant downside risk`,
      );
    } else if (skew.skew25Delta < -SKEW_FEAR_THRESHOLD) {
      signals.push(
        `SKEW_GREED: 25-delta skew ${round(skew.skew25Delta, 1)}% (calls expensive). ` +
        `Unusual upside demand — potential top signal`,
      );
    }
  }

  // Term structure signals
  if (termStructure && termStructure.shape === 'backwardation') {
    signals.push(
      `BACKWARDATION: Near-term IV ${round(termStructure.nearTermIV, 1)} > ` +
      `far-term ${round(termStructure.farTermIV, 1)}. ` +
      `Near-term fear elevated — possible event catalyst`,
    );
  }

  // Combined high-conviction signals
  if (ivRank > IV_RANK_HIGH && volPremiumPct > VOL_PREMIUM_HIGH_PCT) {
    signals.push(
      `HIGH_CONVICTION_SELL: Both IV rank (${round(ivRank, 0)}) and vol premium ` +
      `(${round(volPremiumPct, 0)}%) elevated — strong sell-premium setup`,
    );
  }
  if (ivRank < IV_RANK_LOW && volPremiumPct < VOL_PREMIUM_LOW_PCT) {
    signals.push(
      `HIGH_CONVICTION_BUY: Both IV rank (${round(ivRank, 0)}) and vol discount ` +
      `(${round(Math.abs(volPremiumPct), 0)}%) suggest cheap options — strong buy-vol setup`,
    );
  }

  return signals;
}

/**
 * Build a human-readable recommendation summary.
 *
 * @param {Object} data - All analysis metrics
 * @returns {string} Recommendation string
 */
function buildRecommendation(data) {
  const { symbol, ivRank, currentIV, historicalVol, volPremium, skew, termStructure, signals } = data;

  const parts = [];

  // Headline
  if (ivRank >= 0) {
    parts.push(`${symbol} IV Rank ${round(ivRank, 0)}/100`);
  }
  if (currentIV > 0) {
    parts.push(`Current IV: ${round(currentIV, 1)}%`);
  }
  if (historicalVol > 0) {
    parts.push(`HV(20): ${round(historicalVol, 1)}%`);
  }

  // Vol premium context
  if (volPremium !== 0) {
    const direction = volPremium > 0 ? 'above' : 'below';
    parts.push(`IV is ${round(Math.abs(volPremium), 1)} pts ${direction} realized vol`);
  }

  // Directional bias from skew
  if (skew.skewDirection === 'put_heavy') {
    parts.push('Skew: put-heavy (downside hedging demand)');
  } else if (skew.skewDirection === 'call_heavy') {
    parts.push('Skew: call-heavy (upside speculation)');
  }

  // Term structure note
  if (termStructure.shape === 'backwardation') {
    parts.push('Term structure inverted — near-term event risk');
  } else if (termStructure.shape === 'contango') {
    parts.push('Term structure normal (contango)');
  }

  // Action guidance
  if (ivRank > IV_RANK_HIGH) {
    parts.push('→ Options are expensive. Consider selling premium.');
  } else if (ivRank < IV_RANK_LOW) {
    parts.push('→ Options are cheap. Consider buying premium.');
  } else if (ivRank >= 0) {
    parts.push('→ IV is mid-range. No strong vol edge — trade direction or wait.');
  }

  return parts.join('. ') + '.';
}

// ─── MCP Tool Definition & Handler ──────────────────────────────────────────

/**
 * Returns the MCP tool schema for the analyze_volatility tool.
 * Register this alongside other tool definitions in mcp-server.js.
 *
 * @returns {{name: string, description: string, inputSchema: Object}}
 */
export function getVolAnalysisToolDefinition() {
  return {
    name: 'analyze_volatility',
    description:
      'Analyze implied volatility for an options trade. Returns IV rank, IV percentile, ' +
      'vol premium, skew analysis, and term structure. Call before options trades to ' +
      'determine if premium is cheap or expensive.',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: {
          type: 'string',
          description: 'Underlying symbol (e.g. SPY, AAPL)',
        },
        chain_data: {
          type: 'array',
          description:
            'Options chain array from get_options_chain. Each element: ' +
            '{ strike, type, bid, ask, implied_volatility, delta, open_interest, expiration }',
        },
        historical_bars: {
          type: 'array',
          description:
            'Historical daily bars from get_historical_bars (need 252+ for IV rank). ' +
            'Each element: { t, o, h, l, c, v }',
        },
        iv_history: {
          type: 'array',
          description:
            'Optional: array of historical IV values for rank/percentile. ' +
            'Daily ATM IV readings, most recent last. 252+ values ideal.',
          items: { type: 'number' },
        },
        additional_chains: {
          type: 'array',
          description:
            'Optional: additional expiry chains for term structure analysis. ' +
            'Each element is a full chain array for a different expiration.',
        },
      },
      required: ['symbol'],
    },
  };
}

/**
 * Handle an MCP tool call for analyze_volatility.
 *
 * Returns MCP-formatted response (content array with text).
 * If required data is missing, returns guidance on which tools to call first.
 *
 * @param {Object} args - Tool call arguments
 * @param {string} args.symbol - Underlying symbol
 * @param {Array} [args.chain_data] - Options chain
 * @param {Array} [args.historical_bars] - Historical bars
 * @param {number[]} [args.iv_history] - IV history
 * @param {Array<Array>} [args.additional_chains] - Extra expiry chains
 * @returns {{content: Array<{type: string, text: string}>, isError?: boolean}}
 */
export function handleVolAnalysisToolCall(args) {
  const { symbol, chain_data, historical_bars, iv_history, additional_chains } = args;

  if (!symbol) {
    return {
      content: [{ type: 'text', text: 'Error: symbol is required' }],
      isError: true,
    };
  }

  // Guide the agent if data is missing
  const missing = [];
  if (!chain_data || chain_data.length === 0) {
    missing.push(
      'chain_data — call get_options_chain with symbol and desired expiration first',
    );
  }
  if (!historical_bars || historical_bars.length === 0) {
    missing.push(
      'historical_bars — call get_historical_bars with symbol, timeframe=1Day, limit=300+ first',
    );
  }

  if (missing.length > 0) {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              status: 'missing_data',
              symbol,
              message: `Need more data before volatility analysis. Fetch these first:`,
              missing,
              tip: 'After fetching, pass the results back into analyze_volatility.',
            },
            null,
            2,
          ),
        },
      ],
    };
  }

  try {
    const analysis = analyzeVolatility(chain_data, historical_bars, {
      ivHistory: iv_history,
      additionalChains: additional_chains,
      symbol,
    });

    return {
      content: [{ type: 'text', text: JSON.stringify(analysis, null, 2) }],
    };
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Error analyzing volatility: ${err.message}` }],
      isError: true,
    };
  }
}

// ─── Internal Helpers ───────────────────────────────────────────────────────

/**
 * Compute the ATM implied volatility from a chain as the average IV of
 * options with delta closest to ±0.50.
 *
 * @param {Array<{type: string, implied_volatility: number, delta: number}>} chain
 * @returns {number} ATM IV, or -1 if unavailable
 */
function computeATMImpliedVol(chain) {
  if (!chain || chain.length === 0) return -1;

  const atmOptions = chain.filter((o) => {
    if (!isValidOption(o)) return false;
    const absDelta = Math.abs(o.delta);
    return absDelta >= ATM_DELTA_MIN && absDelta <= ATM_DELTA_MAX;
  });

  if (atmOptions.length === 0) {
    // Fallback: find the single option closest to 0.50 delta
    const closest = findClosestByDelta(
      chain.filter(isValidOption),
      0.50,
      1.0, // wide tolerance
    );
    return closest ? closest.implied_volatility : -1;
  }

  const sum = atmOptions.reduce((acc, o) => acc + o.implied_volatility, 0);
  return sum / atmOptions.length;
}

/**
 * Estimate a pseudo-IV history from rolling HV windows.
 * Used as a fallback when explicit IV history isn't provided.
 *
 * @param {Array<{t: string|number, o: number, h: number, l: number, c: number, v: number}>} bars
 * @returns {number[]} Array of estimated IV values
 */
function estimateIVFromBars(bars) {
  if (!bars || bars.length < DEFAULT_HV_PERIOD + 1) return [];

  const sorted = [...bars].sort((a, b) => toTimestamp(a.t) - toTimestamp(b.t));
  const estimates = [];

  for (let i = DEFAULT_HV_PERIOD; i < sorted.length; i++) {
    const window = sorted.slice(i - DEFAULT_HV_PERIOD, i + 1);
    const hv = calculateHistoricalVol(window, DEFAULT_HV_PERIOD);
    if (hv > 0) estimates.push(hv);
  }

  return estimates;
}

/**
 * Find the option in a list whose delta is closest to the target.
 *
 * @param {Array<{delta: number, implied_volatility: number}>} options
 * @param {number} targetDelta - Target delta (negative for puts)
 * @param {number} [maxDistance] - Max acceptable delta distance
 * @returns {Object|null} Closest option or null
 */
function findClosestByDelta(options, targetDelta, maxDistance = WING_DELTA_TOLERANCE) {
  if (!options || options.length === 0) return null;

  let best = null;
  let bestDist = Infinity;

  for (const opt of options) {
    if (typeof opt.delta !== 'number') continue;
    const dist = Math.abs(opt.delta - targetDelta);
    if (dist < bestDist) {
      bestDist = dist;
      best = opt;
    }
  }

  return best && bestDist <= maxDistance ? best : (best || null);
}

/**
 * Validate that an option has usable IV and delta data.
 *
 * @param {Object} opt
 * @returns {boolean}
 */
function isValidOption(opt) {
  return (
    opt &&
    typeof opt.implied_volatility === 'number' &&
    opt.implied_volatility > 0 &&
    typeof opt.delta === 'number'
  );
}

/**
 * Standard deviation of an array of numbers.
 *
 * @param {number[]} values
 * @returns {number}
 */
function stddev(values) {
  if (values.length < 2) return 0;

  const n = values.length;
  const mean = values.reduce((s, v) => s + v, 0) / n;
  const squaredDiffs = values.reduce((s, v) => s + (v - mean) ** 2, 0);

  // Sample standard deviation (n-1)
  return Math.sqrt(squaredDiffs / (n - 1));
}

/**
 * Convert a timestamp (string or number) to a numeric epoch ms.
 *
 * @param {string|number} t
 * @returns {number}
 */
function toTimestamp(t) {
  if (typeof t === 'number') return t;
  return new Date(t).getTime();
}

/**
 * Clamp a value between min and max.
 *
 * @param {number} val
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function clamp(val, min, max) {
  return Math.max(min, Math.min(max, val));
}

/**
 * Round a number to n decimal places.
 *
 * @param {number} val
 * @param {number} decimals
 * @returns {number}
 */
function round(val, decimals) {
  if (typeof val !== 'number' || isNaN(val)) return 0;
  const factor = 10 ** decimals;
  return Math.round(val * factor) / factor;
}
