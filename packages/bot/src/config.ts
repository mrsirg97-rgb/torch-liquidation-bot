/**
 * config.ts — loads environment variables into a typed BotConfig.
 */

import { Keypair } from '@solana/web3.js'
import bs58 from 'bs58'
import { LAMPORTS_PER_SOL } from 'torchsdk'
import type { BotConfig, LogLevel } from './types'

const LOG_LEVELS: LogLevel[] = ['debug', 'info', 'warn', 'error']

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

  return {
    rpcUrl,
    walletKeypair: Keypair.fromSecretKey(bs58.decode(walletKey)),
    scanIntervalMs: Number(process.env.SCAN_INTERVAL_MS ?? '60000'),
    scoreIntervalMs: Number(process.env.SCORE_INTERVAL_MS ?? '15000'),
    minProfitLamports: Math.floor(minProfitSol * LAMPORTS_PER_SOL),
    riskThreshold: Number(process.env.RISK_THRESHOLD ?? '60'),
    priceHistoryDepth: Number(process.env.PRICE_HISTORY ?? '20'),
    logLevel,
  }
}
