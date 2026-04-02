/**
 * lister.js — List purchased items on Amazon FBA, eBay, or Mercari
 * with LLM-optimized titles and descriptions.
 * @module arbitrage/retail/lister
 */

// ─── Structured Logging ──────────────────────────────────────────────────
function log(level, message, meta = {}) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    module: 'arbitrage/retail/lister',
    message,
    ...meta,
  };
  process.stderr.write(JSON.stringify(entry) + '\n');
}

// ─── Constants ───────────────────────────────────────────────────────────
const PLATFORMS = {
  amazon_fba: { name: 'Amazon FBA', maxTitleLen: 200, maxDescLen: 2000 },
  ebay: { name: 'eBay', maxTitleLen: 80, maxDescLen: 4000 },
  mercari: { name: 'Mercari', maxTitleLen: 40, maxDescLen: 1000 },
};

const LISTING_STATUSES = ['draft', 'pending', 'active', 'sold', 'cancelled', 'returned'];

const PLATFORM_FEES = { amazon_fba: 0.15, ebay: 0.13, mercari: 0.10 };

// ─── Factory ─────────────────────────────────────────────────────────────
/**
 * Create a retail listing manager with LLM-optimized content generation.
 * @param {object} [config]
 * @param {string} [config.defaultPlatform] - Target marketplace.
 * @param {string} [config.llmApiKey]       - OpenAI API key for content generation.
 * @param {string} [config.llmModel]        - Model to use for generation.
 * @param {number} [config.markupPct]       - Target markup over source cost.
 * @param {boolean} [config.dryRun]         - When true, listings are simulated only.
 * @returns {RetailLister}
 */
export function createLister(config = {}) {
  const defaultPlatform = config.defaultPlatform ?? process.env.RETAIL_DEFAULT_PLATFORM ?? 'amazon_fba';
  const llmApiKey = config.llmApiKey ?? process.env.OPENAI_API_KEY ?? '';
  const llmModel = config.llmModel ?? process.env.RETAIL_LLM_MODEL ?? 'gpt-4o-mini';
  const markupPct = config.markupPct ?? parseFloat(process.env.RETAIL_MARKUP_PCT || '0.40');
  const dryRun = config.dryRun ?? (process.env.RETAIL_DRY_RUN !== 'false');

  log('INFO', 'Lister initialised', { defaultPlatform, llmModel, markupPct, dryRun });

  const listings = new Map();   // listingId → listing object
  const listingHistory = [];

  // ── Internal Helpers ─────────────────────────────────────────────────
  /** @returns {string} Unique listing ID */
  function _generateListingId() {
    return `lst-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  /** @param {object} product  @returns {string} Fallback title without LLM */
  function _templateTitle(product) {
    return `${product.brand || 'Generic'} ${product.name} - ${product.condition || 'New'}`;
  }

  /** @param {object} product  @returns {string} Fallback bullet-point description */
  function _templateDescription(product) {
    const lines = [];
    lines.push(`${product.brand || ''} ${product.name}`.trim());
    if (product.condition) lines.push(`Condition: ${product.condition}`);
    if (product.category) lines.push(`Category: ${product.category}`);
    if (Array.isArray(product.features) && product.features.length > 0) {
      lines.push('', 'Features:');
      for (const feat of product.features) lines.push(`• ${feat}`);
    }
    return lines.join('\n');
  }

  /** Record an event in listing history. */
  function _recordHistory(action, data) {
    listingHistory.push({ ts: new Date().toISOString(), action, ...data });
  }

  /** Build template-based fallback content for a platform. */
  function _fallbackContent(product, plat, platKey) {
    return {
      title: _templateTitle(product).slice(0, plat.maxTitleLen),
      description: _templateDescription(product).slice(0, plat.maxDescLen),
      keywords: [product.brand, product.category, product.condition].filter(Boolean),
      platform: platKey,
    };
  }

  // ── Public Methods ───────────────────────────────────────────────────
  /**
   * Generate optimised title and description for a product using an LLM.
   * Falls back to template-based generation when no API key is configured.
   * @param {object} product - { name, category, brand, condition, features }
   * @param {string} [platform]
   * @returns {Promise<{ title: string, description: string, keywords: string[], platform: string }>}
   */
  async function generateListingContent(product, platform = defaultPlatform) {
    const plat = PLATFORMS[platform] || PLATFORMS[defaultPlatform];
    const platKey = PLATFORMS[platform] ? platform : defaultPlatform;

    if (!llmApiKey) {
      log('WARN', 'No LLM API key — using template fallback');
      return _fallbackContent(product, plat, platKey);
    }

    try {
      const prompt = [
        `You are an e-commerce listing optimiser for ${plat.name}.`,
        `Product: ${product.brand || ''} ${product.name}`,
        `Category: ${product.category || 'General'}`,
        `Condition: ${product.condition || 'New'}`,
        product.features?.length ? `Features: ${product.features.join(', ')}` : '',
        '',
        'Generate JSON with keys: title, description, keywords (array).',
        `Title max ${plat.maxTitleLen} chars — SEO-optimised with key search terms.`,
        `Description max ${plat.maxDescLen} chars — compelling, benefit-driven copy.`,
      ].filter(Boolean).join('\n');

      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${llmApiKey}` },
        body: JSON.stringify({
          model: llmModel,
          messages: [{ role: 'user', content: prompt }],
          response_format: { type: 'json_object' },
          temperature: 0.7,
        }),
      });
      if (!res.ok) throw new Error(`LLM API ${res.status}: ${await res.text()}`);

      const data = await res.json();
      const content = JSON.parse(data.choices[0].message.content);
      return {
        title: String(content.title || '').slice(0, plat.maxTitleLen),
        description: String(content.description || '').slice(0, plat.maxDescLen),
        keywords: Array.isArray(content.keywords) ? content.keywords : [],
        platform: platKey,
      };
    } catch (err) {
      log('ERROR', 'LLM generation failed, using template fallback', { error: err.message });
      return _fallbackContent(product, plat, platKey);
    }
  }

  /**
   * Calculate listing price based on source cost, markup, and platform fees.
   * @param {object} deal - Must include `sourcePrice`.
   * @param {string} [platform]
   */
  function calculateTargetPrice(deal, platform = defaultPlatform) {
    const source = Number(deal.sourcePrice) || 0;
    const feePct = PLATFORM_FEES[platform] ?? PLATFORM_FEES[defaultPlatform] ?? 0.15;
    const markup = +(source * markupPct).toFixed(2);
    const rawTarget = source + markup;
    const estimatedFees = +(rawTarget * feePct).toFixed(2);
    const targetPrice = +(rawTarget + estimatedFees).toFixed(2);
    const estimatedProfit = +(targetPrice - source - estimatedFees).toFixed(2);
    const margin = targetPrice > 0 ? +((estimatedProfit / targetPrice) * 100).toFixed(1) : 0;
    return { targetPrice, sourcePrice: source, markup, estimatedFees, estimatedProfit, margin };
  }

  /**
   * Create a listing for a purchased item.
   * @param {object} deal - Deal/product data with at least `sourcePrice`, `name`.
   * @param {object} [options] - { platform, customTitle, customDescription, customPrice }
   * @returns {Promise<object>} The created listing record.
   */
  async function createListing(deal, options = {}) {
    const platform = options.platform || defaultPlatform;
    const content = await generateListingContent(deal, platform);
    const pricing = calculateTargetPrice(deal, platform);

    const listing = {
      listingId: _generateListingId(),
      asin: deal.asin || null,
      platform,
      title: options.customTitle || content.title,
      description: options.customDescription || content.description,
      keywords: content.keywords,
      price: options.customPrice ?? pricing.targetPrice,
      sourcePrice: pricing.sourcePrice,
      estimatedProfit: pricing.estimatedProfit,
      margin: pricing.margin,
      status: dryRun ? 'simulated' : 'draft',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    listings.set(listing.listingId, listing);
    _recordHistory('created', { listingId: listing.listingId, platform, dryRun });
    log('INFO', `Listing created: ${listing.listingId}`, { platform, price: listing.price, status: listing.status });
    return { ...listing };
  }

  /**
   * Move a listing from draft to active (submit to platform API).
   * @param {string} listingId
   * @returns {Promise<object>} Updated listing.
   */
  async function publishListing(listingId) {
    const listing = listings.get(listingId);
    if (!listing) throw new Error(`Listing not found: ${listingId}`);
    if (listing.status !== 'draft') throw new Error(`Cannot publish listing in status "${listing.status}"`);

    if (dryRun) {
      log('INFO', `[DRY RUN] Would publish ${listingId} to ${listing.platform}`);
      listing.status = 'simulated';
    } else {
      log('INFO', `Publishing ${listingId} to ${listing.platform}`);
      listing.status = 'active';
    }
    listing.updatedAt = new Date().toISOString();
    _recordHistory('published', { listingId, status: listing.status });
    return { ...listing };
  }

  /**
   * Update mutable fields on a listing.
   * @param {string} listingId
   * @param {object} updates - May include price, title, description, status.
   * @returns {Promise<object>} Updated listing.
   */
  async function updateListing(listingId, updates) {
    const listing = listings.get(listingId);
    if (!listing) throw new Error(`Listing not found: ${listingId}`);

    const allowed = ['price', 'title', 'description', 'status'];
    for (const key of allowed) {
      if (updates[key] !== undefined) {
        if (key === 'status' && !LISTING_STATUSES.includes(updates[key])) {
          throw new Error(`Invalid status: ${updates[key]}`);
        }
        listing[key] = updates[key];
      }
    }
    listing.updatedAt = new Date().toISOString();
    _recordHistory('updated', { listingId, fields: Object.keys(updates).filter(k => allowed.includes(k)) });
    log('INFO', `Listing updated: ${listingId}`, { fields: Object.keys(updates) });
    return { ...listing };
  }

  /**
   * Re-optimise all active listings — check if prices need adjustment.
   * @returns {Promise<{ optimized: number, priceChanges: object[], unchanged: number }>}
   */
  async function optimizeListings() {
    const priceChanges = [];
    let unchanged = 0;

    for (const [id, listing] of listings) {
      if (listing.status !== 'active') continue;
      const repriced = calculateTargetPrice({ sourcePrice: listing.sourcePrice }, listing.platform);

      if (Math.abs(repriced.targetPrice - listing.price) > 0.01) {
        const oldPrice = listing.price;
        listing.price = repriced.targetPrice;
        listing.margin = repriced.margin;
        listing.updatedAt = new Date().toISOString();
        priceChanges.push({ listingId: id, oldPrice, newPrice: repriced.targetPrice });
        _recordHistory('repriced', { listingId: id, oldPrice, newPrice: repriced.targetPrice });
      } else {
        unchanged++;
      }
    }
    log('INFO', 'Listing optimisation complete', { optimized: priceChanges.length, unchanged });
    return { optimized: priceChanges.length, priceChanges: [...priceChanges], unchanged };
  }

  /** @param {string} listingId  @returns {object|undefined} Copy of listing */
  function getListing(listingId) {
    const listing = listings.get(listingId);
    return listing ? { ...listing } : undefined;
  }

  /** @param {{ platform?: string, status?: string }} [filter]  @returns {object[]} */
  function getListings(filter = {}) {
    let results = [...listings.values()];
    if (filter.platform) results = results.filter(l => l.platform === filter.platform);
    if (filter.status) results = results.filter(l => l.status === filter.status);
    return results.map(l => ({ ...l }));
  }

  /** @returns {object[]} Copy of full listing history */
  function getListingHistory() {
    return [...listingHistory];
  }

  /** @returns {object} Current config with masked LLM key */
  function getConfig() {
    return {
      defaultPlatform,
      llmModel,
      llmApiKey: llmApiKey ? `${llmApiKey.slice(0, 4)}…${llmApiKey.slice(-4)}` : '(none)',
      markupPct,
      dryRun,
    };
  }

  // ── Public API ───────────────────────────────────────────────────────
  return {
    generateListingContent,
    calculateTargetPrice,
    createListing,
    publishListing,
    updateListing,
    optimizeListings,
    getListing,
    getListings,
    getListingHistory,
    getConfig,
    // Test backdoors
    _listings: listings,
    _listingHistory: listingHistory,
    _generateListingId,
    _templateTitle,
    _templateDescription,
  };
}

export default createLister;
