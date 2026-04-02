/**
 * scheduler.js — Retail arbitrage scheduler for OpenProphet.
 * Runs hourly deal scanning, daily listing optimization, and weekly P&L reports.
 * @module arbitrage/retail/scheduler
 */

// ─── Logging ─────────────────────────────────────────────────────────────

function log(level, message, meta = {}) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    module: 'arbitrage/retail/scheduler',
    message,
    ...meta,
  };
  process.stderr.write(JSON.stringify(entry) + '\n');
}

// ─── Constants ───────────────────────────────────────────────────────────

const JOBS = {
  scanDeals: { name: 'scanDeals', description: 'Hourly deal scanning' },
  optimizeListings: { name: 'optimizeListings', description: 'Daily listing optimization' },
  generateReport: { name: 'generateReport', description: 'Weekly P&L report' },
};

// ─── Factory ─────────────────────────────────────────────────────────────

/**
 * Create a retail arbitrage scheduler.
 * @param {object} [config]
 * @param {object} [config.scanner]   - Scanner module (findArbitrageOpportunities).
 * @param {object} [config.analyzer]  - Analyzer module (analyzeOpportunities).
 * @param {object} [config.purchaser] - Purchaser module (addToCart, executePurchases).
 * @param {object} [config.lister]    - Lister module (createListing, optimizeListings).
 * @param {object} [config.tracker]   - Tracker module (record, getAggregatePnL, getInventorySummary).
 * @param {number}  [config.scanIntervalHours]     - Hours between deal scans.
 * @param {number}  [config.optimizeIntervalHours]  - Hours between listing optimizations.
 * @param {number}  [config.reportIntervalHours]    - Hours between P&L reports.
 * @param {boolean} [config.enabled]                - Whether scheduler is enabled.
 * @returns {RetailScheduler}
 */
export function createScheduler(config = {}) {
  const { scanner, analyzer, purchaser, lister, tracker } = config;

  // ── Config: explicit → env → default ────────────────────────────────
  const scanIntervalMs = (config.scanIntervalHours ?? parseFloat(process.env.RETAIL_SCAN_INTERVAL_HOURS || '1')) * 3600_000;
  const optimizeIntervalMs = (config.optimizeIntervalHours ?? parseFloat(process.env.RETAIL_OPTIMIZE_INTERVAL_HOURS || '24')) * 3600_000;
  const reportIntervalMs = (config.reportIntervalHours ?? parseFloat(process.env.RETAIL_REPORT_INTERVAL_HOURS || '168')) * 3600_000;
  const enabled = config.enabled ?? (process.env.RETAIL_SCHEDULER_ENABLED !== 'false');

  log('INFO', 'Scheduler initialised', { scanIntervalMs, optimizeIntervalMs, reportIntervalMs, enabled });

  // ── Internal State ──────────────────────────────────────────────────
  /** @type {Map<string, ReturnType<typeof setInterval>>} */
  const timers = new Map();
  /** @type {object[]} */
  const jobHistory = [];
  let running = false;

  // ── Internal Helpers ────────────────────────────────────────────────

  /** Record a job execution in history. */
  function _recordJob(job, status, details = {}) {
    jobHistory.push({ job, status, timestamp: new Date().toISOString(), ...details });
  }

  /** Wrap a job in error handling so a failure never crashes the scheduler. */
  async function _safeRun(jobName, fn) {
    try {
      const result = await fn();
      _recordJob(jobName, 'success', { result });
    } catch (err) {
      log('ERROR', `Job "${jobName}" failed`, { error: err.message });
      _recordJob(jobName, 'failed', { error: err.message });
    }
  }

  // ── Public Methods ──────────────────────────────────────────────────

  /**
   * Start all scheduled jobs. Idempotent — returns early if already running.
   * Runs an initial scan immediately.
   * @returns {{ started: boolean, jobs: string[] }}
   */
  function start() {
    if (running) {
      log('WARN', 'Scheduler already running');
      return { started: true, jobs: Object.keys(JOBS) };
    }
    if (!enabled) {
      log('WARN', 'Scheduler is disabled via config');
      return { started: false, jobs: [] };
    }

    running = true;
    timers.set(JOBS.scanDeals.name, setInterval(() => _safeRun(JOBS.scanDeals.name, runScanCycle), scanIntervalMs));
    timers.set(JOBS.optimizeListings.name, setInterval(() => _safeRun(JOBS.optimizeListings.name, runOptimizeCycle), optimizeIntervalMs));
    timers.set(JOBS.generateReport.name, setInterval(() => _safeRun(JOBS.generateReport.name, runReportCycle), reportIntervalMs));

    _safeRun(JOBS.scanDeals.name, runScanCycle); // initial scan

    log('INFO', 'Scheduler started', { jobs: Object.keys(JOBS) });
    return { started: true, jobs: Object.keys(JOBS) };
  }

  /**
   * Stop all scheduled jobs. Clears all intervals.
   * @returns {{ stopped: boolean, clearedJobs: number }}
   */
  function stop() {
    let cleared = 0;
    for (const [name, intervalId] of timers) {
      clearInterval(intervalId);
      cleared++;
      log('INFO', `Cleared job timer: ${name}`);
    }
    timers.clear();
    running = false;
    log('INFO', 'Scheduler stopped', { clearedJobs: cleared });
    return { stopped: true, clearedJobs: cleared };
  }

  /**
   * Execute one scan cycle: find → analyze → purchase → list → track.
   * @returns {Promise<{ scanned: number, analyzed: number, passed: number, purchased: number, listed: number, errors: string[], timestamp: string }>}
   */
  async function runScanCycle() {
    const errors = [];
    const ts = new Date().toISOString();
    let scanned = 0, analyzed = 0, passed = 0, purchased = 0, listed = 0;

    try {
      const opportunities = await scanner.findArbitrageOpportunities();
      scanned = opportunities.length;

      const analysis = await analyzer.analyzeOpportunities(opportunities);
      analyzed = analysis.deals?.length ?? 0;

      const viable = analysis.passed ?? [];
      passed = viable.length;

      for (const deal of viable) {
        try { await purchaser.addToCart(deal); }
        catch (err) { errors.push(`addToCart failed: ${err.message}`); }
      }

      const purchaseResult = await purchaser.executePurchases();
      const purchasedItems = purchaseResult.orders ?? [];
      purchased = purchasedItems.length;

      for (const item of purchasedItems) {
        try { await lister.createListing(item); listed++; }
        catch (err) { errors.push(`createListing failed: ${err.message}`); }
      }

      if (tracker?.record) {
        await tracker.record({ type: 'scanCycle', scanned, analyzed, passed, purchased, listed, errors: errors.length, timestamp: ts });
      }
    } catch (err) {
      errors.push(`Scan cycle error: ${err.message}`);
      log('ERROR', 'Scan cycle failed', { error: err.message });
    }

    log('INFO', 'Scan cycle complete', { scanned, analyzed, passed, purchased, listed, errorCount: errors.length });
    return { scanned, analyzed, passed, purchased, listed, errors, timestamp: ts };
  }

  /**
   * Execute listing optimization cycle.
   * @returns {Promise<{ optimized: number, priceChanges: object[], timestamp: string }>}
   */
  async function runOptimizeCycle() {
    const ts = new Date().toISOString();
    try {
      const result = await lister.optimizeListings();
      const report = { optimized: result.optimized ?? 0, priceChanges: [...(result.priceChanges || [])], timestamp: ts };
      log('INFO', 'Optimize cycle complete', { optimized: report.optimized, priceChanges: report.priceChanges.length });
      return report;
    } catch (err) {
      log('ERROR', 'Optimize cycle failed', { error: err.message });
      return { optimized: 0, priceChanges: [], timestamp: ts };
    }
  }

  /**
   * Generate a comprehensive P&L report from tracker data.
   * @returns {Promise<object>}
   */
  async function runReportCycle() {
    const ts = new Date().toISOString();
    try {
      const pnl = await tracker.getAggregatePnL();
      const inventory = await tracker.getInventorySummary();
      const report = { pnl: { ...pnl }, inventory: { ...inventory }, timestamp: ts };
      log('INFO', 'P&L report generated', { netProfit: pnl.netProfit ?? pnl.net ?? 0, totalItems: inventory.totalItems ?? inventory.count ?? 0 });
      return report;
    } catch (err) {
      log('ERROR', 'Report cycle failed', { error: err.message });
      return { pnl: {}, inventory: {}, timestamp: ts, error: err.message };
    }
  }

  /** @returns {boolean} Whether the scheduler is running. */
  function isRunning() { return running; }

  /** @returns {object[]} Copy of job execution history. */
  function getJobHistory() { return [...jobHistory]; }

  /**
   * Return current scheduler status including per-job info.
   * @returns {{ running: boolean, jobs: object, totalJobsRun: number }}
   */
  function getStatus() {
    const lastRunByJob = {};
    for (const entry of jobHistory) lastRunByJob[entry.job] = entry.timestamp;

    const jobs = {};
    for (const [key, job] of Object.entries(JOBS)) {
      const intervalMs = key === 'scanDeals' ? scanIntervalMs
        : key === 'optimizeListings' ? optimizeIntervalMs
        : reportIntervalMs;
      jobs[key] = { description: job.description, intervalMs, active: timers.has(key), lastRun: lastRunByJob[key] ?? null };
    }

    return { running, jobs, totalJobsRun: jobHistory.length };
  }

  // ── Public API ──────────────────────────────────────────────────────
  return {
    start,
    stop,
    runScanCycle,
    runOptimizeCycle,
    runReportCycle,
    isRunning,
    getJobHistory,
    getStatus,
    // Test backdoors
    _timers: timers,
    _jobHistory: jobHistory,
    _safeRun,
    _recordJob,
  };
}

export default createScheduler;
