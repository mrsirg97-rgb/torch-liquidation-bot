/**
 * Lending Monitor E2E Test — Surfpool (mainnet fork)
 *
 * Simulates the lending-monitor's functionality:
 *   1. Create a token (setup)
 *   2. Bond to completion with multiple wallets
 *   3. Migrate to Raydium DEX
 *   4. Get lending info (rates, LTV, available SOL)
 *   5. Borrow SOL against token collateral
 *   6. Get loan position / watch health
 *   7. Repay the loan
 *   8. Verify position is closed
 *
 * Run:
 *   surfpool start --network mainnet --no-tui
 *   npx tsx tests/test_lending.ts
 */

import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js'
import {
  getToken,
  buildCreateTokenTransaction,
  buildBuyTransaction,
  getLendingInfo,
  getLoanPosition,
  buildBorrowTransaction,
  buildRepayTransaction,
  buildLiquidateTransaction,
  confirmTransaction,
} from 'torchsdk'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

// ============================================================================
// Config
// ============================================================================

const RPC_URL = 'http://localhost:8899'
const WALLET_PATH = path.join(os.homedir(), '.config/solana/id.json')

const loadWallet = (): Keypair => {
  const raw = JSON.parse(fs.readFileSync(WALLET_PATH, 'utf-8'))
  return Keypair.fromSecretKey(Uint8Array.from(raw))
}

const log = (msg: string) => {
  const ts = new Date().toISOString().substr(11, 8)
  console.log(`[${ts}] ${msg}`)
}

const signAndSend = async (
  connection: Connection,
  wallet: Keypair,
  tx: Transaction,
): Promise<string> => {
  tx.partialSign(wallet)
  const sig = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    preflightCommitment: 'confirmed',
  })
  await connection.confirmTransaction(sig, 'confirmed')
  return sig
}

const bpsToPercent = (bps: number): string => (bps / 100).toFixed(2) + '%'

// ============================================================================
// Main
// ============================================================================

const main = async () => {
  console.log('='.repeat(60))
  console.log('LENDING MONITOR TEST — Surfpool Mainnet Fork')
  console.log('='.repeat(60))

  const connection = new Connection(RPC_URL, 'confirmed')
  const wallet = loadWallet()
  const walletAddr = wallet.publicKey.toBase58()

  log(`Wallet: ${walletAddr}`)
  const balance = await connection.getBalance(wallet.publicKey)
  log(`Balance: ${balance / LAMPORTS_PER_SOL} SOL`)

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

  // ------------------------------------------------------------------
  // 1. Create Token
  // ------------------------------------------------------------------
  log('\n[1] Create Token')
  let mint: string
  try {
    const result = await buildCreateTokenTransaction(connection, {
      creator: walletAddr,
      name: 'Lending Test Token',
      symbol: 'LEND',
      metadata_uri: 'https://example.com/lend.json',
    })
    const sig = await signAndSend(connection, wallet, result.transaction)
    mint = result.mint.toBase58()
    ok('create token', `mint=${mint.slice(0, 8)}... sig=${sig.slice(0, 8)}...`)
  } catch (e: any) {
    fail('create token', e)
    console.error('Cannot continue without token. Exiting.')
    process.exit(1)
  }

  // ------------------------------------------------------------------
  // 2. Bond to Completion (requires multiple wallets due to 2% cap)
  // ------------------------------------------------------------------
  log('\n[2] Bond to Completion')
  log('  Generating and funding buyer wallets...')

  const NUM_BUYERS = 60
  const BUY_AMOUNT = 5 * LAMPORTS_PER_SOL
  const buyers: Keypair[] = []
  for (let i = 0; i < NUM_BUYERS; i++) buyers.push(Keypair.generate())

  // Fund in batches of 10
  for (let i = 0; i < buyers.length; i += 10) {
    const batch = buyers.slice(i, i + 10)
    const fundTx = new Transaction()
    for (const b of batch) {
      fundTx.add(
        SystemProgram.transfer({
          fromPubkey: wallet.publicKey,
          toPubkey: b.publicKey,
          lamports: BUY_AMOUNT + 0.1 * LAMPORTS_PER_SOL,
        }),
      )
    }
    const { blockhash } = await connection.getLatestBlockhash()
    fundTx.recentBlockhash = blockhash
    fundTx.feePayer = wallet.publicKey
    await signAndSend(connection, wallet, fundTx)
  }
  log(`  Funded ${buyers.length} wallets with ${BUY_AMOUNT / LAMPORTS_PER_SOL} SOL each`)

  let bondingComplete = false
  let buyCount = 0
  for (const buyer of buyers) {
    if (bondingComplete) break
    try {
      const result = await buildBuyTransaction(connection, {
        mint,
        buyer: buyer.publicKey.toBase58(),
        amount_sol: BUY_AMOUNT,
        slippage_bps: 1000,
        vote: Math.random() > 0.5 ? 'burn' : 'return',
      })
      await signAndSend(connection, buyer, result.transaction)
      buyCount++

      if (buyCount % 10 === 0) {
        const detail = await getToken(connection, mint)
        log(
          `  Buy ${buyCount}: ${detail.progress_percent.toFixed(1)}% (${detail.sol_raised.toFixed(1)} SOL)`,
        )
        if (detail.status !== 'bonding') bondingComplete = true
      }
    } catch (e: any) {
      if (
        e.message?.includes('Bonding curve complete') ||
        e.message?.includes('bonding_complete') ||
        e.message?.includes('BondingComplete')
      ) {
        bondingComplete = true
      } else {
        log(`  Buy ${buyCount + 1} skipped: ${e.message?.substring(0, 80)}`)
      }
    }
  }

  // Check final status
  try {
    const detail = await getToken(connection, mint)
    if (detail.status !== 'bonding') bondingComplete = true
    log(
      `  Final: ${detail.progress_percent.toFixed(1)}% (${detail.sol_raised.toFixed(1)} SOL) status=${detail.status}`,
    )
  } catch {
    /* ignore */
  }

  if (bondingComplete) {
    ok('bonding complete', `after ${buyCount} buys`)
  } else {
    fail('bonding', { message: `Only ${buyCount} buys, not complete` })
    console.error('Cannot test lending without migration. Exiting.')
    process.exit(1)
  }

  // ------------------------------------------------------------------
  // 3. Migrate to Raydium DEX
  // ------------------------------------------------------------------
  log('\n[3] Migrate to Raydium DEX')
  try {
    const anchor = require('@coral-xyz/anchor')
    const {
      TOKEN_PROGRAM_ID,
      TOKEN_2022_PROGRAM_ID: T22,
      ASSOCIATED_TOKEN_PROGRAM_ID: ATP,
      getAssociatedTokenAddressSync,
      createAssociatedTokenAccountInstruction,
      createSyncNativeInstruction,
    } = require('@solana/spl-token')

    const idl = require('torchsdk/dist/torch_market.json')
    const PROGRAM_ID = new PublicKey('8hbUkonssSEEtkqzwM7ZcZrD9evacM92TcWSooVF4BeT')
    const RAYDIUM_CPMM = new PublicKey('CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C')
    const RAYDIUM_AMM_CONFIG = new PublicKey('D4FPEruKEHrG5TenZ2mpDGEfu1iUvTiqBxvpU8HLBvC2')
    const RAYDIUM_FEE_RECEIVER = new PublicKey('DNXgeM9EiiaAbaWvwjHj9fQQLAX5ZsfHyvmYUNRAdNC8')
    const WSOL_MINT = new PublicKey('So11111111111111111111111111111111111111112')

    const dummyWallet = {
      publicKey: wallet.publicKey,
      signTransaction: async (t: Transaction) => {
        t.partialSign(wallet)
        return t
      },
      signAllTransactions: async (ts: Transaction[]) => {
        ts.forEach((t) => t.partialSign(wallet))
        return ts
      },
    }
    const provider = new anchor.AnchorProvider(connection, dummyWallet, {})
    const program = new anchor.Program(idl, provider)

    const mintPk = new PublicKey(mint)
    const [globalConfig] = PublicKey.findProgramAddressSync(
      [Buffer.from('global_config')],
      PROGRAM_ID,
    )
    const [bondingCurvePda] = PublicKey.findProgramAddressSync(
      [Buffer.from('bonding_curve'), mintPk.toBuffer()],
      PROGRAM_ID,
    )
    const [treasuryPda] = PublicKey.findProgramAddressSync(
      [Buffer.from('treasury'), mintPk.toBuffer()],
      PROGRAM_ID,
    )

    const [bcAta] = PublicKey.findProgramAddressSync(
      [bondingCurvePda.toBuffer(), T22.toBuffer(), mintPk.toBuffer()],
      ATP,
    )
    const [treasuryAta] = PublicKey.findProgramAddressSync(
      [treasuryPda.toBuffer(), T22.toBuffer(), mintPk.toBuffer()],
      ATP,
    )

    const isWsolToken0 = WSOL_MINT.toBuffer().compare(mintPk.toBuffer()) < 0
    const token0 = isWsolToken0 ? WSOL_MINT : mintPk
    const token1 = isWsolToken0 ? mintPk : WSOL_MINT
    const [raydiumAuth] = PublicKey.findProgramAddressSync(
      [Buffer.from('vault_and_lp_mint_auth_seed')],
      RAYDIUM_CPMM,
    )
    const [poolState] = PublicKey.findProgramAddressSync(
      [Buffer.from('pool'), RAYDIUM_AMM_CONFIG.toBuffer(), token0.toBuffer(), token1.toBuffer()],
      RAYDIUM_CPMM,
    )
    const [lpMint] = PublicKey.findProgramAddressSync(
      [Buffer.from('pool_lp_mint'), poolState.toBuffer()],
      RAYDIUM_CPMM,
    )
    const [obs] = PublicKey.findProgramAddressSync(
      [Buffer.from('observation'), poolState.toBuffer()],
      RAYDIUM_CPMM,
    )
    const [vault0] = PublicKey.findProgramAddressSync(
      [Buffer.from('pool_vault'), poolState.toBuffer(), token0.toBuffer()],
      RAYDIUM_CPMM,
    )
    const [vault1] = PublicKey.findProgramAddressSync(
      [Buffer.from('pool_vault'), poolState.toBuffer(), token1.toBuffer()],
      RAYDIUM_CPMM,
    )

    const payerWsol = getAssociatedTokenAddressSync(WSOL_MINT, wallet.publicKey)
    const [payerToken] = PublicKey.findProgramAddressSync(
      [wallet.publicKey.toBuffer(), T22.toBuffer(), mintPk.toBuffer()],
      ATP,
    )
    const payerLp = getAssociatedTokenAddressSync(lpMint, wallet.publicKey)

    // Create WSOL ATA
    try {
      const tx = new Transaction().add(
        createAssociatedTokenAccountInstruction(
          wallet.publicKey,
          payerWsol,
          wallet.publicKey,
          WSOL_MINT,
          TOKEN_PROGRAM_ID,
          ATP,
        ),
      )
      await provider.sendAndConfirm(tx)
    } catch {
      /* exists */
    }

    // Fund WSOL ATA
    const fundTx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: wallet.publicKey,
        toPubkey: payerWsol,
        lamports: 250 * LAMPORTS_PER_SOL,
      }),
      createSyncNativeInstruction(payerWsol, TOKEN_PROGRAM_ID),
    )
    await provider.sendAndConfirm(fundTx)

    // Create payer Token-2022 ATA
    try {
      const tx = new Transaction().add(
        createAssociatedTokenAccountInstruction(
          wallet.publicKey,
          payerToken,
          wallet.publicKey,
          mintPk,
          T22,
          ATP,
        ),
      )
      await provider.sendAndConfirm(tx)
    } catch {
      /* exists */
    }

    const { ComputeBudgetProgram } = require('@solana/web3.js')
    const migrateIx = await program.methods
      .migrateToDex()
      .accounts({
        payer: wallet.publicKey,
        globalConfig,
        mint: mintPk,
        bondingCurve: bondingCurvePda,
        treasury: treasuryPda,
        tokenVault: bcAta,
        treasuryTokenAccount: treasuryAta,
        payerWsol,
        payerToken,
        raydiumProgram: RAYDIUM_CPMM,
        ammConfig: RAYDIUM_AMM_CONFIG,
        raydiumAuthority: raydiumAuth,
        poolState,
        wsolMint: WSOL_MINT,
        token0Vault: vault0,
        token1Vault: vault1,
        lpMint,
        payerLpToken: payerLp,
        observationState: obs,
        createPoolFee: RAYDIUM_FEE_RECEIVER,
        tokenProgram: TOKEN_PROGRAM_ID,
        token2022Program: T22,
        associatedTokenProgram: ATP,
        systemProgram: SystemProgram.programId,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .instruction()

    const migrateTx = new Transaction()
      .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }))
      .add(migrateIx)
    await provider.sendAndConfirm(migrateTx)

    ok('migrate to DEX', 'Raydium pool created')
  } catch (e: any) {
    fail('migrate to DEX', e)
    if (e.logs) console.error('  Logs:', e.logs.slice(-5).join('\n        '))
    console.error('Cannot test lending without migration. Exiting.')
    process.exit(1)
  }

  // ------------------------------------------------------------------
  // 4. Get Lending Info
  //    (Simulates: showLendingInfo)
  // ------------------------------------------------------------------
  log('\n[4] Get Lending Info')
  try {
    const lending = await getLendingInfo(connection, mint)

    if (lending.interest_rate_bps <= 0) throw new Error('Interest rate should be > 0')
    if (lending.max_ltv_bps <= 0) throw new Error('Max LTV should be > 0')
    if (lending.treasury_sol_available <= 0)
      throw new Error('Treasury should have SOL after migration')

    ok(
      'getLendingInfo',
      `rate=${bpsToPercent(lending.interest_rate_bps)} | maxLTV=${bpsToPercent(lending.max_ltv_bps)} | liqThreshold=${bpsToPercent(lending.liquidation_threshold_bps)} | avail=${(lending.treasury_sol_available / LAMPORTS_PER_SOL).toFixed(2)} SOL | loans=${lending.active_loans}`,
    )
  } catch (e: any) {
    fail('getLendingInfo', e)
  }

  // ------------------------------------------------------------------
  // 5. Borrow SOL against token collateral
  //    (Simulates: buildBorrowTransaction from the monitor)
  // ------------------------------------------------------------------
  log('\n[5] Borrow SOL')
  const borrowerWallet = buyers[0]
  const borrowerAddr = borrowerWallet.publicKey.toBase58()

  // Fund borrower with extra SOL for tx fees
  try {
    const extraFundTx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: wallet.publicKey,
        toPubkey: borrowerWallet.publicKey,
        lamports: 1 * LAMPORTS_PER_SOL,
      }),
    )
    const { blockhash } = await connection.getLatestBlockhash()
    extraFundTx.recentBlockhash = blockhash
    extraFundTx.feePayer = wallet.publicKey
    await signAndSend(connection, wallet, extraFundTx)
  } catch {
    /* ignore */
  }

  let borrowSig: string | undefined
  try {
    const { getAssociatedTokenAddressSync: gata } = require('@solana/spl-token')
    const TOKEN_2022 = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb')
    const borrowerAta = gata(new PublicKey(mint), borrowerWallet.publicKey, false, TOKEN_2022)
    const tokenBal = await connection.getTokenAccountBalance(borrowerAta)
    const totalTokens = Number(tokenBal.value.amount)
    log(`  Borrower token balance: ${(totalTokens / 1e6).toFixed(0)} tokens`)

    // Use 60% of tokens as collateral, borrow 0.5 SOL
    const collateralAmount = Math.floor(totalTokens * 0.6)

    const result = await buildBorrowTransaction(connection, {
      mint,
      borrower: borrowerAddr,
      collateral_amount: collateralAmount,
      sol_to_borrow: 500_000_000, // 0.5 SOL
    })
    borrowSig = await signAndSend(connection, borrowerWallet, result.transaction)
    ok('borrow', `${result.message} sig=${borrowSig.slice(0, 8)}...`)
  } catch (e: any) {
    fail('borrow', e)
  }

  // ------------------------------------------------------------------
  // 6. Watch Loan Position / Health
  //    (Simulates: watchPosition → getLoanPosition)
  // ------------------------------------------------------------------
  log('\n[6] Watch Loan Position')
  try {
    const pos = await getLoanPosition(connection, mint, borrowerAddr)

    if (pos.health === 'none') throw new Error('Expected active loan')
    if (pos.borrowed_amount <= 0) throw new Error('Expected borrowed amount > 0')
    if (pos.collateral_amount <= 0) throw new Error('Expected collateral > 0')

    ok(
      'getLoanPosition',
      `health=${pos.health} | collateral=${pos.collateral_amount} tokens | borrowed=${(pos.borrowed_amount / LAMPORTS_PER_SOL).toFixed(4)} SOL | owed=${(pos.total_owed / LAMPORTS_PER_SOL).toFixed(4)} SOL | LTV=${bpsToPercent(pos.current_ltv_bps)}`,
    )
  } catch (e: any) {
    fail('getLoanPosition', e)
  }

  // ------------------------------------------------------------------
  // 7. Confirm Borrow via SAID
  // ------------------------------------------------------------------
  log('\n[7] Confirm Borrow (SAID)')
  if (borrowSig) {
    try {
      const result = await confirmTransaction(connection, borrowSig, borrowerAddr)
      if (!result.confirmed) throw new Error('Not confirmed')
      ok('confirm borrow', `event=${result.event_type}`)
    } catch (e: any) {
      fail('confirm borrow', e)
    }
  } else {
    fail('confirm borrow', { message: 'No borrow sig' })
  }

  // ------------------------------------------------------------------
  // 8. Repay the Loan
  //    (Simulates: auto-repay from watchPosition)
  // ------------------------------------------------------------------
  log('\n[8] Repay Loan')
  try {
    const result = await buildRepayTransaction(connection, {
      mint,
      borrower: borrowerAddr,
      sol_amount: 600_000_000, // 0.6 SOL (overpay to fully close)
    })
    const sig = await signAndSend(connection, borrowerWallet, result.transaction)
    ok('repay', `${result.message} sig=${sig.slice(0, 8)}...`)
  } catch (e: any) {
    fail('repay', e)
  }

  // ------------------------------------------------------------------
  // 9. Verify Position Closed
  // ------------------------------------------------------------------
  log('\n[9] Verify Position Closed')
  try {
    const pos = await getLoanPosition(connection, mint, borrowerAddr)
    if (pos.health !== 'none') throw new Error(`Expected no loan, got health=${pos.health}`)
    ok('position closed', `health=${pos.health}`)
  } catch (e: any) {
    fail('position closed', e)
  }

  // ------------------------------------------------------------------
  // 10. Liquidation Path (verify the API works — no actual underwater position)
  //     (Simulates: runLiquidator scanning for liquidatable positions)
  // ------------------------------------------------------------------
  log('\n[10] Liquidation Check (no underwater positions expected)')
  try {
    // The borrower just repaid, so re-checking should show no loan
    const pos = await getLoanPosition(connection, mint, borrowerAddr)
    if (pos.health === 'liquidatable') {
      // This shouldn't happen after repay, but test the path
      log('  Found liquidatable position — attempting liquidation...')
      const result = await buildLiquidateTransaction(connection, {
        mint,
        liquidator: walletAddr,
        borrower: borrowerAddr,
      })
      const sig = await signAndSend(connection, wallet, result.transaction)
      ok('liquidation', `sig=${sig.slice(0, 8)}...`)
    } else {
      ok('liquidation check', `no underwater positions (health=${pos.health})`)
    }
  } catch (e: any) {
    fail('liquidation check', e)
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
