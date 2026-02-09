# DESIGN: Liquidation Opportunity Bot

## overview

a multi-token bot that discovers lending markets, profiles borrower wallets, predicts which loans are likely to fail, and executes profitable liquidations.

the bot earns money by collecting liquidation bonuses when it liquidates underwater positions before other bots do. the edge comes from **predicting** which positions will go underwater, so we're already watching when it happens.

## how it works (explain it to a 12 year old)

1. **find all the lending markets** - scan every token on torch that has lending turned on
2. **check who borrowed money** - for each market, find every wallet that has a loan
3. **figure out who's risky** - look at each borrower's reputation and trade history. are they a good trader or do they lose money a lot?
4. **watch the risky ones closely** - track the price of their collateral. if the price is dropping and they're already close to the danger zone, they're probably going to get liquidated
5. **pull the trigger** - when a position crosses the liquidation threshold, execute the liquidation and collect the bonus

## architecture

```
index.ts          - entry point, wires modules together
config.ts         - loads env vars into typed config
types.ts          - all interfaces/contracts (the blueprint)
scanner.ts        - discovers tokens with active lending
wallet-profiler.ts - assesses wallet risk via SAID + trade history
risk-scorer.ts    - scores loan positions by likelihood of failure
monitor.ts        - main loop: scan -> score -> watch -> liquidate
liquidator.ts     - executes liquidation transactions
logger.ts         - simple structured logging
```

each file has one job. no file should exceed ~150 lines.

## modules

### scanner
- calls `getTokens()` to discover all tokens
- filters for `status === 'migrated'` (only migrated tokens have lending)
- calls `getLendingInfo()` on each to check `active_loans > 0`
- returns list of tokens worth monitoring
- re-scans periodically to discover new markets

### wallet-profiler
- for a given token, calls `getHolders()` to get borrower addresses
- for each borrower, calls `getLoanPosition()` to confirm they have a loan
- calls `verifySaid()` to get reputation/trust tier
- calls `getMessages()` to analyze trade history (wins vs losses)
- builds a risk profile per wallet
- caches profiles in-memory, refreshes on a cooldown

### risk-scorer
- takes a loan position + wallet profile + price snapshots
- computes a composite risk score (0-100, higher = more likely to fail)
- four factors:
  - **ltv proximity**: how close is current LTV to liquidation threshold? (0-100)
  - **price momentum**: is the collateral price trending down? (0-100)
  - **wallet risk**: low trust tier + bad trade history = risky (0-100)
  - **interest burden**: high interest accrual relative to collateral value (0-100)
- weighted average of factors = final score

### monitor
- the main orchestration loop
- tick 1: scanner discovers tokens with lending
- tick 2: for each token, profile borrowers and score their loans
- tick 3: sort by risk score, watch the top positions more frequently
- when a position becomes liquidatable: hand off to liquidator
- tracks price history (last N snapshots) for momentum calculation

### liquidator
- receives a liquidation target (mint + borrower)
- calculates expected profit: `collateral_value * liquidation_bonus_bps / 10000`
- if profit > minimum threshold (configurable): execute
- calls `buildLiquidateTransaction()`, signs, sends
- calls `confirmTransaction()` via SAID for reputation
- logs result

### logger
- wraps console with structured log levels
- prefixes with timestamp + module name
- respects config log level

## types/interfaces

```typescript
// --- wallet profiling ---

interface WalletProfile {
  address: string
  saidVerified: boolean
  trustTier: 'high' | 'medium' | 'low' | null
  tradeStats: TradeStats
  riskScore: number // 0-100
  lastUpdated: number // unix timestamp
}

interface TradeStats {
  totalTrades: number
  wins: number
  losses: number
  winRate: number // 0.0 - 1.0
  netPnlSol: number
}

// --- risk scoring ---

interface RiskFactors {
  ltvProximity: number   // 0-100, how close to liquidation threshold
  priceMomentum: number  // 0-100, higher = price dropping faster
  walletRisk: number     // 0-100, based on SAID + trade history
  interestBurden: number // 0-100, interest accrual vs collateral value
}

interface ScoredLoan {
  mint: string
  tokenName: string
  borrower: string
  position: LoanPositionInfo // from torchsdk
  walletProfile: WalletProfile
  riskScore: number // 0-100 composite
  factors: RiskFactors
  estimatedProfitLamports: number
  lastScored: number
}

// --- token monitoring ---

interface MonitoredToken {
  mint: string
  name: string
  symbol: string
  lendingInfo: LendingInfo // from torchsdk
  priceSol: number
  priceHistory: number[] // last N price snapshots for momentum
  activeBorrowers: string[]
  lastScanned: number
}

// --- liquidation ---

interface LiquidationResult {
  mint: string
  borrower: string
  signature: string
  profitLamports: number
  timestamp: number
  confirmed: boolean
}

// --- config ---

interface BotConfig {
  rpcUrl: string
  walletKeypair: Keypair
  scanIntervalMs: number    // how often to discover new tokens (default: 60000)
  scoreIntervalMs: number   // how often to re-score positions (default: 15000)
  minProfitLamports: number // minimum profit to execute liquidation
  riskThreshold: number     // minimum risk score to watch closely (0-100)
  priceHistoryDepth: number // how many price snapshots to keep
  logLevel: 'debug' | 'info' | 'warn' | 'error'
}
```

## config / env vars

```
RPC_URL            - solana rpc endpoint (required)
WALLET             - base58 private key (required)
SCAN_INTERVAL_MS   - token discovery interval (default: 60000)
SCORE_INTERVAL_MS  - position scoring interval (default: 15000)
MIN_PROFIT_SOL     - minimum profit to liquidate (default: 0.01)
RISK_THRESHOLD     - minimum risk score to prioritize (default: 60)
PRICE_HISTORY      - number of price snapshots to track (default: 20)
LOG_LEVEL          - debug|info|warn|error (default: info)
```

## what happens to the existing code

the current `src/index.ts` has three modes (info/watch/liquidate). this new bot **replaces the liquidate mode** with something much smarter. the info and watch modes are still useful for manual inspection.

plan:
- extract shared utils (sol conversion, wallet loading) into `utils.ts`
- keep info + watch modes accessible via cli flag
- the new default mode is the full monitoring bot
- no regressions: info and watch still work exactly the same

## risk scoring formula

```
ltvProximity   = (current_ltv / liquidation_threshold) * 100
priceMomentum  = based on linear regression slope of price history (normalized 0-100)
walletRisk     = base from trust tier + modifier from win/loss ratio
interestBurden = (accrued_interest / collateral_value) * 100

weights:
  ltvProximity:   0.40  (most important - how close are they?)
  priceMomentum:  0.30  (is price working against them?)
  walletRisk:     0.20  (are they the type to get liquidated?)
  interestBurden: 0.10  (is interest eating their margin?)

riskScore = weighted sum, clamped to 0-100
```

## execution flow

```
startup:
  1. load config from env
  2. connect to solana
  3. start scan loop
  4. start score loop

scan loop (every SCAN_INTERVAL_MS):
  1. getTokens() -> filter migrated
  2. getLendingInfo() for each -> filter active_loans > 0
  3. update monitored tokens list
  4. snapshot current prices

score loop (every SCORE_INTERVAL_MS):
  1. for each monitored token:
     a. getHolders() -> find borrowers with active loans
     b. profile new wallets (SAID + trade history)
     c. getLoanPosition() for each borrower
     d. score each position
     e. if position.health === 'liquidatable' && profit > min:
        -> liquidate immediately
     f. if riskScore > threshold:
        -> log as high-risk, continue monitoring
```

## security considerations

- private key loaded from env, never logged
- transactions built via SDK (no raw instruction construction)
- minimum profit threshold prevents unprofitable liquidations
- no external APIs beyond solana RPC and torchsdk
- rate limiting on RPC calls to avoid throttling

## future iterations (not in v1)

- websocket subscriptions for real-time price updates
- file/sqlite persistence for wallet profiles
- telegram/discord notifications for high-value liquidation opportunities
- multi-wallet support for parallel liquidations
- MEV protection (jito bundles)
