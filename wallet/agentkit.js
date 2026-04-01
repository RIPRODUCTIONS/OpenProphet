/**
 * agentkit.js — Coinbase AgentKit wallet manager for OpenProphet.
 *
 * Provides on-chain wallet operations on Base L2 via @coinbase/agentkit.
 * Wallet seed is encrypted at rest using AES-256-GCM (same pattern as scripts/secrets.js).
 * Wallet address persisted to data/wallet.json.
 *
 * @module wallet/agentkit
 */

import { CdpEvmWalletProvider } from '@coinbase/agentkit';
import { ethers } from 'ethers';
import { createCipheriv, createDecipheriv, randomBytes, pbkdf2Sync } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..');
const WALLET_FILE = resolve(PROJECT_ROOT, 'data', 'wallet.json');

// Encryption constants — mirrors scripts/secrets.js
const PBKDF2_ITERATIONS = 100_000;
const PBKDF2_DIGEST = 'sha512';
const KEY_LENGTH = 32;
const SALT_LENGTH = 32;
const IV_LENGTH = 16;

// ─── Logging ──────────────────────────────────────────────────────────────

function log(level, message, meta = {}) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    module: 'wallet/agentkit',
    message,
    ...meta,
  };
  process.stderr.write(JSON.stringify(entry) + '\n');
}

// ─── Encryption helpers ───────────────────────────────────────────────────

function deriveKey(passphrase, salt) {
  return pbkdf2Sync(passphrase, salt, PBKDF2_ITERATIONS, KEY_LENGTH, PBKDF2_DIGEST);
}

/**
 * Encrypt plaintext with AES-256-GCM.
 * @param {string} plaintext
 * @param {string} passphrase
 * @returns {{ salt: string, iv: string, tag: string, data: string }}
 */
export function encryptData(plaintext, passphrase) {
  const salt = randomBytes(SALT_LENGTH);
  const iv = randomBytes(IV_LENGTH);
  const key = deriveKey(passphrase, salt);

  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    salt: salt.toString('hex'),
    iv: iv.toString('hex'),
    tag: tag.toString('hex'),
    data: encrypted.toString('hex'),
  };
}

/**
 * Decrypt an AES-256-GCM payload.
 * @param {{ salt: string, iv: string, tag: string, data: string }} payload
 * @param {string} passphrase
 * @returns {string}
 */
export function decryptData(payload, passphrase) {
  const salt = Buffer.from(payload.salt, 'hex');
  const iv = Buffer.from(payload.iv, 'hex');
  const tag = Buffer.from(payload.tag, 'hex');
  const data = Buffer.from(payload.data, 'hex');
  const key = deriveKey(passphrase, salt);

  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

// ─── Wallet persistence ───────────────────────────────────────────────────

function loadWalletFile() {
  if (!existsSync(WALLET_FILE)) return null;
  try {
    return JSON.parse(readFileSync(WALLET_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function saveWalletFile(data) {
  const dir = dirname(WALLET_FILE);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(WALLET_FILE, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

// ─── Wallet Manager ───────────────────────────────────────────────────────

/**
 * Create a WalletManager instance for on-chain operations on Base L2.
 *
 * @param {object} [config]
 * @param {string} [config.apiKey]         - Coinbase API key (env: COINBASE_API_KEY)
 * @param {string} [config.apiSecret]      - Coinbase API secret (env: COINBASE_API_SECRET)
 * @param {string} [config.encryptionKey]  - Key for encrypting wallet seed (env: WALLET_ENCRYPTION_KEY)
 * @param {string} [config.rpcUrl]         - Base RPC URL (env: BASE_RPC_URL)
 * @param {string} [config.networkId]      - Network ID (default: 'base-mainnet')
 * @returns {WalletManager}
 */
export function createWalletManager(config = {}) {
  const apiKey = config.apiKey || process.env.COINBASE_API_KEY || '';
  const apiSecret = config.apiSecret || process.env.COINBASE_API_SECRET || '';
  const encryptionKey = config.encryptionKey || process.env.WALLET_ENCRYPTION_KEY || '';
  const rpcUrl = config.rpcUrl || process.env.BASE_RPC_URL || 'https://mainnet.base.org';
  const networkId = config.networkId || 'base-mainnet';

  let walletProvider = null;
  let provider = null;
  let walletAddress = null;

  /**
   * Initialize or restore the agent wallet.
   * If wallet.json exists with encrypted seed data, restores from it.
   * Otherwise creates a new wallet and persists the encrypted seed.
   * @returns {Promise<{ address: string, isNew: boolean }>}
   */
  async function initWallet() {
    if (!apiKey || !apiSecret) {
      throw new Error('COINBASE_API_KEY and COINBASE_API_SECRET are required');
    }
    if (!encryptionKey) {
      throw new Error('WALLET_ENCRYPTION_KEY is required to encrypt wallet seed');
    }

    provider = new ethers.JsonRpcProvider(rpcUrl);

    const walletData = loadWalletFile();
    let isNew = false;

    if (walletData?.encryptedSeed) {
      // Restore existing wallet
      try {
        const seedJson = decryptData(walletData.encryptedSeed, encryptionKey);
        const seed = JSON.parse(seedJson);

        walletProvider = await CdpEvmWalletProvider.configureWithWallet({
          apiKeyName: apiKey,
          apiKeyPrivateKey: apiSecret,
          networkId,
          wallet: seed,
        });

        walletAddress = walletData.address;
        log('INFO', 'Wallet restored from encrypted seed', { address: walletAddress });
      } catch (err) {
        throw new Error(`Failed to restore wallet: ${err.message}`);
      }
    } else {
      // Create new wallet
      walletProvider = await CdpEvmWalletProvider.configureWithWallet({
        apiKeyName: apiKey,
        apiKeyPrivateKey: apiSecret,
        networkId,
      });

      const exportedWallet = await walletProvider.exportWallet();
      walletAddress = await walletProvider.getAddress();

      // Encrypt and save
      const encryptedSeed = encryptData(JSON.stringify(exportedWallet), encryptionKey);

      saveWalletFile({
        address: walletAddress,
        networkId,
        createdAt: new Date().toISOString(),
        encryptedSeed,
      });

      isNew = true;
      log('INFO', 'New wallet created and saved', { address: walletAddress });
    }

    return { address: walletAddress, isNew };
  }

  /**
   * Check token balances for the wallet.
   * @param {string[]} [tokens=['ETH', 'USDC']] - Token symbols to check
   * @returns {Promise<Record<string, { balance: string, decimals: number }>>}
   */
  async function getBalance(tokens = ['ETH', 'USDC']) {
    if (!provider || !walletAddress) {
      throw new Error('Wallet not initialized — call initWallet() first');
    }

    const balances = {};

    // Well-known Base L2 token addresses
    const TOKEN_ADDRESSES = {
      USDC: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      USDbC: '0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6B1',
      DAI: '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb',
      USDT: '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2',
      WETH: '0x4200000000000000000000000000000000000006',
    };

    const ERC20_ABI = [
      'function balanceOf(address) view returns (uint256)',
      'function decimals() view returns (uint8)',
    ];

    for (const token of tokens) {
      try {
        if (token === 'ETH') {
          const wei = await provider.getBalance(walletAddress);
          balances.ETH = { balance: ethers.formatEther(wei), decimals: 18 };
        } else {
          const addr = TOKEN_ADDRESSES[token];
          if (!addr) {
            balances[token] = { balance: '0', decimals: 0, error: 'Unknown token' };
            continue;
          }
          const contract = new ethers.Contract(addr, ERC20_ABI, provider);
          const [raw, decimals] = await Promise.all([
            contract.balanceOf(walletAddress),
            contract.decimals(),
          ]);
          balances[token] = {
            balance: ethers.formatUnits(raw, decimals),
            decimals: Number(decimals),
          };
        }
      } catch (err) {
        balances[token] = { balance: '0', decimals: 0, error: err.message };
      }
    }

    return balances;
  }

  /**
   * Send a payment from the agent wallet.
   * @param {string} to      - Recipient address
   * @param {string} amount  - Amount to send (human-readable)
   * @param {string} [token='ETH'] - Token symbol
   * @returns {Promise<{ txHash: string, amount: string, token: string, to: string }>}
   */
  async function sendPayment(to, amount, token = 'ETH') {
    if (!walletProvider || !walletAddress) {
      throw new Error('Wallet not initialized — call initWallet() first');
    }

    if (!ethers.isAddress(to)) {
      throw new Error(`Invalid recipient address: ${to}`);
    }

    const parsedAmount = parseFloat(amount);
    if (isNaN(parsedAmount) || parsedAmount <= 0) {
      throw new Error(`Invalid amount: ${amount}`);
    }

    log('TRADE', 'Sending payment', { to, amount, token });

    if (token === 'ETH') {
      const tx = await walletProvider.sendTransaction({
        to,
        value: ethers.parseEther(amount),
      });
      log('TRADE', 'Payment sent', { txHash: tx.hash, token, amount });
      return { txHash: tx.hash, amount, token, to };
    }

    // ERC-20 transfer via wallet provider's native transfer
    const txHash = await walletProvider.nativeTransfer(to, token, amount);
    log('TRADE', 'ERC-20 payment sent', { txHash, token, amount });
    return { txHash, amount, token, to };
  }

  /**
   * Get recent transaction history for the wallet.
   * Uses the Base RPC provider to scan recent blocks.
   * @param {number} [blockCount=100] - Number of recent blocks to scan
   * @returns {Promise<Array<{ hash: string, from: string, to: string, value: string, blockNumber: number }>>}
   */
  async function getTransactionHistory(blockCount = 100) {
    if (!provider || !walletAddress) {
      throw new Error('Wallet not initialized — call initWallet() first');
    }

    const currentBlock = await provider.getBlockNumber();
    const fromBlock = Math.max(0, currentBlock - blockCount);
    const transactions = [];
    const lowerAddr = walletAddress.toLowerCase();

    // Scan blocks for transactions involving our wallet
    for (let i = currentBlock; i >= fromBlock && transactions.length < 50; i--) {
      try {
        const block = await provider.getBlock(i, true);
        if (!block?.transactions) continue;

        for (const tx of block.transactions) {
          const txObj = typeof tx === 'string' ? await provider.getTransaction(tx) : tx;
          if (!txObj) continue;
          if (txObj.from?.toLowerCase() === lowerAddr || txObj.to?.toLowerCase() === lowerAddr) {
            transactions.push({
              hash: txObj.hash,
              from: txObj.from,
              to: txObj.to,
              value: ethers.formatEther(txObj.value),
              blockNumber: i,
            });
          }
        }
      } catch {
        // Skip blocks that fail to fetch
      }
    }

    return transactions;
  }

  /**
   * Get current wallet status.
   * @returns {{ initialized: boolean, address: string | null, networkId: string, rpcUrl: string }}
   */
  function getStatus() {
    return {
      initialized: walletProvider !== null,
      address: walletAddress,
      networkId,
      rpcUrl,
    };
  }

  return {
    initWallet,
    getBalance,
    sendPayment,
    getTransactionHistory,
    getStatus,

    // Expose for testing
    _getProvider: () => provider,
    _getWalletProvider: () => walletProvider,
  };
}

export default createWalletManager;
