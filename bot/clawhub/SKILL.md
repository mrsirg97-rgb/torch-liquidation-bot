---
name: torch-liquidation-bot
description: Read-only lending market scanner for Torch Market on Solana. No wallet required. Scans lending markets, profiles borrower wallets, and scores loans by risk. Default info mode makes no state changes and requires only an RPC endpoint. Optional bot mode (requires wallet) can execute liquidations on positions that crossed the on-chain threshold.
license: MIT
metadata:
  author: torch-market
  version: "1.0.8"
  clawhub: https://clawhub.ai/mrsirg97-rgb/torchliquidationbot
  npm: https://www.npmjs.com/package/torch-liquidation-bot
  github: https://github.com/mrsirg97-rgb/torch-liquidation-bot
  sdk: https://github.com/mrsirg97-rgb/torchsdk
compatibility: Requires a Solana RPC endpoint. Default info mode is fully read-only -- no wallet loaded, no signing, no state changes. Wallet keypair only needed for optional bot or watch mode. Distributed via npm.
---

# Torch Liquidation Bot

Read-only lending market scanner for [Torch Market](https://torch.market) on Solana. No wallet required. Only an RPC endpoint is needed to run the default mode.

## What This Skill Does

This skill scans lending markets on Torch Market, a fair-launch DAO launchpad on Solana. Every migrated token on Torch has a built-in lending market where holders can borrow SOL against their tokens. When a borrower's collateral drops in value and their loan-to-value ratio exceeds 65%, the position becomes liquidatable on-chain per the protocol's rules.

The skill's core value is **risk analysis** -- it profiles borrowers, tracks price trends, and scores every loan by how likely it is to fail. In the default info mode, it's a read-only dashboard that requires no wallet and makes no state changes. An optional bot mode (wallet required, off by default) can act on positions that cross the protocol threshold.

## How It Works

```
scan all tokens with active lending
         |
    for each token:
         |
    find all borrowers with active loans
         |
    profile each borrower (SAID reputation + trade history)
         |
    score each loan (4-factor risk model)
         |
    if liquidatable + profitable → execute liquidation
    if high risk → keep watching closely
```

### Three Modes

| Mode | Purpose | Wallet | State Changes |
|------|---------|--------|---------------|
| `info` (default) | Display lending parameters for a token or all tokens | not required | none (read-only) |
| `bot` | Scan and score positions; execute liquidations when threshold is met | required | yes (transactions) |
| `watch` | Monitor your own loan health in real-time | required | optional (auto-repay) |

### Risk Scoring

Every loan is scored 0-100 on four weighted factors:

| Factor | Weight | What It Measures |
|--------|--------|------------------|
| LTV proximity | 40% | How close the position is to the 65% liquidation threshold |
| Price momentum | 30% | Is the collateral token's price trending down? (linear regression on recent snapshots) |
| Wallet risk | 20% | SAID trust tier + trade win/loss ratio. Low-reputation wallets with losing histories score higher |
| Interest burden | 10% | How much accrued interest is eating into the collateral margin |

Positions scoring above the configurable risk threshold (default: 60) are flagged as high-risk and monitored more closely.

## Architecture

```
packages/bot/src/
├── types.ts            — all interfaces and contracts
├── config.ts           — env vars → typed config
├── logger.ts           — structured logging with levels
├── utils.ts            — shared helpers
├── scanner.ts          — discovers tokens with active lending
├── wallet-profiler.ts  — SAID reputation + trade history analysis
├── risk-scorer.ts      — 4-factor weighted risk scoring
├── liquidator.ts       — executes liquidation transactions
├── monitor.ts          — main orchestration (scan + score loops)
└── index.ts            — entry point with mode routing
```

Each file handles a single responsibility. The bot runs two concurrent loops:
- **Scan loop** (default: every 60s) -- discovers tokens with active lending, snapshots prices
- **Score loop** (default: every 15s) -- profiles borrowers, scores loans, executes liquidations

## Network & Permissions

- **Default mode (`info`) is read-only** -- no wallet is loaded, no keypair is decoded, no signing occurs, no state changes. Only `RPC_URL` is required.
- **Outbound connections:** Solana RPC (via `@solana/web3.js`) and SAID Protocol API (via `torchsdk.verifySaid`). No telemetry or third-party services. Confirmed by audit (`audits/audit_botsdk.md`, finding I-2).
- **Private keys never leave the process** -- when a wallet is provided (bot/watch mode only), it is decoded once, held as a `Keypair` object, and used only for local signing via `sendAndConfirmTransaction`. The raw key bytes are never logged, serialized, stored, or transmitted. Confirmed by audit (finding I-1).
- **Distributed via npm** -- all code runs from `node_modules/`. No post-install hooks, no remote code fetching.
- **Transactions are built locally** using the Anchor IDL and signed client-side. The on-chain program validates all parameters.

## Setup

### Install

```bash
npm install torch-liquidation-bot
```

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `RPC_URL` | yes | -- | Solana RPC endpoint |
| `WALLET` | bot/watch only | -- | Solana wallet keypair (base58). Only loaded in bot/watch mode; never logged or transmitted (see audit I-1) |
| `MODE` | no | `info` | `info`, `bot`, or `watch` |
| `MINT` | no (info/watch) | -- | Token mint address for single-token modes |
| `SCAN_INTERVAL_MS` | no | `60000` | How often to discover new lending markets |
| `SCORE_INTERVAL_MS` | no | `15000` | How often to re-score positions |
| `MIN_PROFIT_SOL` | no | `0.01` | Minimum profit in SOL to execute a liquidation |
| `RISK_THRESHOLD` | no | `60` | Minimum risk score (0-100) to flag as high-risk |
| `PRICE_HISTORY` | no | `20` | Number of price snapshots to keep for momentum |
| `LOG_LEVEL` | no | `info` | `debug`, `info`, `warn`, or `error` |
| `POLL_INTERVAL_MS` | no | `15000` | Polling interval for watch mode |
| `AUTO_REPAY` | no | `false` | Auto-repay your own position if liquidatable (watch mode) |

### Run

```bash
# show lending info for all migrated tokens (default, no wallet needed)
RPC_URL=<rpc> npx torch-liquidation-bot

# show lending info for a specific token
MODE=info MINT=<mint> RPC_URL=<rpc> npx torch-liquidation-bot

# run the liquidation bot (requires wallet)
MODE=bot WALLET=<key> RPC_URL=<rpc> npx torch-liquidation-bot

# watch your own loan health (requires wallet)
MODE=watch MINT=<mint> WALLET=<key> RPC_URL=<rpc> npx torch-liquidation-bot
```

### Programmatic Usage

```typescript
import { Monitor, loadConfig } from 'torch-liquidation-bot'
import { Connection } from '@solana/web3.js'

const config = loadConfig()
const connection = new Connection(config.rpcUrl, 'confirmed')
const monitor = new Monitor(connection, config)
await monitor.start()
```

## Key Types

```typescript
interface ScoredLoan {
  mint: string
  tokenName: string
  borrower: string
  position: LoanPositionInfo   // health, LTV, collateral, debt
  walletProfile: WalletProfile // SAID tier, trade stats, risk score
  riskScore: number            // 0-100 composite
  factors: RiskFactors         // breakdown of all 4 scoring factors
  estimatedProfitLamports: number
}

interface WalletProfile {
  address: string
  saidVerified: boolean
  trustTier: 'high' | 'medium' | 'low' | null
  tradeStats: TradeStats       // wins, losses, win rate, net PnL
  riskScore: number            // 0-100
}

interface MonitoredToken {
  mint: string
  name: string
  symbol: string
  lendingInfo: LendingInfo     // rates, thresholds, treasury balance
  priceSol: number
  priceHistory: number[]       // for momentum calculation
  activeBorrowers: string[]
}
```

## Torch Lending Parameters

| Parameter | Value |
|-----------|-------|
| Max LTV | 50% |
| Liquidation threshold | 65% LTV |
| Interest rate | 2% per epoch (~7 days) |
| Liquidation bonus | 10% of collateral value |
| Treasury utilization cap | 50% |
| Min borrow | 0.1 SOL |

## SDK Functions Used

This skill uses the following [torchsdk](https://github.com/mrsirg97-rgb/torchsdk) functions:

| Function | Purpose |
|----------|---------|
| `getTokens(connection, params)` | Discover migrated tokens |
| `getToken(connection, mint)` | Get token price and metadata |
| `getLendingInfo(connection, mint)` | Get lending parameters and active loan count |
| `getLoanPosition(connection, mint, wallet)` | Get a borrower's loan health and LTV |
| `getHolders(connection, mint, limit)` | Find borrowers for a given token |
| `getMessages(connection, mint, limit)` | Analyze trade history for wallet profiling |
| `verifySaid(wallet)` | Check SAID reputation and trust tier |
| `buildLiquidateTransaction(connection, params)` | Build unsigned liquidation tx |
| `buildRepayTransaction(connection, params)` | Build unsigned repay tx (watch mode auto-repay) |
| `confirmTransaction(connection, sig, wallet)` | Confirm tx for SAID reputation |

All transactions are built locally via the Anchor IDL and signed client-side with your own keypair.

## Links

- Source Code: [github.com/mrsirg97-rgb/torch-liquidation-bot](https://github.com/mrsirg97-rgb/torch-liquidation-bot)
- Torch SDK: [github.com/mrsirg97-rgb/torchsdk](https://github.com/mrsirg97-rgb/torchsdk)
- Torch Market: [torch.market](https://torch.market)
- ClawHub: [clawhub.ai/mrsirg97-rgb/torchliquidationbot](https://clawhub.ai/mrsirg97-rgb/torchliquidationbot)
- SAID Protocol: [saidprotocol.com](https://saidprotocol.com)
- Program ID: `8hbUkonssSEEtkqzwM7ZcZrD9evacM92TcWSooVF4BeT`

**NOTE**

an audit is provided in the repository [github.com/mrsirg97-rgb/torch-liquidation-bot](https://github.com/mrsirg97-rgb/torch-liquidation-bot) under audits/audit_botsdk.md. The audit covers security, correctness, and best practices for usage.