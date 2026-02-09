/**
 * liquidator.ts — executes liquidation transactions.
 *
 * receives a target, calculates expected profit, builds the tx,
 * signs and sends it, then confirms via SAID for reputation.
 */

import { type Connection, type Keypair, sendAndConfirmTransaction } from '@solana/web3.js'
import { buildLiquidateTransaction, confirmTransaction } from 'torchsdk'
import type { ScoredLoan, LiquidationResult, BotConfig } from './types'
import type { Logger } from './logger'
import { sol } from './utils'

export class Liquidator {
  private log: Logger
  private wallet: Keypair
  private minProfitLamports: number

  constructor(config: BotConfig, log: Logger) {
    this.wallet = config.walletKeypair
    this.minProfitLamports = config.minProfitLamports
    this.log = log
  }

  async tryLiquidate(
    connection: Connection,
    loan: ScoredLoan,
  ): Promise<LiquidationResult | null> {
    if (loan.position.health !== 'liquidatable') {
      this.log.debug(`skipping ${loan.borrower.slice(0, 8)}... — not liquidatable yet`)
      return null
    }

    if (loan.estimatedProfitLamports < this.minProfitLamports) {
      this.log.debug(`skipping ${loan.borrower.slice(0, 8)}... — profit too low`, {
        expected: sol(loan.estimatedProfitLamports),
        minimum: sol(this.minProfitLamports),
      })
      return null
    }

    this.log.info(`liquidating ${loan.borrower.slice(0, 8)}...`, {
      token: loan.tokenName,
      profit: `${sol(loan.estimatedProfitLamports)} SOL`,
      risk: loan.riskScore,
    })

    try {
      const { transaction, message } = await buildLiquidateTransaction(connection, {
        mint: loan.mint,
        liquidator: this.wallet.publicKey.toBase58(),
        borrower: loan.borrower,
      })

      this.log.debug(`tx built: ${message}`)

      const signature = await sendAndConfirmTransaction(connection, transaction, [this.wallet])
      this.log.info(`liquidation confirmed`, { sig: signature })

      // confirm via SAID for reputation
      let confirmed = false
      try {
        const result = await confirmTransaction(
          connection,
          signature,
          this.wallet.publicKey.toBase58(),
        )
        confirmed = result.confirmed
        this.log.debug(`SAID confirmation`, { event: result.event_type })
      } catch {
        this.log.warn('SAID confirmation failed — tx still went through')
      }

      return {
        mint: loan.mint,
        borrower: loan.borrower,
        signature,
        profitLamports: loan.estimatedProfitLamports,
        timestamp: Date.now(),
        confirmed,
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      this.log.error(`liquidation failed for ${loan.borrower.slice(0, 8)}...`, { error: msg })
      return null
    }
  }
}
