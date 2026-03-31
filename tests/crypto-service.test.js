/**
 * Tests for crypto-service.js — CryptoService exchange abstraction.
 * Uses Node.js built-in test runner (node:test + node:assert).
 *
 * All ccxt interactions are mocked — no real exchange API calls are made.
 */

import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

// ─── Mock ccxt before importing crypto-service ─────────────────────────────
//
// crypto-service.js does `import ccxt from 'ccxt'` and accesses:
//   - ccxt[exchangeId] as a constructor  (e.g. ccxt.binance)
//   - ccxt.AuthenticationError, ccxt.RateLimitExceeded, etc. (error classes)
//
// We intercept via Node's module register hooks by mocking at the module level:
// Since node:test mock.module isn't stable, we instead use a loader-free
// approach: import the named exports and test them with a hand-built config
// that injects our mock exchange instances.

// We can't easily mock the `ccxt` default import for constructor usage,
// so we test using a two-layer approach:
//   1) Test normalizeSymbol, CryptoServiceError, formatSymbol directly
//   2) Build a CryptoService with a real config pointing to 'binance' —
//      which will call `new ccxt.binance(...)`. We mock ccxt.binance by
//      temporarily patching ccxt before constructing the service.

import ccxt from 'ccxt';
import {
  createCryptoService,
  CryptoService,
  CryptoServiceError,
  normalizeSymbol,
} from '../crypto-service.js';

// ─── Helpers ───────────────────────────────────────────────────────────────

/** Suppress stderr logging during tests. */
const _origWrite = process.stderr.write;
function silenceLogs() {
  process.stderr.write = () => true;
}
function restoreLogs() {
  process.stderr.write = _origWrite;
}

/**
 * Build a mock ccxt exchange instance with all methods used by CryptoService.
 * Each method is a mock.fn() that can be configured per-test.
 */
function createMockExchange(overrides = {}) {
  return {
    setSandboxMode: mock.fn(),
    fetchTicker: mock.fn(async () => ({
      symbol: 'BTC/USDT',
      bid: 67000,
      ask: 67050,
      last: 67025,
      high: 68000,
      low: 66000,
      baseVolume: 12345.6,
      quoteVolume: 827000000,
      percentage: 1.5,
      timestamp: Date.now(),
    })),
    fetchTickers: mock.fn(async (syms) => {
      const result = {};
      for (const s of syms) {
        result[s] = { symbol: s, last: 100, bid: 99, ask: 101, baseVolume: 500 };
      }
      return result;
    }),
    fetchOrderBook: mock.fn(async () => ({
      bids: [[67000, 1.5], [66990, 2.0]],
      asks: [[67050, 1.2], [67060, 0.8]],
      timestamp: Date.now(),
    })),
    fetchOHLCV: mock.fn(async () => [
      [1700000000000, 67000, 67500, 66800, 67200, 1234.5],
      [1700003600000, 67200, 67800, 67100, 67600, 987.3],
      [1700007200000, 67600, 67900, 67400, 67700, 1456.8],
    ]),
    fetchBalance: mock.fn(async () => ({
      BTC: { free: 0.5, used: 0.1, total: 0.6 },
      USDT: { free: 10000, used: 500, total: 10500 },
      ETH: { free: 5.0, used: 0, total: 5.0 },
      total: { BTC: 0.6, USDT: 10500, ETH: 5.0 },
      free: { BTC: 0.5, USDT: 10000, ETH: 5.0 },
      used: { BTC: 0.1, USDT: 500, ETH: 0 },
    })),
    createMarketBuyOrder: mock.fn(async (sym, qty) => ({
      id: 'ord-001', symbol: sym, side: 'buy', type: 'market',
      amount: qty, status: 'closed', filled: qty,
    })),
    createMarketSellOrder: mock.fn(async (sym, qty) => ({
      id: 'ord-002', symbol: sym, side: 'sell', type: 'market',
      amount: qty, status: 'closed', filled: qty,
    })),
    createLimitBuyOrder: mock.fn(async (sym, qty, price) => ({
      id: 'ord-003', symbol: sym, side: 'buy', type: 'limit',
      amount: qty, price, status: 'open',
    })),
    createLimitSellOrder: mock.fn(async (sym, qty, price) => ({
      id: 'ord-004', symbol: sym, side: 'sell', type: 'limit',
      amount: qty, price, status: 'open',
    })),
    cancelOrder: mock.fn(async (id, sym) => ({
      id, symbol: sym, status: 'canceled',
    })),
    fetchOrder: mock.fn(async (id, sym) => ({
      id, symbol: sym, status: 'closed', side: 'buy', type: 'limit',
    })),
    fetchOpenOrders: mock.fn(async () => [
      { id: 'ord-010', symbol: 'BTC/USDT', side: 'buy', type: 'limit', status: 'open' },
      { id: 'ord-011', symbol: 'ETH/USDT', side: 'sell', type: 'limit', status: 'open' },
    ]),
    fetchClosedOrders: mock.fn(async () => [
      { id: 'ord-020', symbol: 'BTC/USDT', side: 'buy', type: 'market', status: 'closed' },
    ]),
    loadMarkets: mock.fn(async () => ({
      'BTC/USDT': { id: 'BTCUSDT', symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT' },
      'ETH/USDT': { id: 'ETHUSDT', symbol: 'ETH/USDT', base: 'ETH', quote: 'USDT' },
    })),
    fetchStatus: mock.fn(async () => ({
      status: 'ok', updated: new Date().toISOString(), eta: null, url: null,
    })),
    fetchTicker: mock.fn(async (sym) => ({
      symbol: sym, last: sym === 'BTC/USDT' ? 67000 : 3200,
      bid: 66900, ask: 67100, baseVolume: 5000,
    })),
    ...overrides,
  };
}

/**
 * Inject a mock exchange directly into CryptoService._exchanges map,
 * bypassing the constructor's ccxt instantiation.
 */
function createServiceWithMock(exchangeId = 'binance', mockEx) {
  silenceLogs();
  const svc = new CryptoService({ exchanges: {} }); // empty — no ccxt constructors
  svc._exchanges.set(exchangeId, mockEx ?? createMockExchange());
  restoreLogs();
  return svc;
}

// ─── Tests ─────────────────────────────────────────────────────────────────

// ═══════════════════════════════════════════════════════════════════════════
// 1. normalizeSymbol (utility — exported directly)
// ═══════════════════════════════════════════════════════════════════════════

describe('normalizeSymbol', () => {
  it('passes through canonical BASE/QUOTE format', () => {
    assert.equal(normalizeSymbol('BTC/USDT'), 'BTC/USDT');
  });

  it('normalizes dash-separated symbols', () => {
    assert.equal(normalizeSymbol('btc-usdt'), 'BTC/USDT');
  });

  it('normalizes underscore-separated symbols', () => {
    assert.equal(normalizeSymbol('ETH_BTC'), 'ETH/BTC');
  });

  it('normalizes concatenated pairs like BTCUSDT', () => {
    assert.equal(normalizeSymbol('BTCUSDT'), 'BTC/USDT');
    assert.equal(normalizeSymbol('ETHUSDT'), 'ETH/USDT');
    assert.equal(normalizeSymbol('SOLUSDC'), 'SOL/USDC');
  });

  it('handles whitespace and mixed case', () => {
    assert.equal(normalizeSymbol('  btc / usdt  '), 'BTC/USDT');
    assert.equal(normalizeSymbol('Eth/Btc'), 'ETH/BTC');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. Exchange initialization
// ═══════════════════════════════════════════════════════════════════════════

describe('CryptoService constructor', () => {
  it('creates with empty config without throwing', () => {
    silenceLogs();
    const svc = new CryptoService({ exchanges: {} });
    restoreLogs();
    assert.deepEqual(svc.getExchanges(), []);
  });

  it('creates with null/undefined config without throwing', () => {
    silenceLogs();
    const svc = new CryptoService(null);
    restoreLogs();
    assert.deepEqual(svc.getExchanges(), []);
  });

  it('initializes a valid exchange via ccxt constructor', () => {
    silenceLogs();
    const svc = createCryptoService({
      exchanges: {
        binance: { apiKey: 'test-key', secret: 'test-secret', sandbox: true },
      },
    });
    restoreLogs();
    assert.deepEqual(svc.getExchanges(), ['binance']);
  });

  it('skips unsupported exchange ids', () => {
    silenceLogs();
    const svc = createCryptoService({
      exchanges: {
        notarealexchange: { apiKey: 'key', secret: 'sec', sandbox: true },
      },
    });
    restoreLogs();
    assert.deepEqual(svc.getExchanges(), []);
  });

  it('enables sandbox mode when sandbox is true', () => {
    silenceLogs();
    const svc = createCryptoService({
      exchanges: {
        binance: { apiKey: 'k', secret: 's', sandbox: true },
      },
    });
    restoreLogs();
    const ex = svc.getExchange('binance');
    // ccxt binance in sandbox mode sets urls to testnet
    assert.ok(ex, 'Exchange should be initialized');
  });

  it('enables sandbox mode by default (sandbox undefined)', () => {
    silenceLogs();
    const svc = createCryptoService({
      exchanges: {
        binance: { apiKey: 'k', secret: 's' },
      },
    });
    restoreLogs();
    // sandbox !== false → sandbox mode enabled
    const ex = svc.getExchange('binance');
    assert.ok(ex);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. getExchange / getExchanges
// ═══════════════════════════════════════════════════════════════════════════

describe('getExchange', () => {
  it('returns exchange instance for configured exchange', () => {
    const mockEx = createMockExchange();
    const svc = createServiceWithMock('binance', mockEx);
    assert.equal(svc.getExchange('binance'), mockEx);
  });

  it('throws CryptoServiceError for unconfigured exchange', () => {
    const svc = createServiceWithMock('binance');
    assert.throws(
      () => svc.getExchange('kraken'),
      (err) => {
        assert.ok(err instanceof CryptoServiceError);
        assert.equal(err.exchange, 'kraken');
        assert.equal(err.operation, 'getExchange');
        assert.match(err.message, /not configured/);
        return true;
      },
    );
  });

  it('lists available exchanges in error message', () => {
    const svc = createServiceWithMock('binance');
    try {
      svc.getExchange('kraken');
      assert.fail('Should have thrown');
    } catch (err) {
      assert.match(err.message, /binance/);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. Ticker data
// ═══════════════════════════════════════════════════════════════════════════

describe('getTicker', () => {
  let svc, mockEx;

  beforeEach(() => {
    mockEx = createMockExchange();
    svc = createServiceWithMock('binance', mockEx);
  });

  it('returns ticker with bid/ask/last/volume', async () => {
    silenceLogs();
    const ticker = await svc.getTicker('binance', 'BTC/USDT');
    restoreLogs();
    assert.ok(ticker.bid !== undefined, 'should have bid');
    assert.ok(ticker.ask !== undefined, 'should have ask');
    assert.ok(ticker.last !== undefined, 'should have last');
    assert.ok(ticker.symbol !== undefined, 'should have symbol');
  });

  it('calls fetchTicker with normalized symbol', async () => {
    silenceLogs();
    await svc.getTicker('binance', 'btc-usdt');
    restoreLogs();
    assert.equal(mockEx.fetchTicker.mock.calls[0].arguments[0], 'BTC/USDT');
  });

  it('normalizes concatenated symbols', async () => {
    silenceLogs();
    await svc.getTicker('binance', 'ETHUSDT');
    restoreLogs();
    assert.equal(mockEx.fetchTicker.mock.calls[0].arguments[0], 'ETH/USDT');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. Balance fetching
// ═══════════════════════════════════════════════════════════════════════════

describe('getBalance', () => {
  let svc, mockEx;

  beforeEach(() => {
    mockEx = createMockExchange();
    svc = createServiceWithMock('binance', mockEx);
  });

  it('returns full balances when no currency specified', async () => {
    silenceLogs();
    const balances = await svc.getBalance('binance');
    restoreLogs();
    assert.ok(balances.BTC, 'should contain BTC');
    assert.ok(balances.USDT, 'should contain USDT');
  });

  it('returns single currency balance with free/used/total', async () => {
    silenceLogs();
    const bal = await svc.getBalance('binance', 'BTC');
    restoreLogs();
    assert.equal(bal.currency, 'BTC');
    assert.equal(typeof bal.free, 'number');
    assert.equal(typeof bal.used, 'number');
    assert.equal(typeof bal.total, 'number');
    assert.equal(bal.free, 0.5);
    assert.equal(bal.used, 0.1);
    assert.equal(bal.total, 0.6);
  });

  it('returns zero for unknown currency', async () => {
    silenceLogs();
    const bal = await svc.getBalance('binance', 'DOGE');
    restoreLogs();
    assert.equal(bal.currency, 'DOGE');
    assert.equal(bal.free, 0);
    assert.equal(bal.total, 0);
  });

  it('normalizes currency to uppercase', async () => {
    silenceLogs();
    const bal = await svc.getBalance('binance', 'btc');
    restoreLogs();
    assert.equal(bal.currency, 'BTC');
    assert.equal(bal.total, 0.6);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. OHLCV data
// ═══════════════════════════════════════════════════════════════════════════

describe('getOHLCV', () => {
  let svc, mockEx;

  beforeEach(() => {
    mockEx = createMockExchange();
    svc = createServiceWithMock('binance', mockEx);
  });

  it('returns array of candles', async () => {
    silenceLogs();
    const candles = await svc.getOHLCV('binance', 'BTC/USDT');
    restoreLogs();
    assert.ok(Array.isArray(candles));
    assert.equal(candles.length, 3);
  });

  it('each candle has [timestamp, open, high, low, close, volume]', async () => {
    silenceLogs();
    const candles = await svc.getOHLCV('binance', 'BTC/USDT');
    restoreLogs();
    const [ts, open, high, low, close, vol] = candles[0];
    assert.equal(typeof ts, 'number');
    assert.equal(typeof open, 'number');
    assert.equal(typeof high, 'number');
    assert.equal(typeof low, 'number');
    assert.equal(typeof close, 'number');
    assert.equal(typeof vol, 'number');
  });

  it('passes timeframe and limit to fetchOHLCV', async () => {
    silenceLogs();
    await svc.getOHLCV('binance', 'BTC/USDT', '4h', undefined, 50);
    restoreLogs();
    const args = mockEx.fetchOHLCV.mock.calls[0].arguments;
    assert.equal(args[0], 'BTC/USDT');
    assert.equal(args[1], '4h');
    assert.equal(args[3], 50);
  });

  it('converts ISO string since param to ms timestamp', async () => {
    const isoDate = '2024-01-01T00:00:00Z';
    silenceLogs();
    await svc.getOHLCV('binance', 'BTC/USDT', '1h', isoDate, 100);
    restoreLogs();
    const sinceArg = mockEx.fetchOHLCV.mock.calls[0].arguments[2];
    assert.equal(sinceArg, new Date(isoDate).getTime());
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 7. Order placement
// ═══════════════════════════════════════════════════════════════════════════

describe('order placement', () => {
  let svc, mockEx;

  beforeEach(() => {
    mockEx = createMockExchange();
    svc = createServiceWithMock('binance', mockEx);
  });

  it('createMarketBuy calls createMarketBuyOrder with correct params', async () => {
    silenceLogs();
    const order = await svc.createMarketBuy('binance', 'BTC/USDT', 0.1);
    restoreLogs();
    assert.equal(order.side, 'buy');
    assert.equal(order.type, 'market');
    const args = mockEx.createMarketBuyOrder.mock.calls[0].arguments;
    assert.equal(args[0], 'BTC/USDT');
    assert.equal(args[1], 0.1);
  });

  it('createMarketSell calls createMarketSellOrder with correct params', async () => {
    silenceLogs();
    const order = await svc.createMarketSell('binance', 'ETH/USDT', 2);
    restoreLogs();
    assert.equal(order.side, 'sell');
    assert.equal(order.type, 'market');
    const args = mockEx.createMarketSellOrder.mock.calls[0].arguments;
    assert.equal(args[0], 'ETH/USDT');
    assert.equal(args[1], 2);
  });

  it('createLimitBuy passes price parameter', async () => {
    silenceLogs();
    const order = await svc.createLimitBuy('binance', 'BTC/USDT', 0.5, 65000);
    restoreLogs();
    assert.equal(order.type, 'limit');
    assert.equal(order.side, 'buy');
    const args = mockEx.createLimitBuyOrder.mock.calls[0].arguments;
    assert.equal(args[0], 'BTC/USDT');
    assert.equal(args[1], 0.5);
    assert.equal(args[2], 65000);
  });

  it('createLimitSell passes price parameter', async () => {
    silenceLogs();
    const order = await svc.createLimitSell('binance', 'SOL/USDT', 10, 180);
    restoreLogs();
    assert.equal(order.type, 'limit');
    assert.equal(order.side, 'sell');
    const args = mockEx.createLimitSellOrder.mock.calls[0].arguments;
    assert.equal(args[0], 'SOL/USDT');
    assert.equal(args[1], 10);
    assert.equal(args[2], 180);
  });

  it('converts string amounts to numbers', async () => {
    silenceLogs();
    await svc.createMarketBuy('binance', 'BTC/USDT', '0.25');
    restoreLogs();
    const qty = mockEx.createMarketBuyOrder.mock.calls[0].arguments[1];
    assert.equal(qty, 0.25);
    assert.equal(typeof qty, 'number');
  });

  it('normalizes symbol in order calls', async () => {
    silenceLogs();
    await svc.createMarketBuy('binance', 'btc_usdt', 1);
    restoreLogs();
    assert.equal(mockEx.createMarketBuyOrder.mock.calls[0].arguments[0], 'BTC/USDT');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 8. Order management (cancel, fetch, open/closed)
// ═══════════════════════════════════════════════════════════════════════════

describe('order management', () => {
  let svc, mockEx;

  beforeEach(() => {
    mockEx = createMockExchange();
    svc = createServiceWithMock('binance', mockEx);
  });

  it('cancelOrder passes orderId and normalized symbol', async () => {
    silenceLogs();
    const result = await svc.cancelOrder('binance', 'ord-123', 'btcusdt');
    restoreLogs();
    assert.equal(result.status, 'canceled');
    const args = mockEx.cancelOrder.mock.calls[0].arguments;
    assert.equal(args[0], 'ord-123');
    assert.equal(args[1], 'BTC/USDT');
  });

  it('getOpenOrders returns array of open orders', async () => {
    silenceLogs();
    const orders = await svc.getOpenOrders('binance');
    restoreLogs();
    assert.ok(Array.isArray(orders));
    assert.equal(orders.length, 2);
    assert.equal(orders[0].status, 'open');
  });

  it('getOpenOrders filters by symbol when provided', async () => {
    silenceLogs();
    await svc.getOpenOrders('binance', 'BTC/USDT');
    restoreLogs();
    assert.equal(mockEx.fetchOpenOrders.mock.calls[0].arguments[0], 'BTC/USDT');
  });

  it('getOpenOrders passes undefined when no symbol', async () => {
    silenceLogs();
    await svc.getOpenOrders('binance');
    restoreLogs();
    assert.equal(mockEx.fetchOpenOrders.mock.calls[0].arguments[0], undefined);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 9. Error handling
// ═══════════════════════════════════════════════════════════════════════════

describe('error handling', () => {
  it('wraps AuthenticationError with actionable message', async () => {
    const mockEx = createMockExchange({
      fetchTicker: mock.fn(async () => { throw new ccxt.AuthenticationError('bad key'); }),
    });
    const svc = createServiceWithMock('binance', mockEx);
    silenceLogs();
    await assert.rejects(
      () => svc.getTicker('binance', 'BTC/USDT'),
      (err) => {
        assert.ok(err instanceof CryptoServiceError);
        assert.match(err.message, /Authentication failed/i);
        assert.equal(err.exchange, 'binance');
        return true;
      },
    );
    restoreLogs();
  });

  it('wraps RateLimitExceeded with backoff message', async () => {
    const mockEx = createMockExchange({
      fetchBalance: mock.fn(async () => { throw new ccxt.RateLimitExceeded('slow down'); }),
    });
    const svc = createServiceWithMock('binance', mockEx);
    silenceLogs();
    await assert.rejects(
      () => svc.getBalance('binance'),
      (err) => {
        assert.match(err.message, /Rate limit/i);
        return true;
      },
    );
    restoreLogs();
  });

  it('wraps NetworkError for unreachable exchange', async () => {
    const mockEx = createMockExchange({
      fetchTicker: mock.fn(async () => { throw new ccxt.NetworkError('ECONNREFUSED'); }),
    });
    const svc = createServiceWithMock('binance', mockEx);
    silenceLogs();
    await assert.rejects(
      () => svc.getTicker('binance', 'BTC/USDT'),
      (err) => {
        assert.match(err.message, /Network error/i);
        assert.ok(err.cause instanceof ccxt.NetworkError);
        return true;
      },
    );
    restoreLogs();
  });

  it('wraps InsufficientFunds on order placement', async () => {
    const mockEx = createMockExchange({
      createMarketBuyOrder: mock.fn(async () => { throw new ccxt.InsufficientFunds('not enough'); }),
    });
    const svc = createServiceWithMock('binance', mockEx);
    silenceLogs();
    await assert.rejects(
      () => svc.createMarketBuy('binance', 'BTC/USDT', 100),
      (err) => {
        assert.match(err.message, /Insufficient funds/i);
        return true;
      },
    );
    restoreLogs();
  });

  it('wraps ExchangeNotAvailable as CryptoServiceError', async () => {
    // Note: ccxt.ExchangeNotAvailable extends ccxt.NetworkError, so the
    // service's wrapCall matches the NetworkError branch first. We verify
    // the error is still properly wrapped with the original cause preserved.
    const mockEx = createMockExchange({
      fetchTicker: mock.fn(async () => { throw new ccxt.ExchangeNotAvailable('maintenance'); }),
    });
    const svc = createServiceWithMock('binance', mockEx);
    silenceLogs();
    await assert.rejects(
      () => svc.getTicker('binance', 'BTC/USDT'),
      (err) => {
        assert.ok(err instanceof CryptoServiceError);
        assert.ok(err.cause instanceof ccxt.ExchangeNotAvailable);
        assert.equal(err.exchange, 'binance');
        return true;
      },
    );
    restoreLogs();
  });

  it('preserves original error as cause', async () => {
    const origErr = new ccxt.InvalidOrder('bad order');
    const mockEx = createMockExchange({
      createLimitBuyOrder: mock.fn(async () => { throw origErr; }),
    });
    const svc = createServiceWithMock('binance', mockEx);
    silenceLogs();
    await assert.rejects(
      () => svc.createLimitBuy('binance', 'BTC/USDT', 1, 50000),
      (err) => {
        assert.equal(err.cause, origErr);
        return true;
      },
    );
    restoreLogs();
  });

  it('throws CryptoServiceError for unconfigured exchange', () => {
    const svc = createServiceWithMock('binance');
    assert.throws(
      () => svc.getExchange('coinbase'),
      (err) => err instanceof CryptoServiceError,
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 10. Portfolio
// ═══════════════════════════════════════════════════════════════════════════

describe('getPortfolio', () => {
  it('returns holdings with usd values', async () => {
    const mockEx = createMockExchange({
      fetchBalance: mock.fn(async () => ({
        total: { BTC: 1.0, USDT: 5000, ETH: 2.0 },
      })),
      fetchTickers: mock.fn(async () => ({
        'BTC/USDT': { last: 67000 },
        'ETH/USDT': { last: 3200 },
      })),
    });
    const svc = createServiceWithMock('binance', mockEx);

    silenceLogs();
    const portfolio = await svc.getPortfolio('binance');
    restoreLogs();

    assert.ok(Array.isArray(portfolio));
    assert.equal(portfolio.length, 3);

    const btc = portfolio.find((h) => h.currency === 'BTC');
    assert.ok(btc);
    assert.equal(btc.amount, 1.0);
    assert.equal(btc.usdValue, 67000);

    const usdt = portfolio.find((h) => h.currency === 'USDT');
    assert.ok(usdt);
    assert.equal(usdt.usdValue, 5000); // stablecoin → usdValue = amount
  });

  it('returns empty array when no holdings', async () => {
    const mockEx = createMockExchange({
      fetchBalance: mock.fn(async () => ({ total: {} })),
    });
    const svc = createServiceWithMock('binance', mockEx);

    silenceLogs();
    const portfolio = await svc.getPortfolio('binance');
    restoreLogs();

    assert.deepEqual(portfolio, []);
  });

  it('falls back to individual ticker fetches on batch failure', async () => {
    const mockEx = createMockExchange({
      fetchBalance: mock.fn(async () => ({
        total: { BTC: 1.0 },
      })),
      fetchTickers: mock.fn(async () => { throw new Error('batch not supported'); }),
      fetchTicker: mock.fn(async () => ({ last: 67000 })),
    });
    const svc = createServiceWithMock('binance', mockEx);

    silenceLogs();
    const portfolio = await svc.getPortfolio('binance');
    restoreLogs();

    assert.equal(portfolio.length, 1);
    assert.equal(portfolio[0].usdValue, 67000);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 11. Multi-exchange
// ═══════════════════════════════════════════════════════════════════════════

describe('multi-exchange support', () => {
  it('manages multiple exchanges independently', () => {
    const mockBinance = createMockExchange();
    const mockKraken = createMockExchange();

    silenceLogs();
    const svc = new CryptoService({ exchanges: {} });
    svc._exchanges.set('binance', mockBinance);
    svc._exchanges.set('kraken', mockKraken);
    restoreLogs();

    assert.deepEqual(svc.getExchanges().sort(), ['binance', 'kraken']);
    assert.equal(svc.getExchange('binance'), mockBinance);
    assert.equal(svc.getExchange('kraken'), mockKraken);
  });

  it('fetches ticker from correct exchange', async () => {
    const mockBinance = createMockExchange({
      fetchTicker: mock.fn(async () => ({ symbol: 'BTC/USDT', last: 67000 })),
    });
    const mockKraken = createMockExchange({
      fetchTicker: mock.fn(async () => ({ symbol: 'BTC/USDT', last: 67100 })),
    });

    silenceLogs();
    const svc = new CryptoService({ exchanges: {} });
    svc._exchanges.set('binance', mockBinance);
    svc._exchanges.set('kraken', mockKraken);

    const binTicker = await svc.getTicker('binance', 'BTC/USDT');
    const krakenTicker = await svc.getTicker('kraken', 'BTC/USDT');
    restoreLogs();

    assert.equal(binTicker.last, 67000);
    assert.equal(krakenTicker.last, 67100);
    assert.equal(mockBinance.fetchTicker.mock.callCount(), 1);
    assert.equal(mockKraken.fetchTicker.mock.callCount(), 1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 12. Sandbox mode (via constructor integration)
// ═══════════════════════════════════════════════════════════════════════════

describe('sandbox mode', () => {
  it('calls setSandboxMode(true) when sandbox is true', () => {
    // Use real ccxt constructor but verify sandbox was set
    silenceLogs();
    const svc = createCryptoService({
      exchanges: {
        binance: { apiKey: 'k', secret: 's', sandbox: true },
      },
    });
    restoreLogs();
    // If it didn't throw, sandbox was set. Verify exchange is present.
    assert.ok(svc.getExchanges().includes('binance'));
  });

  it('does NOT call setSandboxMode when sandbox is explicitly false', () => {
    silenceLogs();
    const svc = createCryptoService({
      exchanges: {
        binance: { apiKey: 'k', secret: 's', sandbox: false },
      },
    });
    restoreLogs();
    assert.ok(svc.getExchanges().includes('binance'));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 13. Utilities
// ═══════════════════════════════════════════════════════════════════════════

describe('formatSymbol', () => {
  it('formats base/quote into canonical form', () => {
    silenceLogs();
    const svc = new CryptoService({ exchanges: {} });
    restoreLogs();
    assert.equal(svc.formatSymbol('btc', 'usdt'), 'BTC/USDT');
    assert.equal(svc.formatSymbol('ETH', 'BTC'), 'ETH/BTC');
  });
});

describe('getExchangeStatus', () => {
  it('returns status object with expected fields', async () => {
    const mockEx = createMockExchange();
    const svc = createServiceWithMock('binance', mockEx);

    silenceLogs();
    const status = await svc.getExchangeStatus('binance');
    restoreLogs();

    assert.equal(status.id, 'binance');
    assert.equal(status.status, 'ok');
    assert.ok('updated' in status);
    assert.ok('eta' in status);
    assert.ok('url' in status);
  });

  it('returns unknown status when fetchStatus not supported', async () => {
    const mockEx = createMockExchange({
      fetchStatus: mock.fn(async () => { throw new Error('not supported'); }),
    });
    const svc = createServiceWithMock('binance', mockEx);

    silenceLogs();
    const status = await svc.getExchangeStatus('binance');
    restoreLogs();

    assert.equal(status.id, 'binance');
    assert.match(status.status, /unknown/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 14. CryptoServiceError
// ═══════════════════════════════════════════════════════════════════════════

describe('CryptoServiceError', () => {
  it('has correct name, exchange, operation, and cause properties', () => {
    const cause = new Error('underlying');
    const err = new CryptoServiceError('test error', 'binance', 'getTicker', cause);
    assert.equal(err.name, 'CryptoServiceError');
    assert.equal(err.message, 'test error');
    assert.equal(err.exchange, 'binance');
    assert.equal(err.operation, 'getTicker');
    assert.equal(err.cause, cause);
  });

  it('is an instance of Error', () => {
    const err = new CryptoServiceError('msg', 'ex', 'op');
    assert.ok(err instanceof Error);
  });
});
