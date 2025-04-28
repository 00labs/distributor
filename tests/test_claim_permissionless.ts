import * as anchor from "@coral-xyz/anchor";
import { Keypair, SystemProgram } from "@solana/web3.js";
import { BN } from "bn.js";
import { createAssociatedTokenAccount, getRandomInt, mintTo } from "./common";
import { Context } from "./merkle_distributor";
import { BalanceTree } from "./merkle_tree";

describe("Claim permissionless", function () {
    let ctx: Context;
    let tree: BalanceTree;
    let maxNumNodes = 5;
    let whitelistedKPs: Keypair[] = [];
    let amountUnlockedArr: anchor.BN[] = [];
    let amountLockedArr: anchor.BN[] = [];
    let totalClaim = new BN(0);

    before(async function () {
        ctx = new Context();
        await ctx.start();

        for (let i = 0; i < maxNumNodes; i++) {
            whitelistedKPs.push(ctx.wallets[i + 1]);
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
    });

    it("Full flow", async function () {
        console.log("create distributor");
        const currentTime = await ctx.currentTimestamp();
        const startVestingTs = new BN(currentTime + 3);
        const endVestingTs = new BN(currentTime + 6);
        const clawbackStartTs = new BN(currentTime + 7);
        const activationType = 1; // ActivationType is timestamp.
        const activationPoint = new BN(currentTime + 2);
        const closable = false;
        const totalBonus = new BN(0);
        const bonusVestingDuration = new BN(0);
        const claimType = 0;
        const operator = SystemProgram.programId;
        const locker = SystemProgram.programId;

        const clawbackReceiver = await createAssociatedTokenAccount(
            ctx.provider.context,
            ctx.mint.publicKey,
            ctx.admin().publicKey,
        );
        const { distributorPDA, tokenVault } = await ctx.createNewDistributor({
            admin: ctx.distributorAdmin(),
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
            clawbackReceiver,
        });
        await mintTo(
            ctx.provider.context,
            ctx.mint.publicKey,
            ctx.admin(),
            tokenVault,
            totalClaim.toNumber(),
        );

        await ctx.setNextBlockTimestamp(activationPoint.toNumber());
        console.log("claim");
        for (let i = 0; i < maxNumNodes - 1; i++) {
            const proofBuffers = tree.getProof(
                whitelistedKPs[i].publicKey,
                amountUnlockedArr[i],
                amountLockedArr[i],
            );
            const proof: number[][] = [];
            proofBuffers.forEach(function (value) {
                proof.push(Array.from(new Uint8Array(value)));
            });
            console.log("claim index: ", i);
            await ctx.claim({
                distributorPDA,
                claimant: whitelistedKPs[i],
                amountUnlocked: amountUnlockedArr[i],
                amountLocked: amountLockedArr[i],
                proof,
            });
        }

        await ctx.setNextBlockTimestamp(startVestingTs.toNumber() + 1);
        console.log("claim locked");
        for (let i = 0; i < maxNumNodes - 1; i++) {
            console.log("claim locked index: ", i);
            await ctx.claimLocked({
                distributorPDA,
                claimant: whitelistedKPs[i],
            });
        }

        await ctx.setNextBlockTimestamp(clawbackStartTs.toNumber());
        console.log("clawback");
        await ctx.clawBack({
            distributor: distributorPDA,
            payer: ctx.admin(),
        });
    });
});
