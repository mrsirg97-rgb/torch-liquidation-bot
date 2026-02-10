# torch-liquidation-bot v2.0.0 (Read-Only)

Read-only lending market scanner for [Torch Market](https://torch.market) on Solana. No wallet required. Only an RPC endpoint is needed.

> **v2.0.0 Breaking Change:** All wallet-dependent functionality (bot mode, watch mode, transaction signing) is deprecated. The entry point no longer imports or references any wallet, keypair, or signing code. Only read-only info mode is available.

## Install

```bash
npm install torch-liquidation-bot
```

## Quick Start

```bash
# show lending info for all migrated tokens
RPC_URL=<rpc> npx torch-liquidation-bot

# show lending info for a specific token
MINT=<mint> RPC_URL=<rpc> npx torch-liquidation-bot
```

## What It Does

Every migrated token on Torch has a built-in lending market. This skill discovers those markets and displays their parameters — interest rates, LTV thresholds, treasury balances, and active loan counts.

That's it. No wallet loaded. No transactions built. No state changes.

## Configuration

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `RPC_URL` | yes | -- | Solana RPC endpoint |
| `MINT` | no | -- | Token mint address (omit to show all tokens) |
| `LOG_LEVEL` | no | `info` | `debug`, `info`, `warn`, `error` |

No `WALLET`, no `MODE`, no bot-specific config.

## Programmatic Usage

```typescript
import { loadReadOnlyConfig } from 'torch-liquidation-bot/config'
import { Connection } from '@solana/web3.js'
import { getTokens, getLendingInfo } from 'torchsdk'

const config = loadReadOnlyConfig()
const connection = new Connection(config.rpcUrl, 'confirmed')

const { tokens } = await getTokens(connection, {
  status: 'migrated',
  sort: 'volume',
  limit: 50,
})

for (const t of tokens) {
  const lending = await getLendingInfo(connection, t.mint)
  console.log(`${t.symbol}: ${lending.active_loans} active loans`)
}
```

## Architecture

```
packages/bot/src/
├── types.ts            — interfaces (ReadOnlyConfig + dormant BotConfig)
├── config.ts           — loadReadOnlyConfig() (active) + loadConfig() (dormant)
├── utils.ts            — shared helpers
└── index.ts            — read-only entry point

dormant (retained for future release, not imported by index.ts):
├── logger.ts           — structured logging
├── scanner.ts          — token discovery
├── wallet-profiler.ts  — SAID reputation + trade history
├── risk-scorer.ts      — 4-factor risk model
├── liquidator.ts       — liquidation execution
└── monitor.ts          — scan + score orchestration
```

## Deprecated (v1.x)

The following functionality is preserved in the source files but is not imported or reachable from the entry point. It will be re-enabled in a future version after further security review.

- `bot` mode — scan, score, and liquidate positions
- `watch` mode — monitor loan health + auto-repay
- `loadConfig()` — wallet keypair decoding
- `loadWallet()` — private key loading
- All transaction signing (`sendAndConfirmTransaction`)
- All SAID Protocol write operations (`confirmTransaction`)

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
pnpm test            # read-only test (default)
pnpm test:lending    # v1.x lending lifecycle test (requires wallet)
pnpm test:bot        # v1.x bot module test (requires wallet)
```

## Security

- No wallet loaded, no keypair decoded, no private key in memory
- No transaction building, no signing, no state changes
- Outbound connections: Solana RPC only (no SAID API in active codepath)
- Distributed via npm — no post-install hooks, no remote code fetching

## Links

- [torchsdk](https://github.com/mrsirg97-rgb/torchsdk) -- the SDK this skill reads from
- [Torch Market](https://torch.market) -- the protocol
- [ClawHub](https://clawhub.ai/mrsirg97-rgb/torchliquidationbot) -- skill registry

## License

MIT
