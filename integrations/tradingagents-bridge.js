#!/usr/bin/env node

/**
 * TradingAgents Bridge — connects OpenProphet's MCP server to the
 * TradingAgents multi-agent analysis framework (Python).
 *
 * Spawns a Python subprocess inside the TradingAgents venv, runs a
 * multi-agent debate (bull researcher, bear researcher, trader, risk
 * manager), and returns a structured consensus signal.
 *
 * Usage:
 *   import { runMultiAgentAnalysis, getSignal } from './integrations/tradingagents-bridge.js';
 *   const result = await runMultiAgentAnalysis('AAPL');
 *   const quick  = await getSignal('BTC-USD');
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';

// ── Paths ──────────────────────────────────────────────────────────
const TRADING_AGENTS_ROOT = path.join(
  os.homedir(),
  'WORKSPACE',
  'Active_Projects',
  'TradingAgents',
);
const VENV_PYTHON = path.join(TRADING_AGENTS_ROOT, '.venv', 'bin', 'python');

// ── Default timeout (5 minutes — multi-agent debate is slow) ──────
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

// ── Inline Python script ──────────────────────────────────────────
// Kept as a template function so the symbol is injected safely.
function buildPythonScript(symbol) {
  // JSON-escape the symbol to prevent injection
  const safeSymbol = JSON.stringify(symbol);

  return `
import json, os, sys, datetime

def main():
    symbol = ${safeSymbol}
    result = {
        "symbol": symbol,
        "timestamp": datetime.datetime.utcnow().isoformat() + "Z",
        "signal": None,
        "confidence": 0.0,
        "reasoning": "",
        "agents": {},
        "degraded": False,
        "error": None,
    }

    # ── Detect available LLM provider ──────────────────────────
    anthropic_key = os.environ.get("ANTHROPIC_API_KEY", "")
    openai_key    = os.environ.get("OPENAI_API_KEY", "")
    google_key    = os.environ.get("GOOGLE_API_KEY", "") or os.environ.get("GEMINI_API_KEY", "")

    if anthropic_key:
        provider   = "anthropic"
        deep_model = "claude-sonnet-4-20250514"
        fast_model = "claude-haiku-4-20250414"
    elif openai_key:
        provider   = "openai"
        deep_model = "gpt-4o"
        fast_model = "gpt-4o-mini"
    elif google_key:
        provider   = "google"
        deep_model = "gemini-2.0-flash"
        fast_model = "gemini-2.0-flash"
    else:
        result["degraded"] = True
        result["error"] = "No LLM API key found (set ANTHROPIC_API_KEY, OPENAI_API_KEY, or GOOGLE_API_KEY)"
        result["signal"] = "hold"
        result["confidence"] = 0.0
        result["reasoning"] = "Unable to run multi-agent analysis — no LLM provider configured."
        print(json.dumps(result))
        return

    try:
        from tradingagents.graph.trading_graph import TradingAgentsGraph
        from tradingagents.default_config import DEFAULT_CONFIG
    except ImportError as exc:
        result["degraded"] = True
        result["error"] = f"TradingAgents not importable: {exc}"
        result["signal"] = "hold"
        result["confidence"] = 0.0
        result["reasoning"] = "TradingAgents package not available — returning safe default."
        print(json.dumps(result))
        return

    # ── Configure ──────────────────────────────────────────────
    config = DEFAULT_CONFIG.copy()
    config["llm_provider"]    = provider
    config["deep_think_llm"]  = deep_model
    config["quick_think_llm"] = fast_model
    config["max_debate_rounds"] = 1          # keep it quick for live trading

    # Prefer yfinance (no extra API key needed)
    config["data_vendors"] = {
        "core_stock_apis":      "yfinance",
        "technical_indicators": "yfinance",
        "fundamental_data":     "yfinance",
        "news_data":            "yfinance",
    }

    # ── Run multi-agent analysis ───────────────────────────────
    try:
        today = datetime.date.today().isoformat()
        ta = TradingAgentsGraph(debug=False, config=config)
        state, decision = ta.propagate(symbol, today)

        # Parse the decision text into structured signal
        decision_lower = decision.lower() if isinstance(decision, str) else ""

        if any(w in decision_lower for w in ["strong buy", "strongly buy", "aggressive buy"]):
            signal = "strong_buy"
            confidence = 0.9
        elif any(w in decision_lower for w in ["buy", "long", "bullish", "accumulate"]):
            signal = "buy"
            confidence = 0.75
        elif any(w in decision_lower for w in ["strong sell", "strongly sell", "aggressive sell"]):
            signal = "strong_sell"
            confidence = 0.9
        elif any(w in decision_lower for w in ["sell", "short", "bearish", "reduce"]):
            signal = "sell"
            confidence = 0.75
        else:
            signal = "hold"
            confidence = 0.5

        result["signal"]     = signal
        result["confidence"] = confidence
        result["reasoning"]  = decision if isinstance(decision, str) else str(decision)

        # Extract agent-level data from the graph state if available
        if isinstance(state, dict):
            agent_keys = [
                "bull_researcher", "bear_researcher",
                "trader", "risk_manager",
                "fundamentals_analyst", "sentiment_analyst",
                "news_analyst", "technical_analyst",
            ]
            for key in agent_keys:
                if key in state and state[key]:
                    val = state[key]
                    # LangGraph messages are often lists — grab last
                    if isinstance(val, list) and len(val) > 0:
                        last = val[-1]
                        result["agents"][key] = (
                            last.content if hasattr(last, "content") else str(last)
                        )
                    elif isinstance(val, str):
                        result["agents"][key] = val

    except Exception as exc:
        result["degraded"] = True
        result["error"] = str(exc)
        result["signal"] = "hold"
        result["confidence"] = 0.0
        result["reasoning"] = f"Multi-agent analysis failed: {exc}"

    print(json.dumps(result))

if __name__ == "__main__":
    main()
`;
}

// ── Helpers ────────────────────────────────────────────────────────

/**
 * Spawn the TradingAgents Python process and collect its JSON output.
 * @param {string} symbol  Ticker to analyse (e.g. "AAPL", "BTC-USD")
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs]  Max runtime in ms (default 5 min)
 * @returns {Promise<object>}
 */
function spawnAnalysis(symbol, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return new Promise((resolve, reject) => {
    const script = buildPythonScript(symbol);

    const proc = spawn(VENV_PYTHON, ['-u', '-c', script], {
      cwd: TRADING_AGENTS_ROOT,
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error(`TradingAgents analysis timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);

    proc.on('error', (err) => {
      clearTimeout(timer);
      // Python binary not found — degrade gracefully
      resolve(makeDegradedResponse(symbol, `Python process error: ${err.message}`));
    });

    proc.on('close', (code) => {
      clearTimeout(timer);

      if (code !== 0) {
        // Try to extract a useful error from stderr
        const errMsg = stderr.trim().split('\n').slice(-3).join(' ') || `exit code ${code}`;
        resolve(makeDegradedResponse(symbol, `Python exited with error: ${errMsg}`));
        return;
      }

      // Find the last line that looks like JSON (skip debug output)
      const lines = stdout.trim().split('\n');
      let parsed = null;
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          parsed = JSON.parse(lines[i]);
          break;
        } catch {
          // not JSON, keep scanning
        }
      }

      if (!parsed) {
        resolve(makeDegradedResponse(symbol, 'No valid JSON in Python output'));
        return;
      }

      resolve(parsed);
    });
  });
}

/**
 * Build a safe degraded response when TradingAgents can't run.
 */
function makeDegradedResponse(symbol, errorMessage) {
  return {
    symbol,
    timestamp: new Date().toISOString(),
    signal: 'hold',
    confidence: 0.0,
    reasoning: `TradingAgents unavailable — defaulting to hold. Error: ${errorMessage}`,
    agents: {},
    degraded: true,
    error: errorMessage,
  };
}

// ── Public API ─────────────────────────────────────────────────────

/**
 * Run the full multi-agent analysis for a symbol.
 *
 * Returns:
 * {
 *   symbol:     string,
 *   timestamp:  string (ISO-8601),
 *   signal:     "strong_buy" | "buy" | "hold" | "sell" | "strong_sell",
 *   confidence: number (0–1),
 *   reasoning:  string,
 *   agents:     { bull_researcher?: string, bear_researcher?: string, ... },
 *   degraded:   boolean,
 *   error:      string | null,
 * }
 *
 * @param {string} symbol   Ticker symbol (e.g. "AAPL", "BTC-USD")
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs]  Override default timeout
 * @returns {Promise<object>}
 */
export async function runMultiAgentAnalysis(symbol, opts = {}) {
  if (!symbol || typeof symbol !== 'string') {
    throw new TypeError('symbol must be a non-empty string');
  }

  const clean = symbol.trim().toUpperCase();
  return spawnAnalysis(clean, opts);
}

/**
 * Quick signal-only wrapper — returns just the signal string and confidence.
 *
 * @param {string} symbol   Ticker symbol
 * @param {object} [opts]
 * @returns {Promise<{ signal: string, confidence: number, degraded: boolean }>}
 */
export async function getSignal(symbol, opts = {}) {
  const result = await runMultiAgentAnalysis(symbol, opts);
  return {
    signal: result.signal,
    confidence: result.confidence,
    degraded: result.degraded,
  };
}

// ── CLI entry point (for testing) ──────────────────────────────────
const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'));

if (isMain || process.argv[1]?.endsWith('tradingagents-bridge.js')) {
  const symbol = process.argv[2] || 'AAPL';
  console.error(`[tradingagents-bridge] Analysing ${symbol} …`);

  runMultiAgentAnalysis(symbol)
    .then((result) => {
      console.log(JSON.stringify(result, null, 2));
      process.exit(result.degraded ? 1 : 0);
    })
    .catch((err) => {
      console.error(`[tradingagents-bridge] Fatal: ${err.message}`);
      process.exit(2);
    });
}
