---
name: torch-liquidation-bot
description: Read-only lending market scanner for Torch Market on Solana. No wallet required. Scans lending markets, profiles borrower wallets, and scores loans by risk. Info mode (default and read-only) makes no state changes and requires only an RPC endpoint.
license: MIT
metadata:
  author: torch-market
  version: "2.0.0"
  clawhub: https://clawhub.ai/mrsirg97-rgb/torchliquidationbot
  npm: https://www.npmjs.com/package/torch-liquidation-bot
  github: https://github.com/mrsirg97-rgb/torch-liquidation-bot
  sdk: https://github.com/mrsirg97-rgb/torchsdk
compatibility: Requires a Solana RPC endpoint. Only read-only info mode is available -- no wallet loaded, no signing, no state changes. All wallet-dependent functionality (bot mode, watch mode) is deprecated as of v2.0.0. Distributed via npm.
---

# Torch Liquidation Bot — v2.0.0 (Read-Only)

Read-only lending market scanner for [Torch Market](https://torch.market) on Solana. No wallet required. Only an RPC endpoint is needed.

## v2.0.0 Breaking Change — Read-Only Only

**All wallet-dependent functionality is deprecated as of v2.0.0.**

The entry point (`index.ts`) no longer imports, references, or calls any wallet, keypair, signing, or transaction code. This is not a runtime guard or a flag — the wallet code is structurally unreachable. There is no `WALLET` env var to set, no `MODE` to switch, no `Keypair` in the import graph. The only mode is read-only info.

**What was removed from the active codepath:**

- `bot` mode (liquidation execution)
- `watch` mode (loan health monitoring + auto-repay)
- `loadWallet()` / `loadConfig()` (keypair decoding)
- All `sendAndConfirmTransaction` / `buildRepayTransaction` / `buildLiquidateTransaction` / `confirmTransaction` calls
- All SAID Protocol write operations (`confirmTransaction` for reputation)

**What is retained (dormant, for future release):**

The wallet-dependent source files (`liquidator.ts`, `monitor.ts`, `wallet-profiler.ts`, `risk-scorer.ts`) and the `loadConfig()` function in `config.ts` remain in the codebase unchanged. They are not imported by `index.ts` and are not part of any active codepath. They exist so the full bot can be re-enabled in a future version after further security review of the external SAID Protocol API and wallet handling surface.

**Why:**

The skill's direct handling of a Solana private key via the `WALLET` environment variable and its interaction with the external SAID Protocol API presented a significant attack surface. While the code itself was audited and no malicious behavior was found, the inherent risk of providing a private key and relying on an external reputation API warranted a conservative approach. Read-only mode eliminates this risk entirely — no key is ever loaded, decoded, or held in memory.

## What This Skill Does

This skill scans lending markets on Torch Market, a fair-launch DAO launchpad on Solana. Every migrated token on Torch has a built-in lending market where holders can borrow SOL against their tokens.

In v2.0.0, the skill is a **read-only dashboard**. It discovers migrated tokens and displays their lending parameters — interest rates, LTV thresholds, treasury balances, and active loan counts. No wallet is loaded. No state changes occur. No transactions are built or signed.

## How It Works

```
connect to Solana RPC
         |
    discover migrated tokens (getTokens)
         |
    for each token:
         |
    read lending parameters (getLendingInfo)
         |
    display: rates, thresholds, treasury balance, loan count
```

### One Mode

| Mode | Purpose | Wallet | State Changes |
|------|---------|--------|---------------|
| `info` (only) | Display lending parameters for a token or all tokens | not required | none (read-only) |

## Architecture

```
packages/bot/src/
├── types.ts            — interfaces (ReadOnlyConfig + dormant BotConfig)
├── config.ts           — loadReadOnlyConfig() (active) + loadConfig() (dormant)
├── utils.ts            — shared helpers
└── index.ts            — read-only entry point (getTokens, getToken, getLendingInfo only)

dormant (retained for future release, not imported by index.ts):
├── logger.ts           — structured logging with levels
├── scanner.ts          — discovers tokens with active lending
├── wallet-profiler.ts  — SAID reputation + trade history analysis
├── risk-scorer.ts      — 4-factor weighted risk scoring
├── liquidator.ts       — executes liquidation transactions
└── monitor.ts          — main orchestration (scan + score loops)
```

## Network & Permissions

- **Read-only only** -- no wallet is loaded, no keypair is decoded, no signing occurs, no state changes. Only `RPC_URL` is required.
- **Outbound connections:** Solana RPC (via `@solana/web3.js`) only. The active codepath does not call the SAID Protocol API, `verifySaid`, `confirmTransaction`, or any write endpoint.
- **No private key handling** -- the `Keypair` class is not imported by `index.ts`. The `bs58` decoder is not imported. There is no code in the active path that could decode, hold, or transmit a private key.
- **Distributed via npm** -- all code runs from `node_modules/`. No post-install hooks, no remote code fetching.

## Setup

### Install

```bash
npm install torch-liquidation-bot
```

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `RPC_URL` | yes | -- | Solana RPC endpoint |
| `MINT` | no | -- | Token mint address. If set, shows info for that token. If omitted, shows all migrated tokens. |
| `LOG_LEVEL` | no | `info` | `debug`, `info`, `warn`, or `error` |

That's it. No `WALLET`, no `MODE`, no `AUTO_REPAY`, no bot-specific config.

### Run

```bash
# show lending info for all migrated tokens
RPC_URL=<rpc> npx torch-liquidation-bot

# show lending info for a specific token
MINT=<mint> RPC_URL=<rpc> npx torch-liquidation-bot
```

### Programmatic Usage

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

## SDK Functions Used (v2.0.0)

Only read-only [torchsdk](https://github.com/mrsirg97-rgb/torchsdk) functions are imported:

| Function | Purpose |
|----------|---------|
| `getTokens(connection, params)` | Discover migrated tokens |
| `getToken(connection, mint)` | Get token price and metadata |
| `getLendingInfo(connection, mint)` | Get lending parameters and active loan count |

### Deprecated SDK functions (no longer imported)

These functions remain available in the torchsdk but are not used by v2.0.0:

| Function | Status |
|----------|--------|
| `getLoanPosition(connection, mint, wallet)` | deprecated — requires wallet context |
| `getHolders(connection, mint, limit)` | deprecated — used by bot mode scanner |
| `getMessages(connection, mint, limit)` | deprecated — used by wallet profiler |
| `verifySaid(wallet)` | deprecated — SAID API interaction removed |
| `buildLiquidateTransaction(connection, params)` | deprecated — transaction building removed |
| `buildRepayTransaction(connection, params)` | deprecated — transaction building removed |
| `confirmTransaction(connection, sig, wallet)` | deprecated — SAID write removed |

## Key Types

```typescript
// active in v2.0.0
interface ReadOnlyConfig {
  rpcUrl: string
  logLevel: LogLevel
}

// dormant — retained for future release
interface BotConfig {
  rpcUrl: string
  walletKeypair: Keypair
  scanIntervalMs: number
  scoreIntervalMs: number
  minProfitLamports: number
  riskThreshold: number
  priceHistoryDepth: number
  logLevel: LogLevel
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

## Simulation Results — Read-Only (Surfpool)

The v2.0.0 read-only test was run against a Surfpool mainnet fork. No wallet was loaded. No transactions were signed. Here's what the skill sees with just an RPC endpoint:

```
============================================================
READ-ONLY TEST — Surfpool Mainnet Fork
============================================================
[16:00:21]   ✓ connection — solana-core 3.1.6
[16:00:21]   ✓ getTokens — found 8 migrated tokens
    BTEST      | mint=wokxaeFZ...
    BTEST      | mint=8FqFw5fD...
    LEND       | mint=AD1kat3L...
    LEND       | mint=G6yzUvS7...
    BTEST      | mint=GLim6QRX...
    LEND       | mint=76TEs99p...
    BTEST      | mint=FjGHamUF...
    LEND       | mint=9KNunLmY...
[16:01:43]   ✓ getLendingInfo — 8 tokens with lending data
    BTEST      | rate=2.00%   | loans=null | avail=32.3043 SOL
    LEND       | rate=2.00%   | loans=null | avail=32.3043 SOL
    ...
[16:02:34]   ✓ getToken — Bot Test Token (BTEST) | price=0.0000 SOL | status=migrated
[16:02:34]   ✓ no wallet — no WALLET env var read, no Keypair created, no signing occurred

RESULTS: 5 passed, 0 failed
============================================================
```

### What this tells us

**Token discovery works.** `getTokens` found 8 migrated tokens across previous test runs on the fork. Each token has a mint address, symbol, and status. This is the starting point for any lending dashboard — you need to know what tokens exist before you can query their markets.

**Lending data is real and consistent.** Every migrated token returned a 2.00% interest rate, which matches the protocol's fixed per-epoch rate. Treasury balances show ~32 SOL available for borrowing per token — this is the SOL that accumulated during the bonding curve phase and migrated into each token's lending treasury. These numbers come directly from on-chain account state.

**The `active_loans` null on Surfpool is a known fork artifact.** The loan counter comes from a program-derived account field that doesn't always populate correctly on forked validators. On mainnet, this field correctly reflects the number of open loans. The read-only skill displays whatever the RPC returns — it doesn't compute or infer this value.

**Price shows 0.0000 SOL for test tokens.** These are tokens created on the fork with no real trading volume. On mainnet, `getToken` returns the current price derived from the Raydium pool. The skill just reads and displays — it doesn't need price data to be "correct" because it's not making trading decisions.

**The skill is genuinely inert.** 5 tests, 0 failures, 0 wallet operations. The test explicitly verifies that no `WALLET` env var was read, no `Keypair` was constructed, and no signing occurred. This isn't a claim — it's a tested property. The import graph of `index.ts` contains `Connection`, `getToken`, `getTokens`, `getLendingInfo`, `loadReadOnlyConfig`, `sol`, `bpsToPercent`. That's it. There is nothing in the active codepath that could sign, send, or modify on-chain state.

### Compared to v1.x (full bot)

The v1.x E2E tests covered the full lifecycle — create token, bond, migrate, borrow, profile, score, liquidate, repay. Those tests required a wallet, signed 60+ transactions, and exercised every module. They validated that the bot's risk scoring was accurate (46/100 for a healthy position at 52% LTV proximity) and that the liquidator correctly skipped non-liquidatable positions.

v2.0.0 doesn't need any of that. It reads three things from the chain (tokens, lending info, token detail) and displays them. The attack surface went from "wallet + SAID API + transaction signing + RPC" to "RPC". That's the point.

## Links

- Source Code: [github.com/mrsirg97-rgb/torch-liquidation-bot](https://github.com/mrsirg97-rgb/torch-liquidation-bot)
- Torch SDK: [github.com/mrsirg97-rgb/torchsdk](https://github.com/mrsirg97-rgb/torchsdk)
- Torch Market: [torch.market](https://torch.market)
- ClawHub: [clawhub.ai/mrsirg97-rgb/torchliquidationbot](https://clawhub.ai/mrsirg97-rgb/torchliquidationbot)
- Program ID: `8hbUkonssSEEtkqzwM7ZcZrD9evacM92TcWSooVF4BeT`

**NOTE**

An audit of the v1.x codebase is provided in the repository under `audits/audit_botsdk.md`. The audit covers security, correctness, and best practices. v2.0.0 reduces the active codepath to read-only operations only — the audited wallet-handling and transaction-signing code is dormant and unreachable from the entry point.
