---
name: torch-liquidation-bot
description: a multi-token bot that discovers lending markets, profiles borrower wallets, predicts which loans are likely to fail, and executes profitable liquidations.
license: MIT
metadata:
  author: torch-market
  version: "1.0.0"
  clawhub: https://clawhub.ai/mrsirg97-rgb/torchliquidationbot
  github: https://github.com/mrsirg97-rgb/torch-liquidation-bot
  sdk: https://github.com/mrsirg97-rgb/torchsdk
compatibility: Requires a Solana RPC endpoint and a Solana wallet for signing transactions. No API server dependency.
---

# Torch Liquidation Bot

A skill that monitors Torch Market lending positions across all tokens, profiles borrower wallets for risk, predicts which loans are likely to fail, and executes profitable liquidations autonomously.

## What This Skill Does

This bot makes money by liquidating underwater loans on [Torch Market](https://torch.market), a fair-launch DAO launchpad on Solana. Every migrated token on Torch has a built-in lending market where holders can borrow SOL against their tokens. When a borrower's collateral drops in value and their loan-to-value ratio exceeds 65%, anyone can liquidate the position and collect a 10% bonus on the collateral.

The bot's edge is **prediction** -- it doesn't just wait for positions to become liquidatable. It profiles borrowers, tracks price trends, and scores every loan by how likely it is to fail, so it's already watching when a position crosses the threshold.

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

| Mode | Purpose | Requires Wallet |
|------|---------|----------------|
| `bot` (default) | Full multi-token liquidation bot | yes |
| `info` | Display lending parameters for a token or all tokens | no |
| `watch` | Monitor your own loan health in real-time | yes |

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

## Setup

### Requirements

- Node.js 18+
- Solana RPC endpoint
- Solana wallet with SOL for transaction fees
- `torchsdk` (included as dependency)

### Install

```bash
git clone https://github.com/mrsirg97-rgb/torch-liquidation-bot
cd torch-liquidation-bot/packages/bot
pnpm install
```

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `RPC_URL` | yes | -- | Solana RPC endpoint |
| `WALLET` | yes (bot/watch) | -- | Base58-encoded private key |
| `MODE` | no | `bot` | `bot`, `info`, or `watch` |
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
# run the liquidation bot
MODE=bot WALLET=<key> RPC_URL=<rpc> npx tsx src/index.ts

# show lending info for all migrated tokens
MODE=info RPC_URL=<rpc> npx tsx src/index.ts

# show lending info for a specific token
MODE=info MINT=<mint> RPC_URL=<rpc> npx tsx src/index.ts

# watch your own loan health
MODE=watch MINT=<mint> WALLET=<key> RPC_URL=<rpc> npx tsx src/index.ts
```

### Test

Requires [Surfpool](https://github.com/nicholasgasior/surfpool) running a mainnet fork:

```bash
surfpool start --network mainnet --no-tui
pnpm test       # original lending test
pnpm test:bot   # bot module test
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

All transactions are built locally via the Anchor IDL and signed with your own keypair. Private keys never leave your environment.

## Links

- Torch SDK: [github.com/mrsirg97-rgb/torchsdk](https://github.com/mrsirg97-rgb/torchsdk)
- Torch Market: [torch.market](https://torch.market)
- ClawHub: [clawhub.ai/mrsirg97-rgb/torchliquidationbot](https://clawhub.ai/mrsirg97-rgb/torchliquidationbot)
- SAID Protocol: [saidprotocol.com](https://saidprotocol.com)
- Program ID: `8hbUkonssSEEtkqzwM7ZcZrD9evacM92TcWSooVF4BeT`
