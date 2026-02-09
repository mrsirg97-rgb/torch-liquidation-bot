/**
 * liquidator.ts — executes liquidation transactions.
 *
 * receives a target, calculates expected profit, calls the agent kit
 * to sign + send the liquidation tx, then confirms via SAID for reputation.
 */

import type { SolanaAgentKit } from 'solana-agent-kit'
import { torchLiquidateLoan, torchConfirm } from 'solana-agent-kit-torch-market'
import type { ScoredLoan, LiquidationResult, BotConfig } from './types'
import type { Logger } from './logger'
import { sol } from './utils'

export class Liquidator {
  private log: Logger
  private minProfitLamports: number

  constructor(config: BotConfig, log: Logger) {
    this.minProfitLamports = config.minProfitLamports
    this.log = log
  }

  async tryLiquidate(agent: SolanaAgentKit, loan: ScoredLoan): Promise<LiquidationResult | null> {
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
      const result = await torchLiquidateLoan(agent, loan.mint, loan.borrower)
      const signature = typeof result === 'string' ? result : 'unknown'

      this.log.info(`liquidation confirmed`, { sig: signature })

      // confirm via SAID for reputation
      let confirmed = false
      try {
        const confirmResult = await torchConfirm(agent, signature)
        confirmed = confirmResult.confirmed
        this.log.debug(`SAID confirmation`, { event: confirmResult.event_type })
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
