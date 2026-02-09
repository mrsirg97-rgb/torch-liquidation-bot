/**
 * types.ts — all interfaces and contracts for the liquidation bot.
 *
 * this is the blueprint. everything else implements these shapes.
 */

import type { Keypair } from '@solana/web3.js'
import type { LendingInfo, LoanPositionInfo } from 'torchsdk'

// ---------------------------------------------------------------------------
// wallet profiling
// ---------------------------------------------------------------------------

export interface TradeStats {
  totalTrades: number
  wins: number
  losses: number
  winRate: number // 0.0 - 1.0
  netPnlSol: number
}

export interface WalletProfile {
  address: string
  saidVerified: boolean
  trustTier: 'high' | 'medium' | 'low' | null
  tradeStats: TradeStats
  riskScore: number // 0-100, higher = riskier
  lastUpdated: number // unix ms
}

// ---------------------------------------------------------------------------
// risk scoring
// ---------------------------------------------------------------------------

export interface RiskFactors {
  ltvProximity: number // 0-100, how close to liquidation threshold
  priceMomentum: number // 0-100, higher = price dropping faster
  walletRisk: number // 0-100, based on SAID + trade history
  interestBurden: number // 0-100, interest accrual vs collateral value
}

export interface ScoredLoan {
  mint: string
  tokenName: string
  borrower: string
  position: LoanPositionInfo
  walletProfile: WalletProfile
  riskScore: number // 0-100 composite
  factors: RiskFactors
  estimatedProfitLamports: number
  lastScored: number // unix ms
}

// ---------------------------------------------------------------------------
// token monitoring
// ---------------------------------------------------------------------------

export interface MonitoredToken {
  mint: string
  name: string
  symbol: string
  lendingInfo: LendingInfo
  priceSol: number
  priceHistory: number[] // recent price snapshots for momentum calc
  activeBorrowers: string[]
  lastScanned: number // unix ms
}

// ---------------------------------------------------------------------------
// liquidation
// ---------------------------------------------------------------------------

export interface LiquidationResult {
  mint: string
  borrower: string
  signature: string
  profitLamports: number
  timestamp: number
  confirmed: boolean
}

// ---------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface BotConfig {
  rpcUrl: string
  walletKeypair: Keypair
  scanIntervalMs: number // how often to discover new tokens
  scoreIntervalMs: number // how often to re-score positions
  minProfitLamports: number // minimum profit to execute liquidation
  riskThreshold: number // minimum risk score to watch closely (0-100)
  priceHistoryDepth: number // how many price snapshots to keep
  logLevel: LogLevel
}
