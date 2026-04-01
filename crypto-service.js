/**
 * @fileoverview Multi-exchange crypto trading service for OpenProphet.
 *
 * Wraps ccxt to provide a unified interface across Binance, Coinbase, and Kraken.
 * Designed to be called from MCP tool handlers or directly by the AI agent.
 *
 * All public methods that touch an exchange are async and throw typed errors
 * with actionable messages. Rate limits are handled by ccxt internally;
 * this module adds audit logging on top.
 *
 * @module crypto-service
 * @example
 * ```js
 * import { createCryptoService } from './crypto-service.js';
 * import { loadCryptoConfig } from './crypto-config.js';
 *
 * const svc = createCryptoService(loadCryptoConfig());
 * const ticker = await svc.getTicker('binance', 'BTC/USDT');
 * ```
 */

import ccxt from 'ccxt';

// ─── Logging ────────────────────────────────────────────────────────────────

/**
 * Structured logger for audit trail. Writes to stderr so it doesn't
 * interfere with MCP's stdout transport.
 *
 * @param {'INFO'|'WARN'|'ERROR'|'TRADE'} level
 * @param {string} message
 * @param {Record<string, unknown>} [meta]
 */
function log(level, message, meta = {}) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    module: 'crypto-service',
    message,
    ...meta,
  };
  process.stderr.write(JSON.stringify(entry) + '\n');
}

// ─── Symbol Helpers ─────────────────────────────────────────────────────────

/**
 * Normalize any common symbol format to ccxt canonical form.
 *
 * Accepts: `BTCUSDT`, `BTC/USDT`, `btc-usdt`, `btc_usdt`, `BTC / USDT`
 * Returns: `BTC/USDT`
 *
 * @param {string} raw - Raw symbol input
 * @returns {string} Normalized symbol in `BASE/QUOTE` form
 */
function normalizeSymbol(raw) {
  let s = raw.trim().toUpperCase().replace(/\s+/g, '');

  // Already canonical
  if (/^[A-Z0-9]+\/[A-Z0-9]+$/.test(s)) return s;

  // Dash or underscore separated: BTC-USDT, BTC_USDT
  if (/^[A-Z0-9]+[-_][A-Z0-9]+$/.test(s)) {
    return s.replace(/[-_]/, '/');
  }

  // Concatenated pair — try known quote currencies (longest match first)
  const quotes = ['USDT', 'BUSD', 'USDC', 'USD', 'EUR', 'GBP', 'BTC', 'ETH', 'BNB'];
  for (const q of quotes) {
    if (s.endsWith(q) && s.length > q.length) {
      return `${s.slice(0, -q.length)}/${q}`;
    }
  }

  // Can't parse — return as-is and let ccxt throw if invalid
  return s;
}

// ─── Error Wrapper ──────────────────────────────────────────────────────────

/**
 * Custom error class for crypto service failures.
 * Preserves the original ccxt error as `cause`.
 */
class CryptoServiceError extends Error {
  /**
   * @param {string} message
   * @param {string} exchange
   * @param {string} operation
   * @param {Error}  [cause]
   */
  constructor(message, exchange, operation, cause) {
    super(message);
    this.name = 'CryptoServiceError';
    this.exchange = exchange;
    this.operation = operation;
    this.cause = cause;
  }
}

/**
 * Wrap an async exchange call with structured error handling and logging.
 *
 * @template T
 * @param {string} exchangeId
 * @param {string} operation
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
async function wrapCall(exchangeId, operation, fn) {
  const start = Date.now();
  try {
    const result = await fn();
    log('INFO', `${operation} completed`, { exchange: exchangeId, ms: Date.now() - start });
    return result;
  } catch (err) {
    const ms = Date.now() - start;

    // Map ccxt error types to actionable messages
    let message;
    if (err instanceof ccxt.AuthenticationError) {
      message = `Authentication failed on ${exchangeId} — check API key/secret`;
    } else if (err instanceof ccxt.InsufficientFunds) {
      message = `Insufficient funds on ${exchangeId} for ${operation}`;
    } else if (err instanceof ccxt.InvalidOrder) {
      message = `Invalid order on ${exchangeId}: ${err.message}`;
    } else if (err instanceof ccxt.OrderNotFound) {
      message = `Order not found on ${exchangeId}: ${err.message}`;
    } else if (err instanceof ccxt.RateLimitExceeded) {
      message = `Rate limit hit on ${exchangeId} — backing off`;
    } else if (err instanceof ccxt.NetworkError) {
      message = `Network error reaching ${exchangeId}: ${err.message}`;
    } else if (err instanceof ccxt.ExchangeNotAvailable) {
      message = `${exchangeId} is currently unavailable`;
    } else {
      message = `${exchangeId} ${operation} failed: ${err.message}`;
    }

    log('ERROR', message, { exchange: exchangeId, operation, ms, error: err.message });
    throw new CryptoServiceError(message, exchangeId, operation, err);
  }
}

// ─── CryptoService ──────────────────────────────────────────────────────────

/**
 * Multi-exchange crypto trading service.
 *
 * Manages ccxt exchange instances and provides a clean async API
 * for market data, trading, and portfolio management.
 */
class CryptoService {
  /**
   * @param {import('./crypto-config.js').CryptoConfig} config
   */
  constructor(config) {
    /** @type {Map<string, ccxt.Exchange>} */
    this._exchanges = new Map();

    if (!config?.exchanges || Object.keys(config.exchanges).length === 0) {
      log('WARN', 'No exchanges configured — CryptoService will have no active connections');
      return;
    }

    for (const [id, creds] of Object.entries(config.exchanges)) {
      if (!(id in ccxt)) {
        log('WARN', `Exchange "${id}" is not supported by ccxt — skipping`);
        continue;
      }

      /** @type {ccxt.Exchange} */
      const exchange = new ccxt[id]({
        apiKey: creds.apiKey,
        secret: creds.secret,
        ...(creds.password ? { password: creds.password } : {}),
        enableRateLimit: true,
        options: { defaultType: 'spot' },
      });

      // Sandbox / testnet
      if (creds.sandbox !== false) {
        exchange.setSandboxMode(true);
        log('INFO', `${id}: sandbox mode enabled`);
      } else {
        log('WARN', `${id}: LIVE trading mode — real money at risk`);
      }

      this._exchanges.set(id, exchange);
      log('INFO', `Initialized exchange: ${id}`);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Exchange Management
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * List all configured exchange IDs.
   * @returns {string[]}
   */
  getExchanges() {
    return [...this._exchanges.keys()];
  }

  /**
   * Get a raw ccxt exchange instance by ID.
   * @param {string} id - Exchange identifier (e.g. 'binance')
   * @returns {ccxt.Exchange}
   * @throws {CryptoServiceError} If exchange is not configured
   */
  getExchange(id) {
    const ex = this._exchanges.get(id);
    if (!ex) {
      throw new CryptoServiceError(
        `Exchange "${id}" is not configured. Available: ${this.getExchanges().join(', ') || 'none'}`,
        id,
        'getExchange',
      );
    }
    return ex;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Market Data
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Fetch current ticker for a symbol.
   *
   * @param {string} exchangeId
   * @param {string} symbol - e.g. 'BTC/USDT', 'BTCUSDT', 'btc-usdt'
   * @returns {Promise<ccxt.Ticker>}
   */
  async getTicker(exchangeId, symbol) {
    const ex = this.getExchange(exchangeId);
    const sym = normalizeSymbol(symbol);
    return wrapCall(exchangeId, `getTicker(${sym})`, () => ex.fetchTicker(sym));
  }

  /**
   * Fetch multiple tickers at once.
   *
   * @param {string} exchangeId
   * @param {string[]} symbols - Array of symbols
   * @returns {Promise<Object.<string, ccxt.Ticker>>}
   */
  async getTickers(exchangeId, symbols) {
    const ex = this.getExchange(exchangeId);
    const syms = symbols.map(normalizeSymbol);
    return wrapCall(exchangeId, `getTickers(${syms.length} symbols)`, () =>
      ex.fetchTickers(syms),
    );
  }

  /**
   * Fetch order book depth.
   *
   * @param {string} exchangeId
   * @param {string} symbol
   * @param {number} [limit=20] - Number of price levels
   * @returns {Promise<ccxt.OrderBook>}
   */
  async getOrderBook(exchangeId, symbol, limit = 20) {
    const ex = this.getExchange(exchangeId);
    const sym = normalizeSymbol(symbol);
    return wrapCall(exchangeId, `getOrderBook(${sym})`, () =>
      ex.fetchOrderBook(sym, limit),
    );
  }

  /**
   * Fetch OHLCV candlestick data.
   *
   * @param {string} exchangeId
   * @param {string} symbol
   * @param {string} [timeframe='1h'] - Candle timeframe (1m, 5m, 15m, 1h, 4h, 1d, etc.)
   * @param {number|string} [since]   - Start time (ms timestamp or ISO string)
   * @param {number} [limit=100]      - Max candles to return
   * @returns {Promise<Array<[number, number, number, number, number, number]>>}
   *   Array of [timestamp, open, high, low, close, volume]
   */
  async getOHLCV(exchangeId, symbol, timeframe = '1h', since, limit = 100) {
    const ex = this.getExchange(exchangeId);
    const sym = normalizeSymbol(symbol);
    const sinceMs = since ? (typeof since === 'string' ? new Date(since).getTime() : Number(since)) : undefined;
    return wrapCall(exchangeId, `getOHLCV(${sym}, ${timeframe})`, () =>
      ex.fetchOHLCV(sym, timeframe, sinceMs, limit),
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Account / Balance
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Fetch account balances.
   *
   * @param {string} exchangeId
   * @param {string} [currency] - If provided, returns only that currency's balance
   * @returns {Promise<ccxt.Balances|{free: number, used: number, total: number}>}
   */
  async getBalance(exchangeId, currency) {
    const ex = this.getExchange(exchangeId);
    const balances = await wrapCall(exchangeId, 'getBalance', () => ex.fetchBalance());

    if (currency) {
      const cur = currency.toUpperCase();
      return {
        currency: cur,
        free: Number(balances[cur]?.free ?? 0),
        used: Number(balances[cur]?.used ?? 0),
        total: Number(balances[cur]?.total ?? 0),
      };
    }
    return balances;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Trading
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Place a market buy order.
   *
   * @param {string} exchangeId
   * @param {string} symbol
   * @param {number|string} amount - Quantity of base currency to buy
   * @returns {Promise<ccxt.Order>}
   */
  async createMarketBuy(exchangeId, symbol, amount) {
    const ex = this.getExchange(exchangeId);
    const sym = normalizeSymbol(symbol);
    const qty = Number(amount);
    log('TRADE', `MARKET BUY ${qty} ${sym}`, { exchange: exchangeId });
    return wrapCall(exchangeId, `marketBuy(${sym}, ${qty})`, () =>
      ex.createMarketBuyOrder(sym, qty),
    );
  }

  /**
   * Place a market sell order.
   *
   * @param {string} exchangeId
   * @param {string} symbol
   * @param {number|string} amount
   * @returns {Promise<ccxt.Order>}
   */
  async createMarketSell(exchangeId, symbol, amount) {
    const ex = this.getExchange(exchangeId);
    const sym = normalizeSymbol(symbol);
    const qty = Number(amount);
    log('TRADE', `MARKET SELL ${qty} ${sym}`, { exchange: exchangeId });
    return wrapCall(exchangeId, `marketSell(${sym}, ${qty})`, () =>
      ex.createMarketSellOrder(sym, qty),
    );
  }

  /**
   * Place a limit buy order.
   *
   * @param {string} exchangeId
   * @param {string} symbol
   * @param {number|string} amount
   * @param {number|string} price
   * @returns {Promise<ccxt.Order>}
   */
  async createLimitBuy(exchangeId, symbol, amount, price) {
    const ex = this.getExchange(exchangeId);
    const sym = normalizeSymbol(symbol);
    const qty = Number(amount);
    const px = Number(price);
    log('TRADE', `LIMIT BUY ${qty} ${sym} @ ${px}`, { exchange: exchangeId });
    return wrapCall(exchangeId, `limitBuy(${sym}, ${qty}, ${px})`, () =>
      ex.createLimitBuyOrder(sym, qty, px),
    );
  }

  /**
   * Place a limit sell order.
   *
   * @param {string} exchangeId
   * @param {string} symbol
   * @param {number|string} amount
   * @param {number|string} price
   * @returns {Promise<ccxt.Order>}
   */
  async createLimitSell(exchangeId, symbol, amount, price) {
    const ex = this.getExchange(exchangeId);
    const sym = normalizeSymbol(symbol);
    const qty = Number(amount);
    const px = Number(price);
    log('TRADE', `LIMIT SELL ${qty} ${sym} @ ${px}`, { exchange: exchangeId });
    return wrapCall(exchangeId, `limitSell(${sym}, ${qty}, ${px})`, () =>
      ex.createLimitSellOrder(sym, qty, px),
    );
  }

  /**
   * Cancel an open order.
   *
   * @param {string} exchangeId
   * @param {string} orderId
   * @param {string} symbol
   * @returns {Promise<ccxt.Order>}
   */
  async cancelOrder(exchangeId, orderId, symbol) {
    const ex = this.getExchange(exchangeId);
    const sym = normalizeSymbol(symbol);
    log('TRADE', `CANCEL order ${orderId} on ${sym}`, { exchange: exchangeId });
    return wrapCall(exchangeId, `cancelOrder(${orderId})`, () =>
      ex.cancelOrder(orderId, sym),
    );
  }

  /**
   * Get an order's current status.
   *
   * @param {string} exchangeId
   * @param {string} orderId
   * @param {string} symbol
   * @returns {Promise<ccxt.Order>}
   */
  async getOrder(exchangeId, orderId, symbol) {
    const ex = this.getExchange(exchangeId);
    const sym = normalizeSymbol(symbol);
    return wrapCall(exchangeId, `getOrder(${orderId})`, () =>
      ex.fetchOrder(orderId, sym),
    );
  }

  /**
   * Get open orders, optionally filtered by symbol.
   *
   * @param {string} exchangeId
   * @param {string} [symbol]
   * @returns {Promise<ccxt.Order[]>}
   */
  async getOpenOrders(exchangeId, symbol) {
    const ex = this.getExchange(exchangeId);
    const sym = symbol ? normalizeSymbol(symbol) : undefined;
    return wrapCall(exchangeId, `getOpenOrders(${sym ?? 'all'})`, () =>
      ex.fetchOpenOrders(sym),
    );
  }

  /**
   * Get closed/filled order history.
   *
   * @param {string} exchangeId
   * @param {string} [symbol]
   * @param {number|string} [since] - Start time (ms timestamp or ISO string)
   * @param {number} [limit=50]
   * @returns {Promise<ccxt.Order[]>}
   */
  async getClosedOrders(exchangeId, symbol, since, limit = 50) {
    const ex = this.getExchange(exchangeId);
    const sym = symbol ? normalizeSymbol(symbol) : undefined;
    const sinceMs = since ? (typeof since === 'string' ? new Date(since).getTime() : Number(since)) : undefined;
    return wrapCall(exchangeId, `getClosedOrders(${sym ?? 'all'})`, () =>
      ex.fetchClosedOrders(sym, sinceMs, limit),
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Portfolio
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Get a formatted portfolio with USD values for each holding.
   *
   * Fetches balances, then prices all non-zero holdings against USDT
   * (or USD where available) to compute current value.
   *
   * @param {string} exchangeId
   * @returns {Promise<Array<{currency: string, amount: number, usdValue: number}>>}
   */
  async getPortfolio(exchangeId) {
    const ex = this.getExchange(exchangeId);
    const balances = await wrapCall(exchangeId, 'getPortfolio:balance', () =>
      ex.fetchBalance(),
    );

    // Collect non-zero holdings
    const holdings = [];
    const total = balances.total || {};
    for (const [cur, amt] of Object.entries(total)) {
      const amount = Number(amt);
      if (amount > 0) {
        holdings.push({ currency: cur, amount });
      }
    }

    if (holdings.length === 0) return [];

    // Price each holding in USD
    const stablecoins = new Set(['USDT', 'USDC', 'BUSD', 'USD', 'DAI', 'TUSD']);
    const priceable = holdings.filter((h) => !stablecoins.has(h.currency));

    // Build list of symbols to fetch tickers for
    const tickerSymbols = priceable
      .map((h) => `${h.currency}/USDT`)
      .filter((sym, i, arr) => arr.indexOf(sym) === i);

    let tickers = {};
    if (tickerSymbols.length > 0) {
      try {
        tickers = await wrapCall(exchangeId, 'getPortfolio:tickers', () =>
          ex.fetchTickers(tickerSymbols),
        );
      } catch {
        // Some exchanges don't support batch tickers; fall back to individual
        for (const sym of tickerSymbols) {
          try {
            tickers[sym] = await wrapCall(exchangeId, `getPortfolio:ticker(${sym})`, () =>
              ex.fetchTicker(sym),
            );
          } catch {
            // Skip assets we can't price
          }
        }
      }
    }

    return holdings.map((h) => {
      if (stablecoins.has(h.currency)) {
        return { ...h, usdValue: h.amount };
      }
      const ticker = tickers[`${h.currency}/USDT`];
      const price = ticker?.last ?? 0;
      return { ...h, usdValue: h.amount * price };
    });
  }

  /**
   * Get total portfolio value in USD.
   *
   * @param {string} exchangeId
   * @returns {Promise<{totalUsd: number, holdings: number}>}
   */
  async getTotalValue(exchangeId) {
    const portfolio = await this.getPortfolio(exchangeId);
    const totalUsd = portfolio.reduce((sum, h) => sum + h.usdValue, 0);
    return { totalUsd: Math.round(totalUsd * 100) / 100, holdings: portfolio.length };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Utilities
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Fetch available markets/trading pairs on an exchange.
   *
   * @param {string} exchangeId
   * @returns {Promise<ccxt.Market[]>}
   */
  async getMarkets(exchangeId) {
    const ex = this.getExchange(exchangeId);
    return wrapCall(exchangeId, 'getMarkets', () => ex.loadMarkets());
  }

  /**
   * Check if an exchange is operational.
   *
   * @param {string} exchangeId
   * @returns {Promise<{id: string, status: string, updated: string|null, eta: string|null, url: string|null}>}
   */
  async getExchangeStatus(exchangeId) {
    const ex = this.getExchange(exchangeId);

    // Not all exchanges implement fetchStatus — graceful fallback
    try {
      const status = await wrapCall(exchangeId, 'getExchangeStatus', () =>
        ex.fetchStatus(),
      );
      return {
        id: exchangeId,
        status: status?.status ?? 'unknown',
        updated: status?.updated ?? null,
        eta: status?.eta ?? null,
        url: status?.url ?? null,
      };
    } catch {
      return { id: exchangeId, status: 'unknown (fetchStatus not supported)', updated: null, eta: null, url: null };
    }
  }

  /**
   * Format a base/quote pair into ccxt canonical form.
   *
   * @param {string} base  - e.g. 'BTC'
   * @param {string} quote - e.g. 'USDT'
   * @returns {string} 'BTC/USDT'
   */
  formatSymbol(base, quote) {
    return `${base.toUpperCase()}/${quote.toUpperCase()}`;
  }
}

// ─── Factory ────────────────────────────────────────────────────────────────

/**
 * Create a CryptoService instance from config.
 *
 * @param {import('./crypto-config.js').CryptoConfig} config
 * @returns {CryptoService}
 */
export function createCryptoService(config) {
  return new CryptoService(config);
}

export { CryptoService, CryptoServiceError, normalizeSymbol };
export default CryptoService;
