---
name: torch-liquidation-agent
description: Read-only by default. Solana Agent Kit skill that monitors Torch Market lending positions, profiles borrower wallets, scores loan risk, and executes profitable liquidations autonomously. Default info mode requires no wallet and makes no state changes.
license: MIT
metadata:
  author: torch-market
  version: "1.0.1"
  clawhub: https://clawhub.ai/mrsirg97-rgb/torchliquidationagent
  npm: https://www.npmjs.com/package/torch-liquidation-agent
  github: https://github.com/mrsirg97-rgb/torch-liquidation-bot
  agentkit: https://github.com/mrsirg97-rgb/solana-agent-kit-torch-market
compatibility: Requires solana-agent-kit ^2.0.0 and solana-agent-kit-torch-market ^3.0.6. Solana RPC endpoint required. Default info mode is fully read-only. Wallet keypair only needed for bot or watch mode.
---

# Torch Liquidation Agent

A Solana Agent Kit skill that monitors lending positions on [Torch Market](https://torch.market), profiles borrower wallets for risk, predicts which loans are likely to fail, and executes profitable liquidations when positions cross the on-chain threshold.

Built on [solana-agent-kit-torch-market](https://www.npmjs.com/package/solana-agent-kit-torch-market) -- all lending reads, liquidations, repayments, and SAID confirmations go through the agent kit plugin.

## Installation

```bash
npm install torch-liquidation-agent solana-agent-kit solana-agent-kit-torch-market
```

## Usage

```typescript
import { SolanaAgentKit, KeypairWallet } from "solana-agent-kit"
import TorchMarketPlugin from "solana-agent-kit-torch-market"
import { Monitor, loadConfig } from "torch-liquidation-agent"

// Initialize agent
const wallet = new KeypairWallet(keypair, rpcUrl)
const agent = new SolanaAgentKit(wallet, rpcUrl, {})
agent.use(TorchMarketPlugin)
```

## Available Actions

These are the Torch Market plugin actions this skill uses for lending operations:

| Action | Description |
|--------|-------------|
| `TORCH_LIST_TOKENS` | Discover migrated tokens with active lending markets |
| `TORCH_GET_TOKEN` | Get token price and metadata for collateral valuation |
| `TORCH_GET_LENDING_INFO` | Get lending parameters -- rates, thresholds, treasury balance |
| `TORCH_GET_LOAN_POSITION` | Get a borrower's loan health, LTV, collateral, and debt |
| `TORCH_GET_MESSAGES` | Read trade history for borrower wallet profiling |
| `TORCH_LIQUIDATE_LOAN` | Execute a liquidation on an underwater position |
| `TORCH_REPAY_LOAN` | Repay borrowed SOL (used in watch mode auto-repay) |
| `TORCH_CONFIRM` | Report transaction to SAID Protocol for reputation |

## Methods

### Read Operations (no wallet required)

```typescript
import {
  torchListTokens,
  torchGetToken,
  torchGetLendingInfo,
  torchGetLoanPosition,
  torchGetMessages,
} from "solana-agent-kit-torch-market"

// Discover tokens with active lending
const tokens = await torchListTokens(agent, "migrated", "volume", 50)

// Get token price for collateral valuation
const token = await torchGetToken(agent, "MINT_ADDRESS")

// Get lending parameters
const lending = await torchGetLendingInfo(agent, "MINT_ADDRESS")
// lending.interest_rate_bps      -- 200 (2%)
// lending.liquidation_threshold_bps -- 6500 (65%)
// lending.liquidation_bonus_bps  -- 1000 (10%)
// lending.treasury_sol_available  -- SOL available for borrowing

// Get a borrower's loan health
const position = await torchGetLoanPosition(agent, "MINT_ADDRESS", "BORROWER_ADDRESS")
// position.health          -- "healthy" | "at_risk" | "liquidatable" | "none"
// position.current_ltv_bps -- current loan-to-value in basis points
// position.collateral_amount -- tokens locked as collateral
// position.total_owed      -- principal + accrued interest

// Get trade messages for wallet profiling
const messages = await torchGetMessages(agent, "MINT_ADDRESS", 50)
```

### Write Operations (wallet required)

```typescript
import {
  torchLiquidateLoan,
  torchRepayLoan,
  torchConfirm,
} from "solana-agent-kit-torch-market"

// Liquidate an underwater position (permissionless)
// Liquidator receives collateral + 10% bonus
const sig = await torchLiquidateLoan(agent, "MINT_ADDRESS", "BORROWER_ADDRESS")

// Repay borrowed SOL (interest first, then principal)
const sig = await torchRepayLoan(agent, "MINT_ADDRESS", 600_000_000) // lamports

// Confirm transaction for SAID reputation
const result = await torchConfirm(agent, "TX_SIGNATURE")
// result.confirmed: boolean
// result.event_type: "trade_complete" (+5 reputation)
```

## What This Skill Does

Every migrated token on Torch has a built-in lending market. Holders borrow SOL against their tokens. When a borrower's collateral drops in value and their LTV exceeds 65%, the position becomes liquidatable on-chain. The liquidator receives the collateral plus a 10% bonus.

This skill finds those opportunities by **predicting** which positions will go underwater:

```
scan all tokens with active lending
         |
    for each token:
         |
    find all holders with active loans
         |
    profile each borrower (SAID reputation + trade history)
         |
    score each loan (4-factor risk model, 0-100)
         |
    if liquidatable + profitable → execute liquidation
    if high risk → keep watching closely
```

### Three Modes

| Mode | Purpose | Requires Wallet |
|------|---------|----------------|
| `info` (default) | Display lending parameters for a token or all tokens | no |
| `bot` | Scan, score, and liquidate positions autonomously | yes |
| `watch` | Monitor your own loan health; optionally auto-repay | yes |

### Risk Scoring

Every loan is scored 0-100 on four weighted factors:

| Factor | Weight | What It Measures |
|--------|--------|------------------|
| LTV proximity | 40% | How close the position is to the 65% liquidation threshold |
| Price momentum | 30% | Is the collateral price trending down? (linear regression on recent snapshots) |
| Wallet risk | 20% | SAID trust tier + trade win/loss ratio |
| Interest burden | 10% | Accrued interest relative to collateral value |

Positions above the risk threshold (default: 60) are flagged as high-risk and watched closely. Liquidatable positions are executed highest-profit-first.

## Programmatic Usage

### Full autonomous bot

```typescript
import { Monitor, loadConfig } from "torch-liquidation-agent"

const config = loadConfig() // reads RPC_URL, WALLET, etc. from env
const monitor = new Monitor(config)

process.on("SIGINT", () => monitor.stop())
await monitor.start()
```

### Individual modules

```typescript
import { SolanaAgentKit, KeypairWallet } from "solana-agent-kit"
import { scanForLendingMarkets } from "torch-liquidation-agent/scanner"
import { WalletProfiler } from "torch-liquidation-agent/wallet-profiler"
import { scoreLoan } from "torch-liquidation-agent/risk-scorer"
import { Liquidator } from "torch-liquidation-agent/liquidator"
import { Logger } from "torch-liquidation-agent/logger"

const wallet = new KeypairWallet(keypair, rpcUrl)
const agent = new SolanaAgentKit(wallet, rpcUrl, {})
const log = new Logger("my-bot", "info")

// Discover lending markets
const tokens = await scanForLendingMarkets(agent, new Map(), 20, log)

// Profile a borrower
const profiler = new WalletProfiler(log)
const profile = await profiler.profile(agent, "BORROWER_ADDRESS", "MINT_ADDRESS")

// Score a loan
const scored = scoreLoan(token, "BORROWER_ADDRESS", position, profile)
// scored.riskScore: 0-100
// scored.estimatedProfitLamports: expected profit after fees
```

## Configuration

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `RPC_URL` | yes | -- | Solana RPC endpoint |
| `WALLET` | bot/watch | -- | Solana wallet keypair (base58) |
| `MODE` | no | `info` | `info`, `bot`, or `watch` |
| `MINT` | info/watch | -- | Token mint address for single-token modes |
| `SCAN_INTERVAL_MS` | no | `60000` | How often to discover new lending markets |
| `SCORE_INTERVAL_MS` | no | `15000` | How often to re-score positions |
| `MIN_PROFIT_SOL` | no | `0.01` | Minimum profit in SOL to execute a liquidation |
| `RISK_THRESHOLD` | no | `60` | Minimum risk score (0-100) to flag as high-risk |
| `PRICE_HISTORY` | no | `20` | Price snapshots to keep for momentum calculation |
| `LOG_LEVEL` | no | `info` | `debug`, `info`, `warn`, or `error` |
| `AUTO_REPAY` | no | `false` | Auto-repay your position if liquidatable (watch mode) |

## Key Types

```typescript
interface ScoredLoan {
  mint: string
  tokenName: string
  borrower: string
  position: TorchLoanPosition  // health, LTV, collateral, debt
  walletProfile: WalletProfile // SAID tier, trade stats, risk score
  riskScore: number            // 0-100 composite
  factors: RiskFactors         // breakdown of all 4 scoring factors
  estimatedProfitLamports: number
}

interface WalletProfile {
  address: string
  saidVerified: boolean
  trustTier: "high" | "medium" | "low" | null
  tradeStats: TradeStats       // wins, losses, win rate, net PnL
  riskScore: number            // 0-100
}

interface MonitoredToken {
  mint: string
  name: string
  symbol: string
  lendingInfo: TorchLendingInfo  // rates, thresholds, treasury balance
  priceSol: number
  priceHistory: number[]         // for momentum calculation
  activeBorrowers: string[]
}
```

## Security Model

This section addresses the three categories flagged in the OpenClaw skill review: private key handling, financial transaction execution, and external network calls.

### 1. Private Key Isolation

The wallet keypair is read **once** from the `WALLET` environment variable in [`config.ts`](https://github.com/mrsirg97-rgb/torch-liquidation-bot/blob/main/packages/agent/src/config.ts) and immediately converted into a `KeypairWallet` → `SolanaAgentKit` instance. After initialization:

- The raw key bytes are **never logged, serialized, stored, or transmitted** by any module in this skill
- All transaction signing happens inside `SolanaAgentKit.signOrSendTX()` -- the skill never accesses the secret key directly
- `info` mode does not require a wallet at all. A dummy keypair is generated for read-only RPC calls and discarded on exit
- The key never leaves the local process. No outbound request includes key material

```
env WALLET → Keypair.fromSecretKey() → KeypairWallet → SolanaAgentKit
                                                            ↓
                                          agent.signOrSendTX(tx)  ← only signing path
```

### 2. On-Chain Transaction Validation

This skill executes two types of write transactions: `torchLiquidateLoan` and `torchRepayLoan`. Both are validated by the on-chain Torch Market program (`8hbUkonssSEEtkqzwM7ZcZrD9evacM92TcWSooVF4BeT`):

- **Liquidations are permissionless but program-validated** -- the on-chain instruction checks that the position's LTV exceeds the 65% liquidation threshold. If the position is healthy, the transaction fails. The skill cannot force a liquidation on a healthy position regardless of what parameters it sends
- **Minimum profit threshold** (`MIN_PROFIT_SOL`, default `0.01`) -- the skill estimates profit before submitting and skips positions below the threshold. This prevents dust liquidations and wasted transaction fees
- **Repayments are self-scoped** -- `torchRepayLoan` only repays debt belonging to the signing wallet. It cannot affect other users' positions
- **No arbitrary instruction construction** -- the skill does not build raw Solana instructions. All transactions are constructed by the `solana-agent-kit-torch-market` plugin, which wraps the protocol SDK

### 3. External Network Calls

The skill makes exactly two categories of outbound calls. There is no telemetry, analytics, or reporting to any other endpoint.

| Destination | Purpose | Data Sent | Failure Mode |
|-------------|---------|-----------|--------------|
| Solana RPC (`RPC_URL`) | All on-chain reads and transaction submission | Standard Solana JSON-RPC requests | Fatal -- skill cannot operate without RPC |
| SAID Protocol API (`api.saidprotocol.com/api/verify/{address}`) | Look up borrower wallet trust tier for risk scoring | Public wallet address only | **Non-fatal** -- skill continues with neutral risk score (50) if SAID is unreachable |

SAID Protocol details:
- Called in [`wallet-profiler.ts`](https://github.com/mrsirg97-rgb/torch-liquidation-bot/blob/main/packages/agent/src/wallet-profiler.ts) via a single `GET` request per borrower
- Sends only the **public** wallet address (already visible on-chain)
- Response is cached in-memory for the session -- each borrower is queried at most once
- If the API returns an error or is unreachable, the profiler returns `{ verified: false, trustTier: null }` and the risk scorer assigns a neutral 50/100 wallet risk. The bot continues normally
- `torchConfirm` (SAID reputation write) is also non-fatal -- a failed confirmation is logged and skipped

### General Safety Properties

- **Read-only default** -- `info` mode requires no wallet and makes no state changes
- **Deterministic risk scoring** -- transparent 4-factor model with configurable weights and threshold, no black-box decisions
- **Per-token error isolation** -- a failure on one token does not crash the bot or affect other markets
- **Graceful shutdown** -- SIGINT handler stops both scan and score loops cleanly
- **Full source available** -- [github.com/mrsirg97-rgb/torch-liquidation-bot](https://github.com/mrsirg97-rgb/torch-liquidation-bot)

## SAID Protocol Integration

Borrower wallets are profiled using [SAID Protocol](https://saidprotocol.com) (Solana Agent Identity):

- **Read**: Wallet trust tier (`high` / `medium` / `low`) feeds into the 20% wallet risk factor
- **Write**: Call `torchConfirm()` after liquidations to build your agent's portable reputation (+5 per trade)

Low-reputation borrowers with losing trade histories score higher risk, meaning the bot watches their positions more closely.

## Lending Protocol Constants

| Parameter | Value |
|-----------|-------|
| Max LTV | 50% |
| Liquidation threshold | 65% LTV |
| Interest rate | 2% per epoch (~7 days) |
| Liquidation bonus | 10% of collateral value |
| Treasury utilization cap | 50% |
| Min borrow | 0.1 SOL |
| Token-2022 transfer fee | 1% on all transfers |

## Links

- npm: [npmjs.com/package/torch-liquidation-agent](https://www.npmjs.com/package/torch-liquidation-agent)
- Agent Kit Plugin: [npmjs.com/package/solana-agent-kit-torch-market](https://www.npmjs.com/package/solana-agent-kit-torch-market)
- Source Code: [github.com/mrsirg97-rgb/torch-liquidation-bot](https://github.com/mrsirg97-rgb/torch-liquidation-bot)
- ClawHub: [clawhub.ai/mrsirg97-rgb/torchliquidationagent](https://clawhub.ai/mrsirg97-rgb/torchliquidationagent)
- Torch Market: [torch.market](https://torch.market)
- SAID Protocol: [saidprotocol.com](https://saidprotocol.com)
- Program ID: `8hbUkonssSEEtkqzwM7ZcZrD9evacM92TcWSooVF4BeT`

## License

MIT
