/**
 * wallet-tools.js — MCP tool definitions and handlers for wallet/DeFi operations.
 *
 * Follows the same pattern as crypto-tools.js:
 *   getWalletToolDefinitions()              — tool schemas for ListToolsRequestSchema
 *   handleWalletToolCall(name, args, sys)   — dispatcher for CallToolRequestSchema
 *   isWalletTool(name)                      — check if a tool name is a wallet tool
 *
 * @module wallet-tools
 */

const WALLET_TOOL_NAMES = new Set([
  'wallet_balance',
  'wallet_send',
  'wallet_yield_report',
  'wallet_arbitrage_status',
  'wallet_treasury_pnl',
  'wallet_rebalance',
  'wallet_status',
]);

// ─── Response helpers (match mcp-server.js format) ────────────────────────

function ok(data) {
  return {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
  };
}

function fail(message) {
  return {
    content: [{ type: 'text', text: `Error: ${message}` }],
    isError: true,
  };
}

// ─── Tool Definitions ─────────────────────────────────────────────────────

export function getWalletToolDefinitions() {
  return [
    {
      name: 'wallet_balance',
      description:
        'Check the agent wallet balance for USDC, ETH, and other tokens on Base L2. ' +
        'Returns current balances for the on-chain agent wallet.',
      inputSchema: {
        type: 'object',
        properties: {
          tokens: {
            type: 'array',
            items: { type: 'string' },
            description: 'Token symbols to check. Defaults to ["ETH", "USDC"].',
          },
        },
      },
    },

    {
      name: 'wallet_send',
      description:
        'Send a crypto payment from the agent wallet. ' +
        'Supports ETH and ERC-20 tokens on Base L2. Requires wallet to be initialized.',
      inputSchema: {
        type: 'object',
        properties: {
          to: {
            type: 'string',
            description: 'Recipient Ethereum address (0x...).',
          },
          amount: {
            type: 'string',
            description: 'Amount to send (human-readable, e.g. "0.1").',
          },
          token: {
            type: 'string',
            description: 'Token symbol. Defaults to "ETH".',
          },
        },
        required: ['to', 'amount'],
      },
    },

    {
      name: 'wallet_yield_report',
      description:
        'Get a yield farming report: deposits, earnings, current APY across DeFi protocols on Base L2. ' +
        'Shows Aave and Compound rates and the agent\'s earned yield.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },

    {
      name: 'wallet_arbitrage_status',
      description:
        'Check stablecoin arbitrage opportunities and history. ' +
        'Scans USDC/USDT/DAI prices across Uniswap and Aerodrome on Base L2.',
      inputSchema: {
        type: 'object',
        properties: {
          scan: {
            type: 'boolean',
            description: 'If true, actively scan for new opportunities. Otherwise returns history only.',
          },
        },
      },
    },

    {
      name: 'wallet_treasury_pnl',
      description:
        'Get the treasury profit/loss report including yield earnings, ' +
        'arbitrage profits, and overall wallet performance.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },

    {
      name: 'wallet_rebalance',
      description:
        'Rebalance DeFi yield positions to the highest-yielding protocol. ' +
        'Compares Aave vs Compound APY and moves funds if spread is meaningful.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },

    {
      name: 'wallet_status',
      description:
        'Get the overall wallet system status including initialization state, ' +
        'network info, arbitrage config, and allocation strategy.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
  ];
}

// ─── Tool Handler ─────────────────────────────────────────────────────────

/**
 * Handle a wallet tool call.
 *
 * @param {string} name     - Tool name
 * @param {object} args     - Tool arguments
 * @param {object} sys      - Wallet system (from createWalletSystem)
 * @returns {Promise<{ content: Array<{ type: string, text: string }>, isError?: boolean }>}
 */
export async function handleWalletToolCall(name, args, sys) {
  if (!sys) {
    return fail('Wallet system not initialized — configure COINBASE_API_KEY in .env');
  }

  try {
    switch (name) {
      case 'wallet_balance': {
        const tokens = args.tokens || ['ETH', 'USDC'];
        const balances = await sys.walletManager.getBalance(tokens);
        return ok({ address: sys.walletManager.getStatus().address, balances });
      }

      case 'wallet_send': {
        const { to, amount, token } = args;
        if (!to || !amount) return fail('Missing required: to, amount');
        const result = await sys.walletManager.sendPayment(to, amount, token || 'ETH');
        return ok(result);
      }

      case 'wallet_yield_report': {
        const report = await sys.defiManager.getYieldReport();
        return ok(report);
      }

      case 'wallet_arbitrage_status': {
        const result = {
          config: sys.arbitrageManager.getConfig(),
          history: sys.arbitrageManager.getArbitrageHistory(),
        };
        if (args.scan) {
          result.opportunities = await sys.arbitrageManager.findOpportunities();
        }
        return ok(result);
      }

      case 'wallet_treasury_pnl': {
        const pnl = await sys.treasuryManager.reportPnL();
        return ok(pnl);
      }

      case 'wallet_rebalance': {
        const result = await sys.defiManager.rebalance();
        return ok(result);
      }

      case 'wallet_status': {
        return ok(sys.getStatus());
      }

      default:
        return fail(`Unknown wallet tool: ${name}`);
    }
  } catch (err) {
    return fail(`${name} failed: ${err.message}`);
  }
}

/**
 * Check if a tool name is a wallet tool.
 * @param {string} name
 * @returns {boolean}
 */
export function isWalletTool(name) {
  return WALLET_TOOL_NAMES.has(name);
}
