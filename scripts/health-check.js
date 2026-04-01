#!/usr/bin/env node
/**
 * health-check.js — OpenProphet preflight health checker.
 *
 * Verifies the trading system is ready before starting:
 *   - Alpaca API connectivity (paper + live)
 *   - Account status, PDT flag, buying power
 *   - Database writable (better-sqlite3)
 *   - Strategy configs loaded and valid
 *   - Go backend reachable (optional)
 *
 * Usage:
 *   node scripts/health-check.js          # human-readable output
 *   node scripts/health-check.js --json   # machine-readable JSON
 *
 * @module health-check
 */

import 'dotenv/config';
import { readdir, readFile, access, constants } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..');

const PAPER_BASE_URL = 'https://paper-api.alpaca.markets';
const LIVE_BASE_URL = 'https://api.alpaca.markets';
const ACCOUNT_PATH = '/v2/account';
const FETCH_TIMEOUT_MS = 8000;

// ─── Individual Health Checks ────────────────────────────────────────────────

/**
 * Ping an Alpaca endpoint and return account info.
 * @param {string} baseUrl
 * @param {string} apiKey
 * @param {string} secretKey
 * @returns {Promise<{ok: boolean, account?: object, error?: string}>}
 */
async function pingAlpaca(baseUrl, apiKey, secretKey) {
  try {
    const res = await fetch(`${baseUrl}${ACCOUNT_PATH}`, {
      headers: {
        'APCA-API-KEY-ID': apiKey,
        'APCA-API-SECRET-KEY': secretKey,
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { ok: false, error: `HTTP ${res.status}: ${body.slice(0, 120)}` };
    }
    const account = await res.json();
    return { ok: true, account };
  } catch (err) {
    const msg = err.name === 'TimeoutError' ? 'Request timed out' : err.message;
    return { ok: false, error: msg };
  }
}

/**
 * Resolve Alpaca API credentials from environment.
 * Returns separate paper and live key sets when distinguishable.
 */
function resolveAlpacaKeys() {
  const apiKey = process.env.ALPACA_PUBLIC_KEY || process.env.ALPACA_API_KEY || '';
  const secretKey = process.env.ALPACA_SECRET_KEY || '';
  const endpoint = process.env.ALPACA_ENDPOINT || process.env.ALPACA_BASE_URL || PAPER_BASE_URL;
  const isPaper = endpoint.includes('paper');

  return { apiKey, secretKey, endpoint, isPaper };
}

async function checkAlpacaPaper(keys) {
  if (!keys.apiKey || !keys.secretKey) {
    return {
      name: 'Alpaca Paper API',
      status: 'fail',
      message: 'No API keys configured (ALPACA_PUBLIC_KEY / ALPACA_SECRET_KEY)',
      critical: true,
    };
  }
  // If the configured endpoint is paper, use those keys against paper
  // If it's live, we still try paper with the same keys (Alpaca keys are env-specific)
  const url = keys.isPaper ? keys.endpoint : PAPER_BASE_URL;
  const result = await pingAlpaca(url, keys.apiKey, keys.secretKey);

  if (!result.ok) {
    // If keys are for live, paper will fail — that's expected, mark as skip
    if (!keys.isPaper) {
      return {
        name: 'Alpaca Paper API',
        status: 'skip',
        message: 'Keys configured for live endpoint, paper skipped',
        critical: false,
      };
    }
    return {
      name: 'Alpaca Paper API',
      status: 'fail',
      message: result.error,
      critical: true,
    };
  }

  const acctStatus = result.account.status || 'UNKNOWN';
  return {
    name: 'Alpaca Paper API',
    status: acctStatus === 'ACTIVE' ? 'pass' : 'warn',
    message: `Connected, account ${acctStatus}`,
    critical: true,
    account: result.account,
  };
}

async function checkAlpacaLive(keys) {
  if (!keys.apiKey || !keys.secretKey) {
    return {
      name: 'Alpaca Live API',
      status: 'skip',
      message: 'No API keys configured',
      critical: false,
    };
  }
  // Only attempt live if keys are for live endpoint
  if (keys.isPaper) {
    return {
      name: 'Alpaca Live API',
      status: 'skip',
      message: 'No live keys configured',
      critical: false,
    };
  }

  const result = await pingAlpaca(LIVE_BASE_URL, keys.apiKey, keys.secretKey);
  if (!result.ok) {
    return {
      name: 'Alpaca Live API',
      status: 'fail',
      message: result.error,
      critical: true,
    };
  }

  const acctStatus = result.account.status || 'UNKNOWN';
  return {
    name: 'Alpaca Live API',
    status: acctStatus === 'ACTIVE' ? 'pass' : 'warn',
    message: `Connected, account ${acctStatus}`,
    critical: true,
    account: result.account,
  };
}

function checkAccountStatus(paperCheck, liveCheck) {
  // Use whichever API check succeeded and has account data
  const source = paperCheck.account || liveCheck.account;
  if (!source) {
    return {
      name: 'Account Status',
      status: 'fail',
      message: 'No account data available (API checks failed)',
      critical: true,
    };
  }

  const status = source.status || 'UNKNOWN';
  const buyingPower = parseFloat(source.buying_power || 0);
  const formatted = buyingPower.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
  });

  return {
    name: 'Account Status',
    status: status === 'ACTIVE' ? 'pass' : 'fail',
    message: `${status}, buying power ${formatted}`,
    critical: true,
  };
}

function checkPDTFlag(paperCheck, liveCheck) {
  const source = paperCheck.account || liveCheck.account;
  if (!source) {
    return {
      name: 'PDT Flag',
      status: 'skip',
      message: 'No account data available',
      critical: false,
    };
  }

  const flagged = source.pattern_day_trader === true ||
                  source.daytrade_count >= 3;

  return {
    name: 'PDT Flag',
    status: flagged ? 'warn' : 'pass',
    message: flagged
      ? `Flagged as PDT (day trades: ${source.daytrade_count ?? 'N/A'})`
      : 'Not flagged',
    critical: false,
  };
}

async function checkDatabase() {
  const dbPath = process.env.DATABASE_PATH ||
    join(PROJECT_ROOT, 'data', 'prophet_trader.db');
  const displayPath = dbPath.startsWith(PROJECT_ROOT)
    ? './' + dbPath.slice(PROJECT_ROOT.length + 1)
    : dbPath;

  try {
    // Dynamic import so the module still loads even if better-sqlite3 is missing
    const { default: Database } = await import('better-sqlite3');
    const db = new Database(dbPath);

    // Verify writable with a temp table round-trip
    db.exec(`
      CREATE TABLE IF NOT EXISTS _health_check (ts INTEGER);
      INSERT INTO _health_check (ts) VALUES (${Date.now()});
      DELETE FROM _health_check;
    `);
    db.close();

    return {
      name: 'Database Writable',
      status: 'pass',
      message: `${displayPath} (writable)`,
      critical: true,
    };
  } catch (err) {
    return {
      name: 'Database Writable',
      status: 'fail',
      message: `${displayPath}: ${err.message}`,
      critical: true,
    };
  }
}

async function checkStrategies() {
  const strategiesDir = join(PROJECT_ROOT, 'strategies');
  try {
    const files = await readdir(strategiesDir);
    const jsonFiles = files.filter(f => f.endsWith('.json'));

    if (jsonFiles.length === 0) {
      return {
        name: 'Strategies Loaded',
        status: 'fail',
        message: 'No strategy JSON files found in strategies/',
        critical: true,
      };
    }

    // Validate each JSON is parseable and has required fields
    const errors = [];
    for (const file of jsonFiles) {
      try {
        const raw = await readFile(join(strategiesDir, file), 'utf-8');
        const strategy = JSON.parse(raw);
        if (!strategy.id || !strategy.name) {
          errors.push(`${file}: missing id or name`);
        }
      } catch (parseErr) {
        errors.push(`${file}: ${parseErr.message}`);
      }
    }

    if (errors.length > 0) {
      return {
        name: 'Strategies Loaded',
        status: 'warn',
        message: `${jsonFiles.length} found, ${errors.length} invalid: ${errors[0]}`,
        critical: true,
      };
    }

    return {
      name: 'Strategies Loaded',
      status: 'pass',
      message: `${jsonFiles.length} strategies available`,
      critical: false,
    };
  } catch (err) {
    return {
      name: 'Strategies Loaded',
      status: 'fail',
      message: `Cannot read strategies/: ${err.message}`,
      critical: true,
    };
  }
}

async function checkGoBackend() {
  const port = process.env.TRADING_BOT_PORT || '4534';
  const baseUrl = process.env.TRADING_BOT_URL || `http://localhost:${port}`;
  const healthUrl = `${baseUrl}/health`;

  try {
    const res = await fetch(healthUrl, {
      signal: AbortSignal.timeout(3000),
    });
    if (res.ok) {
      return {
        name: 'Go Backend',
        status: 'pass',
        message: `${baseUrl} responding`,
        critical: false,
      };
    }
    return {
      name: 'Go Backend',
      status: 'fail',
      message: `${baseUrl} returned HTTP ${res.status}`,
      critical: false,
    };
  } catch {
    return {
      name: 'Go Backend',
      status: 'fail',
      message: `${baseUrl.replace(/^https?:\/\//, '')} not responding`,
      critical: false,
    };
  }
}

// ─── Orchestrator ────────────────────────────────────────────────────────────

/**
 * Run all preflight health checks.
 * @param {object} [options]
 * @param {boolean} [options.skipLive=false]  - Skip live API check
 * @param {boolean} [options.skipBackend=false] - Skip Go backend check
 * @returns {Promise<{passed: boolean, checks: Array<{name: string, status: string, message: string, critical: boolean}>}>}
 */
export async function runHealthCheck(options = {}) {
  const keys = resolveAlpacaKeys();

  // Run API checks (paper + live in parallel)
  const [paperCheck, liveCheck] = await Promise.all([
    checkAlpacaPaper(keys),
    options.skipLive ? Promise.resolve({
      name: 'Alpaca Live API', status: 'skip', message: 'Skipped by option', critical: false,
    }) : checkAlpacaLive(keys),
  ]);

  // Account-derived checks use data from API results
  const accountCheck = checkAccountStatus(paperCheck, liveCheck);
  const pdtCheck = checkPDTFlag(paperCheck, liveCheck);

  // Run independent checks in parallel
  const [dbCheck, strategyCheck, backendCheck] = await Promise.all([
    checkDatabase(),
    checkStrategies(),
    options.skipBackend ? Promise.resolve({
      name: 'Go Backend', status: 'skip', message: 'Skipped by option', critical: false,
    }) : checkGoBackend(),
  ]);

  // Strip internal account data from check results
  const sanitize = ({ account, ...rest }) => rest;
  const checks = [
    sanitize(paperCheck),
    sanitize(liveCheck),
    accountCheck,
    pdtCheck,
    dbCheck,
    strategyCheck,
    backendCheck,
  ];

  // System passes if all critical checks pass (or skip)
  const criticalFailure = checks.some(
    c => c.critical && c.status === 'fail'
  );

  return { passed: !criticalFailure, checks };
}

// ─── Formatting ──────────────────────────────────────────────────────────────

const STATUS_ICONS = {
  pass: '✓ PASS',
  fail: '✗ FAIL',
  skip: '⚠ SKIP',
  warn: '⚠ WARN',
};

/**
 * Format health check results as a human-readable report.
 * @param {{passed: boolean, checks: object[]}} result
 * @returns {string}
 */
export function formatHealthReport(result) {
  const lines = [];

  lines.push('');
  lines.push('╔══════════════════════════════════════════════════════════════╗');
  lines.push('║  OpenProphet Preflight Health Check                         ║');
  lines.push('╚══════════════════════════════════════════════════════════════╝');
  lines.push('');

  // Column widths
  const nameWidth = 30;
  const statusWidth = 10;

  lines.push(
    `  ${'Check'.padEnd(nameWidth)}${'Status'.padEnd(statusWidth)}Details`
  );
  lines.push(`  ${'─'.repeat(61)}`);

  for (const check of result.checks) {
    const icon = STATUS_ICONS[check.status] || check.status;
    lines.push(
      `  ${check.name.padEnd(nameWidth)}${icon.padEnd(statusWidth)}${check.message}`
    );
  }

  lines.push(`  ${'─'.repeat(61)}`);

  // Summary counts
  const counts = { pass: 0, fail: 0, skip: 0, warn: 0 };
  for (const c of result.checks) counts[c.status]++;
  const total = result.checks.length;
  const parts = [];
  if (counts.pass) parts.push(`${counts.pass} passed`);
  if (counts.warn) parts.push(`${counts.warn} warnings`);
  if (counts.skip) parts.push(`${counts.skip} skipped`);
  if (counts.fail) parts.push(`${counts.fail} failed`);
  lines.push(`  Result: ${parts.join(', ')} (${total} total)`);
  lines.push('');

  // Non-critical failures get a note
  const nonCritFails = result.checks.filter(
    c => !c.critical && (c.status === 'fail' || c.status === 'warn')
  );
  for (const c of nonCritFails) {
    lines.push(`  ⚠  Non-critical: ${c.name} — ${c.message}`);
  }

  if (result.passed) {
    lines.push('  ✓  System ready to start');
  } else {
    const blockers = result.checks
      .filter(c => c.critical && c.status === 'fail')
      .map(c => c.name);
    lines.push(`  ✗  System NOT ready — blocked by: ${blockers.join(', ')}`);
  }

  lines.push('');
  return lines.join('\n');
}

// ─── CLI Entry Point ─────────────────────────────────────────────────────────

async function main() {
  const jsonMode = process.argv.includes('--json');

  const result = await runHealthCheck();

  if (jsonMode) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } else {
    process.stdout.write(formatHealthReport(result));
  }

  process.exitCode = result.passed ? 0 : 1;
}

// Run when executed directly (not imported)
const isMain = process.argv[1] &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isMain) {
  main().catch(err => {
    console.error('Health check crashed:', err);
    process.exitCode = 2;
  });
}
