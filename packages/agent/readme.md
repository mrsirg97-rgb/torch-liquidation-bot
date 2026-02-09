# torch-liquidation-agent

Multi-token liquidation bot for [Torch Market](https://torch.market) lending on Solana, built on [solana-agent-kit](https://github.com/sendaifun/solana-agent-kit) + [solana-agent-kit-torch-market](https://www.npmjs.com/package/solana-agent-kit-torch-market).

Same functionality as [`torch-liquidation-bot`](../bot/) but uses the Torch Agent Kit plugin instead of raw torchsdk — making it compatible with AI agent frameworks (LangChain, Vercel AI, OpenAI tools).

## Install

```bash
npm install torch-liquidation-agent
```

## How It Works

Every migrated token on Torch has a built-in lending market. Holders borrow SOL against their tokens. When a borrower's loan-to-value ratio exceeds 65%, anyone can liquidate the position and collect a 10% bonus on the collateral.

This bot finds those opportunities before other bots do by **predicting** which positions will go underwater:

1. **Scan** -- discovers all tokens with active lending markets
2. **Profile** -- checks each borrower's SAID reputation and trade history
3. **Score** -- rates every loan on a 4-factor risk model (0-100)
4. **Liquidate** -- executes when a position crosses the threshold and the profit exceeds your minimum

## Quick Start

```bash
MODE=bot WALLET=<base58-private-key> RPC_URL=<rpc-endpoint> npx torch-liquidation-agent
```

## Modes

### `bot` (default) -- full liquidation bot

Runs two concurrent loops:
- **Scan loop** (every 60s) -- finds tokens with active lending, snapshots prices
- **Score loop** (every 15s) -- profiles borrowers, scores loans, executes liquidations

```bash
MODE=bot WALLET=<key> RPC_URL=<rpc> npx torch-liquidation-agent
```

### `info` -- display lending parameters

```bash
# all migrated tokens with lending
MODE=info RPC_URL=<rpc> npx torch-liquidation-agent

# specific token
MODE=info MINT=<mint> RPC_URL=<rpc> npx torch-liquidation-agent
```

### `watch` -- monitor your own loan health

```bash
MODE=watch MINT=<mint> WALLET=<key> RPC_URL=<rpc> npx torch-liquidation-agent

# with auto-repay if your position becomes liquidatable
MODE=watch MINT=<mint> WALLET=<key> AUTO_REPAY=true RPC_URL=<rpc> npx torch-liquidation-agent
```

## Risk Scoring

Every loan gets a composite score from four weighted factors:

| Factor | Weight | What It Measures |
|--------|--------|------------------|
| LTV proximity | 40% | How close to the 65% liquidation threshold |
| Price momentum | 30% | Collateral price trend (linear regression on recent snapshots) |
| Wallet risk | 20% | SAID trust tier + trade win/loss ratio |
| Interest burden | 10% | Accrued interest relative to collateral value |

Positions above the risk threshold (default: 60) are flagged and watched closely. Liquidatable positions with profit above your minimum are executed immediately, highest profit first.

## Configuration

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `RPC_URL` | yes | -- | Solana RPC endpoint |
| `WALLET` | bot/watch | -- | Base58 private key |
| `MODE` | no | `bot` | `bot`, `info`, or `watch` |
| `MINT` | info/watch | -- | Token mint address |
| `SCAN_INTERVAL_MS` | no | `60000` | Token discovery interval |
| `SCORE_INTERVAL_MS` | no | `15000` | Position scoring interval |
| `MIN_PROFIT_SOL` | no | `0.01` | Minimum profit to execute liquidation |
| `RISK_THRESHOLD` | no | `60` | Risk score cutoff for close monitoring |
| `PRICE_HISTORY` | no | `20` | Price snapshots to keep for momentum |
| `LOG_LEVEL` | no | `info` | `debug`, `info`, `warn`, `error` |

## Architecture

```
src/
├── types.ts            — interfaces and contracts
├── config.ts           — env vars → SolanaAgentKit + typed config
├── logger.ts           — structured logging
├── utils.ts            — shared helpers
├── scanner.ts          — discovers tokens with active lending
├── wallet-profiler.ts  — SAID reputation + trade history
├── risk-scorer.ts      — 4-factor risk model
├── liquidator.ts       — executes liquidation txs via agent kit
├── monitor.ts          — scan + score orchestration
└── index.ts            — entry point
```

### Differences from `torch-liquidation-bot`

| | `bot` (torchsdk) | `agent` (agent kit) |
|---|---|---|
| SDK | `torchsdk` direct | `solana-agent-kit-torch-market` plugin |
| Transaction signing | Manual (`sendAndConfirmTransaction`) | Handled by `SolanaAgentKit` |
| Holder discovery | `torchsdk.getHolders()` | Solana RPC `getTokenLargestAccounts` |
| SAID verification | `torchsdk.verifySaid()` | Direct SAID API call |
| AI agent compatible | No | Yes (LangChain, Vercel AI, OpenAI tools) |

## Lending Parameters

| Parameter | Value |
|-----------|-------|
| Max LTV | 50% |
| Liquidation threshold | 65% LTV |
| Interest rate | 2% per epoch (~7 days) |
| Liquidation bonus | 10% of collateral |
| Min borrow | 0.1 SOL |

## Testing

Requires [Surfpool](https://github.com/nicholasgasior/surfpool) running a mainnet fork:

```bash
surfpool start --network mainnet --no-tui
pnpm test        # lending lifecycle test
pnpm test:bot    # bot module test (scanner, profiler, scorer, liquidator)
```

## Security

- Private keys loaded from env, never logged or transmitted
- All transactions signed by `SolanaAgentKit` via `KeypairWallet` -- keys never leave your environment
- Minimum profit threshold prevents unprofitable executions
- Graceful shutdown on SIGINT

## Links

- [solana-agent-kit](https://github.com/sendaifun/solana-agent-kit) -- the agent framework
- [solana-agent-kit-torch-market](https://www.npmjs.com/package/solana-agent-kit-torch-market) -- Torch Market plugin
- [torch-liquidation-bot](../bot/) -- the torchsdk-based version
- [Torch Market](https://torch.market) -- the protocol
- [SAID Protocol](https://saidprotocol.com) -- wallet reputation layer

## License

MIT
