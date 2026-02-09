# torch-liquidation-bot

Multi-token liquidation bot for [Torch Market](https://torch.market) lending on Solana. Discovers lending markets, profiles borrower wallets, predicts which loans are likely to fail, and executes profitable liquidations.

## Install

```bash
npm install torch-liquidation-bot
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
MODE=bot WALLET=<base58-private-key> RPC_URL=<rpc-endpoint> npx torch-liquidation-bot
```

## Modes

### `bot` (default) -- full liquidation bot

Runs two concurrent loops:
- **Scan loop** (every 60s) -- finds tokens with active lending, snapshots prices
- **Score loop** (every 15s) -- profiles borrowers, scores loans, executes liquidations

```bash
MODE=bot WALLET=<key> RPC_URL=<rpc> npx torch-liquidation-bot
```

### `info` -- display lending parameters

```bash
# all migrated tokens with lending
MODE=info RPC_URL=<rpc> npx torch-liquidation-bot

# specific token
MODE=info MINT=<mint> RPC_URL=<rpc> npx torch-liquidation-bot
```

### `watch` -- monitor your own loan health

```bash
MODE=watch MINT=<mint> WALLET=<key> RPC_URL=<rpc> npx torch-liquidation-bot

# with auto-repay if your position becomes liquidatable
MODE=watch MINT=<mint> WALLET=<key> AUTO_REPAY=true RPC_URL=<rpc> npx torch-liquidation-bot
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
├── config.ts           — env vars → typed config
├── logger.ts           — structured logging
├── utils.ts            — shared helpers
├── scanner.ts          — discovers tokens with active lending
├── wallet-profiler.ts  — SAID reputation + trade history
├── risk-scorer.ts      — 4-factor risk model
├── liquidator.ts       — executes liquidation txs
├── monitor.ts          — scan + score orchestration
└── index.ts            — entry point
```

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
- All transactions built locally via [torchsdk](https://github.com/mrsirg97-rgb/torchsdk) Anchor IDL
- Unsigned transactions signed with your own keypair -- keys never leave your environment
- Minimum profit threshold prevents unprofitable executions
- Graceful shutdown on SIGINT

## Links

- [torchsdk](https://github.com/mrsirg97-rgb/torchsdk) -- the SDK this bot is built on
- [Torch Market](https://torch.market) -- the protocol
- [SAID Protocol](https://saidprotocol.com) -- wallet reputation layer
- [ClawHub](https://clawhub.ai/mrsirg97-rgb/torchliquidationbot) -- skill registry

## License

MIT
