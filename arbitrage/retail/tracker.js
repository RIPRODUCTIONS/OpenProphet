// ── arbitrage/retail/tracker.js ── Inventory, sales, shipping, returns & P&L
// Part of the OpenProphet trading system.
// ─────────────────────────────────────────────────────────────────────────────

/** @typedef {'purchased'|'shipped_to_fba'|'in_stock'|'listed'|'sold'|'returned'} ItemStatus */

/**
 * @typedef {Object} InventoryRecord
 * @property {string} asin  @property {string} [name]  @property {string} [category]
 * @property {number} sourceCost  @property {number} [targetPrice]  @property {string} [platform]
 * @property {ItemStatus} status  @property {number} quantity
 * @property {string} [orderId]  @property {string} [listingId]
 * @property {string} [purchasedAt]  @property {string} [listedAt]  @property {string} [soldAt]
 * @property {number} shippingCost  @property {number} fees  @property {number} netProfit
 */

const VALID_TRANSITIONS = {
  purchased:      ['shipped_to_fba', 'listed', 'returned'],
  shipped_to_fba: ['in_stock', 'returned'],
  in_stock:       ['listed', 'returned'],
  listed:         ['sold', 'returned', 'in_stock'],
  sold:           ['returned'],
  returned:       ['listed', 'in_stock'],
};

/**
 * Structured logger — writes JSON to stderr so it never interferes with
 * MCP's stdout transport.
 * @param {'INFO'|'WARN'|'ERROR'|'TRADE'} level
 * @param {string} message
 * @param {Record<string, unknown>} [meta]
 */
function log(level, message, meta = {}) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    module: 'arbitrage/retail/tracker',
    message,
    ...meta,
  };
  process.stderr.write(JSON.stringify(entry) + '\n');
}

// ── Factory ──────────────────────────────────────────────────────────────────

/**
 * Create a retail-arbitrage tracker instance.
 * @param {Object} [config]
 * @param {string} [config.defaultPlatform] - explicit → env → 'amazon_fba'
 * @param {string} [config.defaultCategory] - explicit → env → 'general'
 * @param {number} [config.defaultQuantity] - explicit → env → 1
 * @returns {Object} Tracker public API
 */
export function createTracker(config = {}) {
  const defaultPlatform = config.defaultPlatform
    ?? process.env.RETAIL_DEFAULT_PLATFORM ?? 'amazon_fba';
  const defaultCategory = config.defaultCategory
    ?? process.env.RETAIL_DEFAULT_CATEGORY ?? 'general';
  const defaultQuantity = config.defaultQuantity
    ?? (process.env.RETAIL_DEFAULT_QTY ? Number(process.env.RETAIL_DEFAULT_QTY) : 1);

  /** @type {Map<string, InventoryRecord>} */
  const inventory = new Map();
  const sales = [], returns = [], shipments = [], pnlEntries = [];

  // ── Internal helpers ─────────────────────────────────────────────────────

  /** @param {ItemStatus} current  @param {ItemStatus} next  @returns {boolean} */
  function _validateStatusTransition(current, next) {
    const allowed = VALID_TRANSITIONS[current];
    return Array.isArray(allowed) && allowed.includes(next);
  }

  /** @param {InventoryRecord} item  @returns {Object} P&L breakdown */
  function _calculateItemPnL(item) {
    const saleEntry = sales.find((s) => s.asin === item.asin);
    const salePrice = saleEntry ? saleEntry.salePrice : 0;
    const fees = item.fees || 0;
    const shippingCost = item.shippingCost || 0;
    const returnAdjust = returns
      .filter((r) => r.asin === item.asin)
      .reduce((sum, r) => sum + (r.pnlAdjust || 0), 0);
    const netProfit = salePrice - item.sourceCost - fees - shippingCost + returnAdjust;
    const roi = item.sourceCost > 0 ? (netProfit / item.sourceCost) * 100 : 0;
    return { sourceCost: item.sourceCost, salePrice, fees, shippingCost, netProfit, roi };
  }

  // ── Public methods ───────────────────────────────────────────────────────

  /** Add a purchased item to inventory. @param {Object} item @returns {InventoryRecord} */
  function addItem(item) {
    if (!item || !item.asin) throw new Error('addItem: asin is required');
    if (item.sourceCost == null || item.sourceCost < 0) {
      throw new Error('addItem: sourceCost is required and must be >= 0');
    }
    if (inventory.has(item.asin)) {
      throw new Error(`addItem: item with asin ${item.asin} already exists`);
    }

    const record = {
      asin:         item.asin,
      name:         item.name || '',
      category:     item.category || defaultCategory,
      sourceCost:   item.sourceCost,
      targetPrice:  item.targetPrice || 0,
      platform:     item.platform || defaultPlatform,
      status:       'purchased',
      quantity:     item.quantity ?? defaultQuantity,
      orderId:      item.orderId || null,
      listingId:    null,
      purchasedAt:  new Date().toISOString(),
      listedAt:     null,
      soldAt:       null,
      shippingCost: 0,
      fees:         0,
      netProfit:    0,
    };

    inventory.set(record.asin, record);
    log('INFO', 'Item added to inventory', { asin: record.asin, sourceCost: record.sourceCost });
    return { ...record };
  }

  /**
   * Update item status with transition validation.
   * @param {string} asin  @param {ItemStatus} status  @param {Object} [meta]
   * @returns {InventoryRecord}
   */
  function updateStatus(asin, status, meta = {}) {
    const item = inventory.get(asin);
    if (!item) throw new Error(`updateStatus: no item found for asin ${asin}`);
    if (!_validateStatusTransition(item.status, status)) {
      throw new Error(`updateStatus: invalid transition ${item.status} → ${status} for asin ${asin}`);
    }

    item.status = status;
    if (status === 'listed') item.listedAt = new Date().toISOString();
    if (status === 'sold')   item.soldAt   = new Date().toISOString();

    for (const [key, value] of Object.entries(meta)) {
      if (key in item) item[key] = value;
    }

    log('INFO', 'Status updated', { asin, status });
    return { ...item };
  }

  /**
   * Record a completed sale and compute P&L.
   * @param {string} asin  @param {Object} saleData  @returns {Object}
   */
  function recordSale(asin, saleData) {
    const item = inventory.get(asin);
    if (!item) throw new Error(`recordSale: no item found for asin ${asin}`);
    if (!saleData || saleData.salePrice == null) {
      throw new Error('recordSale: salePrice is required');
    }
    if (!_validateStatusTransition(item.status, 'sold')) {
      throw new Error(`recordSale: cannot sell item in status ${item.status}`);
    }

    const fees         = saleData.fees || 0;
    const shippingCost = item.shippingCost || 0;
    const netProfit    = saleData.salePrice - item.sourceCost - fees - shippingCost;

    item.fees      = fees;
    item.netProfit = netProfit;
    item.status    = 'sold';
    item.soldAt    = new Date().toISOString();

    const saleRecord = {
      asin, salePrice: saleData.salePrice, platform: saleData.platform || item.platform,
      fees, buyerLocation: saleData.buyerLocation || null,
      sourceCost: item.sourceCost, shippingCost, netProfit, soldAt: item.soldAt,
    };
    sales.push(saleRecord);
    pnlEntries.push({ type: 'sale', asin, amount: netProfit, ts: item.soldAt });

    log('TRADE', 'Sale recorded', { asin, salePrice: saleData.salePrice, netProfit });
    return { ...saleRecord };
  }

  /**
   * Record a return and adjust P&L.
   * @param {string} asin  @param {Object} [returnData]  @returns {Object}
   */
  function recordReturn(asin, returnData = {}) {
    const item = inventory.get(asin);
    if (!item) throw new Error(`recordReturn: no item found for asin ${asin}`);

    const prevStatus = item.status;
    const newStatus  = prevStatus === 'sold' ? 'returned' : 'in_stock';
    if (!_validateStatusTransition(prevStatus, newStatus)) {
      throw new Error(`recordReturn: cannot return item in status ${prevStatus}`);
    }

    const refundAmount = returnData.refundAmount || 0;
    const restockFee   = returnData.restockFee || 0;
    const pnlAdjust    = -(refundAmount - restockFee);

    item.status    = newStatus;
    item.netProfit = (item.netProfit || 0) + pnlAdjust;
    item.soldAt    = null;

    const returnRecord = {
      asin, reason: returnData.reason || 'unspecified', refundAmount, restockFee,
      pnlAdjust, previousStatus: prevStatus, newStatus,
      returnedAt: new Date().toISOString(),
    };
    returns.push(returnRecord);
    pnlEntries.push({ type: 'return', asin, amount: pnlAdjust, ts: returnRecord.returnedAt });

    log('TRADE', 'Return recorded', { asin, reason: returnRecord.reason, pnlAdjust });
    return { ...returnRecord };
  }

  /**
   * Record a shipment to FBA.
   * @param {string} asin  @param {Object} [shipmentData]  @returns {Object}
   */
  function recordShipment(asin, shipmentData = {}) {
    const item = inventory.get(asin);
    if (!item) throw new Error(`recordShipment: no item found for asin ${asin}`);
    if (!_validateStatusTransition(item.status, 'shipped_to_fba')) {
      throw new Error(`recordShipment: cannot ship item in status ${item.status}`);
    }

    item.status       = 'shipped_to_fba';
    item.shippingCost = (item.shippingCost || 0) + (shipmentData.cost || 0);

    const shipmentRecord = {
      asin, trackingNumber: shipmentData.trackingNumber || null,
      carrier: shipmentData.carrier || null, cost: shipmentData.cost || 0,
      estimatedArrival: shipmentData.estimatedArrival || null,
      shippedAt: new Date().toISOString(),
    };
    shipments.push(shipmentRecord);

    log('INFO', 'Shipment recorded', { asin, carrier: shipmentRecord.carrier });
    return { ...shipmentRecord };
  }

  /**
   * Get inventory items, optionally filtered by status / category / platform.
   * @param {Object} [filter]  @returns {InventoryRecord[]}
   */
  function getInventory(filter = {}) {
    let items = [...inventory.values()];
    if (filter.status)   items = items.filter((i) => i.status === filter.status);
    if (filter.category) items = items.filter((i) => i.category === filter.category);
    if (filter.platform) items = items.filter((i) => i.platform === filter.platform);
    return items.map((i) => ({ ...i }));
  }

  /** P&L breakdown for a single item. @param {string} asin @returns {Object} */
  function getItemPnL(asin) {
    const item = inventory.get(asin);
    if (!item) throw new Error(`getItemPnL: no item found for asin ${asin}`);
    const pnl = _calculateItemPnL(item);
    return { asin, ...pnl, status: item.status };
  }

  /** Aggregate P&L across all tracked items. @returns {Object} */
  function getAggregatePnL() {
    const items = [...inventory.values()];
    const totalInvested = items.reduce((s, i) => s + i.sourceCost * i.quantity, 0);
    const totalRevenue  = sales.reduce((s, r) => s + r.salePrice, 0);
    const totalFees     = sales.reduce((s, r) => s + (r.fees || 0), 0);
    const totalShipping = items.reduce((s, i) => s + (i.shippingCost || 0), 0);
    const totalReturns  = returns.reduce((s, r) => s + (r.refundAmount || 0), 0);
    const netProfit     = totalRevenue - totalInvested - totalFees - totalShipping;
    const roi           = totalInvested > 0 ? (netProfit / totalInvested) * 100 : 0;
    const soldCount     = items.filter((i) => i.status === 'sold').length;

    const margins = sales.map((s) => {
      const inv = inventory.get(s.asin);
      return inv ? ((s.salePrice - inv.sourceCost) / s.salePrice) * 100 : 0;
    });
    const avgMargin = margins.length > 0
      ? margins.reduce((a, b) => a + b, 0) / margins.length : 0;

    const withPnL = items.filter((i) => i.status === 'sold' || i.netProfit !== 0);
    const sorted  = [...withPnL].sort((a, b) => b.netProfit - a.netProfit);
    const best  = sorted[0]     || null;
    const worst = sorted.at(-1) || null;

    return {
      totalInvested, totalRevenue, totalFees, totalShipping, totalReturns,
      netProfit,
      roi:         Math.round(roi * 100) / 100,
      itemCount:   items.length,
      soldCount,
      returnCount: returns.length,
      avgMargin:   Math.round(avgMargin * 100) / 100,
      bestItem:    best  ? { asin: best.asin,  netProfit: best.netProfit }  : null,
      worstItem:   worst ? { asin: worst.asin, netProfit: worst.netProfit } : null,
    };
  }

  /** Summary counts by status plus total portfolio value. @returns {Object} */
  function getInventorySummary() {
    const items = [...inventory.values()];
    const byStatus   = (s) => items.filter((i) => i.status === s).length;
    const totalValue = items.reduce((s, i) => s + i.sourceCost * i.quantity, 0);
    return {
      total:        items.length,
      purchased:    byStatus('purchased'),
      shippedToFba: byStatus('shipped_to_fba'),
      inStock:      byStatus('in_stock'),
      listed:       byStatus('listed'),
      sold:         byStatus('sold'),
      returned:     byStatus('returned'),
      totalValue,
    };
  }

  /** Defensive copy of the sales ledger. @returns {Object[]} */
  function getSales() { return sales.map((s) => ({ ...s })); }

  /** Defensive copy of the returns ledger. @returns {Object[]} */
  function getReturns() { return returns.map((r) => ({ ...r })); }

  // ── Public API ───────────────────────────────────────────────────────────

  return {
    addItem, updateStatus, recordSale, recordReturn, recordShipment,
    getInventory, getItemPnL, getAggregatePnL, getInventorySummary,
    getSales, getReturns,
    // Test backdoors
    _inventory: inventory, _sales: sales, _returns: returns,
    _shipments: shipments, _pnlEntries: pnlEntries,
    _validateStatusTransition, _calculateItemPnL,
  };
}

export default createTracker;
