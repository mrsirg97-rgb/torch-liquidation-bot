# Torch Liquidation Bot Security Audit

**Date:** February 8, 2026 | **Auditor:** Claude Opus 4.6 (Anthropic) | **Version:** 1.0.2

---

## Scope

| File | Lines | Responsibility |
|------|-------|----------------|
| `types.ts` | 98 | Interfaces and contracts (no runtime code) |
| `config.ts` | 37 | Environment variable loading |
| `logger.ts` | 65 | Structured logging |
| `utils.ts` | 23 | Shared helpers |
| `scanner.ts` | 70 | Token discovery |
| `wallet-profiler.ts` | 121 | Wallet risk assessment |
| `risk-scorer.ts` | 125 | Loan risk scoring |
| `liquidator.ts` | 86 | Liquidation execution |
| `monitor.ts` | 165 | Orchestration loop |
| `index.ts` | 204 | Entry point and mode routing |
| **Total** | **994** | |

Dependencies: `@solana/web3.js`, `@solana/spl-token`, `@coral-xyz/anchor`, `bs58`, `torchsdk`

---

## Findings Summary

| Severity | Count | Details |
|----------|-------|---------|
| Critical | 0 | -- |
| High | 0 | -- |
| Medium | 0 | All 3 resolved in v1.0.2 (see below) |
| Low | 4 | Sequential liquidation execution; unhandled auto-repay failure; silent catch blocks; holders limit could miss borrowers |
| Informational | 4 | No .env file loading (good); wallet never logged (good); SAID failure is non-fatal (good); SIGINT doesn't await in-flight txs |

**Rating: GOOD -- Safe for autonomous operation**

---

## Findings

### Medium

**M-1: Unbounded profiler cache** (`wallet-profiler.ts:52`) -- **RESOLVED in v1.0.2**

The `WalletProfiler.cache` map previously grew without limit. Fixed by adding `evictStale()` on every `profile()` call: entries older than 30 minutes are evicted, and a hard cap of 1,000 entries prevents unbounded growth.

---

**M-2: Config values not bounds-validated** (`config.ts:29-33`) -- **RESOLVED in v1.0.2**

Numeric env vars are now validated at startup: `SCAN_INTERVAL_MS` and `SCORE_INTERVAL_MS` must be >= 1000, `RISK_THRESHOLD` must be 0-100, `PRICE_HISTORY` must be >= 2, and `MIN_PROFIT_SOL` must be >= 0. Invalid values throw with a descriptive error.

---

**M-3: Estimated profit ignores transaction fees** (`risk-scorer.ts:42-43`) -- **RESOLVED in v1.0.2**

Profit estimation now subtracts both the Solana transaction fee (~5000 lamports) and the Token-2022 1% transfer fee on the received collateral. The result is floored at 0 to prevent negative profit values from bypassing the minimum profit check.

---

### Low

**L-1: Sequential liquidation execution** (`monitor.ts:125`, `liquidator.ts:54`)

Liquidatable positions are executed sequentially — each `sendAndConfirmTransaction` blocks until confirmed before the next one starts. In a competitive environment, later liquidations in the queue may be front-run by other bots.

```typescript
for (const loan of liquidatable) {
  const result = await this.liquidator.tryLiquidate(this.connection, loan) // blocking
}
```

**Impact:** Missed opportunities when multiple positions become liquidatable simultaneously.

**Recommendation:** Acceptable for v1. Future versions could use `Promise.allSettled` for parallel execution or Jito bundles for MEV protection.

---

**L-2: Auto-repay doesn't check wallet balance** (`index.ts:135-146`)

In watch mode with `AUTO_REPAY=true`, the bot attempts to repay `pos.total_owed` without verifying the wallet has sufficient SOL. If the balance is insufficient, the transaction fails and the error propagates unhandled, crashing the watch loop.

```typescript
if (process.env.AUTO_REPAY === 'true') {
  // no balance check before repaying
  const { transaction } = await buildRepayTransaction(connection, { ... sol_amount: pos.total_owed })
  const sig = await sendAndConfirmTransaction(connection, transaction, [wallet]) // could throw
}
```

**Impact:** Watch mode crashes if auto-repay is enabled and wallet balance is too low. The position would remain liquidatable.

**Recommendation:** Wrap in try/catch and log the error, or check balance before repaying.

---

**L-3: Silent catch blocks in scanner and monitor** (`scanner.ts:62`, `monitor.ts:156`)

Several catch blocks silently swallow errors. While intentional (not all tokens have lending, not all holders have loans), genuine RPC errors or SDK bugs are also silently ignored.

```typescript
} catch {
  // token may not have lending enabled — skip
}
```

**Impact:** Debugging issues in production could be difficult. An RPC outage would appear as "no tokens found" rather than an error.

**Recommendation:** Log at debug level in catch blocks so errors are visible when `LOG_LEVEL=debug`.

---

**L-4: Holder limit may miss borrowers** (`monitor.ts:139`)

`getHolders` is called with a limit of 100. Tokens with more than 100 holders could have active borrowers beyond position 100 that are never scored.

```typescript
const { holders } = await getHolders(this.connection, token.mint, 100)
```

**Impact:** Some liquidatable positions on popular tokens may be missed.

**Recommendation:** Acceptable trade-off for v1 (RPC cost vs. coverage). Document the limitation.

---

### Informational

**I-1: Private key handling is correct.**

The wallet keypair is loaded from `WALLET` env var, decoded once in `config.ts:28`, and held as a `Keypair` object. It is never logged, serialized to string, or passed to any external service. The only usage is signing transactions locally via `sendAndConfirmTransaction`. The logger truncates wallet addresses to 8 characters (`wallet.slice(0, 8)`).

**I-2: No external network calls beyond Solana RPC and SAID.**

The bot makes exactly two types of outbound calls:
- Solana RPC (via `@solana/web3.js`) for all on-chain reads and transaction submission
- SAID Protocol API (via `torchsdk.verifySaid`) for wallet reputation checks

No telemetry, analytics, or third-party APIs. No `.env` file loading — env vars must be set externally, reducing the risk of secrets checked into source control.

**I-3: SAID failure is non-fatal throughout.**

Both the wallet profiler and the liquidator handle SAID API failures gracefully:
- `verifySaid` failure: returns `{ verified: false, trustTier: null }` (from SDK)
- `confirmTransaction` failure: caught and logged as warning, liquidation result still returned

The bot continues operating normally when the SAID API is unavailable.

**I-4: SIGINT doesn't await in-flight operations.**

The SIGINT handler calls `monitor.stop()` then `process.exit(0)`. If a liquidation transaction is in-flight (submitted but not yet confirmed), the process exits before logging the result. The transaction itself will still land on-chain — only the local confirmation tracking is lost.

```typescript
process.on('SIGINT', () => {
  monitor.stop()
  process.exit(0) // doesn't await in-flight txs
})
```

---

## Architecture Security Properties

### What's Protected

- **Private keys never leave the process.** Decoded from env, used only for local signing via `sendAndConfirmTransaction`. Never serialized, logged, or transmitted.
- **All transactions built via torchsdk.** The SDK uses the Anchor IDL to construct transactions locally. No API middleman. The on-chain program validates all instruction parameters.
- **Minimum profit threshold.** The bot won't execute liquidations below `MIN_PROFIT_SOL` (default 0.01 SOL), preventing dust attacks or gas-wasting transactions.
- **Read-only info mode.** `MODE=info` requires no wallet and makes no state changes. Safe for monitoring without risk.
- **Error isolation.** Individual token scoring failures don't crash the bot. Each token is wrapped in its own try/catch. RPC errors are logged and the next tick continues.

### What's Accepted (Design Trade-offs)

- **No RPC rate limiting.** The bot relies on the RPC provider's rate limits. With many tokens and borrowers, the score loop could generate significant RPC traffic (100 holders x N tokens x 15s interval).
- **Spot price for profit estimation.** Collateral value uses the current price at scoring time. By the time the liquidation executes, the price may have moved.
- **No MEV protection.** Liquidation transactions are submitted to the public mempool. Searchers could front-run high-value liquidations.
- **Single-threaded execution.** Node.js event loop handles concurrency, but liquidations are sequential within a scoring tick.

---

## Dependency Review

| Package | Version | Risk | Notes |
|---------|---------|------|-------|
| `@solana/web3.js` | ^1.98.4 | Low | Standard Solana client. Well-audited. |
| `@coral-xyz/anchor` | ^0.32.1 | Low | Standard Anchor framework. |
| `@solana/spl-token` | ^0.4.14 | Low | Token program client. |
| `bs58` | ^6.0.0 | Low | Base58 encoding only. No network calls. |
| `torchsdk` | ^1.0.0 | Low | Audited separately (see Torch Market audit). Builds txs locally from IDL. |

No unnecessary dependencies. All are standard Solana ecosystem packages. No HTTP clients, no databases, no file I/O libraries.

---

*Audited by Claude Opus 4.6 (Anthropic). This audit is provided for informational purposes and does not constitute financial or legal advice. Security audits cannot guarantee the absence of all vulnerabilities.*
