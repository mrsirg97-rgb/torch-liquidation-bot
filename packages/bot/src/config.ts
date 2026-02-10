/**
 * config.ts — loads environment variables into a typed BotConfig.
 */

import { Keypair } from '@solana/web3.js'
import bs58 from 'bs58'
import { LAMPORTS_PER_SOL } from 'torchsdk'
import type { BotConfig, ReadOnlyConfig, LogLevel } from './types'

const LOG_LEVELS: LogLevel[] = ['debug', 'info', 'warn', 'error']

/**
 * loadReadOnlyConfig — read-only config that only needs RPC_URL.
 * no wallet loaded, no keypair decoded, no signing possible.
 */
export function loadReadOnlyConfig(): ReadOnlyConfig {
  const rpcUrl = process.env.RPC_URL
  if (!rpcUrl) throw new Error('RPC_URL env var is required')

  const logLevel = (process.env.LOG_LEVEL ?? 'info') as LogLevel
  if (!LOG_LEVELS.includes(logLevel)) {
    throw new Error(`LOG_LEVEL must be one of: ${LOG_LEVELS.join(', ')}`)
  }

  return { rpcUrl, logLevel }
}

// --- wallet-dependent config below — retained for future release ---

export function loadConfig(): BotConfig {
  const rpcUrl = process.env.RPC_URL
  if (!rpcUrl) throw new Error('RPC_URL env var is required')

  const walletKey = process.env.WALLET
  if (!walletKey) throw new Error('WALLET env var is required (base58 private key)')

  const logLevel = (process.env.LOG_LEVEL ?? 'info') as LogLevel
  if (!LOG_LEVELS.includes(logLevel)) {
    throw new Error(`LOG_LEVEL must be one of: ${LOG_LEVELS.join(', ')}`)
  }

  const minProfitSol = Number(process.env.MIN_PROFIT_SOL ?? '0.01')
  const scanIntervalMs = Number(process.env.SCAN_INTERVAL_MS ?? '60000')
  const scoreIntervalMs = Number(process.env.SCORE_INTERVAL_MS ?? '15000')
  const riskThreshold = Number(process.env.RISK_THRESHOLD ?? '60')
  const priceHistoryDepth = Number(process.env.PRICE_HISTORY ?? '20')

  if (isNaN(scanIntervalMs) || scanIntervalMs < 1000)
    throw new Error('SCAN_INTERVAL_MS must be >= 1000')
  if (isNaN(scoreIntervalMs) || scoreIntervalMs < 1000)
    throw new Error('SCORE_INTERVAL_MS must be >= 1000')
  if (isNaN(riskThreshold) || riskThreshold < 0 || riskThreshold > 100)
    throw new Error('RISK_THRESHOLD must be 0-100')
  if (isNaN(priceHistoryDepth) || priceHistoryDepth < 2)
    throw new Error('PRICE_HISTORY must be >= 2')
  if (isNaN(minProfitSol) || minProfitSol < 0) throw new Error('MIN_PROFIT_SOL must be >= 0')

  return {
    rpcUrl,
    walletKeypair: Keypair.fromSecretKey(bs58.decode(walletKey)),
    scanIntervalMs,
    scoreIntervalMs,
    minProfitLamports: Math.floor(minProfitSol * LAMPORTS_PER_SOL),
    riskThreshold,
    priceHistoryDepth,
    logLevel,
  }
}
