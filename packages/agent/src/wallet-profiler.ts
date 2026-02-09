/**
 * wallet-profiler.ts — assesses wallet risk using SAID reputation + trade history.
 *
 * checks each borrower's trust tier and analyzes their trade messages
 * to determine if they tend to lose money (higher liquidation risk).
 *
 * profiles are cached in-memory with a cooldown to avoid hammering RPC.
 *
 * uses the torch agent kit for trade messages and calls the SAID API
 * directly for wallet reputation verification.
 */

import type { SolanaAgentKit } from 'solana-agent-kit'
import { torchGetMessages } from 'solana-agent-kit-torch-market'
import type { WalletProfile, TradeStats } from './types'
import type { Logger } from './logger'
import { clamp } from './utils'

const PROFILE_COOLDOWN_MS = 5 * 60 * 1000 // refresh profiles every 5 min
const MAX_CACHE_AGE_MS = 30 * 60 * 1000 // evict entries older than 30 min
const MAX_CACHE_SIZE = 1000 // hard cap on cache entries
const SAID_API_URL = 'https://api.saidprotocol.com/api'

interface SaidVerification {
  verified: boolean
  trustTier: 'high' | 'medium' | 'low' | null
}

async function verifySaid(address: string): Promise<SaidVerification> {
  try {
    const res = await fetch(`${SAID_API_URL}/verify/${address}`)
    if (!res.ok) return { verified: false, trustTier: null }
    const data = (await res.json()) as { verified?: boolean; trust_tier?: string }
    return {
      verified: data.verified ?? false,
      trustTier: (data.trust_tier as 'high' | 'medium' | 'low') ?? null,
    }
  } catch {
    return { verified: false, trustTier: null }
  }
}

export class WalletProfiler {
  private cache = new Map<string, WalletProfile>()
  private log: Logger

  constructor(log: Logger) {
    this.log = log
  }

  async profile(agent: SolanaAgentKit, address: string, mint: string): Promise<WalletProfile> {
    this.evictStale()

    const cached = this.cache.get(address)
    if (cached && Date.now() - cached.lastUpdated < PROFILE_COOLDOWN_MS) {
      return cached
    }

    this.log.debug(`profiling wallet ${address.slice(0, 8)}...`)

    // SAID reputation
    const said = await verifySaid(address)

    // trade history from messages
    const tradeStats = await this.analyzeTradeHistory(agent, mint, address)

    // compute wallet risk score (0-100)
    const riskScore = this.computeWalletRisk(said.trustTier, tradeStats)

    const profile: WalletProfile = {
      address,
      saidVerified: said.verified,
      trustTier: said.trustTier,
      tradeStats,
      riskScore,
      lastUpdated: Date.now(),
    }

    this.cache.set(address, profile)
    return profile
  }

  private async analyzeTradeHistory(
    agent: SolanaAgentKit,
    mint: string,
    address: string,
  ): Promise<TradeStats> {
    try {
      const messages = await torchGetMessages(agent, mint, 50)

      // filter messages from this wallet and analyze buy/sell patterns
      const walletMsgs = messages.filter((m: { sender: string }) => m.sender === address)

      let wins = 0
      let losses = 0
      let netPnlSol = 0

      for (const msg of walletMsgs) {
        const m = msg as { pnl_sol?: number }
        if (m.pnl_sol !== undefined) {
          if (m.pnl_sol > 0) wins++
          else losses++
          netPnlSol += m.pnl_sol
        }
      }

      const totalTrades = wins + losses
      return {
        totalTrades,
        wins,
        losses,
        winRate: totalTrades > 0 ? wins / totalTrades : 0.5,
        netPnlSol,
      }
    } catch {
      // if we can't get trade history, assume neutral
      return { totalTrades: 0, wins: 0, losses: 0, winRate: 0.5, netPnlSol: 0 }
    }
  }

  private computeWalletRisk(
    trustTier: 'high' | 'medium' | 'low' | null,
    stats: TradeStats,
  ): number {
    // base risk from trust tier
    const tierRisk: Record<string, number> = {
      high: 10,
      medium: 40,
      low: 70,
    }
    let risk = tierRisk[trustTier ?? ''] ?? 50 // unverified = 50

    // modifier from trade history: bad traders are riskier
    if (stats.totalTrades > 0) {
      // low win rate increases risk, high win rate decreases it
      const winRateModifier = (0.5 - stats.winRate) * 40 // -20 to +20
      risk += winRateModifier

      // net losses increase risk
      if (stats.netPnlSol < 0) {
        risk += Math.min(Math.abs(stats.netPnlSol) * 5, 20) // up to +20
      }
    }

    return clamp(Math.round(risk), 0, 100)
  }

  private evictStale(): void {
    const now = Date.now()
    for (const [key, profile] of this.cache) {
      if (now - profile.lastUpdated > MAX_CACHE_AGE_MS) {
        this.cache.delete(key)
      }
    }
    // hard cap: if still too large, evict oldest entries
    if (this.cache.size > MAX_CACHE_SIZE) {
      const sorted = [...this.cache.entries()].sort((a, b) => a[1].lastUpdated - b[1].lastUpdated)
      const toEvict = sorted.slice(0, this.cache.size - MAX_CACHE_SIZE)
      for (const [key] of toEvict) {
        this.cache.delete(key)
      }
    }
  }
}
