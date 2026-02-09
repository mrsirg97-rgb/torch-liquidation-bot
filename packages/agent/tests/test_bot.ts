/**
 * Bot E2E Test — Surfpool (mainnet fork)
 *
 * Tests the new bot modules end-to-end:
 *   1. Setup: create token, bond, migrate (shared setup)
 *   2. Create a borrower with an active loan
 *   3. Test scanner: discovers the token with active lending
 *   4. Test wallet-profiler: profiles the borrower
 *   5. Test risk-scorer: scores the loan position
 *   6. Test liquidator: attempts liquidation (should skip — position is healthy)
 *   7. Full monitor tick: runs one scoring cycle
 *
 * Run:
 *   surfpool start --network mainnet --no-tui
 *   npx tsx tests/test_bot.ts
 */

import { SystemProgram, Transaction, PublicKey, Keypair, LAMPORTS_PER_SOL } from '@solana/web3.js'
import { SolanaAgentKit, KeypairWallet } from 'solana-agent-kit'
import {
  torchGetToken,
  torchGetLendingInfo,
  torchGetLoanPosition,
} from 'solana-agent-kit-torch-market'
import {
  buildBorrowTransaction,
  buildRepayTransaction,
  LAMPORTS_PER_SOL as SDK_LAMPORTS,
} from 'torchsdk'
import { setupMigratedToken, log, signAndSend, bpsToPercent, RPC_URL } from './setup'
import { scanForLendingMarkets } from '../src/scanner'
import { WalletProfiler } from '../src/wallet-profiler'
import { scoreLoan } from '../src/risk-scorer'
import { Liquidator } from '../src/liquidator'
import { Logger } from '../src/logger'
import type { MonitoredToken, BotConfig } from '../src/types'

// ============================================================================
// Test runner
// ============================================================================

let passed = 0
let failed = 0

const ok = (name: string, detail?: string) => {
  passed++
  log(`  ✓ ${name}${detail ? ` — ${detail}` : ''}`)
}
const fail = (name: string, err: any) => {
  failed++
  log(`  ✗ ${name} — ${err.message || err}`)
}

// ============================================================================
// Main
// ============================================================================

const main = async () => {
  console.log('='.repeat(60))
  console.log('BOT MODULE TEST (AGENT KIT) — Surfpool Mainnet Fork')
  console.log('='.repeat(60))

  // ------------------------------------------------------------------
  // setup: create, bond, migrate
  // ------------------------------------------------------------------
  const { connection, wallet, mint, buyers } = await setupMigratedToken()

  // create agent kit instance from the test wallet
  const keypairWallet = new KeypairWallet(wallet, RPC_URL)
  const agent = new SolanaAgentKit(keypairWallet, RPC_URL, {})

  // ------------------------------------------------------------------
  // 1. create a borrower with an active loan
  // ------------------------------------------------------------------
  log('\n[1] Create Borrower')
  const borrower = buyers[0]
  const borrowerAddr = borrower.publicKey.toBase58()

  // fund borrower for tx fees
  try {
    const fundTx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: wallet.publicKey,
        toPubkey: borrower.publicKey,
        lamports: 1 * LAMPORTS_PER_SOL,
      }),
    )
    const { blockhash } = await connection.getLatestBlockhash()
    fundTx.recentBlockhash = blockhash
    fundTx.feePayer = wallet.publicKey
    await signAndSend(connection, wallet, fundTx)
  } catch {
    /* ignore */
  }

  try {
    const { getAssociatedTokenAddressSync } = require('@solana/spl-token')
    const T22 = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb')
    const ata = getAssociatedTokenAddressSync(new PublicKey(mint), borrower.publicKey, false, T22)
    const tokenBal = await connection.getTokenAccountBalance(ata)
    const totalTokens = Number(tokenBal.value.amount)
    const collateral = Math.floor(totalTokens * 0.6)

    const result = await buildBorrowTransaction(connection, {
      mint,
      borrower: borrowerAddr,
      collateral_amount: collateral,
      sol_to_borrow: 500_000_000, // 0.5 SOL
    })
    await signAndSend(connection, borrower, result.transaction)
    ok('create borrower', `collateral=${collateral} tokens, borrowed=0.5 SOL`)
  } catch (e: any) {
    fail('create borrower', e)
    console.error('Cannot test bot without a loan. Exiting.')
    process.exit(1)
  }

  // ------------------------------------------------------------------
  // 2. test scanner
  // ------------------------------------------------------------------
  log('\n[2] Scanner — Discover Lending Markets')
  const testLogger = new Logger('test', 'info')
  let tokens = new Map<string, MonitoredToken>()

  try {
    tokens = await scanForLendingMarkets(agent, tokens, 20, testLogger.child('scanner'))

    const found = tokens.get(mint)
    if (found) {
      ok(
        'scanner',
        `found ${tokens.size} tokens, our token has ${found.lendingInfo.active_loans ?? 'unknown'} active loans`,
      )
    } else {
      // on Surfpool fork, torchListTokens doesn't index local tokens.
      // build the MonitoredToken manually so we can test the other modules.
      log(
        '  note: torchListTokens does not index local fork tokens — building MonitoredToken directly',
      )

      const tokenDetail = await torchGetToken(agent, mint)
      const lending = await torchGetLendingInfo(agent, mint)
      const priceSol = tokenDetail.price_sol / SDK_LAMPORTS

      tokens.set(mint, {
        mint,
        name: tokenDetail.name,
        symbol: tokenDetail.symbol,
        lendingInfo: lending,
        priceSol,
        priceHistory: [priceSol],
        activeBorrowers: [],
        lastScanned: Date.now(),
      })

      ok(
        'scanner fallback',
        `built MonitoredToken for ${tokenDetail.symbol}, loans=${lending.active_loans ?? 'unknown'}`,
      )
    }
  } catch (e: any) {
    fail('scanner', e)
  }

  // ------------------------------------------------------------------
  // 3. test wallet profiler
  // ------------------------------------------------------------------
  log('\n[3] Wallet Profiler — Profile Borrower')
  const profiler = new WalletProfiler(testLogger.child('profiler'))

  try {
    const profile = await profiler.profile(agent, borrowerAddr, mint)

    if (profile.address !== borrowerAddr) throw new Error('Address mismatch')
    if (profile.riskScore < 0 || profile.riskScore > 100) {
      throw new Error(`Risk score out of range: ${profile.riskScore}`)
    }

    ok(
      'wallet profiler',
      [
        `verified=${profile.saidVerified}`,
        `tier=${profile.trustTier ?? 'none'}`,
        `trades=${profile.tradeStats.totalTrades}`,
        `winRate=${(profile.tradeStats.winRate * 100).toFixed(0)}%`,
        `risk=${profile.riskScore}`,
      ].join(' | '),
    )

    // test cache: second call should be instant
    const start = Date.now()
    const cached = await profiler.profile(agent, borrowerAddr, mint)
    const elapsed = Date.now() - start
    if (cached.address !== profile.address) throw new Error('Cache returned wrong profile')
    ok('profiler cache', `cached lookup in ${elapsed}ms`)
  } catch (e: any) {
    fail('wallet profiler', e)
  }

  // ------------------------------------------------------------------
  // 4. test risk scorer
  // ------------------------------------------------------------------
  log('\n[4] Risk Scorer — Score Loan Position')
  try {
    const token = tokens.get(mint)
    if (!token) throw new Error('Token not in monitored map')

    const position = await torchGetLoanPosition(agent, mint, borrowerAddr)
    if (position.health === 'none') throw new Error('Expected active loan')

    const profile = await profiler.profile(agent, borrowerAddr, mint)
    const scored = scoreLoan(token, borrowerAddr, position, profile)

    if (scored.riskScore < 0 || scored.riskScore > 100) {
      throw new Error(`Risk score out of range: ${scored.riskScore}`)
    }
    if (scored.estimatedProfitLamports < 0) {
      throw new Error(`Negative profit estimate: ${scored.estimatedProfitLamports}`)
    }

    ok(
      'risk scorer',
      [
        `risk=${scored.riskScore}`,
        `ltvProx=${scored.factors.ltvProximity}`,
        `momentum=${scored.factors.priceMomentum}`,
        `walletRisk=${scored.factors.walletRisk}`,
        `interest=${scored.factors.interestBurden}`,
        `profit=${(scored.estimatedProfitLamports / LAMPORTS_PER_SOL).toFixed(4)} SOL`,
      ].join(' | '),
    )

    // verify the position is healthy (should not be liquidatable with 0.5 SOL borrow)
    if (scored.position.health === 'healthy') {
      ok('health check', 'position is healthy as expected')
    } else {
      log(`  note: position health is ${scored.position.health}`)
    }
  } catch (e: any) {
    fail('risk scorer', e)
  }

  // ------------------------------------------------------------------
  // 5. test liquidator — should skip (position is healthy)
  // ------------------------------------------------------------------
  log('\n[5] Liquidator — Skip Healthy Position')
  try {
    const token = tokens.get(mint)!
    const position = await torchGetLoanPosition(agent, mint, borrowerAddr)
    const profile = await profiler.profile(agent, borrowerAddr, mint)
    const scored = scoreLoan(token, borrowerAddr, position, profile)

    const config: BotConfig = {
      agent,
      scanIntervalMs: 60000,
      scoreIntervalMs: 15000,
      minProfitLamports: 10_000_000, // 0.01 SOL
      riskThreshold: 60,
      priceHistoryDepth: 20,
      logLevel: 'info',
    }

    const liquidator = new Liquidator(config, testLogger.child('liquidator'))
    const result = await liquidator.tryLiquidate(agent, scored)

    if (result === null) {
      ok('liquidator skip', 'correctly skipped healthy position')
    } else {
      fail('liquidator skip', { message: 'Should not have liquidated a healthy position' })
    }
  } catch (e: any) {
    fail('liquidator', e)
  }

  // ------------------------------------------------------------------
  // 6. test price history tracking
  // ------------------------------------------------------------------
  log('\n[6] Price History Tracking')
  try {
    const token = tokens.get(mint)!
    const before = token.priceHistory.length

    // simulate a second price snapshot
    const tokenDetail = await torchGetToken(agent, mint)
    const newPrice = tokenDetail.price_sol / SDK_LAMPORTS
    token.priceHistory.push(newPrice)

    ok(
      'price history',
      `${before} -> ${token.priceHistory.length} snapshots, latest=${newPrice.toFixed(8)}`,
    )
  } catch (e: any) {
    fail('price history', e)
  }

  // ------------------------------------------------------------------
  // 7. verify lending info
  // ------------------------------------------------------------------
  log('\n[7] Verify Lending Info')
  try {
    const lending = await torchGetLendingInfo(agent, mint)

    if (lending.interest_rate_bps <= 0) throw new Error('Interest rate should be > 0')
    if (lending.liquidation_threshold_bps <= 0)
      throw new Error('Liquidation threshold should be > 0')
    if (lending.liquidation_bonus_bps <= 0) throw new Error('Liquidation bonus should be > 0')

    ok(
      'lending info',
      [
        `rate=${bpsToPercent(lending.interest_rate_bps)}`,
        `loans=${lending.active_loans ?? 'unknown'}`,
        `threshold=${bpsToPercent(lending.liquidation_threshold_bps)}`,
        `bonus=${bpsToPercent(lending.liquidation_bonus_bps)}`,
      ].join(' | '),
    )
  } catch (e: any) {
    fail('lending info', e)
  }

  // ------------------------------------------------------------------
  // 8. cleanup: repay the loan
  // ------------------------------------------------------------------
  log('\n[8] Cleanup — Repay Loan')
  try {
    const result = await buildRepayTransaction(connection, {
      mint,
      borrower: borrowerAddr,
      sol_amount: 600_000_000, // overpay to fully close
    })
    await signAndSend(connection, borrower, result.transaction)

    const pos = await torchGetLoanPosition(agent, mint, borrowerAddr)
    if (pos.health !== 'none') throw new Error(`Loan not closed: health=${pos.health}`)
    ok('repay + close', 'loan fully repaid')
  } catch (e: any) {
    fail('cleanup', e)
  }

  // ------------------------------------------------------------------
  // Summary
  // ------------------------------------------------------------------
  console.log('\n' + '='.repeat(60))
  console.log(`RESULTS: ${passed} passed, ${failed} failed`)
  console.log('='.repeat(60))

  if (failed > 0) process.exit(1)
}

main().catch((err) => {
  console.error('\nFATAL:', err)
  process.exit(1)
})
