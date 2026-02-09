#!/usr/bin/env node
/**
 * torch-liquidation-agent
 *
 * multi-token liquidation bot that discovers lending markets, profiles
 * borrower wallets, predicts which loans will fail, and executes
 * profitable liquidations.
 *
 * built on solana-agent-kit + solana-agent-kit-torch-market.
 *
 * modes:
 *   info      — display lending parameters for a token (or all tokens) (default)
 *   watch     — monitor your own loan health in real-time
 *   bot       — run the full liquidation bot
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

import { Keypair } from '@solana/web3.js'
import { SolanaAgentKit, KeypairWallet } from 'solana-agent-kit'
import bs58 from 'bs58'
import {
  torchGetToken,
  torchListTokens,
  torchGetLendingInfo,
  torchGetLoanPosition,
  torchRepayLoan,
  torchConfirm,
  type TorchLendingInfo,
  type TorchLoanPosition,
} from 'solana-agent-kit-torch-market'
import { Monitor } from './monitor'
import { loadConfig } from './config'
import { sol, bpsToPercent, sleep } from './utils'

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function createAgent(rpcUrl: string, walletKey?: string): SolanaAgentKit {
  const keypair = walletKey ? Keypair.fromSecretKey(bs58.decode(walletKey)) : Keypair.generate() // dummy keypair for read-only modes
  const wallet = new KeypairWallet(keypair, rpcUrl)
  return new SolanaAgentKit(wallet, rpcUrl, {})
}

// ---------------------------------------------------------------------------
// mode: info
// ---------------------------------------------------------------------------

async function showLendingInfo(agent: SolanaAgentKit, mint: string) {
  const token = await torchGetToken(agent, mint)
  const lending: TorchLendingInfo = await torchGetLendingInfo(agent, mint)

  console.log(`\n=== lending info: ${token.name} (${token.symbol}) ===`)
  console.log(`status:                ${token.status}`)
  console.log(`token price:           ${sol(token.price_sol)} SOL`)
  console.log(`interest rate:         ${bpsToPercent(lending.interest_rate_bps)}`)
  console.log(`max LTV:               ${bpsToPercent(lending.max_ltv_bps)}`)
  console.log(`liquidation threshold: ${bpsToPercent(lending.liquidation_threshold_bps)}`)
  console.log(`liquidation bonus:     ${bpsToPercent(lending.liquidation_bonus_bps)}`)
  console.log(`treasury SOL avail:    ${sol(lending.treasury_sol_available)} SOL`)
  console.log(
    `total SOL lent:        ${lending.total_sol_lent != null ? sol(lending.total_sol_lent) + ' SOL' : 'unknown'}`,
  )
  console.log(`active loans:          ${lending.active_loans ?? 'unknown'}`)
}

async function showAllLending(agent: SolanaAgentKit) {
  console.log('=== torch lending agent ===\n')
  console.log('no MINT specified — showing all migrated tokens with lending\n')

  const tokens = await torchListTokens(agent, 'migrated', 'volume', 10)

  for (const t of tokens) {
    try {
      const lending = await torchGetLendingInfo(agent, t.mint)
      console.log(
        `${t.symbol.padEnd(10)} | ` +
          `rate: ${bpsToPercent(lending.interest_rate_bps).padEnd(7)} | ` +
          `loans: ${String(lending.active_loans ?? '?').padEnd(4)} | ` +
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

async function watchPosition(agent: SolanaAgentKit, mint: string) {
  const pollMs = Number(process.env.POLL_INTERVAL_MS ?? '15000')
  const walletAddr = agent.wallet.publicKey.toBase58()

  console.log(`\n=== watching loan: ${walletAddr} ===`)
  console.log(`mint: ${mint}\n`)

  while (true) {
    const pos: TorchLoanPosition = await torchGetLoanPosition(agent, mint, walletAddr)

    if (pos.health === 'none') {
      console.log(`[${new Date().toISOString()}] no active loan`)
    } else {
      const healthColor =
        pos.health === 'healthy' ? 'OK' : pos.health === 'at_risk' ? 'WARNING' : 'DANGER'

      console.log(`[${new Date().toISOString()}] health: ${healthColor} (${pos.health})`)
      console.log(`  collateral:    ${pos.collateral_amount} tokens`)
      console.log(`  collat value:  ${sol(pos.collateral_value_sol ?? 0)} SOL`)
      console.log(`  borrowed:      ${sol(pos.borrowed_amount)} SOL`)
      console.log(`  interest:      ${sol(pos.accrued_interest)} SOL`)
      console.log(`  total owed:    ${sol(pos.total_owed)} SOL`)
      console.log(`  current LTV:   ${bpsToPercent(pos.current_ltv_bps ?? 0)}`)

      if (pos.health === 'at_risk') {
        console.log('  --> consider adding collateral or repaying to avoid liquidation')
      }
      if (pos.health === 'liquidatable') {
        console.log('  --> your position can be liquidated! repay immediately')

        if (process.env.AUTO_REPAY === 'true') {
          console.log('  --> auto-repaying...')
          const result = await torchRepayLoan(agent, mint, pos.total_owed)
          const sig = typeof result === 'string' ? result : 'unknown'
          console.log(`  confirmed: ${sig}`)

          try {
            const confirmResult = await torchConfirm(agent, sig)
            console.log(`  SAID event: ${confirmResult.event_type}`)
          } catch {
            console.log('  SAID confirmation failed — tx still went through')
          }
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
  const MODE = process.env.MODE ?? 'info'
  const MINT = process.env.MINT
  const RPC_URL = process.env.RPC_URL ?? 'https://api.mainnet-beta.solana.com'

  // info mode: no wallet needed
  if (MODE === 'info') {
    const agent = createAgent(RPC_URL)
    if (MINT) {
      await showLendingInfo(agent, MINT)
    } else {
      await showAllLending(agent)
    }
    return
  }

  // watch mode: single token + wallet
  if (MODE === 'watch') {
    if (!MINT) throw new Error('MINT env var required for watch mode')
    const walletKey = process.env.WALLET
    if (!walletKey) throw new Error('Set WALLET env var to a base58-encoded private key')
    const agent = createAgent(RPC_URL, walletKey)
    await watchPosition(agent, MINT)
    return
  }

  // bot mode: full liquidation bot
  if (MODE === 'bot') {
    const config = loadConfig()
    const monitor = new Monitor(config)

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
