// Wallet API routes for agent dashboard.
import { Router } from 'express';

/**
 * Create wallet routes that integrate with the wallet subsystem.
 *
 * @param {object} ctx - App context
 * @param {object|null} walletSystem - Wallet system from wallet/index.js (null if not configured)
 * @returns {Router}
 */
export default function createWalletRoutes(ctx, walletSystem) {
  const router = Router();

  // Guard: wallet not configured
  function requireWallet(req, res, next) {
    if (!walletSystem) {
      return res.status(503).json({
        error: 'Wallet not configured',
        message: 'Set COINBASE_API_KEY and COINBASE_API_SECRET in .env',
      });
    }
    next();
  }

  router.use(requireWallet);

  // GET /api/wallet/status — overall wallet system status
  router.get('/wallet/status', (req, res) => {
    res.json(walletSystem.getStatus());
  });

  // GET /api/wallet/balance — token balances
  router.get('/wallet/balance', async (req, res) => {
    try {
      const tokens = req.query.tokens
        ? req.query.tokens.split(',').map(t => t.trim())
        : ['ETH', 'USDC'];
      const balances = await walletSystem.walletManager.getBalance(tokens);
      res.json({
        address: walletSystem.walletManager.getStatus().address,
        balances,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/wallet/yield — yield report
  router.get('/wallet/yield', async (req, res) => {
    try {
      const report = await walletSystem.defiManager.getYieldReport();
      res.json(report);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/wallet/yield/rates — current APY rates
  router.get('/wallet/yield/rates', async (req, res) => {
    try {
      const rates = await walletSystem.defiManager.checkYieldRates();
      res.json(rates);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/wallet/rebalance — trigger yield rebalance
  router.post('/wallet/rebalance', async (req, res) => {
    try {
      const result = await walletSystem.defiManager.rebalance();
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/wallet/arbitrage — arbitrage status and history
  router.get('/wallet/arbitrage', async (req, res) => {
    try {
      const result = {
        config: walletSystem.arbitrageManager.getConfig(),
        history: walletSystem.arbitrageManager.getArbitrageHistory(),
      };
      if (req.query.scan === 'true') {
        result.opportunities = await walletSystem.arbitrageManager.findOpportunities();
      }
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/wallet/treasury — treasury PnL report
  router.get('/wallet/treasury', async (req, res) => {
    try {
      const pnl = await walletSystem.treasuryManager.reportPnL();
      res.json(pnl);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/wallet/treasury/allocate — execute allocation
  router.post('/wallet/treasury/allocate', async (req, res) => {
    try {
      const result = await walletSystem.treasuryManager.allocate();
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // PUT /api/wallet/treasury/allocation — update allocation strategy
  router.put('/wallet/treasury/allocation', (req, res) => {
    try {
      const result = walletSystem.treasuryManager.setAllocationStrategy(req.body);
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  return router;
}
