/**
 * utils.ts — shared helpers used across modules.
 */

import { LAMPORTS_PER_SOL } from 'torchsdk'

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

export function sol(lamports: number): string {
  return (lamports / LAMPORTS_PER_SOL).toFixed(4)
}

export function bpsToPercent(bps: number): string {
  return (bps / 100).toFixed(2) + '%'
}

/** clamp a value between min and max */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}
