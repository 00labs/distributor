import { web3 } from "@coral-xyz/anchor";
import {
    createAssociatedTokenAccountIdempotentInstruction,
    createInitializeMint2Instruction,
    createMintToCheckedInstruction,
    getAssociatedTokenAddressSync,
    MINT_SIZE,
    TOKEN_PROGRAM_ID,
    unpackMint,
} from "@solana/spl-token";
import { AccountInfo, Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { ProgramTestContext } from "solana-bankrun";

export * from "./asserter";

export const encodeU64 = (num: number): Buffer => {
    const buf = Buffer.alloc(8);
    buf.writeBigUint64LE(BigInt(num));
    return buf;
};

export function getRandomInt(min: number, max: number) {
    const minCeiled = Math.ceil(min);
    const maxFloored = Math.floor(max);
    return Math.floor(Math.random() * (maxFloored - minCeiled) + minCeiled); // The maximum is exclusive and the minimum is inclusive
}

export async function createMint(
    ctx: ProgramTestContext,
    mintAuthority: PublicKey,
    freezeAuthority: PublicKey,
    decimals: number,
    mint: Keypair,
    tokenProgramId = TOKEN_PROGRAM_ID,
) {
    const createAccountIx = SystemProgram.createAccount({
        fromPubkey: ctx.payer.publicKey,
        newAccountPubkey: mint.publicKey,
        lamports: web3.LAMPORTS_PER_SOL,
        space: MINT_SIZE,
        programId: tokenProgramId,
    });
    const initIx = createInitializeMint2Instruction(
        mint.publicKey,
        decimals,
        mintAuthority,
        freezeAuthority,
        tokenProgramId,
    );
    const tx = new Transaction();
    const latestBlockhash = await ctx.banksClient.getLatestBlockhash();
    if (!latestBlockhash) throw new Error("Could not get latest blockhash");
    tx.recentBlockhash = latestBlockhash[0];
    tx.add(createAccountIx, initIx).sign(ctx.payer, mint);

    return await ctx.banksClient.processTransaction(tx);
}

export async function createAssociatedTokenAccount(
    ctx: ProgramTestContext,
    mint: PublicKey,
    owner: PublicKey,
    allowOwnerOffCurve = false,
    tokenProgramId = TOKEN_PROGRAM_ID,
) {
    const associatedTokenAddr = getAssociatedTokenAddressSync(
        mint,
        owner,
        allowOwnerOffCurve,
        tokenProgramId,
    );

    const ix = createAssociatedTokenAccountIdempotentInstruction(
        ctx.payer.publicKey,
        associatedTokenAddr,
        owner,
        mint,
        tokenProgramId,
    );
    const tx = new Transaction();
    const latestBlockhash = await ctx.banksClient.getLatestBlockhash();
    if (!latestBlockhash) throw new Error("Could not get latest blockhash");
    tx.recentBlockhash = latestBlockhash[0];
    tx.add(ix).sign(ctx.payer);

    await ctx.banksClient.processTransaction(tx);

    return associatedTokenAddr;
}

export async function mintTo(
    ctx: ProgramTestContext,
    mint: PublicKey,
    authority: Keypair,
    destination: PublicKey,
    amount: number | bigint,
    tokenProgramId = TOKEN_PROGRAM_ID,
) {
    const mintAccount = await getMint(ctx, mint, tokenProgramId);
    const ix = createMintToCheckedInstruction(
        mint,
        destination,
        authority.publicKey,
        amount,
        mintAccount.decimals,
        [],
        tokenProgramId,
    );

    const tx = new Transaction();
    const latestBlockhash = await ctx.banksClient.getLatestBlockhash();
    if (!latestBlockhash) throw new Error("Could not get latest blockhash");
    tx.recentBlockhash = latestBlockhash[0];
    tx.add(ix).sign(ctx.payer, authority);

    return await ctx.banksClient.processTransaction(tx);
}

async function getMint(ctx: ProgramTestContext, mintKey: PublicKey, tokenProgramId: PublicKey) {
    const accountInfo = await ctx.banksClient.getAccount(mintKey);
    return unpackMint(
        mintKey,
        {
            ...accountInfo,
            data: Buffer.from(accountInfo!.data),
        } as AccountInfo<Buffer>,
        tokenProgramId,
    );
}
