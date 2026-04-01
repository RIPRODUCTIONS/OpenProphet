/**
 * @fileoverview Crypto exchange configuration loader for OpenProphet.
 * Reads exchange credentials from environment variables and builds
 * the config object consumed by CryptoService.
 *
 * @module crypto-config
 */

import 'dotenv/config';

/**
 * @typedef {Object} ExchangeCredentials
 * @property {string}  apiKey     - Exchange API key
 * @property {string}  secret     - Exchange API secret
 * @property {boolean} sandbox    - Whether to use sandbox/testnet mode
 * @property {string}  [password] - Exchange passphrase (Coinbase Pro)
 */

/**
 * @typedef {Object} CryptoConfig
 * @property {Object.<string, ExchangeCredentials>} exchanges - Map of exchange id → credentials
 */

/**
 * Parse a boolean-ish env var. Defaults to `true` (sandbox) when unset.
 * @param {string|undefined} value
 * @returns {boolean}
 */
function parseBool(value) {
  if (value === undefined || value === '') return true;
  return !['false', '0', 'no'].includes(value.toLowerCase());
}

/**
 * Build crypto config from environment variables.
 *
 * Only exchanges whose API key is set are included.
 * Sandbox mode defaults to true for safety — you must explicitly
 * set `*_SANDBOX=false` to trade with real money.
 *
 * @returns {CryptoConfig}
 */
export function loadCryptoConfig() {
  /** @type {CryptoConfig} */
  const config = { exchanges: {} };

  // --- Binance ---
  if (process.env.BINANCE_API_KEY) {
    config.exchanges.binance = {
      apiKey: process.env.BINANCE_API_KEY,
      secret: process.env.BINANCE_SECRET || '',
      sandbox: parseBool(process.env.BINANCE_SANDBOX),
    };
  }

  // --- Coinbase (Advanced Trade / Pro) ---
  if (process.env.COINBASE_API_KEY) {
    config.exchanges.coinbase = {
      apiKey: process.env.COINBASE_API_KEY,
      secret: process.env.COINBASE_SECRET || '',
      password: process.env.COINBASE_PASSPHRASE || '',
      sandbox: parseBool(process.env.COINBASE_SANDBOX),
    };
  }

  // --- Kraken ---
  if (process.env.KRAKEN_API_KEY) {
    config.exchanges.kraken = {
      apiKey: process.env.KRAKEN_API_KEY,
      secret: process.env.KRAKEN_SECRET || '',
      sandbox: parseBool(process.env.KRAKEN_SANDBOX),
    };
  }

  return config;
}

export default loadCryptoConfig;
