// Auth middleware — token-based authentication for API routes.
// Set AGENT_AUTH_TOKEN env var to enable. Without it, server is open (local dev).

const AUTH_TOKEN = process.env.AGENT_AUTH_TOKEN || '';

export default function authMiddleware(req, res, next) {
  if (!AUTH_TOKEN) return next(); // no token configured = open access
  // Allow health check unauthenticated
  if (req.path === '/api/health') return next();
  // Check Authorization header or query param
  const header = req.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice(7) : req.query.token;
  if (token === AUTH_TOKEN) return next();
  res.status(401).json({ error: 'Unauthorized. Set Authorization: Bearer <token> header.' });
}
