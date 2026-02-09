/**
 * risk-scorer.ts — scores loan positions by likelihood of liquidation.
 *
 * four weighted factors:
 *   - ltv proximity (40%): how close to the liquidation threshold
 *   - price momentum (30%): is the collateral price trending down
 *   - wallet risk (20%): borrower reputation + trade history
 *   - interest burden (10%): is interest eating their margin
 */

import type { TorchLoanPosition, TorchLendingInfo } from 'solana-agent-kit-torch-market'
import type { WalletProfile, RiskFactors, ScoredLoan, MonitoredToken } from './types'
import { clamp } from './utils'

const WEIGHTS = {
  ltvProximity: 0.4,
  priceMomentum: 0.3,
  walletRisk: 0.2,
  interestBurden: 0.1,
}

export function scoreLoan(
  token: MonitoredToken,
  borrower: string,
  position: TorchLoanPosition,
  profile: WalletProfile,
): ScoredLoan {
  const factors = computeFactors(position, token.lendingInfo, token.priceHistory, profile)

  const riskScore = clamp(
    Math.round(
      factors.ltvProximity * WEIGHTS.ltvProximity +
        factors.priceMomentum * WEIGHTS.priceMomentum +
        factors.walletRisk * WEIGHTS.walletRisk +
        factors.interestBurden * WEIGHTS.interestBurden,
    ),
    0,
    100,
  )

  // estimated profit = collateral value * liquidation bonus - fees
  const collateralValue = position.collateral_value_sol ?? 0
  const bonusPct = token.lendingInfo.liquidation_bonus_bps / 10000
  const grossProfit = collateralValue * bonusPct
  const txFeeLamports = 5000 // ~0.000005 SOL per tx
  const transferFeeLamports = Math.floor(collateralValue * 0.01) // Token-2022 1% fee
  const estimatedProfitLamports = Math.max(
    0,
    Math.floor(grossProfit) - txFeeLamports - transferFeeLamports,
  )

  return {
    mint: token.mint,
    tokenName: token.name,
    borrower,
    position,
    walletProfile: profile,
    riskScore,
    factors,
    estimatedProfitLamports,
    lastScored: Date.now(),
  }
}

function computeFactors(
  position: TorchLoanPosition,
  lending: TorchLendingInfo,
  priceHistory: number[],
  profile: WalletProfile,
): RiskFactors {
  return {
    ltvProximity: computeLtvProximity(position, lending),
    priceMomentum: computePriceMomentum(priceHistory),
    walletRisk: profile.riskScore,
    interestBurden: computeInterestBurden(position),
  }
}

/**
 * how close is current LTV to the liquidation threshold?
 * at threshold = 100, at 0 LTV = 0
 */
function computeLtvProximity(position: TorchLoanPosition, lending: TorchLendingInfo): number {
  if (lending.liquidation_threshold_bps === 0) return 0
  const ratio = (position.current_ltv_bps ?? 0) / lending.liquidation_threshold_bps
  return clamp(Math.round(ratio * 100), 0, 100)
}

/**
 * is the price trending down?
 * uses simple slope of recent price history.
 * negative slope = price dropping = higher risk.
 */
function computePriceMomentum(priceHistory: number[]): number {
  if (priceHistory.length < 2) return 50 // not enough data, assume neutral

  // simple linear regression slope
  const n = priceHistory.length
  let sumX = 0
  let sumY = 0
  let sumXY = 0
  let sumX2 = 0

  for (let i = 0; i < n; i++) {
    sumX += i
    sumY += priceHistory[i]
    sumXY += i * priceHistory[i]
    sumX2 += i * i
  }

  const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX)

  // normalize: negative slope = high risk, positive = low risk
  // use avg price as baseline for relative change
  const avgPrice = sumY / n
  if (avgPrice === 0) return 50

  const relativeSlopePerTick = slope / avgPrice
  // scale: -5% per tick = 100 risk, +5% = 0 risk
  const score = 50 - relativeSlopePerTick * 1000
  return clamp(Math.round(score), 0, 100)
}

/**
 * how much is interest eating into the collateral margin?
 */
function computeInterestBurden(position: TorchLoanPosition): number {
  const collateralValue = position.collateral_value_sol ?? 0
  if (collateralValue === 0) return 100
  const ratio = position.accrued_interest / collateralValue
  return clamp(Math.round(ratio * 1000), 0, 100) // 10% interest/collateral = 100
}
