/**
 * scanner.ts — discovers tokens with active lending markets.
 *
 * scans all migrated tokens, checks which ones have active loans,
 * and returns them as MonitoredToken objects with price snapshots.
 */

import { LAMPORTS_PER_SOL } from '@solana/web3.js'
import type { SolanaAgentKit } from 'solana-agent-kit'
import { torchListTokens, torchGetLendingInfo } from 'solana-agent-kit-torch-market'
import type { MonitoredToken } from './types'
import type { Logger } from './logger'

export async function scanForLendingMarkets(
  agent: SolanaAgentKit,
  existing: Map<string, MonitoredToken>,
  priceHistoryDepth: number,
  log: Logger,
): Promise<Map<string, MonitoredToken>> {
  log.info('scanning for tokens with active lending...')

  const tokens = await torchListTokens(agent, 'migrated', 'volume', 50)

  log.debug(`found ${tokens.length} migrated tokens`)

  const monitored = new Map<string, MonitoredToken>(existing)

  for (const token of tokens) {
    try {
      const lending = await torchGetLendingInfo(agent, token.mint)

      // skip tokens with zero active loans.
      // null means loan enumeration failed (e.g. on a fork) — treat as
      // "unknown, keep monitoring" so we don't miss positions.
      if (lending.active_loans === 0) continue

      const priceSol = token.price_sol / LAMPORTS_PER_SOL
      const prev = existing.get(token.mint)

      // build price history: append new price, trim to depth
      const priceHistory = prev?.priceHistory ?? []
      priceHistory.push(priceSol)
      if (priceHistory.length > priceHistoryDepth) {
        priceHistory.splice(0, priceHistory.length - priceHistoryDepth)
      }

      monitored.set(token.mint, {
        mint: token.mint,
        name: token.name,
        symbol: token.symbol,
        lendingInfo: lending,
        priceSol,
        priceHistory,
        activeBorrowers: prev?.activeBorrowers ?? [],
        lastScanned: Date.now(),
      })

      const loansDisplay = lending.active_loans ?? 'unknown'
      log.info(`tracking: ${token.symbol}`, {
        loans: loansDisplay,
        price: priceSol.toFixed(6),
      })
    } catch {
      // token may not have lending enabled — skip
    }
  }

  log.info(`monitoring ${monitored.size} tokens with active lending`)
  return monitored
}
