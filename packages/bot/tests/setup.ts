/**
 * setup.ts — shared test helpers for Surfpool E2E tests.
 *
 * creates a token, bonds to completion, migrates to DEX.
 * returns the mint address + buyer wallets for further testing.
 *
 * Run surfpool first:
 *   surfpool start --network mainnet --no-tui
 */

import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js'
import { getToken, buildCreateTokenTransaction, buildBuyTransaction } from 'torchsdk'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

export const RPC_URL = 'http://localhost:8899'
const WALLET_PATH = path.join(os.homedir(), '.config/solana/id.json')

export const log = (msg: string) => {
  const ts = new Date().toISOString().substr(11, 8)
  console.log(`[${ts}] ${msg}`)
}

export const loadWallet = (): Keypair => {
  const raw = JSON.parse(fs.readFileSync(WALLET_PATH, 'utf-8'))
  return Keypair.fromSecretKey(Uint8Array.from(raw))
}

export const signAndSend = async (
  connection: Connection,
  wallet: Keypair,
  tx: Transaction,
): Promise<string> => {
  tx.partialSign(wallet)
  const sig = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    preflightCommitment: 'confirmed',
  })
  await connection.confirmTransaction(sig, 'confirmed')
  return sig
}

export const bpsToPercent = (bps: number): string => (bps / 100).toFixed(2) + '%'

export interface SetupResult {
  connection: Connection
  wallet: Keypair
  mint: string
  buyers: Keypair[]
}

/**
 * full setup: create token -> bond to completion -> migrate to DEX.
 * returns everything needed to test lending features.
 */
export async function setupMigratedToken(): Promise<SetupResult> {
  const connection = new Connection(RPC_URL, 'confirmed')
  const wallet = loadWallet()
  const walletAddr = wallet.publicKey.toBase58()

  log(`Wallet: ${walletAddr}`)
  const balance = await connection.getBalance(wallet.publicKey)
  log(`Balance: ${balance / LAMPORTS_PER_SOL} SOL`)

  // 1. create token
  log('\n[setup] Create Token')
  const createResult = await buildCreateTokenTransaction(connection, {
    creator: walletAddr,
    name: 'Bot Test Token',
    symbol: 'BTEST',
    metadata_uri: 'https://example.com/btest.json',
  })
  const createSig = await signAndSend(connection, wallet, createResult.transaction)
  const mint = createResult.mint.toBase58()
  log(`  created: ${mint.slice(0, 8)}... sig=${createSig.slice(0, 8)}...`)

  // 2. bond to completion
  log('\n[setup] Bond to Completion')
  const NUM_BUYERS = 60
  const BUY_AMOUNT = 5 * LAMPORTS_PER_SOL
  const buyers: Keypair[] = []
  for (let i = 0; i < NUM_BUYERS; i++) buyers.push(Keypair.generate())

  // fund in batches
  for (let i = 0; i < buyers.length; i += 10) {
    const batch = buyers.slice(i, i + 10)
    const fundTx = new Transaction()
    for (const b of batch) {
      fundTx.add(
        SystemProgram.transfer({
          fromPubkey: wallet.publicKey,
          toPubkey: b.publicKey,
          lamports: BUY_AMOUNT + 0.1 * LAMPORTS_PER_SOL,
        }),
      )
    }
    const { blockhash } = await connection.getLatestBlockhash()
    fundTx.recentBlockhash = blockhash
    fundTx.feePayer = wallet.publicKey
    await signAndSend(connection, wallet, fundTx)
  }
  log(`  funded ${buyers.length} wallets`)

  let bondingComplete = false
  let buyCount = 0
  for (const buyer of buyers) {
    if (bondingComplete) break
    try {
      const result = await buildBuyTransaction(connection, {
        mint,
        buyer: buyer.publicKey.toBase58(),
        amount_sol: BUY_AMOUNT,
        slippage_bps: 1000,
        vote: Math.random() > 0.5 ? 'burn' : 'return',
      })
      await signAndSend(connection, buyer, result.transaction)
      buyCount++

      if (buyCount % 10 === 0) {
        const detail = await getToken(connection, mint)
        log(`  buy ${buyCount}: ${detail.progress_percent.toFixed(1)}% status=${detail.status}`)
        if (detail.status !== 'bonding') bondingComplete = true
      }
    } catch (e: any) {
      if (
        e.message?.includes('Bonding curve complete') ||
        e.message?.includes('bonding_complete') ||
        e.message?.includes('BondingComplete')
      ) {
        bondingComplete = true
      }
    }
  }

  const detail = await getToken(connection, mint)
  if (detail.status !== 'bonding') bondingComplete = true
  log(`  final: ${detail.progress_percent.toFixed(1)}% status=${detail.status}`)

  if (!bondingComplete) {
    throw new Error(`Bonding not complete after ${buyCount} buys`)
  }

  // 3. migrate to DEX
  log('\n[setup] Migrate to DEX')
  const anchor = require('@coral-xyz/anchor')
  const {
    TOKEN_PROGRAM_ID,
    TOKEN_2022_PROGRAM_ID: T22,
    ASSOCIATED_TOKEN_PROGRAM_ID: ATP,
    getAssociatedTokenAddressSync,
    createAssociatedTokenAccountInstruction,
    createSyncNativeInstruction,
  } = require('@solana/spl-token')

  const idl = require('torchsdk/dist/torch_market.json')
  const PROGRAM_ID = new PublicKey('8hbUkonssSEEtkqzwM7ZcZrD9evacM92TcWSooVF4BeT')
  const RAYDIUM_CPMM = new PublicKey('CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C')
  const RAYDIUM_AMM_CONFIG = new PublicKey('D4FPEruKEHrG5TenZ2mpDGEfu1iUvTiqBxvpU8HLBvC2')
  const RAYDIUM_FEE_RECEIVER = new PublicKey('DNXgeM9EiiaAbaWvwjHj9fQQLAX5ZsfHyvmYUNRAdNC8')
  const WSOL_MINT = new PublicKey('So11111111111111111111111111111111111111112')

  const dummyWallet = {
    publicKey: wallet.publicKey,
    signTransaction: async (t: Transaction) => {
      t.partialSign(wallet)
      return t
    },
    signAllTransactions: async (ts: Transaction[]) => {
      ts.forEach((t) => t.partialSign(wallet))
      return ts
    },
  }
  const provider = new anchor.AnchorProvider(connection, dummyWallet, {})
  const program = new anchor.Program(idl, provider)

  const mintPk = new PublicKey(mint)
  const [globalConfig] = PublicKey.findProgramAddressSync(
    [Buffer.from('global_config')],
    PROGRAM_ID,
  )
  const [bondingCurvePda] = PublicKey.findProgramAddressSync(
    [Buffer.from('bonding_curve'), mintPk.toBuffer()],
    PROGRAM_ID,
  )
  const [treasuryPda] = PublicKey.findProgramAddressSync(
    [Buffer.from('treasury'), mintPk.toBuffer()],
    PROGRAM_ID,
  )
  const [bcAta] = PublicKey.findProgramAddressSync(
    [bondingCurvePda.toBuffer(), T22.toBuffer(), mintPk.toBuffer()],
    ATP,
  )
  const [treasuryAta] = PublicKey.findProgramAddressSync(
    [treasuryPda.toBuffer(), T22.toBuffer(), mintPk.toBuffer()],
    ATP,
  )

  const isWsolToken0 = WSOL_MINT.toBuffer().compare(mintPk.toBuffer()) < 0
  const token0 = isWsolToken0 ? WSOL_MINT : mintPk
  const token1 = isWsolToken0 ? mintPk : WSOL_MINT
  const [raydiumAuth] = PublicKey.findProgramAddressSync(
    [Buffer.from('vault_and_lp_mint_auth_seed')],
    RAYDIUM_CPMM,
  )
  const [poolState] = PublicKey.findProgramAddressSync(
    [Buffer.from('pool'), RAYDIUM_AMM_CONFIG.toBuffer(), token0.toBuffer(), token1.toBuffer()],
    RAYDIUM_CPMM,
  )
  const [lpMint] = PublicKey.findProgramAddressSync(
    [Buffer.from('pool_lp_mint'), poolState.toBuffer()],
    RAYDIUM_CPMM,
  )
  const [obs] = PublicKey.findProgramAddressSync(
    [Buffer.from('observation'), poolState.toBuffer()],
    RAYDIUM_CPMM,
  )
  const [vault0] = PublicKey.findProgramAddressSync(
    [Buffer.from('pool_vault'), poolState.toBuffer(), token0.toBuffer()],
    RAYDIUM_CPMM,
  )
  const [vault1] = PublicKey.findProgramAddressSync(
    [Buffer.from('pool_vault'), poolState.toBuffer(), token1.toBuffer()],
    RAYDIUM_CPMM,
  )

  const payerWsol = getAssociatedTokenAddressSync(WSOL_MINT, wallet.publicKey)
  const [payerToken] = PublicKey.findProgramAddressSync(
    [wallet.publicKey.toBuffer(), T22.toBuffer(), mintPk.toBuffer()],
    ATP,
  )
  const payerLp = getAssociatedTokenAddressSync(lpMint, wallet.publicKey)

  try {
    const tx = new Transaction().add(
      createAssociatedTokenAccountInstruction(
        wallet.publicKey,
        payerWsol,
        wallet.publicKey,
        WSOL_MINT,
        TOKEN_PROGRAM_ID,
        ATP,
      ),
    )
    await provider.sendAndConfirm(tx)
  } catch {
    /* exists */
  }

  const wsolFundTx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: wallet.publicKey,
      toPubkey: payerWsol,
      lamports: 250 * LAMPORTS_PER_SOL,
    }),
    createSyncNativeInstruction(payerWsol, TOKEN_PROGRAM_ID),
  )
  await provider.sendAndConfirm(wsolFundTx)

  try {
    const tx = new Transaction().add(
      createAssociatedTokenAccountInstruction(
        wallet.publicKey,
        payerToken,
        wallet.publicKey,
        mintPk,
        T22,
        ATP,
      ),
    )
    await provider.sendAndConfirm(tx)
  } catch {
    /* exists */
  }

  const { ComputeBudgetProgram } = require('@solana/web3.js')
  const migrateIx = await program.methods
    .migrateToDex()
    .accounts({
      payer: wallet.publicKey,
      globalConfig,
      mint: mintPk,
      bondingCurve: bondingCurvePda,
      treasury: treasuryPda,
      tokenVault: bcAta,
      treasuryTokenAccount: treasuryAta,
      payerWsol,
      payerToken,
      raydiumProgram: RAYDIUM_CPMM,
      ammConfig: RAYDIUM_AMM_CONFIG,
      raydiumAuthority: raydiumAuth,
      poolState,
      wsolMint: WSOL_MINT,
      token0Vault: vault0,
      token1Vault: vault1,
      lpMint,
      payerLpToken: payerLp,
      observationState: obs,
      createPoolFee: RAYDIUM_FEE_RECEIVER,
      tokenProgram: TOKEN_PROGRAM_ID,
      token2022Program: T22,
      associatedTokenProgram: ATP,
      systemProgram: SystemProgram.programId,
      rent: anchor.web3.SYSVAR_RENT_PUBKEY,
    })
    .instruction()

  const migrateTx = new Transaction()
    .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }))
    .add(migrateIx)
  await provider.sendAndConfirm(migrateTx)

  log('  migration complete')
  return { connection, wallet, mint, buyers }
}
