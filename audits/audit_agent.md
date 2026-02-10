# Torch Liquidation Agent Security Audit

**Date:** February 10, 2026 | **Auditor:** Claude Opus 4.6 (Anthropic) | **Version:** 1.0.3

---

## Scope

| File | Lines | Responsibility |
|------|-------|----------------|
| `types.ts` | 96 | Interfaces and contracts (no runtime code) |
| `config.ts` | 55 | Environment variable loading |
| `logger.ts` | 64 | Structured logging |
| `utils.ts` | 22 | Shared helpers |
| `scanner.ts` | 70 | Token discovery |
| `wallet-profiler.ts` | 145 | Wallet risk assessment |
| `risk-scorer.ts` | 132 | Loan risk scoring |
| `liquidator.ts` | 73 | Liquidation execution |
| `monitor.ts` | 198 | Orchestration loop |
| `index.ts` | 203 | Entry point and mode routing |
| **Total** | **1058** | |

Dependencies: `solana-agent-kit`, `solana-agent-kit-torch-market`, `@solana/web3.js`, `@solana/spl-token`, `@coral-xyz/anchor`, `bs58`

This is the agent kit variant of the Torch Liquidation Bot (`packages/agent`). It replaces all direct `torchsdk` usage with `solana-agent-kit-torch-market` plugin calls, routing through `SolanaAgentKit` for all I/O.

---

## Findings Summary

| Severity | Count | Details |
|----------|-------|---------|
| Critical | 0 | -- |
| High | 0 | -- |
| Medium | 0 | -- |
| Low | 4 | Sequential liquidation execution; unhandled auto-repay failure; silent catch blocks; holder limit may miss borrowers |
| Informational | 5 | No direct external network calls (good); private key isolation (good); SAID failure non-fatal (good); SIGINT doesn't await in-flight txs; dummy keypair for read-only mode (good) |

**Rating: GOOD -- Safe for autonomous operation**

---

## Comparison to Bot Audit (audit_botsdk.md)

The three medium findings from the bot audit (M-1, M-2, M-3) are already resolved in this codebase:

| Bot Finding | Agent Status |
|-------------|-------------|
| M-1: Unbounded profiler cache | Resolved -- `evictStale()` called on every `profile()`, 30min TTL, 1000 entry hard cap (`wallet-profiler.ts:129-143`) |
| M-2: Config values not bounds-validated | Resolved -- all numeric env vars validated at startup with descriptive errors (`config.ts:32-40`) |
| M-3: Estimated profit ignores fees | Resolved -- tx fee (5000 lamports) and Token-2022 1% transfer fee subtracted, floored at 0 (`risk-scorer.ts:45-50`) |

---

## Findings

### Low

**L-1: Sequential liquidation execution** (`monitor.ts:159`, `liquidator.ts:44`)

Liquidatable positions are executed sequentially -- each `torchLiquidateLoan` call blocks until the transaction is confirmed before the next starts. In a competitive environment, later liquidations may be front-run.

```typescript
for (const loan of liquidatable) {
  const result = await this.liquidator.tryLiquidate(this.agent, loan) // blocking
}
```

**Impact:** Missed opportunities when multiple positions become liquidatable simultaneously.

**Recommendation:** Acceptable for v1. Future versions could use `Promise.allSettled` for parallel execution or Jito bundles for MEV protection.

---

**L-2: Auto-repay doesn't check wallet balance** (`index.ts:134-145`)

In watch mode with `AUTO_REPAY=true`, the bot attempts to repay `pos.total_owed` without verifying the wallet has sufficient SOL. If the balance is insufficient, `torchRepayLoan` throws and the error propagates to the watch loop's next iteration (it doesn't crash since sleep is always reached, but the repay fails silently).

```typescript
if (process.env.AUTO_REPAY === 'true') {
  const result = await torchRepayLoan(agent, mint, pos.total_owed) // could throw
}
```

**Impact:** Auto-repay silently fails if wallet balance is too low. The position remains liquidatable.

**Recommendation:** Check SOL balance before repaying, or wrap in try/catch with a user-visible warning.

---

**L-3: Silent catch blocks in scanner and monitor** (`scanner.ts:63`, `monitor.ts:46`, `monitor.ts:190`)

Several catch blocks silently swallow errors. While intentional (not all tokens have lending, not all holders have loans), genuine RPC errors or SDK bugs are also ignored.

```typescript
} catch {
  // token may not have lending enabled — skip
}
```

**Impact:** Debugging production issues is harder. An RPC outage appears as "no tokens found" rather than an error.

**Recommendation:** Log at debug level in catch blocks so errors are visible when `LOG_LEVEL=debug`.

---

**L-4: Holder limit may miss borrowers** (`monitor.ts:173`)

`getTokenHolders` uses `getTokenLargestAccounts` which returns at most 20 accounts (Solana RPC limit). Tokens with more than 20 unique holders could have active borrowers that are never scored.

```typescript
const holders = await getTokenHolders(this.agent, token.mint, 100)
// getTokenLargestAccounts returns max 20 accounts regardless of limit param
```

**Impact:** Some liquidatable positions on popular tokens may be missed.

**Recommendation:** Acceptable trade-off for v1. Consider using `getProgramAccounts` with filters for wider coverage in future versions.

---

### Informational

**I-1: No direct external network calls from this skill.**

Unlike the bot package (which calls `torchsdk.verifySaid` which internally fetches from `api.saidprotocol.com`), the agent package makes **zero direct HTTP calls**. All outbound communication is routed through dependencies:

- Solana RPC: via `solana-agent-kit` (`agent.connection`)
- SAID Protocol API: via `solana-agent-kit-torch-market` (`torchVerifySaid`)
- Torch Market reads: via `solana-agent-kit-torch-market` (`torchListTokens`, `torchGetLendingInfo`, etc.)
- Transaction signing/submission: via `solana-agent-kit-torch-market` (`torchLiquidateLoan`, `torchRepayLoan`)

No `fetch()`, `http`, `axios`, or any direct network call exists in the agent source code.

**I-2: Private key handling is correct.**

The wallet keypair is loaded from the `WALLET` env var, decoded once in `config.ts:42`, and passed into `KeypairWallet` -> `SolanaAgentKit`. After initialization:

- The raw key bytes are never logged, serialized, stored, or transmitted
- All signing happens inside `SolanaAgentKit.signOrSendTX()` -- the skill never accesses the secret key directly
- The logger truncates wallet addresses to 8 characters (`wallet.slice(0, 8)`)
- No `.env` file loading -- env vars must be set externally

**I-3: SAID failure is non-fatal throughout.**

Both the wallet profiler and liquidator handle SAID failures gracefully:

- `torchVerifySaid` failure: the SDK returns `{ verified: false, trustTier: null }` (handled in the plugin)
- `torchConfirm` failure: caught and logged as warning (`liquidator.ts:55-57`), liquidation result still returned

The bot continues operating normally when SAID Protocol is unavailable.

**I-4: SIGINT doesn't await in-flight operations.**

The SIGINT handler calls `monitor.stop()` then `process.exit(0)`. If a liquidation transaction is in-flight, the process exits before logging the result. The transaction itself will still land on-chain -- only local tracking is lost.

```typescript
process.on('SIGINT', () => {
  monitor.stop()
  process.exit(0) // doesn't await in-flight txs
})
```

**I-5: Dummy keypair for read-only mode.**

In info mode, `createAgent()` generates a random `Keypair.generate()` for read-only RPC calls (`index.ts:52`). This keypair is never funded and is discarded on exit. No wallet env var is required. This is the correct approach for read-only operations.

---

## Architecture Security Properties

### What's Protected

- **No direct external calls.** All network I/O goes through `solana-agent-kit` and `solana-agent-kit-torch-market`. The skill itself has no `fetch`, no HTTP clients, no outbound URLs.
- **Private keys never leave the process.** Decoded from env, wrapped in `KeypairWallet`, used only for signing via `SolanaAgentKit.signOrSendTX()`. Never serialized, logged, or transmitted.
- **All transactions constructed by the agent kit plugin.** The plugin wraps `torchsdk` which uses the Anchor IDL. No raw instruction construction in this skill. The on-chain program validates all parameters.
- **Minimum profit threshold.** The bot won't execute liquidations below `MIN_PROFIT_SOL` (default 0.01 SOL), preventing dust attacks or gas-wasting transactions.
- **Read-only info mode.** `MODE=info` requires no wallet and makes no state changes. Safe for monitoring without risk.
- **Error isolation.** Individual token scoring failures don't crash the bot. Each token is wrapped in its own try/catch.
- **Profiler cache is bounded.** 30-minute TTL eviction, 1000 entry hard cap, eviction on every profile call.

### What's Accepted (Design Trade-offs)

- **No RPC rate limiting.** The bot relies on the RPC provider's rate limits.
- **Spot price for profit estimation.** Collateral value uses the current price at scoring time.
- **No MEV protection.** Liquidation transactions are submitted to the public mempool.
- **Single-threaded execution.** Liquidations are sequential within a scoring tick.
- **`getTokenLargestAccounts` returns max 20 accounts.** This is a Solana RPC limitation, not a code issue.

---

## Dependency Review

| Package | Version | Risk | Notes |
|---------|---------|------|-------|
| `solana-agent-kit` | ^2.0.0 | Low | Standard agent framework. Handles wallet management and tx signing. |
| `solana-agent-kit-torch-market` | ^3.0.8 | Low | Torch Market plugin. Wraps torchsdk. All SAID and Torch calls routed here. |
| `@solana/web3.js` | ^1.98.4 | Low | Standard Solana client. Well-audited. |
| `@coral-xyz/anchor` | ^0.32.1 | Low | Standard Anchor framework. |
| `@solana/spl-token` | ^0.4.14 | Low | Token program client. |
| `bs58` | ^6.0.0 | Low | Base58 encoding only. No network calls. |

No unnecessary dependencies. `torchsdk` is a devDependency only (used in tests for setup operations like `buildBorrowTransaction`). It is **not** a runtime dependency.

---

## Key Difference from Bot Package

| Property | Bot (`packages/bot`) | Agent (`packages/agent`) |
|----------|---------------------|-------------------------|
| SDK | `torchsdk` (direct) | `solana-agent-kit-torch-market` (plugin) |
| Wallet | `Keypair` + `sendAndConfirmTransaction` | `KeypairWallet` + `SolanaAgentKit` |
| SAID calls | `verifySaid()` from torchsdk (internal fetch) | `torchVerifySaid()` from plugin (no direct fetch) |
| Direct HTTP calls | 0 from skill, 1 from SDK | 0 from skill, 0 from skill code (all via deps) |
| Tx construction | torchsdk builds locally from IDL | Plugin wraps torchsdk, signs via `signOrSendTX` |

The agent package is a pure orchestrator -- it contains no direct network calls, no transaction construction, and no cryptographic operations. All I/O is delegated to its dependencies.

---

*Audited by Claude Opus 4.6 (Anthropic). This audit is provided for informational purposes and does not constitute financial or legal advice. Security audits cannot guarantee the absence of all vulnerabilities.*
