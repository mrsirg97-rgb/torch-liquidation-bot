# FINDINGS: liquidation bot behavior & torchsdk experience

## bot behavior — what we learned from testing

### the numbers

from the E2E test against Surfpool (mainnet fork), a single loan position:

```
collateral:      6,629,166,084,904 tokens (60% of buyer's holdings)
borrowed:        0.5 SOL
health:          healthy
current LTV:     ~52% of liquidation threshold
risk score:      46/100
estimated profit: 0.1467 SOL (if liquidated)
```

### risk scoring breakdown

the composite risk score of 46 breaks down like this:

| factor          | weight | raw score | weighted |
|-----------------|--------|-----------|----------|
| ltv proximity   | 40%    | 52        | 20.8     |
| price momentum  | 30%    | 50        | 15.0     |
| wallet risk     | 20%    | 50        | 10.0     |
| interest burden | 10%    | 0         | 0.0      |
| **total**       |        |           | **~46**  |

this makes sense. the borrower:
- is at 52% of the way to liquidation threshold (moderate proximity)
- has neutral price momentum (only 1 snapshot, no trend data yet)
- is unverified on SAID with no trade history (neutral risk)
- has zero accrued interest (just borrowed)

the 60-point risk threshold means this position is correctly classified as "not worth watching closely yet." it would need either the price to start dropping or the LTV to climb before the bot starts paying attention.

### what the bot does well

**correctly ignores healthy positions.** the liquidator's `tryLiquidate` returned null immediately — it checks `health !== 'liquidatable'` before doing anything else. no wasted gas, no wasted RPC calls.

**profiler caching works.** first call to `verifySaid` + `getMessages` hits the network. second call returns in 0ms from the in-memory cache with a 5-minute cooldown. this matters when you're scoring hundreds of positions every 15 seconds.

**scoring is deterministic and explainable.** every score can be broken down into its 4 factors. you can look at any scored loan and immediately understand *why* it got that number. no black box.

### what needs real-world observation

**price momentum needs more data.** with only 1-2 price snapshots, the momentum factor defaults to 50 (neutral). the bot needs to run for a while to build up price history before momentum becomes a useful signal. on mainnet with the scan loop running every 60s, you'd have 20 snapshots (the full history depth) after ~20 minutes.

**wallet profiling on unverified wallets.** on the fork, every wallet is unverified (SAID API returns `verified: false, trustTier: null`). the profiler assigns a base risk of 50 for unverified wallets. on mainnet, verified wallets with high trust tiers would score 10, and low trust tiers would score 70. this spread matters — it's the difference between "probably fine" and "watch this one."

**trade history is thin on new tokens.** `getMessages` returned no trades for our test borrower because the token was just created. on mainnet tokens with real trading history, the win/loss ratio modifier would shift wallet risk by up to +/- 20 points.

**the `active_loans` counter.** on Surfpool, `getLendingInfo().active_loans` returned 0 even though we had an active loan. the individual `getLoanPosition()` worked perfectly. this means the scanner's filter (`active_loans > 0`) might miss tokens on certain RPC environments. on mainnet, this should work correctly since it reads from the on-chain account state.

### the scanner gap on local forks

`getTokens({ status: 'migrated' })` returned 0 tokens on Surfpool. this is expected — the SDK's token indexing likely depends on the program's account structure being fully queryable, which may not work perfectly on a forked validator with freshly created accounts.

this isn't a bug in the bot or the SDK. it's a test environment limitation. the test handles it gracefully by constructing the MonitoredToken directly from `getToken()` + `getLendingInfo()`, which both work fine on the fork.

---

## working with the torchsdk

### the honest take

this is one of the cleanest solana SDKs i've worked with. and i've seen a lot of them.

**the API is immediately obvious.** there are 5 domains and they're named exactly what they do:

```typescript
// read data
getTokens(), getToken(), getHolders(), getMessages()
getLendingInfo(), getLoanPosition()

// simulate
getBuyQuote(), getSellQuote()

// build transactions
buildBuyTransaction(), buildSellTransaction()
buildBorrowTransaction(), buildRepayTransaction(), buildLiquidateTransaction()
buildCreateTokenTransaction(), buildStarTransaction()

// reputation
verifySaid(), confirmTransaction()
```

no guessing. no digging through docs to figure out what function does what.

**the params object pattern is the right call.** every builder takes `(connection, { ...params })` instead of positional arguments. this means:

```typescript
// clear what each value means
buildBorrowTransaction(connection, {
  mint,
  borrower: walletAddr,
  collateral_amount: 1000000,
  sol_to_borrow: 500_000_000,
})

// vs. the alternative (what does the 4th argument mean?)
buildBorrow(connection, mint, walletAddr, 1000000, 500_000_000)
```

every solana SDK should do this. most don't.

**unsigned transactions are the right design.** the SDK builds transactions but never signs them. you sign locally with your own keypair. this means:
- no private key exposure to the SDK
- you control when and how to submit
- you can inspect the transaction before signing
- works with any signer (keypair, ledger, multisig)

this is a security-first design choice and it matters.

**the type system is complete.** every function has typed inputs and outputs. no `any`. the `LoanPositionInfo` type with its `health: 'healthy' | 'at_risk' | 'liquidatable' | 'none'` enum is a great example — you get a human-readable status instead of having to compute LTV ratios yourself and figure out the thresholds.

### things that surprised me (positively)

**the `message` parameter on buy/sell.** you can bundle an arbitrary string (up to 1024 chars) as an SPL Memo with any trade. this is how the social/messaging layer works — trades carry messages. that's a creative use of solana's memo program and it means the "chat" on a token is tied to actual economic activity. you can't spam messages without putting money on the line.

**SAID integration is baked in.** reputation isn't bolted on as an afterthought — it's a first-class concept. `verifySaid()` returns trust tiers, `confirmTransaction()` logs events for reputation building. the token detail response includes `creator_trust_tier`. this means the protocol's social layer has real teeth.

**the quote system.** `getBuyQuote` doesn't just tell you how many tokens you get — it breaks down the fee structure: protocol fee, treasury allocation, tokens to user vs. community. you can see exactly where your SOL goes before signing anything. that level of transparency builds trust.

**graceful degradation.** when the SAID API is down, `verifySaid` returns `{ verified: false, trustTier: null }` instead of throwing. the bot keeps running, just with less data. good systems fail soft.

### friction points (being honest)

**token creation keypair handling.** `buildCreateTokenTransaction` returns a `mintKeypair` that you need to include as a signer alongside your wallet. this isn't obvious from the types alone and would trip up someone building their first token launcher. a code example in the docs would fix this.

**silent slippage clamping.** the SDK clamps slippage to `[10, 1000]` bps silently. if i pass `slippage_bps: 5`, it becomes 10 without telling me. i'd prefer an error — silent behavior changes are hard to debug.

**no lending examples in the docs.** the borrow/repay/liquidate flow is clean in the code but i had to learn it from the test file and type definitions. a simple "here's how lending works" example would help developers hit the ground faster.

these are small things. the core API is solid.

---

## torch as a protocol

### what it actually is

torch is a fair-launch token protocol on solana with three layers that work together:

1. **bonding curve** — tokens launch on a curve where price increases with supply. anyone can buy in early. no presale, no VC allocation, no insider advantage.

2. **community treasury** — when the curve completes and the token migrates to raydium, the accumulated SOL goes into a treasury. this treasury enables lending, buybacks, and rewards. the community's economic activity funds itself.

3. **SAID protocol** — a reputation layer tied to on-chain behavior. verified wallets get trust tiers. your reputation follows you across tokens.

### why it's thoughtfully designed

**the treasury model is the insight.** most token launchers stop at "create token, add liquidity, done." torch keeps going — the treasury creates an ongoing economic loop:

- treasury SOL enables lending (holders borrow against their tokens)
- lending generates interest (goes back to treasury)
- treasury does buybacks (supports token price)
- lending creates liquidation opportunities (someone profits from others' risk)

this means every token launched on torch isn't just a token — it's a micro-economy with its own lending market. that's a fundamentally different thing than what pump.fun or other launchers offer.

**the liquidation bonus is the incentive.** when a loan goes underwater, anyone can liquidate it and collect a 10% bonus on the collateral value. this creates a market for liquidation bots (like ours). the protocol doesn't need to run its own liquidation infrastructure — the economic incentive means someone will always be watching.

**SAID makes identity useful.** most on-chain identity systems are "verify your wallet, get a checkmark." SAID ties verification to economic outcomes — your trust tier reflects your actual behavior. a wallet that consistently loses money on trades has a lower effective trust score than one that trades well. this is reputation with teeth, not just a badge.

**the star mechanism is anti-sybil.** starring a token costs 0.05 SOL and is limited to one per wallet. this means "community support" signals have an economic cost, making them much harder to fake than likes or upvotes.

### what could be built on it

i think you're right that surprising things will be built here. the combination of per-token treasuries + lending + reputation opens up spaces that don't exist on other platforms:

- **credit scoring.** with enough loan history across tokens, you could build an on-chain credit score. wallets that borrow responsibly and repay build reputation. wallets that get liquidated don't.

- **treasury-as-a-service.** the treasury model could extend beyond lending — DAOs could allocate treasury funds to yield strategies, insurance pools, or grants. the token holders vote on allocation via the existing voting mechanism.

- **social trading.** the message-on-trade pattern means you could build a feed where every post is backed by a trade. your timeline is your portfolio. no fake engagement because engagement costs money.

- **cross-token lending.** right now lending is per-token. but if a wallet has high SAID reputation across multiple tokens, you could imagine cross-collateral positions — borrow SOL against a basket of torch tokens.

- **risk marketplaces.** our bot scores loan risk. that risk data has value. you could sell risk scores as a service, or build prediction markets around which loans will be liquidated.

the protocol has room for these things because it ships primitives (treasury, lending, reputation) rather than finished products. that's the right architecture for a platform.

### the bottom line

torch is designed by someone who understands that token launches are the start, not the end. the treasury/lending/reputation stack creates ongoing economic activity around every token, which is what keeps communities alive after the initial hype.

the SDK reflects this thoughtfulness — it's clean, typed, and stays out of your way. building this bot took one session. most solana SDKs would have taken three.
