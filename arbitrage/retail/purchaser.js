/**
 * purchaser.js — Auto-purchase module for retail arbitrage.
 *
 * Evaluates analyzed deals, manages a shopping cart, and executes
 * purchases within configurable budget and rate limits.
 * Safety: per-cycle budget cap, max item price, dry-run default.
 *
 * @module arbitrage/retail/purchaser
 */

// ─── Logging ──────────────────────────────────────────────────────────────

function log(level, message, meta = {}) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    module: 'arbitrage/retail/purchaser',
    message,
    ...meta,
  };
  process.stderr.write(JSON.stringify(entry) + '\n');
}

// ─── Constants ────────────────────────────────────────────────────────────

const CYCLE_DURATION = 24 * 60 * 60 * 1000; // 24 hours

// ─── Factory ──────────────────────────────────────────────────────────────

/**
 * Create a retail auto-purchaser with budget controls and cart management.
 *
 * @param {object} [config]
 * @param {number}  [config.budgetPerCycle]    - Max spend per 24h cycle
 * @param {number}  [config.maxItemPrice]      - Max price for a single item
 * @param {number}  [config.maxItemsPerCycle]  - Max items purchased per cycle
 * @param {boolean} [config.dryRun]            - Simulate purchases without executing
 * @param {object}  [config.treasuryManager]   - Optional TreasuryManager for budget allocation
 * @returns {{ addToCart: Function, removeFromCart: Function, getCart: Function, clearCart: Function, purchaseItem: Function, executePurchases: Function, checkBudget: Function, resetCycle: Function, getPurchaseHistory: Function, getConfig: Function, _checkCycleReset: Function, _generateOrderId: Function }}
 */
export function createPurchaser(config = {}) {
  const budgetPerCycle = config.budgetPerCycle ?? parseFloat(process.env.RETAIL_BUDGET_PER_CYCLE || '500');
  const maxItemPrice = config.maxItemPrice ?? parseFloat(process.env.RETAIL_MAX_ITEM_PRICE || '200');
  const maxItemsPerCycle = config.maxItemsPerCycle ?? parseInt(process.env.RETAIL_MAX_ITEMS_PER_CYCLE || '10', 10);
  const dryRun = config.dryRun ?? (process.env.RETAIL_DRY_RUN !== 'false');
  const treasuryManager = config.treasuryManager ?? null;

  // ─── Internal state ───────────────────────────────────────────────────

  const purchaseHistory = [];
  const cart = [];
  let cycleSpend = 0;
  let cycleItemCount = 0;
  let lastCycleReset = Date.now();

  log('info', 'purchaser created', { budgetPerCycle, maxItemPrice, maxItemsPerCycle, dryRun });

  // ─── Internal helpers ─────────────────────────────────────────────────

  /** Auto-reset cycle counters when CYCLE_DURATION has elapsed. */
  function _checkCycleReset() {
    if (Date.now() - lastCycleReset >= CYCLE_DURATION) {
      log('info', 'cycle auto-reset', { previousSpend: cycleSpend, previousItemCount: cycleItemCount });
      cycleSpend = 0;
      cycleItemCount = 0;
      lastCycleReset = Date.now();
    }
  }

  /** @returns {string} Unique order ID for a retail purchase. */
  function _generateOrderId() {
    return `retail-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  // ─── Cart management ──────────────────────────────────────────────────

  /**
   * Add an analyzed deal to the cart.
   *
   * @param {object} deal
   * @param {string} deal.asin       - Product identifier
   * @param {number} deal.price      - Purchase price
   * @param {string} [deal.retailer] - Source retailer
   * @returns {{ added: boolean, reason: string, cartSize: number, remainingBudget: number }}
   */
  function addToCart(deal) {
    _checkCycleReset();
    const rej = (reason, extra = 0) => ({ added: false, reason, cartSize: cart.length, remainingBudget: budgetPerCycle - cycleSpend - extra });

    if (!deal || !deal.asin || deal.price == null) return rej('invalid deal: asin and price required');
    if (deal.price > maxItemPrice) return rej(`price ${deal.price} exceeds max ${maxItemPrice}`);

    const cartTotal = cart.reduce((sum, item) => sum + item.price, 0);
    if (cycleSpend + cartTotal + deal.price > budgetPerCycle) return rej('would exceed cycle budget', cartTotal);
    if (cart.some((item) => item.asin === deal.asin)) return rej('duplicate asin in cart', cartTotal);

    cart.push({ ...deal, addedAt: new Date().toISOString() });
    log('info', 'deal added to cart', { asin: deal.asin, price: deal.price, cartSize: cart.length });
    return { added: true, reason: 'ok', cartSize: cart.length, remainingBudget: budgetPerCycle - cycleSpend - cartTotal - deal.price };
  }

  /**
   * Remove an item from the cart by ASIN.
   *
   * @param {string} asin
   * @returns {{ removed: boolean, cartSize: number }}
   */
  function removeFromCart(asin) {
    const idx = cart.findIndex((item) => item.asin === asin);
    if (idx === -1) return { removed: false, cartSize: cart.length };
    cart.splice(idx, 1);
    log('info', 'item removed from cart', { asin, cartSize: cart.length });
    return { removed: true, cartSize: cart.length };
  }

  /** @returns {object[]} Copy of the current cart. */
  function getCart() {
    return cart.map((item) => ({ ...item }));
  }

  /** Empty the cart. @returns {{ cleared: number }} */
  function clearCart() {
    const count = cart.length;
    cart.length = 0;
    log('info', 'cart cleared', { cleared: count });
    return { cleared: count };
  }

  // ─── Purchasing ───────────────────────────────────────────────────────

  /**
   * Purchase a single item. Validates budget, generates order ID, and
   * records the transaction. In dry-run mode the purchase is simulated.
   *
   * @param {object} deal
   * @param {string} deal.asin       - Product identifier
   * @param {number} deal.price      - Purchase price
   * @param {string} [deal.retailer] - Source retailer
   * @returns {Promise<{ orderId: string, asin: string, retailer: string, price: number, status: string, dryRun: boolean, timestamp: string }>}
   */
  async function purchaseItem(deal) {
    _checkCycleReset();

    const fail = (d) => ({
      orderId: null, asin: d?.asin ?? null, retailer: d?.retailer ?? null,
      price: d?.price ?? null, status: 'failed', dryRun, timestamp: new Date().toISOString(),
    });

    if (!deal || !deal.asin || deal.price == null) return fail(deal);
    if (deal.price > maxItemPrice) {
      log('warn', 'item price exceeds max', { asin: deal.asin, price: deal.price, maxItemPrice });
      return fail(deal);
    }
    if (cycleSpend + deal.price > budgetPerCycle) {
      log('warn', 'cycle budget exhausted', { asin: deal.asin, cycleSpend, price: deal.price });
      return fail(deal);
    }
    if (cycleItemCount >= maxItemsPerCycle) {
      log('warn', 'cycle item limit reached', { asin: deal.asin, cycleItemCount, maxItemsPerCycle });
      return fail(deal);
    }

    const orderId = _generateOrderId();
    const status = dryRun ? 'simulated' : 'purchased';
    cycleSpend += deal.price;
    cycleItemCount += 1;

    const record = {
      orderId, asin: deal.asin, retailer: deal.retailer ?? null,
      price: deal.price, status, dryRun, timestamp: new Date().toISOString(),
    };
    purchaseHistory.push({ ...record });
    log('info', `item ${status}`, { orderId, asin: deal.asin, price: deal.price, dryRun });
    return { ...record };
  }

  /**
   * Execute purchases for all items currently in the cart.
   * Processes sequentially to avoid race conditions on budget counters.
   *
   * @returns {Promise<{ orders: object[], totalSpent: number, itemCount: number, dryRun: boolean, errors: object[] }>}
   */
  async function executePurchases() {
    _checkCycleReset();

    const orders = [];
    const errors = [];
    let totalSpent = 0;

    // Sequential to guard budget state
    for (const deal of [...cart]) {
      try {
        const result = await purchaseItem(deal);
        if (result.status === 'failed') {
          errors.push({ asin: deal.asin, reason: 'purchase failed' });
        } else {
          orders.push(result);
          totalSpent += deal.price;
        }
      } catch (err) {
        log('error', 'purchase threw', { asin: deal.asin, error: err.message });
        errors.push({ asin: deal.asin, reason: err.message });
      }
    }

    cart.length = 0;
    log('info', 'purchase cycle complete', { orders: orders.length, totalSpent, errors: errors.length });

    return { orders, totalSpent, itemCount: orders.length, dryRun, errors };
  }

  // ─── Budget ───────────────────────────────────────────────────────────

  /**
   * Check remaining budget for the current cycle. Queries treasuryManager
   * for allocation when available.
   *
   * @returns {Promise<{ budgetPerCycle: number, cycleSpend: number, remaining: number, maxItemPrice: number, cycleItemCount: number, maxItemsPerCycle: number, cycleStarted: string }>}
   */
  async function checkBudget() {
    _checkCycleReset();

    let effectiveBudget = budgetPerCycle;
    if (treasuryManager && typeof treasuryManager.getAllocation === 'function') {
      try {
        const allocation = await treasuryManager.getAllocation();
        if (allocation && allocation.retailBudget != null) {
          effectiveBudget = allocation.retailBudget;
        }
      } catch (err) {
        log('warn', 'treasuryManager.getAllocation failed, using default', { error: err.message });
      }
    }

    return {
      budgetPerCycle: effectiveBudget,
      cycleSpend,
      remaining: effectiveBudget - cycleSpend,
      maxItemPrice,
      cycleItemCount,
      maxItemsPerCycle,
      cycleStarted: new Date(lastCycleReset).toISOString(),
    };
  }

  /** @returns {{ previousSpend: number, previousItemCount: number, resetAt: string }} */
  function resetCycle() {
    const prev = { previousSpend: cycleSpend, previousItemCount: cycleItemCount };
    cycleSpend = 0;
    cycleItemCount = 0;
    lastCycleReset = Date.now();
    log('info', 'cycle manually reset', prev);
    return { ...prev, resetAt: new Date(lastCycleReset).toISOString() };
  }

  /** @returns {object[]} Copy of the full purchase history. */
  function getPurchaseHistory() {
    return purchaseHistory.map((r) => ({ ...r }));
  }

  /** @returns {{ budgetPerCycle: number, maxItemPrice: number, maxItemsPerCycle: number, dryRun: boolean, hasTreasuryManager: boolean }} */
  function getConfig() {
    return { budgetPerCycle, maxItemPrice, maxItemsPerCycle, dryRun, hasTreasuryManager: treasuryManager !== null };
  }

  // ─── Public API ───────────────────────────────────────────────────────

  return {
    addToCart,
    removeFromCart,
    getCart,
    clearCart,
    purchaseItem,
    executePurchases,
    checkBudget,
    resetCycle,
    getPurchaseHistory,
    getConfig,
    // Test backdoors
    _checkCycleReset,
    _generateOrderId,
  };
}

export default createPurchaser;
