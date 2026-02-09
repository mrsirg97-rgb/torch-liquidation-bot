/**
 * monitor.ts — main orchestration loop.
 *
 * two loops running on intervals:
 *   1. scan loop: discover tokens with active lending
 *   2. score loop: profile borrowers, score loans, execute liquidations
 */

import type { Connection } from '@solana/web3.js'
import { getHolders, getLoanPosition } from 'torchsdk'
import type { BotConfig, MonitoredToken, ScoredLoan } from './types'
import { Logger } from './logger'
import { WalletProfiler } from './wallet-profiler'
import { Liquidator } from './liquidator'
import { scanForLendingMarkets } from './scanner'
import { scoreLoan } from './risk-scorer'
import { sleep, sol, bpsToPercent } from './utils'

export class Monitor {
  private connection: Connection
  private config: BotConfig
  private log: Logger
  private profiler: WalletProfiler
  private liquidator: Liquidator
  private tokens = new Map<string, MonitoredToken>()
  private running = false

  constructor(connection: Connection, config: BotConfig) {
    this.connection = connection
    this.config = config
    this.log = new Logger('monitor', config.logLevel)
    this.profiler = new WalletProfiler(this.log.child('profiler'))
    this.liquidator = new Liquidator(config, this.log.child('liquidator'))
  }

  async start() {
    this.running = true
    const wallet = this.config.walletKeypair.publicKey.toBase58()

    this.log.info('starting liquidation bot', {
      wallet: `${wallet.slice(0, 8)}...`,
      scanInterval: `${this.config.scanIntervalMs / 1000}s`,
      scoreInterval: `${this.config.scoreIntervalMs / 1000}s`,
      minProfit: `${sol(this.config.minProfitLamports)} SOL`,
      riskThreshold: this.config.riskThreshold,
    })

    // initial scan before starting loops
    await this.scan()

    // run both loops concurrently
    await Promise.all([this.scanLoop(), this.scoreLoop()])
  }

  stop() {
    this.running = false
    this.log.info('stopping bot...')
  }

  private async scanLoop() {
    while (this.running) {
      await sleep(this.config.scanIntervalMs)
      await this.scan()
    }
  }

  private async scan() {
    try {
      this.tokens = await scanForLendingMarkets(
        this.connection,
        this.tokens,
        this.config.priceHistoryDepth,
        this.log.child('scanner'),
      )
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      this.log.error('scan failed', { error: msg })
    }
  }

  private async scoreLoop() {
    while (this.running) {
      await this.scoreAllPositions()
      await sleep(this.config.scoreIntervalMs)
    }
  }

  private async scoreAllPositions() {
    if (this.tokens.size === 0) return

    const allScored: ScoredLoan[] = []

    for (const token of this.tokens.values()) {
      try {
        const scored = await this.scoreToken(token)
        allScored.push(...scored)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        this.log.error(`failed scoring ${token.symbol}`, { error: msg })
      }
    }

    // sort by risk: highest risk first
    allScored.sort((a, b) => b.riskScore - a.riskScore)

    // log high-risk positions
    const highRisk = allScored.filter((l) => l.riskScore >= this.config.riskThreshold)
    if (highRisk.length > 0) {
      this.log.info(`${highRisk.length} high-risk positions detected`)
      for (const loan of highRisk) {
        this.log.info(`  ${loan.tokenName} | ${loan.borrower.slice(0, 8)}...`, {
          risk: loan.riskScore,
          health: loan.position.health,
          ltv: bpsToPercent(loan.position.current_ltv_bps),
          profit: `${sol(loan.estimatedProfitLamports)} SOL`,
        })
      }
    }

    // attempt liquidations on any liquidatable positions (highest profit first)
    const liquidatable = allScored
      .filter((l) => l.position.health === 'liquidatable')
      .sort((a, b) => b.estimatedProfitLamports - a.estimatedProfitLamports)

    for (const loan of liquidatable) {
      const result = await this.liquidator.tryLiquidate(this.connection, loan)
      if (result) {
        this.log.info('liquidation successful!', {
          token: loan.tokenName,
          borrower: `${result.borrower.slice(0, 8)}...`,
          profit: `${sol(result.profitLamports)} SOL`,
          sig: result.signature,
        })
      }
    }
  }

  private async scoreToken(token: MonitoredToken): Promise<ScoredLoan[]> {
    const { holders } = await getHolders(this.connection, token.mint, 100)
    const scored: ScoredLoan[] = []

    // update active borrowers list
    const borrowers: string[] = []

    for (const holder of holders) {
      try {
        const position = await getLoanPosition(
          this.connection,
          token.mint,
          holder.address,
        )

        if (position.health === 'none') continue

        borrowers.push(holder.address)

        const profile = await this.profiler.profile(
          this.connection,
          holder.address,
          token.mint,
        )

        scored.push(scoreLoan(token, holder.address, position, profile))
      } catch {
        // skip holders we can't score
      }
    }

    token.activeBorrowers = borrowers
    return scored
  }
}
