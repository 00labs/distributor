import { Program, web3 } from "@coral-xyz/anchor";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import BN from "bn.js";
import { Clock, startAnchor } from "solana-bankrun";
import IDL from "../../target/idl/merkle_distributor.json";
import { MerkleDistributor } from "../../target/types/merkle_distributor";
import { BankrunProvider } from "../anchor-bankrun";
import { createAssociatedTokenAccount, createMint, encodeU64 } from "../common";

export enum WalletIndex {
    ADMIN,
    DISTRIBUTOR_ADMIN,
    OPERATOR,
}

export interface CreateNewDistributorParams {
    admin: Keypair;
    version: number;
    root: Buffer;
    totalClaim: BN;
    maxNumNodes: BN;
    startVestingTs: BN;
    endVestingTs: BN;
    clawbackStartTs: BN;
    activationPoint: BN;
    activationType: number;
    closable: boolean;
    totalBonus: BN;
    bonusVestingDuration: BN;
    claimType: number;
    operator: PublicKey;
    locker: PublicKey;
    clawbackReceiver: PublicKey;
}

export interface ClaimParams {
    claimant: Keypair;
    operator?: Keypair;
    distributorPDA: PublicKey;
    amountUnlocked: BN;
    amountLocked: BN;
    proof: Array<number>[];
}

export interface ClaimLockedParams {
    claimant: Keypair;
    operator?: Keypair;
    distributorPDA: PublicKey;
}

export interface ClawbackParams {
    payer: Keypair;
    distributor: PublicKey;
}

export class Context {
    provider!: BankrunProvider;
    program!: Program<MerkleDistributor>;
    wallets: Keypair[] = [];
    mint: Keypair;

    constructor() {
        this.mint = Keypair.generate();
    }

    async start(numAccounts: number = 25) {
        const accounts = [];
        for (let i = 0; i < numAccounts; i++) {
            const account = Keypair.generate();
            this.wallets.push(account);
            accounts.push({
                address: account.publicKey,
                info: {
                    lamports: 100 * web3.LAMPORTS_PER_SOL,
                    data: Buffer.alloc(0),
                    owner: SystemProgram.programId,
                    executable: false,
                },
            });
        }

        const programPath = require("path").resolve(__dirname, "../..");
        const context = await startAnchor(programPath, [], accounts);
        this.provider = new BankrunProvider(context);
        const idl = IDL as MerkleDistributor;
        this.program = new Program<MerkleDistributor>(idl, this.provider);

        await createMint(
            this.provider.context,
            this.admin().publicKey,
            this.admin().publicKey,
            6,
            this.mint,
        );
    }

    async createNewDistributor(params: CreateNewDistributorParams) {
        let {
            admin,
            version,
            root,
            totalClaim,
            maxNumNodes,
            startVestingTs,
            endVestingTs,
            clawbackStartTs,
            activationPoint,
            activationType,
            closable,
            totalBonus,
            bonusVestingDuration,
            claimType,
            operator,
            locker,
            clawbackReceiver,
        } = params;
        const base = Keypair.generate();

        const distributorPDA = this.distributorPDA(base.publicKey, this.mint.publicKey, version);
        const tokenVault = await createAssociatedTokenAccount(
            this.provider.context,
            this.mint.publicKey,
            distributorPDA,
            true,
        );
        await this.program.methods
            .newDistributor({
                version: new BN(version),
                root: Array.from(new Uint8Array(root)),
                totalClaim,
                maxNumNodes,
                startVestingTs,
                endVestingTs,
                clawbackStartTs,
                activationPoint,
                activationType,
                closable,
                totalBonus,
                bonusVestingDuration,
                claimType,
                operator,
                locker,
            })
            .accountsPartial({
                distributor: distributorPDA,
                mint: this.mint.publicKey,
                clawbackReceiver,
                tokenVault,
                admin: admin.publicKey,
                base: base.publicKey,
                systemProgram: web3.SystemProgram.programId,
                tokenProgram: TOKEN_PROGRAM_ID,
            })
            .signers([base, this.distributorAdmin()])
            .rpc();

        return { distributorPDA, tokenVault };
    }

    async claim(params: ClaimParams) {
        const { claimant, amountUnlocked, amountLocked, proof, distributorPDA, operator } = params;

        const distributorState =
            await this.program.account.merkleDistributor.fetch(distributorPDA);
        const claimStatusPDA = this.claimStatusPDA(distributorPDA, claimant.publicKey);
        const to = await createAssociatedTokenAccount(
            this.provider.context,
            this.mint.publicKey,
            claimant.publicKey,
        );

        if (!operator) {
            await this.program.methods
                .newClaim(amountUnlocked, amountLocked, proof)
                .accountsPartial({
                    distributor: distributorPDA,
                    claimant: claimant.publicKey,
                    claimStatus: claimStatusPDA,
                    from: distributorState.tokenVault,
                    to,
                    systemProgram: web3.SystemProgram.programId,
                    tokenProgram: TOKEN_PROGRAM_ID,
                    operator: undefined,
                })
                .signers([claimant])
                .rpc();
        } else {
            // user sign tx first (need to verify signature to avoid spamming)
            let tx = await this.program.methods
                .newClaim(amountUnlocked, amountLocked, proof)
                .accountsPartial({
                    distributor: distributorPDA,
                    claimant: claimant.publicKey,
                    claimStatus: claimStatusPDA,
                    from: distributorState.tokenVault,
                    to,
                    systemProgram: web3.SystemProgram.programId,
                    tokenProgram: TOKEN_PROGRAM_ID,
                    operator: operator.publicKey,
                })
                .signers([claimant, operator])
                .rpc();
        }
    }

    async claimLocked(params: ClaimLockedParams) {
        const { claimant, distributorPDA, operator } = params;

        const distributorState =
            await this.program.account.merkleDistributor.fetch(distributorPDA);
        const claimStatusPDA = this.claimStatusPDA(distributorPDA, claimant.publicKey);
        const to = await createAssociatedTokenAccount(
            this.provider.context,
            this.mint.publicKey,
            claimant.publicKey,
        );

        if (!operator) {
            await this.program.methods
                .claimLocked()
                .accountsPartial({
                    distributor: distributorPDA,
                    claimant: claimant.publicKey,
                    claimStatus: claimStatusPDA,
                    from: distributorState.tokenVault,
                    to,
                    tokenProgram: TOKEN_PROGRAM_ID,
                    operator: undefined,
                })
                .signers([claimant])
                .rpc();
        } else {
            await this.program.methods
                .claimLocked()
                .accountsPartial({
                    distributor: distributorPDA,
                    claimant: claimant.publicKey,
                    claimStatus: claimStatusPDA,
                    from: distributorState.tokenVault,
                    to,
                    tokenProgram: TOKEN_PROGRAM_ID,
                    operator: operator.publicKey,
                })
                .signers([claimant, operator])
                .rpc();
        }
    }

    async clawBack(params: ClawbackParams) {
        const { distributor } = params;

        const distributorState = await this.program.account.merkleDistributor.fetch(distributor);

        await this.program.methods
            .clawback()
            .accountsPartial({
                distributor,
                from: distributorState.tokenVault,
                clawbackReceiver: distributorState.clawbackReceiver,
                tokenProgram: TOKEN_PROGRAM_ID,
            })
            .rpc();
    }

    async setNextBlockTimestamp(timestamp: number) {
        const clock = await this.provider.context.banksClient.getClock();
        this.provider.context.setClock(
            new Clock(
                clock.slot,
                clock.epochStartTimestamp,
                clock.epoch,
                clock.leaderScheduleEpoch,
                BigInt(timestamp),
            ),
        );
    }

    async advanceTime(secondsElapsed: number) {
        const currentTS = await this.currentTimestamp();
        const nextTS = currentTS + secondsElapsed;
        await this.setNextBlockTimestamp(nextTS);

        return nextTS;
    }

    async currentTimestamp() {
        const clock = await this.provider.context.banksClient.getClock();
        return Number(clock.unixTimestamp);
    }

    admin() {
        return this.wallets[WalletIndex.ADMIN];
    }

    distributorAdmin() {
        return this.wallets[WalletIndex.DISTRIBUTOR_ADMIN];
    }

    operator() {
        return this.wallets[WalletIndex.OPERATOR];
    }

    distributorPDA(base: web3.PublicKey, mint: web3.PublicKey, version: number) {
        console.log("^^^^^^^^^^^^^^^^^^^^^^^^^");
        console.log(base);
        console.log(mint);
        console.log("^^^^^^^^^^^^^^^^^^^^^^^^^");
        const [pda] = web3.PublicKey.findProgramAddressSync(
            [
                Buffer.from("MerkleDistributor"),
                base.toBuffer(),
                mint.toBuffer(),
                encodeU64(version),
            ],
            this.program.programId,
        );
        return pda;
    }

    claimStatusPDA(distributor: web3.PublicKey, claimant: web3.PublicKey) {
        const [pda] = web3.PublicKey.findProgramAddressSync(
            [Buffer.from("ClaimStatus"), claimant.toBuffer(), distributor.toBuffer()],
            this.program.programId,
        );
        return pda;
    }
}
