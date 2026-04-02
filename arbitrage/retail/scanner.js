/**
 * scanner.js — Scan retail marketplaces for items selling below market value
 * and identify cross-platform arbitrage opportunities.
 * @module arbitrage/retail/scanner
 * @example
 * ```js
 * import { createRetailScanner } from './scanner.js';
 * const scanner = createRetailScanner({ minDiscount: 25 });
 * const opps = await scanner.findArbitrageOpportunities();
 * ```
 */

// ─── Structured Logging ──────────────────────────────────────────────────
/**
 * @param {'INFO'|'WARN'|'ERROR'} level
 * @param {string} message
 * @param {Record<string, unknown>} [meta]
 */
function log(level, message, meta = {}) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    module: 'arbitrage/retail/scanner',
    message,
    ...meta,
  };
  process.stderr.write(JSON.stringify(entry) + '\n');
}

// ─── Constants ───────────────────────────────────────────────────────────
const RETAILERS = {
  amazon: { name: 'Amazon', baseUrl: 'https://api.amazon.com/paapi5', searchPath: '/searchitems' },
  walmart: { name: 'Walmart', baseUrl: 'https://developer.api.walmart.com/api-proxy/service/affil/product/v2', searchPath: '/search' },
  target: { name: 'Target', baseUrl: 'https://redsky.target.com/redsky_aggregations/v1', searchPath: '/product_search_v2' },
  bestbuy: { name: 'Best Buy', baseUrl: 'https://api.bestbuy.com/v1', searchPath: '/products' },
};

const DEFAULT_CATEGORIES = ['electronics', 'toys', 'home', 'health', 'sports', 'beauty', 'grocery'];

const CACHE_TTL = 900_000; // 15 minutes in ms

// ─── Factory ─────────────────────────────────────────────────────────────
/**
 * Create a retail deal scanner for cross-platform arbitrage discovery.
 * @param {object} [config]
 * @param {object} [config.apiKeys]        - API keys per retailer.
 * @param {string} [config.apiKeys.amazon]
 * @param {string} [config.apiKeys.walmart]
 * @param {string} [config.apiKeys.target]
 * @param {string} [config.apiKeys.bestbuy]
 * @param {number} [config.scanInterval]   - Interval between scans in ms.
 * @param {number} [config.maxResults]     - Max results per retailer query.
 * @param {number} [config.minDiscount]    - Minimum discount % to qualify as a deal.
 * @param {string[]} [config.categories]   - Product categories to scan.
 * @returns {RetailScanner}
 */
export function createRetailScanner(config = {}) {
  // ── Config: explicit → env → default ─────────────────────────────────
  const apiKeys = {
    amazon: config.apiKeys?.amazon ?? process.env.RETAIL_AMAZON_API_KEY ?? '',
    walmart: config.apiKeys?.walmart ?? process.env.RETAIL_WALMART_API_KEY ?? '',
    target: config.apiKeys?.target ?? process.env.RETAIL_TARGET_API_KEY ?? '',
    bestbuy: config.apiKeys?.bestbuy ?? process.env.RETAIL_BESTBUY_API_KEY ?? '',
  };
  const scanInterval = config.scanInterval ?? parseInt(process.env.RETAIL_SCAN_INTERVAL || '300000', 10);
  const maxResults = config.maxResults ?? parseInt(process.env.RETAIL_MAX_RESULTS || '50', 10);
  const minDiscount = config.minDiscount ?? parseFloat(process.env.RETAIL_MIN_DISCOUNT || '15');
  const categories = config.categories ?? [...DEFAULT_CATEGORIES];

  log('INFO', 'Retail scanner initialised', {
    retailers: Object.keys(RETAILERS).filter(r => apiKeys[r]),
    scanInterval,
    maxResults,
    minDiscount,
    categories,
  });

  // ── Internal State ───────────────────────────────────────────────────
  /** @type {object[]} */
  const scanHistory = [];
  /** @type {Map<string, { price: number, timestamp: number }>} */
  const priceCache = new Map();

  // ── Internal Helpers ─────────────────────────────────────────────────
  /**
   * Check if a cached price entry is still valid.
   * @param {string} cacheKey
   * @returns {{ price: number, timestamp: number } | null}
   */
  function _getCachedPrice(cacheKey) {
    const entry = priceCache.get(cacheKey);
    if (!entry) return null;
    if (Date.now() - entry.timestamp > CACHE_TTL) {
      priceCache.delete(cacheKey);
      return null;
    }
    return entry;
  }

  /**
   * Store a price in the cache.
   * @param {string} retailer
   * @param {string} asin
   * @param {number} price
   */
  function _setCachedPrice(retailer, asin, price) {
    priceCache.set(`${retailer}:${asin}`, { price, timestamp: Date.now() });
  }

  /**
   * Mask an API key for safe logging.
   * @param {string} key
   * @returns {string}
   */
  function _maskKey(key) {
    if (!key || key.length < 8) return '(none)';
    return `${key.slice(0, 4)}…${key.slice(-4)}`;
  }

  /**
   * Normalize retailer-specific product data into a standard format.
   * @param {string} retailer
   * @param {object} rawProduct
   * @returns {object}
   */
  function _normalizeProduct(retailer, rawProduct) {
    const price = Number(rawProduct.price ?? rawProduct.salePrice ?? 0);
    const originalPrice = Number(rawProduct.originalPrice ?? rawProduct.listPrice ?? rawProduct.msrp ?? price);
    const discount = originalPrice > price ? +(originalPrice - price).toFixed(2) : 0;
    const discountPct = originalPrice > 0 ? +((discount / originalPrice) * 100).toFixed(1) : 0;

    return {
      retailer,
      name: rawProduct.name ?? rawProduct.title ?? 'Unknown Product',
      price,
      originalPrice,
      discount,
      discountPct,
      asin: rawProduct.asin ?? rawProduct.upc ?? rawProduct.itemId ?? null,
      url: rawProduct.url ?? rawProduct.productUrl ?? null,
      category: rawProduct.category ?? rawProduct.categoryPath ?? null,
      inStock: rawProduct.inStock ?? rawProduct.availableOnline ?? true,
      rank: Number(rawProduct.salesRank ?? rawProduct.rank ?? 0),
      rating: Number(rawProduct.rating ?? rawProduct.customerRating ?? 0),
      reviewCount: Number(rawProduct.reviewCount ?? rawProduct.numReviews ?? 0),
    };
  }

  /**
   * Fetch deals from a single retailer API.
   * @param {string} retailer
   * @param {string} query
   * @param {object} options
   * @returns {Promise<object[]>}
   */
  async function _fetchRetailerDeals(retailer, query, options = {}) {
    const key = apiKeys[retailer];
    if (!key) {
      log('WARN', `No API key for ${retailer}, skipping`, { retailer });
      return [];
    }

    const info = RETAILERS[retailer];
    if (!info) return [];

    const limit = options.maxResults ?? maxResults;
    const url = `${info.baseUrl}${info.searchPath}?query=${encodeURIComponent(query)}&limit=${limit}`;

    try {
      const headers = {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
      };

      // Retailer-specific header adjustments
      if (retailer === 'bestbuy') {
        headers['apiKey'] = key;
        delete headers.Authorization;
      } else if (retailer === 'walmart') {
        headers['WM_SEC.ACCESS_TOKEN'] = key;
        delete headers.Authorization;
      }

      const res = await fetch(url, { method: 'GET', headers, signal: AbortSignal.timeout(15_000) });
      if (!res.ok) {
        throw new Error(`${info.name} API ${res.status}: ${res.statusText}`);
      }

      const data = await res.json();
      const items = data.items ?? data.products ?? data.searchResults ?? data.list ?? [];

      const minPct = options.minDiscount ?? minDiscount;
      return items
        .map(item => _normalizeProduct(retailer, item))
        .filter(p => p.discountPct >= minPct);
    } catch (err) {
      log('WARN', `Failed to fetch deals from ${info.name}`, { retailer, error: err.message });
      return [];
    }
  }

  /**
   * Record a scan event in history.
   * @param {string} action
   * @param {object} data
   */
  function _recordScan(action, data) {
    scanHistory.push({ ts: new Date().toISOString(), action, ...data });
  }

  // ── Public Methods ───────────────────────────────────────────────────
  /**
   * Search across all (or specified) retailers for deals matching a product query.
   * Uses `Promise.allSettled` to handle partial failures gracefully.
   * @param {string} query - Product search term.
   * @param {object} [options]
   * @param {string[]} [options.retailers] - Subset of retailers to query.
   * @param {number}   [options.maxResults]
   * @param {number}   [options.minDiscount]
   * @returns {Promise<object[]>} Array of deal objects across all queried retailers.
   */
  async function scanDeals(query, options = {}) {
    const retailerKeys = options.retailers ?? Object.keys(RETAILERS);
    log('INFO', 'Scanning deals', { query, retailers: retailerKeys });

    const results = await Promise.allSettled(
      retailerKeys.map(r => _fetchRetailerDeals(r, query, options)),
    );

    const deals = [];
    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (result.status === 'fulfilled') {
        deals.push(...result.value);
      } else {
        log('WARN', `Scan failed for ${retailerKeys[i]}`, { error: result.reason?.message });
      }
    }

    // Sort by discount percentage descending
    deals.sort((a, b) => b.discountPct - a.discountPct);

    const limited = deals.slice(0, options.maxResults ?? maxResults);
    _recordScan('scanDeals', { query, retailers: retailerKeys, totalDeals: limited.length });

    return limited.map(d => ({ ...d }));
  }

  /**
   * Look up a specific product (by ASIN/UPC) across all retailers and compare prices.
   * @param {string} asin - Product ASIN or UPC.
   * @returns {Promise<{ asin: string, prices: object[], lowestPrice: number, highestPrice: number, spread: number, spreadPct: number }>}
   */
  async function comparePrices(asin) {
    log('INFO', 'Comparing prices', { asin });

    const prices = [];
    const retailerKeys = Object.keys(RETAILERS);

    const results = await Promise.allSettled(
      retailerKeys.map(async (retailer) => {
        const cached = _getCachedPrice(`${retailer}:${asin}`);
        if (cached) {
          return { retailer, price: cached.price, cached: true };
        }

        const deals = await _fetchRetailerDeals(retailer, asin, { maxResults: 5, minDiscount: 0 });
        const match = deals.find(d => d.asin === asin) ?? deals[0] ?? null;
        if (match) {
          _setCachedPrice(retailer, asin, match.price);
        }
        return match ? { retailer, price: match.price, url: match.url, inStock: match.inStock } : null;
      }),
    );

    for (const result of results) {
      if (result.status === 'fulfilled' && result.value) {
        prices.push({
          ...result.value,
          timestamp: new Date().toISOString(),
        });
      }
    }

    const numericPrices = prices.map(p => p.price).filter(p => p > 0);
    const lowestPrice = numericPrices.length > 0 ? Math.min(...numericPrices) : 0;
    const highestPrice = numericPrices.length > 0 ? Math.max(...numericPrices) : 0;
    const spread = +(highestPrice - lowestPrice).toFixed(2);
    const spreadPct = highestPrice > 0 ? +((spread / highestPrice) * 100).toFixed(1) : 0;

    _recordScan('comparePrices', { asin, pricesFound: prices.length, spread });

    return { asin, prices: [...prices], lowestPrice, highestPrice, spread, spreadPct };
  }

  /**
   * Scan predefined categories for cross-platform arbitrage opportunities.
   * For each category, scans deals, compares prices, and returns opportunities
   * where the spread is significant.
   * @param {object} [options]
   * @param {string[]} [options.categories]   - Categories to scan (defaults to configured).
   * @param {number}   [options.minDiscount]  - Minimum discount % to qualify.
   * @param {number}   [options.maxResults]   - Max opportunities to return.
   * @returns {Promise<object[]>} Array of arbitrage opportunity objects.
   */
  async function findArbitrageOpportunities(options = {}) {
    const cats = options.categories ?? categories;
    const minPct = options.minDiscount ?? minDiscount;
    const limit = options.maxResults ?? maxResults;

    log('INFO', 'Finding arbitrage opportunities', { categories: cats, minDiscount: minPct });

    const opportunities = [];

    for (const category of cats) {
      let deals;
      try {
        deals = await scanDeals(category, { minDiscount: minPct });
      } catch (err) {
        log('WARN', `Category scan failed: ${category}`, { error: err.message });
        continue;
      }

      // Group deals by ASIN to find cross-platform matches
      /** @type {Map<string, object[]>} */
      const byAsin = new Map();
      for (const deal of deals) {
        if (!deal.asin) continue;
        const group = byAsin.get(deal.asin) ?? [];
        group.push(deal);
        byAsin.set(deal.asin, group);
      }

      for (const [asin, group] of byAsin) {
        if (group.length < 2) continue;

        // Sort by price to find best buy/sell pair
        const sorted = group.sort((a, b) => a.price - b.price);
        const cheapest = sorted[0];
        const priciest = sorted[sorted.length - 1];

        const spread = +(priciest.price - cheapest.price).toFixed(2);
        const spreadPct = priciest.price > 0
          ? +((spread / priciest.price) * 100).toFixed(1)
          : 0;

        if (spread > 0 && spreadPct >= minPct) {
          opportunities.push({
            product: cheapest.name,
            sourceRetailer: cheapest.retailer,
            sourcePrice: cheapest.price,
            targetRetailer: priciest.retailer,
            targetPrice: priciest.price,
            spread,
            spreadPct,
            category,
            asin,
            timestamp: new Date().toISOString(),
          });
        }
      }
    }

    // Sort by spread percentage descending — best opportunities first
    opportunities.sort((a, b) => b.spreadPct - a.spreadPct);
    const limited = opportunities.slice(0, limit);

    _recordScan('findArbitrageOpportunities', {
      categoriesScanned: cats.length,
      opportunitiesFound: limited.length,
    });

    log('INFO', 'Arbitrage scan complete', { opportunities: limited.length });
    return limited.map(o => ({ ...o }));
  }

  /**
   * Return current configuration with API keys masked.
   * @returns {object}
   */
  function getConfig() {
    return {
      apiKeys: {
        amazon: _maskKey(apiKeys.amazon),
        walmart: _maskKey(apiKeys.walmart),
        target: _maskKey(apiKeys.target),
        bestbuy: _maskKey(apiKeys.bestbuy),
      },
      scanInterval,
      maxResults,
      minDiscount,
      categories: [...categories],
    };
  }

  /**
   * Return a copy of the scan history.
   * @returns {object[]}
   */
  function getScanHistory() {
    return [...scanHistory];
  }

  // ── Public API ───────────────────────────────────────────────────────
  return {
    scanDeals,
    comparePrices,
    findArbitrageOpportunities,
    getConfig,
    getScanHistory,
    // Test backdoors
    _fetchRetailerDeals,
    _normalizeProduct,
    _scanHistory: scanHistory,
    _priceCache: priceCache,
  };
}

export default createRetailScanner;
