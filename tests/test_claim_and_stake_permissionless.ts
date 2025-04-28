import * as anchor from "@coral-xyz/anchor";
import { web3 } from "@coral-xyz/anchor";
import { createMint, mintTo, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Keypair, PublicKey } from "@solana/web3.js";
import { BN } from "bn.js";
import {
    createAndFundWallet,
    getBlockTime,
    getOrCreateAssociatedTokenAccountWrap,
    getRandomInt,
    sleep,
} from "./common";
import { createNewEscrowWithMaxLock, setupLocker } from "./locked_voter/setup";
import {
    ADMIN,
    claimAndStake,
    claimLockedAndStake,
    clawBack,
    createNewDistributor,
} from "./merkle_distributor";
import { BalanceTree } from "./merkle_tree";
const provider = anchor.AnchorProvider.env();

describe("Claim and stake permissionless", function() {
    let admin: Keypair;
    let tree: BalanceTree;
    let maxNumNodes = 5;
    let whitelistedKPs: web3.Keypair[] = [];
    let amountUnlockedArr: anchor.BN[] = [];
    let amountLockedArr: anchor.BN[] = [];
    let totalClaim = new BN(0);
    let mint: PublicKey;
    let locker: PublicKey;
    let escrow: PublicKey;

    before(async function() {
        admin = Keypair.generate();

        let escrowOwner = Keypair.generate();
        await createAndFundWallet(provider.connection, ADMIN);
        await createAndFundWallet(provider.connection, admin);
        await createAndFundWallet(provider.connection, escrowOwner);

        for (let i = 0; i < maxNumNodes; i++) {
            const result = await createAndFundWallet(provider.connection);
            whitelistedKPs.push(result.keypair);
            let amountUnlocked = new BN(getRandomInt(1000, 20000));
            let amountLocked = new BN(getRandomInt(1000, 20000));

            amountUnlockedArr.push(amountUnlocked);
            amountLockedArr.push(amountLocked);
            totalClaim = totalClaim.add(amountUnlocked).add(amountLocked);
        }

        tree = new BalanceTree(
            whitelistedKPs.map((kp, index) => {
                return {
                    account: kp.publicKey,
                    amountUnlocked: amountUnlockedArr[index],
                    amountLocked: amountLockedArr[index],
                };
            }),
        );

        mint = await createMint(
            provider.connection,
            ADMIN,
            ADMIN.publicKey,
            null,
            6,
            web3.Keypair.generate(),
            {
                commitment: "confirmed",
            },
            TOKEN_PROGRAM_ID,
        );

        console.log("create locker");
        locker = await setupLocker({
            payer: ADMIN,
            tokenMint: mint,
            maxStakeVoteMultiplier: 1,
            minStakeDuration: new BN(10),
            maxStakeDuration: new BN(10000),
            proposalActivationMinVotes: new BN(100),
        });

        console.log("create escrow");
        escrow = await createNewEscrowWithMaxLock({
            locker,
            escrowOwner,
        });
    });

    it("Full flow", async function() {
        console.log("create distributor");
        let currentTime = await getBlockTime(provider.connection);
        let startVestingTs = new BN(currentTime + 3);
        let endVestingTs = new BN(currentTime + 6);
        let clawbackStartTs = new BN(currentTime + 7);
        let activationType = 1; // timestamp
        let activationPoint = new BN(currentTime + 2);
        let closable = false;
        let totalBonus = new BN(0);
        let bonusVestingDuration = new BN(0);
        let claimType = 2;
        let operator = web3.SystemProgram.programId;

        let clawbackReceiver = await getOrCreateAssociatedTokenAccountWrap(
            provider.connection,
            ADMIN,
            mint,
            ADMIN.publicKey,
        );
        let { distributor, tokenVault } = await createNewDistributor({
            admin,
            version: 0,
            root: tree.getRoot(),
            totalClaim,
            maxNumNodes: new BN(maxNumNodes),
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
            mint,
            clawbackReceiver,
        });
        // mint
        await mintTo(provider.connection, ADMIN, mint, tokenVault, ADMIN, totalClaim.toNumber());

        while (currentTime <= activationPoint.toNumber()) {
            currentTime = await getBlockTime(provider.connection);
            await sleep(1000);
            console.log("Wait until activationPoint");
        }

        console.log("claim and stake");
        for (let i = 0; i < maxNumNodes - 1; i++) {
            const proofBuffers = tree.getProof(
                whitelistedKPs[i].publicKey,
                amountUnlockedArr[i],
                amountLockedArr[i],
            );
            let proof = [];
            proofBuffers.forEach(function (value) {
                proof.push(Array.from(new Uint8Array(value)));
            });
            console.log("claim index: ", i);
            await claimAndStake({
                distributor,
                claimant: whitelistedKPs[i],
                amountUnlocked: amountUnlockedArr[i],
                amountLocked: amountLockedArr[i],
                proof,
                escrow,
            });
        }

        while (currentTime <= startVestingTs.toNumber()) {
            currentTime = await getBlockTime(provider.connection);
            await sleep(1000);
            console.log("Wait until startVestingTs");
        }
        console.log("claim locked");
        for (let i = 0; i < maxNumNodes - 1; i++) {
            console.log("claim locked index: ", i);
            await claimLockedAndStake({
                distributor,
                claimant: whitelistedKPs[i],
                escrow,
            });
        }

        while (currentTime <= clawbackStartTs.toNumber()) {
            currentTime = await getBlockTime(provider.connection);
            await sleep(1000);
            console.log("Wait until clawbackStartTs");
        }
        console.log("clawback");
        await clawBack({
            distributor,
            payer: ADMIN,
        });
    });
});
