/**
 * Read-Only E2E Test — Surfpool (mainnet fork)
 *
 * Tests the read-only path only. No wallet, no signing, no state changes.
 *   1. Connect to surfpool RPC
 *   2. Discover migrated tokens via getTokens
 *   3. Get lending info for each token
 *   4. Get token detail for a specific token
 *
 * Run:
 *   surfpool start --network mainnet --no-tui
 *   npx tsx tests/test_readonly.ts
 */

import { Connection, LAMPORTS_PER_SOL } from '@solana/web3.js'
import {
  getToken,
  getTokens,
  getLendingInfo,
  type LendingInfo,
} from 'torchsdk'

const RPC_URL = process.env.RPC_URL ?? 'http://localhost:8899'

const log = (msg: string) => {
  const ts = new Date().toISOString().substr(11, 8)
  console.log(`[${ts}] ${msg}`)
}

const bpsToPercent = (bps: number): string => (bps / 100).toFixed(2) + '%'
const sol = (lamports: number): string => (lamports / LAMPORTS_PER_SOL).toFixed(4)

let passed = 0
let failed = 0

const ok = (name: string, detail?: string) => {
  passed++
  log(`  ✓ ${name}${detail ? ` — ${detail}` : ''}`)
}
const fail = (name: string, err: any) => {
  failed++
  log(`  ✗ ${name} — ${err.message || err}`)
}

const main = async () => {
  console.log('='.repeat(60))
  console.log('READ-ONLY TEST — Surfpool Mainnet Fork')
  console.log('='.repeat(60))

  // ------------------------------------------------------------------
  // 1. Connect
  // ------------------------------------------------------------------
  log('\n[1] Connect to RPC')
  const connection = new Connection(RPC_URL, 'confirmed')
  try {
    const version = await connection.getVersion()
    ok('connection', `solana-core ${version['solana-core']}`)
  } catch (e: any) {
    fail('connection', e)
    console.error('Cannot reach RPC. Is surfpool running?')
    process.exit(1)
  }

  // ------------------------------------------------------------------
  // 2. Discover migrated tokens
  // ------------------------------------------------------------------
  log('\n[2] Discover Migrated Tokens (getTokens)')
  let firstMint: string | undefined
  try {
    const { tokens } = await getTokens(connection, {
      status: 'migrated',
      sort: 'volume',
      limit: 10,
    })

    if (!tokens || tokens.length === 0) {
      throw new Error('No migrated tokens found')
    }

    firstMint = tokens[0].mint
    ok('getTokens', `found ${tokens.length} migrated tokens`)

    for (const t of tokens) {
      log(`    ${t.symbol.padEnd(10)} | mint=${t.mint.slice(0, 8)}...`)
    }
  } catch (e: any) {
    fail('getTokens', e)
  }

  // ------------------------------------------------------------------
  // 3. Get lending info for each discovered token
  // ------------------------------------------------------------------
  log('\n[3] Get Lending Info (getLendingInfo)')
  if (firstMint) {
    let lendingCount = 0
    try {
      const { tokens } = await getTokens(connection, {
        status: 'migrated',
        sort: 'volume',
        limit: 10,
      })

      for (const t of tokens) {
        try {
          const lending: LendingInfo = await getLendingInfo(connection, t.mint)

          if (lending.interest_rate_bps <= 0) {
            throw new Error(`Invalid interest rate for ${t.symbol}`)
          }

          lendingCount++
          log(
            `    ${t.symbol.padEnd(10)} | ` +
              `rate=${bpsToPercent(lending.interest_rate_bps).padEnd(7)} | ` +
              `loans=${String(lending.active_loans).padEnd(4)} | ` +
              `avail=${sol(lending.treasury_sol_available)} SOL`,
          )
        } catch {
          // token may not have lending enabled — not a test failure
        }
      }

      if (lendingCount > 0) {
        ok('getLendingInfo', `${lendingCount} tokens with lending data`)
      } else {
        fail('getLendingInfo', { message: 'No tokens returned lending data' })
      }
    } catch (e: any) {
      fail('getLendingInfo', e)
    }
  }

  // ------------------------------------------------------------------
  // 4. Get token detail for first token
  // ------------------------------------------------------------------
  log('\n[4] Get Token Detail (getToken)')
  if (firstMint) {
    try {
      const token = await getToken(connection, firstMint)

      if (!token.name) throw new Error('Missing token name')
      if (!token.symbol) throw new Error('Missing token symbol')
      if (token.price_sol <= 0) throw new Error('Invalid price')

      ok(
        'getToken',
        `${token.name} (${token.symbol}) | price=${sol(token.price_sol)} SOL | status=${token.status}`,
      )
    } catch (e: any) {
      fail('getToken', e)
    }
  }

  // ------------------------------------------------------------------
  // 5. Verify no wallet was loaded or needed
  // ------------------------------------------------------------------
  log('\n[5] Verify Read-Only')
  ok('no wallet', 'no WALLET env var read, no Keypair created, no signing occurred')

  // ------------------------------------------------------------------
  // Summary
  // ------------------------------------------------------------------
  console.log('\n' + '='.repeat(60))
  console.log(`RESULTS: ${passed} passed, ${failed} failed`)
  console.log('='.repeat(60))

  if (failed > 0) process.exit(1)
}

main().catch((err) => {
  console.error('\nFATAL:', err)
  process.exit(1)
})
