/**
 * env-check.js — Validates environment variables at startup.
 * Required vars cause a fatal exit. Optional vars emit warnings.
 *
 * @module env-check
 */

const REQUIRED = [
  { key: 'ALPACA_PUBLIC_KEY', desc: 'Alpaca API public key for trading' },
  { key: 'ALPACA_SECRET_KEY', desc: 'Alpaca API secret key for trading' },
  { key: 'TRADING_BOT_URL',  desc: 'Go backend URL (default: http://localhost:4534)' },
];

const OPTIONAL = [
  { key: 'GEMINI_API_KEY',       desc: 'Google Gemini for embeddings/analysis' },
  { key: 'STRATEGY_ID',          desc: 'Active strategy preset name' },
  { key: 'TELEGRAM_BOT_TOKEN',   desc: 'Telegram alerts bot token' },
  { key: 'TELEGRAM_CHAT_ID',     desc: 'Telegram alerts chat ID' },
  { key: 'DISCORD_WEBHOOK_URL',  desc: 'Discord alerts webhook' },
  { key: 'ALERT_WEBHOOK_URL',    desc: 'Custom webhook for alerts' },
  { key: 'BINANCE_API_KEY',      desc: 'Binance exchange API key' },
  { key: 'BINANCE_SECRET',       desc: 'Binance exchange secret' },
  { key: 'COINBASE_API_KEY',     desc: 'Coinbase exchange API key' },
  { key: 'COINBASE_SECRET',      desc: 'Coinbase exchange secret' },
  { key: 'KRAKEN_API_KEY',       desc: 'Kraken exchange API key' },
  { key: 'KRAKEN_SECRET',        desc: 'Kraken exchange secret' },
];

/**
 * Validate environment variables. Logs results to stderr.
 * @param {{ fatal?: boolean }} [opts] - If fatal=true (default), exits on missing required vars
 * @returns {{ ok: boolean, missing: string[], warnings: string[] }}
 */
export function validateEnv(opts = {}) {
  const fatal = opts.fatal !== false;
  const missing = [];
  const warnings = [];

  console.error('[env-check] Validating environment...');

  for (const { key, desc } of REQUIRED) {
    if (!process.env[key]) {
      missing.push(key);
      console.error(`  ✗ MISSING REQUIRED: ${key} — ${desc}`);
    }
  }

  for (const { key, desc } of OPTIONAL) {
    if (!process.env[key]) {
      warnings.push(key);
      console.error(`  ⚠ optional not set: ${key} — ${desc}`);
    }
  }

  const ok = missing.length === 0;
  if (ok) {
    console.error(`[env-check] ✓ All ${REQUIRED.length} required vars present (${warnings.length} optional missing)`);
  } else {
    console.error(`[env-check] ✗ ${missing.length} required var(s) missing: ${missing.join(', ')}`);
    if (fatal) {
      console.error('[env-check] Cannot start without required environment variables. Exiting.');
      process.exit(1);
    }
  }

  return { ok, missing, warnings };
}

export default validateEnv;
