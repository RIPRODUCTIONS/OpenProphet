/**
 * Tests for env-check.js — environment variable validation.
 * Uses Node.js built-in test runner (node:test + node:assert).
 *
 * Each test saves/restores process.env to avoid pollution.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { validateEnv } from '../env-check.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Required env vars that must be set for validateEnv to return ok:true. */
const REQUIRED_KEYS = ['ALPACA_PUBLIC_KEY', 'ALPACA_SECRET_KEY', 'TRADING_BOT_URL'];

/** A set of optional keys the module checks. */
const SOME_OPTIONAL_KEYS = [
  'GEMINI_API_KEY', 'STRATEGY_ID', 'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_CHAT_ID', 'DISCORD_WEBHOOK_URL',
];

let savedEnv;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('validateEnv', () => {
  beforeEach(() => {
    savedEnv = { ...process.env };
  });

  afterEach(() => {
    // Restore original env — wipe any keys we added, restore any we removed
    for (const key of Object.keys(process.env)) {
      if (!(key in savedEnv)) {
        delete process.env[key];
      }
    }
    for (const [key, val] of Object.entries(savedEnv)) {
      process.env[key] = val;
    }
  });

  it('returns ok:true when all required vars are set', () => {
    for (const key of REQUIRED_KEYS) {
      process.env[key] = 'test-value';
    }

    const result = validateEnv({ fatal: false });
    assert.equal(result.ok, true);
    assert.deepEqual(result.missing, []);
  });

  it('returns ok:false with missing key when ALPACA_PUBLIC_KEY is absent', () => {
    // Set the other required vars
    process.env.ALPACA_SECRET_KEY = 'test';
    process.env.TRADING_BOT_URL = 'test';
    // Ensure ALPACA_PUBLIC_KEY is NOT set
    delete process.env.ALPACA_PUBLIC_KEY;

    const result = validateEnv({ fatal: false });
    assert.equal(result.ok, false);
    assert.ok(result.missing.includes('ALPACA_PUBLIC_KEY'),
      `missing should include ALPACA_PUBLIC_KEY, got: ${result.missing}`);
  });

  it('fatal=false does NOT exit the process', () => {
    // Remove all required vars
    for (const key of REQUIRED_KEYS) {
      delete process.env[key];
    }

    // If fatal were true and we didn't handle it, process.exit would kill the test.
    // With fatal=false, it should just return the result.
    const result = validateEnv({ fatal: false });
    assert.equal(result.ok, false);
    assert.ok(result.missing.length > 0);
  });

  it('missing optional vars appear in warnings array', () => {
    // Set all required
    for (const key of REQUIRED_KEYS) {
      process.env[key] = 'test-value';
    }
    // Ensure at least some optional vars are NOT set
    for (const key of SOME_OPTIONAL_KEYS) {
      delete process.env[key];
    }

    const result = validateEnv({ fatal: false });
    assert.ok(Array.isArray(result.warnings), 'Should return warnings array');
    assert.ok(result.warnings.length > 0, 'Should have at least one warning');
    // Check that at least one of our deleted optional keys appears
    const found = SOME_OPTIONAL_KEYS.some(k => result.warnings.includes(k));
    assert.ok(found, `Expected at least one of ${SOME_OPTIONAL_KEYS.join(', ')} in warnings`);
  });

  it('returns empty warnings when all optional vars are set', () => {
    // Set all required
    for (const key of REQUIRED_KEYS) {
      process.env[key] = 'test-value';
    }
    // Set all known optional
    for (const key of SOME_OPTIONAL_KEYS) {
      process.env[key] = 'test-value';
    }
    // Also set the rest of the optional keys the module checks
    process.env.ALERT_WEBHOOK_URL = 'test';
    process.env.BINANCE_API_KEY = 'test';
    process.env.BINANCE_SECRET = 'test';
    process.env.COINBASE_API_KEY = 'test';
    process.env.COINBASE_SECRET = 'test';
    process.env.KRAKEN_API_KEY = 'test';
    process.env.KRAKEN_SECRET = 'test';

    const result = validateEnv({ fatal: false });
    assert.equal(result.ok, true);
    assert.deepEqual(result.warnings, []);
  });
});
