// Portfolio proxy routes: Alpaca account/positions/orders + crypto integration.
import { Router } from 'express';

export default function createPortfolioRoutes(ctx) {
  const router = Router();

  // ── Alpaca Portfolio Proxy ───────────────────────────────────────
  router.get('/portfolio/account', async (req, res) => {
    try {
      const client = ctx.getGoClientForSandbox(req.query.sandboxId);
      if (!client) return res.status(404).json({ error: 'Sandbox trading backend unavailable' });
      const { data } = await client.get('/api/v1/account');
      res.json(data);
    } catch { res.status(502).json({ error: 'Trading bot unavailable' }); }
  });

  router.get('/portfolio/positions', async (req, res) => {
    try {
      const client = ctx.getGoClientForSandbox(req.query.sandboxId);
      if (!client) return res.status(404).json({ error: 'Sandbox trading backend unavailable' });
      const { data } = await client.get('/api/v1/options/positions');
      res.json(data);
    } catch { res.status(502).json({ error: 'Trading bot unavailable' }); }
  });

  router.get('/portfolio/orders', async (req, res) => {
    try {
      const client = ctx.getGoClientForSandbox(req.query.sandboxId);
      if (!client) return res.status(404).json({ error: 'Sandbox trading backend unavailable' });
      const { data } = await client.get('/api/v1/orders');
      res.json(data);
    } catch { res.status(502).json({ error: 'Trading bot unavailable' }); }
  });

  // ── Crypto Portfolio ─────────────────────────────────────────────
  router.get('/portfolio/crypto/balances', async (req, res) => {
    if (!ctx.cryptoService) return res.json({ configured: false, balances: [] });
    try {
      const data = await ctx.cryptoService.getBalance(req.query.exchange);
      res.json({ configured: true, ...data });
    } catch (e) { res.status(502).json({ error: 'Crypto exchange unavailable: ' + e.message }); }
  });

  router.get('/portfolio/crypto/positions', async (req, res) => {
    if (!ctx.cryptoService) return res.json({ configured: false, positions: [] });
    try {
      const positions = await ctx.cryptoService.getPositions(req.query.exchange);
      res.json({ configured: true, positions });
    } catch (e) { res.status(502).json({ error: 'Crypto exchange unavailable: ' + e.message }); }
  });

  router.get('/portfolio/crypto/orders', async (req, res) => {
    if (!ctx.cryptoService) return res.json({ configured: false, orders: [] });
    try {
      const orders = await ctx.cryptoService.getOpenOrders(req.query.exchange);
      res.json({ configured: true, orders });
    } catch (e) { res.status(502).json({ error: 'Crypto exchange unavailable: ' + e.message }); }
  });

  router.get('/portfolio/crypto/ticker/:symbol', async (req, res) => {
    if (!ctx.cryptoService) return res.status(503).json({ error: 'Crypto not configured' });
    try {
      const ticker = await ctx.cryptoService.getTicker(req.params.symbol, req.query.exchange);
      res.json(ticker);
    } catch (e) { res.status(502).json({ error: 'Ticker unavailable: ' + e.message }); }
  });

  router.get('/portfolio/crypto/status', async (req, res) => {
    if (!ctx.cryptoService) return res.json({ configured: false, exchanges: {} });
    try {
      const status = await ctx.cryptoService.getExchangeStatus();
      const exchanges = {};
      for (const [name, s] of status) exchanges[name] = s;
      res.json({ configured: true, exchanges });
    } catch (e) { res.status(502).json({ error: e.message }); }
  });

  return router;
}
