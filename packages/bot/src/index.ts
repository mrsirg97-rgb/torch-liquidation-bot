#!/usr/bin/env node
/**
 * torch-lending-monitor
 *
 * multi-token liquidation bot that discovers lending markets, profiles
 * borrower wallets, predicts which loans will fail, and executes
 * profitable liquidations.
 *
 * modes:
 *   info      — display lending parameters for a token (or all tokens)
 *   watch     — monitor your own loan health in real-time
 *   bot       — run the full liquidation bot (default)
 *
 * usage:
 *   # show all migrated tokens with lending
 *   RPC_URL=<rpc> npx tsx src/index.ts
 *
 *   # show lending info for one token
 *   MODE=info MINT=<mint> RPC_URL=<rpc> npx tsx src/index.ts
 *
 *   # watch your loan health
 *   MODE=watch MINT=<mint> WALLET=<key> RPC_URL=<rpc> npx tsx src/index.ts
 *
 *   # run the liquidation bot
 *   MODE=bot WALLET=<key> RPC_URL=<rpc> npx tsx src/index.ts
 */

import { Connection, Keypair, sendAndConfirmTransaction } from '@solana/web3.js'
import bs58 from 'bs58'
import {
  getToken,
  getTokens,
  getLendingInfo,
  getLoanPosition,
  buildRepayTransaction,
  confirmTransaction,
  type LendingInfo,
  type LoanPositionInfo,
} from 'torchsdk'
import { Monitor } from './monitor'
import { loadConfig } from './config'
import { sol, bpsToPercent, sleep } from './utils'

// ---------------------------------------------------------------------------
// helpers for info/watch modes (don't need full config)
// ---------------------------------------------------------------------------

function loadWallet(): Keypair {
  const key = process.env.WALLET
  if (!key) throw new Error('Set WALLET env var to a base58-encoded private key')
  return Keypair.fromSecretKey(bs58.decode(key))
}

// ---------------------------------------------------------------------------
// mode: info
// ---------------------------------------------------------------------------

async function showLendingInfo(connection: Connection, mint: string) {
  const token = await getToken(connection, mint)
  const lending: LendingInfo = await getLendingInfo(connection, mint)

  console.log(`\n=== lending info: ${token.name} (${token.symbol}) ===`)
  console.log(`status:                ${token.status}`)
  console.log(`token price:           ${sol(token.price_sol)} SOL`)
  console.log(`interest rate:         ${bpsToPercent(lending.interest_rate_bps)}`)
  console.log(`max LTV:               ${bpsToPercent(lending.max_ltv_bps)}`)
  console.log(`liquidation threshold: ${bpsToPercent(lending.liquidation_threshold_bps)}`)
  console.log(`liquidation bonus:     ${bpsToPercent(lending.liquidation_bonus_bps)}`)
  console.log(`treasury SOL avail:    ${sol(lending.treasury_sol_available)} SOL`)
  console.log(`total SOL lent:        ${sol(lending.total_sol_lent)} SOL`)
  console.log(`active loans:          ${lending.active_loans}`)
}

async function showAllLending(connection: Connection) {
  console.log('=== torch lending monitor ===\n')
  console.log('no MINT specified — showing all migrated tokens with lending\n')

  const { tokens } = await getTokens(connection, {
    status: 'migrated',
    sort: 'volume',
    limit: 10,
  })

  for (const t of tokens) {
    try {
      const lending = await getLendingInfo(connection, t.mint)
      console.log(
        `${t.symbol.padEnd(10)} | ` +
          `rate: ${bpsToPercent(lending.interest_rate_bps).padEnd(7)} | ` +
          `loans: ${String(lending.active_loans).padEnd(4)} | ` +
          `avail: ${sol(lending.treasury_sol_available)} SOL`,
      )
    } catch {
      // token may not have lending enabled yet
    }
  }
}

// ---------------------------------------------------------------------------
// mode: watch
// ---------------------------------------------------------------------------

async function watchPosition(connection: Connection, mint: string, wallet: Keypair) {
  const pollMs = Number(process.env.POLL_INTERVAL_MS ?? '15000')

  console.log(`\n=== watching loan: ${wallet.publicKey.toBase58()} ===`)
  console.log(`mint: ${mint}\n`)

  while (true) {
    const pos: LoanPositionInfo = await getLoanPosition(
      connection,
      mint,
      wallet.publicKey.toBase58(),
    )

    if (pos.health === 'none') {
      console.log(`[${new Date().toISOString()}] no active loan`)
    } else {
      const healthColor =
        pos.health === 'healthy' ? 'OK' : pos.health === 'at_risk' ? 'WARNING' : 'DANGER'

      console.log(`[${new Date().toISOString()}] health: ${healthColor} (${pos.health})`)
      console.log(`  collateral:    ${pos.collateral_amount} tokens`)
      console.log(`  collat value:  ${sol(pos.collateral_value_sol)} SOL`)
      console.log(`  borrowed:      ${sol(pos.borrowed_amount)} SOL`)
      console.log(`  interest:      ${sol(pos.accrued_interest)} SOL`)
      console.log(`  total owed:    ${sol(pos.total_owed)} SOL`)
      console.log(`  current LTV:   ${bpsToPercent(pos.current_ltv_bps)}`)

      if (pos.health === 'at_risk') {
        console.log('  --> consider adding collateral or repaying to avoid liquidation')
      }
      if (pos.health === 'liquidatable') {
        console.log('  --> your position can be liquidated! repay immediately')

        if (process.env.AUTO_REPAY === 'true') {
          console.log('  --> auto-repaying...')
          const { transaction, message } = await buildRepayTransaction(connection, {
            mint,
            borrower: wallet.publicKey.toBase58(),
            sol_amount: pos.total_owed,
          })
          console.log(`  tx: ${message}`)
          const sig = await sendAndConfirmTransaction(connection, transaction, [wallet])
          console.log(`  confirmed: ${sig}`)
          const result = await confirmTransaction(connection, sig, wallet.publicKey.toBase58())
          console.log(`  SAID event: ${result.event_type}`)
        }
      }
    }

    await sleep(pollMs)
  }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  const MODE = process.env.MODE ?? 'bot'
  const MINT = process.env.MINT
  const RPC_URL = process.env.RPC_URL ?? 'https://api.mainnet-beta.solana.com'

  // info mode: no wallet needed
  if (MODE === 'info') {
    const connection = new Connection(RPC_URL, 'confirmed')
    if (MINT) {
      await showLendingInfo(connection, MINT)
    } else {
      await showAllLending(connection)
    }
    return
  }

  // watch mode: single token + wallet
  if (MODE === 'watch') {
    if (!MINT) throw new Error('MINT env var required for watch mode')
    const connection = new Connection(RPC_URL, 'confirmed')
    await watchPosition(connection, MINT, loadWallet())
    return
  }

  // bot mode: full liquidation bot
  if (MODE === 'bot') {
    const config = loadConfig()
    const connection = new Connection(config.rpcUrl, 'confirmed')
    const monitor = new Monitor(connection, config)

    // graceful shutdown
    process.on('SIGINT', () => {
      monitor.stop()
      process.exit(0)
    })

    await monitor.start()
    return
  }

  console.error(`unknown MODE: ${MODE}. use info | watch | bot`)
  process.exit(1)
}

main()
