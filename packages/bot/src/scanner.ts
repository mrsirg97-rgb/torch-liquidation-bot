/**
 * scanner.ts — discovers tokens with active lending markets.
 *
 * scans all migrated tokens, checks which ones have active loans,
 * and returns them as MonitoredToken objects with price snapshots.
 */

import type { Connection } from '@solana/web3.js'
import { getTokens, getLendingInfo, LAMPORTS_PER_SOL } from 'torchsdk'
import type { MonitoredToken } from './types'
import type { Logger } from './logger'

export async function scanForLendingMarkets(
  connection: Connection,
  existing: Map<string, MonitoredToken>,
  priceHistoryDepth: number,
  log: Logger,
): Promise<Map<string, MonitoredToken>> {
  log.info('scanning for tokens with active lending...')

  const { tokens } = await getTokens(connection, {
    status: 'migrated',
    sort: 'volume',
    limit: 50,
  })

  log.debug(`found ${tokens.length} migrated tokens`)

  const monitored = new Map<string, MonitoredToken>(existing)

  for (const token of tokens) {
    try {
      const lending = await getLendingInfo(connection, token.mint)

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

      log.info(`tracking: ${token.symbol}`, {
        loans: lending.active_loans,
        price: priceSol.toFixed(6),
      })
    } catch {
      // token may not have lending enabled — skip
    }
  }

  log.info(`monitoring ${monitored.size} tokens with active lending`)
  return monitored
}
