/**
 * crypto-tools.js — MCP tool definitions and handlers for crypto trading.
 *
 * Provides 11 tools for market data, account management, trading, and analysis.
 * Designed to integrate with the existing mcp-server.js setRequestHandler pattern.
 *
 * Exports:
 *   getCryptoToolDefinitions()              — tool schemas for ListToolsRequestSchema
 *   handleCryptoToolCall(name, args, svc)   — dispatcher for CallToolRequestSchema
 *   registerCryptoTools(server, svc)        — convenience for server.tool() API
 */

const DEFAULT_EXCHANGE = 'binance';
const CRYPTO_TOOL_PREFIX = 'get_crypto_';
const CRYPTO_TOOL_NAMES = new Set([
  'get_crypto_ticker',
  'get_crypto_ohlcv',
  'get_crypto_orderbook',
  'get_crypto_tickers',
  'get_crypto_balance',
  'get_crypto_portfolio',
  'place_crypto_order',
  'cancel_crypto_order',
  'get_crypto_orders',
  'get_crypto_markets',
  'get_crypto_exchange_status',
]);

// ───────────────────────────────────────────────────────────────────────────
// Response helpers — match mcp-server.js format exactly
// ───────────────────────────────────────────────────────────────────────────

function ok(data) {
  return {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
  };
}

function fail(message) {
  return {
    content: [{ type: 'text', text: `Error: ${message}` }],
    isError: true,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Tool Definitions
// ───────────────────────────────────────────────────────────────────────────

export function getCryptoToolDefinitions() {
  return [
    // ── Market Data ──────────────────────────────────────────────────────

    {
      name: 'get_crypto_ticker',
      description:
        'Get current price, 24h high/low, percent change, and volume for a crypto pair. ' +
        'Use this to check the latest price of any cryptocurrency. ' +
        'Example: get_crypto_ticker({ symbol: "BTC/USDT" }) returns price, 24h stats, and timestamp.',
      inputSchema: {
        type: 'object',
        properties: {
          exchange: {
            type: 'string',
            description: 'Exchange ID: "binance", "coinbase", or "kraken". Defaults to "binance".',
          },
          symbol: {
            type: 'string',
            description: 'Trading pair in BASE/QUOTE format, e.g. "BTC/USDT", "ETH/BTC", "SOL/USDT".',
          },
        },
        required: ['symbol'],
      },
    },

    {
      name: 'get_crypto_ohlcv',
      description:
        'Get historical candlestick (OHLCV) data for charting and technical analysis. ' +
        'Returns arrays of [timestamp, open, high, low, close, volume]. ' +
        'Example: get_crypto_ohlcv({ symbol: "ETH/USDT", timeframe: "4h", limit: 50 }).',
      inputSchema: {
        type: 'object',
        properties: {
          exchange: {
            type: 'string',
            description: 'Exchange ID. Defaults to "binance".',
          },
          symbol: {
            type: 'string',
            description: 'Trading pair, e.g. "BTC/USDT".',
          },
          timeframe: {
            type: 'string',
            description: 'Candle interval: 1m, 5m, 15m, 1h, 4h, or 1d. Defaults to "1h".',
            enum: ['1m', '5m', '15m', '1h', '4h', '1d'],
          },
          limit: {
            type: 'number',
            description: 'Number of candles to return. Defaults to 100, max 1000.',
          },
        },
        required: ['symbol'],
      },
    },

    {
      name: 'get_crypto_orderbook',
      description:
        'Get the order book (bid/ask depth) for a crypto pair. ' +
        'Returns top bids, top asks, spread, and mid-price. Useful for gauging liquidity and slippage. ' +
        'Example: get_crypto_orderbook({ symbol: "BTC/USDT", limit: 10 }).',
      inputSchema: {
        type: 'object',
        properties: {
          exchange: {
            type: 'string',
            description: 'Exchange ID. Defaults to "binance".',
          },
          symbol: {
            type: 'string',
            description: 'Trading pair, e.g. "BTC/USDT".',
          },
          limit: {
            type: 'number',
            description: 'Number of price levels per side. Defaults to 20.',
          },
        },
        required: ['symbol'],
      },
    },

    {
      name: 'get_crypto_tickers',
      description:
        'Get current prices and 24h stats for multiple crypto pairs in one call. ' +
        'More efficient than calling get_crypto_ticker repeatedly. ' +
        'Example: get_crypto_tickers({ symbols: ["BTC/USDT", "ETH/USDT", "SOL/USDT"] }).',
      inputSchema: {
        type: 'object',
        properties: {
          exchange: {
            type: 'string',
            description: 'Exchange ID. Defaults to "binance".',
          },
          symbols: {
            type: 'array',
            items: { type: 'string' },
            description: 'Array of trading pairs, e.g. ["BTC/USDT", "ETH/USDT"].',
          },
        },
        required: ['symbols'],
      },
    },

    // ── Account ──────────────────────────────────────────────────────────

    {
      name: 'get_crypto_balance',
      description:
        'Get exchange wallet balances showing free, used, and total amounts per currency. ' +
        'Use this to check how much of each crypto you hold and what is available to trade. ' +
        'Example: get_crypto_balance({ exchange: "binance" }).',
      inputSchema: {
        type: 'object',
        properties: {
          exchange: {
            type: 'string',
            description: 'Exchange ID. Defaults to "binance".',
          },
        },
      },
    },

    {
      name: 'get_crypto_portfolio',
      description:
        'Get a formatted portfolio overview with USD values for all holdings. ' +
        'Shows each asset with quantity, estimated USD value, and portfolio allocation percentage. ' +
        'Example: get_crypto_portfolio({ exchange: "binance" }).',
      inputSchema: {
        type: 'object',
        properties: {
          exchange: {
            type: 'string',
            description: 'Exchange ID. Defaults to "binance".',
          },
        },
      },
    },

    // ── Trading ──────────────────────────────────────────────────────────

    {
      name: 'place_crypto_order',
      description:
        'Place a crypto trade — buy or sell, market or limit order. ' +
        'Market orders execute immediately at best price. Limit orders wait for the specified price. ' +
        'Example market buy: place_crypto_order({ symbol: "BTC/USDT", side: "buy", type: "market", amount: 0.001 }). ' +
        'Example limit sell: place_crypto_order({ symbol: "ETH/USDT", side: "sell", type: "limit", amount: 1.5, price: 4000 }).',
      inputSchema: {
        type: 'object',
        properties: {
          exchange: {
            type: 'string',
            description: 'Exchange ID. Defaults to "binance".',
          },
          symbol: {
            type: 'string',
            description: 'Trading pair, e.g. "BTC/USDT".',
          },
          side: {
            type: 'string',
            description: 'Order side.',
            enum: ['buy', 'sell'],
          },
          type: {
            type: 'string',
            description: 'Order type. Market executes immediately; limit waits for the target price.',
            enum: ['market', 'limit'],
          },
          amount: {
            type: 'number',
            description: 'Quantity of the base currency to trade (e.g. 0.5 for 0.5 BTC).',
          },
          price: {
            type: 'number',
            description: 'Limit price in quote currency. Required for limit orders, ignored for market.',
          },
        },
        required: ['symbol', 'side', 'type', 'amount'],
      },
    },

    {
      name: 'cancel_crypto_order',
      description:
        'Cancel a pending (open) crypto order by its order ID. ' +
        'Example: cancel_crypto_order({ orderId: "12345", symbol: "BTC/USDT" }).',
      inputSchema: {
        type: 'object',
        properties: {
          exchange: {
            type: 'string',
            description: 'Exchange ID. Defaults to "binance".',
          },
          orderId: {
            type: 'string',
            description: 'The exchange-assigned order ID to cancel.',
          },
          symbol: {
            type: 'string',
            description: 'Trading pair the order was placed on, e.g. "BTC/USDT".',
          },
        },
        required: ['orderId', 'symbol'],
      },
    },

    {
      name: 'get_crypto_orders',
      description:
        'Get open, closed, or all orders. Use to check pending orders or review trade history. ' +
        'Example: get_crypto_orders({ symbol: "BTC/USDT", status: "open" }).',
      inputSchema: {
        type: 'object',
        properties: {
          exchange: {
            type: 'string',
            description: 'Exchange ID. Defaults to "binance".',
          },
          symbol: {
            type: 'string',
            description: 'Filter by trading pair. If omitted, returns orders for all pairs.',
          },
          status: {
            type: 'string',
            description: 'Order status filter. Defaults to "open".',
            enum: ['open', 'closed', 'all'],
          },
        },
      },
    },

    // ── Analysis ─────────────────────────────────────────────────────────

    {
      name: 'get_crypto_markets',
      description:
        'List available trading pairs on an exchange. Filter by base or quote currency. ' +
        'Useful for discovering what can be traded. ' +
        'Example: get_crypto_markets({ base: "BTC" }) lists all BTC trading pairs. ' +
        'Example: get_crypto_markets({ quote: "USDT" }) lists all USDT-quoted pairs.',
      inputSchema: {
        type: 'object',
        properties: {
          exchange: {
            type: 'string',
            description: 'Exchange ID. Defaults to "binance".',
          },
          base: {
            type: 'string',
            description: 'Filter by base currency, e.g. "BTC", "ETH".',
          },
          quote: {
            type: 'string',
            description: 'Filter by quote currency, e.g. "USDT", "BTC".',
          },
        },
      },
    },

    {
      name: 'get_crypto_exchange_status',
      description:
        'Check whether an exchange is operational or under maintenance. ' +
        'Call this before placing trades if you suspect connectivity issues. ' +
        'Example: get_crypto_exchange_status({ exchange: "binance" }).',
      inputSchema: {
        type: 'object',
        properties: {
          exchange: {
            type: 'string',
            description: 'Exchange ID. Defaults to "binance".',
          },
        },
      },
    },
  ];
}

// ───────────────────────────────────────────────────────────────────────────
// Tool Handlers
// ───────────────────────────────────────────────────────────────────────────

/**
 * Check if a tool name belongs to the crypto module.
 * @param {string} name
 * @returns {boolean}
 */
export function isCryptoTool(name) {
  return CRYPTO_TOOL_NAMES.has(name);
}

/**
 * Dispatch a crypto tool call and return an MCP response.
 * Returns null if `name` is not a crypto tool.
 *
 * @param {string} name   — tool name from request.params.name
 * @param {object} args   — tool arguments from request.params.arguments
 * @param {import('./crypto-service.js').CryptoService} svc
 * @returns {Promise<{content: Array, isError?: boolean} | null>}
 */
export async function handleCryptoToolCall(name, args, svc) {
  if (!CRYPTO_TOOL_NAMES.has(name)) return null;

  try {
    switch (name) {
      case 'get_crypto_ticker':
        return await handleGetTicker(args, svc);
      case 'get_crypto_ohlcv':
        return await handleGetOHLCV(args, svc);
      case 'get_crypto_orderbook':
        return await handleGetOrderbook(args, svc);
      case 'get_crypto_tickers':
        return await handleGetTickers(args, svc);
      case 'get_crypto_balance':
        return await handleGetBalance(args, svc);
      case 'get_crypto_portfolio':
        return await handleGetPortfolio(args, svc);
      case 'place_crypto_order':
        return await handlePlaceOrder(args, svc);
      case 'cancel_crypto_order':
        return await handleCancelOrder(args, svc);
      case 'get_crypto_orders':
        return await handleGetOrders(args, svc);
      case 'get_crypto_markets':
        return await handleGetMarkets(args, svc);
      case 'get_crypto_exchange_status':
        return await handleGetExchangeStatus(args, svc);
      default:
        return null;
    }
  } catch (error) {
    return fail(error.message);
  }
}

// ── Market Data ────────────────────────────────────────────────────────────

async function handleGetTicker(args, svc) {
  const exchange = args.exchange || DEFAULT_EXCHANGE;
  const ticker = await svc.getTicker(exchange, args.symbol);

  return ok({
    symbol: ticker.symbol,
    price: ticker.last,
    high24h: ticker.high,
    low24h: ticker.low,
    change24h: ticker.percentage,
    volume24h: ticker.baseVolume,
    quoteVolume24h: ticker.quoteVolume,
    bid: ticker.bid,
    ask: ticker.ask,
    timestamp: ticker.datetime || new Date(ticker.timestamp).toISOString(),
    exchange,
  });
}

async function handleGetOHLCV(args, svc) {
  const exchange = args.exchange || DEFAULT_EXCHANGE;
  const timeframe = args.timeframe || '1h';
  const limit = Math.min(args.limit || 100, 1000);

  const candles = await svc.getOHLCV(exchange, args.symbol, timeframe, undefined, limit);

  return ok({
    symbol: args.symbol,
    timeframe,
    count: candles.length,
    exchange,
    candles: candles.map(([ts, o, h, l, c, v]) => ({
      timestamp: new Date(ts).toISOString(),
      open: o,
      high: h,
      low: l,
      close: c,
      volume: v,
    })),
  });
}

async function handleGetOrderbook(args, svc) {
  const exchange = args.exchange || DEFAULT_EXCHANGE;
  const limit = args.limit || 20;

  const book = await svc.getOrderBook(exchange, args.symbol, limit);

  const bestBid = book.bids.length > 0 ? book.bids[0][0] : null;
  const bestAsk = book.asks.length > 0 ? book.asks[0][0] : null;
  const spread = bestBid && bestAsk ? bestAsk - bestBid : null;
  const midPrice = bestBid && bestAsk ? (bestBid + bestAsk) / 2 : null;
  const spreadPercent = midPrice && spread ? (spread / midPrice) * 100 : null;

  return ok({
    symbol: args.symbol,
    exchange,
    bids: book.bids.map(([price, amount]) => ({ price, amount })),
    asks: book.asks.map(([price, amount]) => ({ price, amount })),
    spread,
    spreadPercent: spreadPercent ? Math.round(spreadPercent * 10000) / 10000 : null,
    midPrice,
    bestBid,
    bestAsk,
    timestamp: book.datetime || new Date(book.timestamp).toISOString(),
  });
}

async function handleGetTickers(args, svc) {
  const exchange = args.exchange || DEFAULT_EXCHANGE;
  const tickersMap = await svc.getTickers(exchange, args.symbols);

  const tickers = Object.values(tickersMap).map((t) => ({
    symbol: t.symbol,
    price: t.last,
    high24h: t.high,
    low24h: t.low,
    change24h: t.percentage,
    volume24h: t.baseVolume,
    bid: t.bid,
    ask: t.ask,
  }));

  return ok({ exchange, count: tickers.length, tickers });
}

// ── Account ────────────────────────────────────────────────────────────────

async function handleGetBalance(args, svc) {
  const exchange = args.exchange || DEFAULT_EXCHANGE;
  const balance = await svc.getBalance(exchange);

  // Extract per-currency balances, filter out dust (zero totals)
  const currencies = {};
  const raw = balance.total || balance;
  for (const [currency, total] of Object.entries(raw)) {
    if (typeof total === 'number' && total > 0) {
      currencies[currency] = {
        free: balance.free?.[currency] ?? 0,
        used: balance.used?.[currency] ?? 0,
        total,
      };
    }
  }

  return ok({
    exchange,
    currencies,
    currencyCount: Object.keys(currencies).length,
  });
}

async function handleGetPortfolio(args, svc) {
  const exchange = args.exchange || DEFAULT_EXCHANGE;
  const balance = await svc.getBalance(exchange);

  // Collect non-zero holdings
  const raw = balance.total || balance;
  const holdings = [];
  for (const [currency, total] of Object.entries(raw)) {
    if (typeof total === 'number' && total > 0) {
      holdings.push({ currency, total, free: balance.free?.[currency] ?? 0 });
    }
  }

  // Fetch USD values — stablecoins are 1:1, others need a ticker lookup
  const STABLECOINS = new Set(['USDT', 'USDC', 'BUSD', 'DAI', 'TUSD', 'USD']);
  let totalValueUSD = 0;
  const portfolio = [];

  for (const h of holdings) {
    let usdPrice = null;
    let usdValue = null;

    if (STABLECOINS.has(h.currency)) {
      usdPrice = 1;
      usdValue = h.total;
    } else {
      // Try USDT pair, then USDC, then USD
      for (const quote of ['USDT', 'USDC', 'USD']) {
        try {
          const ticker = await svc.getTicker(exchange, `${h.currency}/${quote}`);
          usdPrice = ticker.last;
          usdValue = h.total * usdPrice;
          break;
        } catch {
          // pair not available, try next
        }
      }
    }

    if (usdValue !== null) totalValueUSD += usdValue;

    portfolio.push({
      currency: h.currency,
      quantity: h.total,
      free: h.free,
      usdPrice,
      usdValue: usdValue !== null ? Math.round(usdValue * 100) / 100 : null,
    });
  }

  // Compute allocation percentages
  for (const item of portfolio) {
    item.allocation =
      item.usdValue !== null && totalValueUSD > 0
        ? Math.round((item.usdValue / totalValueUSD) * 10000) / 100
        : null;
  }

  // Sort by USD value descending
  portfolio.sort((a, b) => (b.usdValue ?? 0) - (a.usdValue ?? 0));

  return ok({
    exchange,
    totalValueUSD: Math.round(totalValueUSD * 100) / 100,
    holdingCount: portfolio.length,
    holdings: portfolio,
  });
}

// ── Trading ────────────────────────────────────────────────────────────────

async function handlePlaceOrder(args, svc) {
  const exchange = args.exchange || DEFAULT_EXCHANGE;
  const { symbol, side, type, amount, price } = args;

  if (type === 'limit' && (price === undefined || price === null)) {
    return fail('Limit orders require a "price" parameter.');
  }

  let order;
  if (type === 'market' && side === 'buy') {
    order = await svc.createMarketBuy(exchange, symbol, amount);
  } else if (type === 'market' && side === 'sell') {
    order = await svc.createMarketSell(exchange, symbol, amount);
  } else if (type === 'limit' && side === 'buy') {
    order = await svc.createLimitBuy(exchange, symbol, amount, price);
  } else if (type === 'limit' && side === 'sell') {
    order = await svc.createLimitSell(exchange, symbol, amount, price);
  } else {
    return fail(`Invalid order: side="${side}", type="${type}".`);
  }

  return ok({
    orderId: order.id,
    symbol: order.symbol,
    side: order.side,
    type: order.type,
    status: order.status,
    amount: order.amount,
    filled: order.filled,
    remaining: order.remaining,
    price: order.price,
    average: order.average,
    cost: order.cost,
    timestamp: order.datetime || new Date(order.timestamp).toISOString(),
    exchange,
  });
}

async function handleCancelOrder(args, svc) {
  const exchange = args.exchange || DEFAULT_EXCHANGE;

  const result = await svc.cancelOrder(exchange, args.orderId, args.symbol);

  return ok({
    success: true,
    orderId: args.orderId,
    symbol: args.symbol,
    status: result.status || 'canceled',
    exchange,
  });
}

async function handleGetOrders(args, svc) {
  const exchange = args.exchange || DEFAULT_EXCHANGE;
  const status = args.status || 'open';
  const symbol = args.symbol || undefined;

  let orders = [];

  if (status === 'open' || status === 'all') {
    const open = await svc.getOpenOrders(exchange, symbol);
    orders.push(...open.map((o) => ({ ...formatOrder(o), statusGroup: 'open' })));
  }

  if (status === 'closed' || status === 'all') {
    const closed = await svc.getClosedOrders(exchange, symbol);
    orders.push(...closed.map((o) => ({ ...formatOrder(o), statusGroup: 'closed' })));
  }

  // Sort by timestamp descending (most recent first)
  orders.sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || ''));

  return ok({
    exchange,
    status,
    count: orders.length,
    orders,
  });
}

function formatOrder(order) {
  return {
    orderId: order.id,
    symbol: order.symbol,
    side: order.side,
    type: order.type,
    status: order.status,
    amount: order.amount,
    filled: order.filled,
    remaining: order.remaining,
    price: order.price,
    average: order.average,
    cost: order.cost,
    timestamp: order.datetime || (order.timestamp ? new Date(order.timestamp).toISOString() : null),
  };
}

// ── Analysis ───────────────────────────────────────────────────────────────

async function handleGetMarkets(args, svc) {
  const exchange = args.exchange || DEFAULT_EXCHANGE;
  let markets = await svc.getMarkets(exchange);

  // Apply filters
  if (args.base) {
    const base = args.base.toUpperCase();
    markets = markets.filter((m) => m.base === base);
  }
  if (args.quote) {
    const quote = args.quote.toUpperCase();
    markets = markets.filter((m) => m.quote === quote);
  }

  // Only include active spot markets, trim to essential fields
  const result = markets
    .filter((m) => m.active !== false)
    .map((m) => ({
      symbol: m.symbol,
      base: m.base,
      quote: m.quote,
      type: m.type || 'spot',
      active: m.active,
      limits: {
        amount: m.limits?.amount || null,
        price: m.limits?.price || null,
        cost: m.limits?.cost || null,
      },
    }));

  return ok({
    exchange,
    count: result.length,
    markets: result,
  });
}

async function handleGetExchangeStatus(args, svc) {
  const exchange = args.exchange || DEFAULT_EXCHANGE;
  const status = await svc.getExchangeStatus(exchange);

  return ok({
    exchange,
    status: status.status,
    updated: status.updated || null,
    eta: status.eta || null,
    url: status.url || null,
    operational: status.status === 'ok',
  });
}

// ───────────────────────────────────────────────────────────────────────────
// Registration — server.tool() convenience API
// ───────────────────────────────────────────────────────────────────────────

/**
 * Register all crypto tools using the SDK's server.tool() method.
 * Use this if the server doesn't already have a custom setRequestHandler
 * for ListToolsRequestSchema / CallToolRequestSchema.
 *
 * @param {import('@modelcontextprotocol/sdk/server/index.js').Server} server
 * @param {import('./crypto-service.js').CryptoService} svc
 */
export function registerCryptoTools(server, svc) {
  const definitions = getCryptoToolDefinitions();

  for (const def of definitions) {
    server.tool(
      def.name,
      def.description,
      def.inputSchema.properties,
      async (args) => {
        const result = await handleCryptoToolCall(def.name, args, svc);
        if (result) return result;
        return fail(`Unhandled crypto tool: ${def.name}`);
      },
    );
  }
}
