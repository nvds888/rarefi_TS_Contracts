// AlphaYieldFactory.algo.ts - rare.fi pool lifecycle App (specifically tailored to $ALPHA)

import {
  Contract,
  GlobalState,
  itxn,
  gtxn,
  Global,
  assert,
  Uint64,
  uint64,
  Account,
  Asset,
  TemplateVar,
} from '@algorandfoundation/algorand-typescript';
import { mulw, divmodw } from '@algorandfoundation/algorand-typescript/op'


const MINT_FEE_BPS: uint64 = Uint64(50);              // 0.50%
const EARLY_REDEEM_FEE_BPS: uint64 = Uint64(150);     // 1.50%
const BPS_DIVISOR: uint64 = Uint64(10_000);           // basis points divisor
const MIN_DEPOSIT_UNITS: uint64 = Uint64(1_000_000);  // 1 token if asset has 6 decimals
const THIRTY_DAYS_SEC: uint64 = Uint64(2_592_000);    // 30 * 24 * 60 * 60

export class AlphaYieldFactory extends Contract {
  // Global state 
  creator = GlobalState<Account>();
  alphaAssetId = GlobalState<uint64>();
  ptAssetId = GlobalState<uint64>();
  ytAssetId = GlobalState<uint64>();
  usdcAssetId = GlobalState<uint64>();
  startMintTimestamp = GlobalState<uint64>();
  mintEndTimestamp = GlobalState<uint64>();
  maturityTimestamp = GlobalState<uint64>();
  totalAlphaLocked = GlobalState<uint64>();
  isPaused = GlobalState<boolean>();

// using the mulw and divmodw opcodes to avoid overflow/underflow for divisions (128bit)
  private mulDivFloor(n1: uint64, n2: uint64, d: uint64): uint64 {
    const [hi, lo] = mulw(n1, n2);
    const [q_hi, q_lo, _r_hi, _r_lo] = divmodw(hi, lo, Uint64(0), d);
    assert(q_hi === Uint64(0), 'mulDiv overflow');
    return q_lo;
  }

  // Create App 
  createApplication(
    startMint: uint64,
    mintEnd: uint64,
    maturity: uint64,
    alphaId: uint64,
    ptId: uint64,
    ytId: uint64,
    usdcId: uint64
  ): void {
    assert(startMint < mintEnd, 'Start mint must be before mint end');
    assert(mintEnd < maturity, 'Mint end must be before maturity');

    this.creator.value = Global.creatorAddress;
    this.startMintTimestamp.value = startMint;
    this.mintEndTimestamp.value = mintEnd;
    this.maturityTimestamp.value = maturity;
    this.alphaAssetId.value = alphaId;
    this.ptAssetId.value = ptId;
    this.ytAssetId.value = ytId;
    this.usdcAssetId.value = usdcId;
    this.totalAlphaLocked.value = Uint64(0);
    this.isPaused.value = false;
  }

  // Phase 0: Contract opt-in to assets (creator only) 
  optInAssets(): void {
    assert(Global.creatorAddress === this.creator.value, 'Only creator can opt-in');

    const appAddr: Account = Global.currentApplicationAddress;

    itxn.assetTransfer({
      assetReceiver: appAddr,
      xferAsset: Asset(this.alphaAssetId.value),
      assetAmount: Uint64(0),
      fee: Uint64(0),
    }).submit();

    itxn.assetTransfer({
      assetReceiver: appAddr,
      xferAsset: Asset(this.usdcAssetId.value),
      assetAmount: Uint64(0),
      fee: Uint64(0),
    }).submit();

    itxn.assetTransfer({
      assetReceiver: appAddr,
      xferAsset: Asset(this.ptAssetId.value),
      assetAmount: Uint64(0),
      fee: Uint64(0),
    }).submit();

    itxn.assetTransfer({
      assetReceiver: appAddr,
      xferAsset: Asset(this.ytAssetId.value),
      assetAmount: Uint64(0),
      fee: Uint64(0),
    }).submit();
  }

  // Phase 1: Mint PT + YT by depositing underlying asset + mint fee 
  mintTokens(): void {
    assert(!this.isPaused.value, 'Minting is paused');
    assert(Global.latestTimestamp >= this.startMintTimestamp.value, 'Minting not started');
    assert(Global.latestTimestamp <= this.mintEndTimestamp.value, 'Minting period ended');

    assert(gtxn.ApplicationCallTxn(1).groupIndex === Uint64(1), 'Must be transaction 1 in group');
    assert(Global.groupSize === Uint64(2), 'Group must have 2 transactions');

    const alphaTransfer = gtxn.AssetTransferTxn(0);

    assert(alphaTransfer.xferAsset === Asset(this.alphaAssetId.value), 'Must transfer Alpha asset');
    assert(alphaTransfer.assetReceiver === Global.currentApplicationAddress, 'Must send Alpha to contract');
    assert(alphaTransfer.sender === gtxn.ApplicationCallTxn(1).sender, 'Sender mismatch');

    const depositAmount = alphaTransfer.assetAmount;

    assert(depositAmount >= MIN_DEPOSIT_UNITS, 'Deposit too small (min 1 token)');

    const feeAmount: uint64 = this.mulDivFloor(depositAmount, MINT_FEE_BPS, BPS_DIVISOR);
    const amountAfterFee: uint64 = depositAmount - feeAmount;

    assert(amountAfterFee >= MIN_DEPOSIT_UNITS, 'Amount after fee too small');

    this.totalAlphaLocked.value = this.totalAlphaLocked.value + amountAfterFee;

    if (feeAmount > Uint64(0)) {
      itxn.assetTransfer({
        assetReceiver: this.creator.value,
        xferAsset: Asset(this.alphaAssetId.value),
        assetAmount: feeAmount,
        fee: Uint64(0),
      }).submit();
    }

    itxn.assetTransfer({
      assetReceiver: alphaTransfer.sender,
      xferAsset: Asset(this.ptAssetId.value),
      assetAmount: amountAfterFee,
      fee: Uint64(0),
    }).submit();

    itxn.assetTransfer({
      assetReceiver: alphaTransfer.sender,
      xferAsset: Asset(this.ytAssetId.value),
      assetAmount: amountAfterFee,
      fee: Uint64(0),
    }).submit();
  }

  // Phase 2: Redeem underlying asset by returning PT + YT (fee applies after mint phase)
redeemTokens(): void {
  assert(!this.isPaused.value, 'Redemption is paused');
  assert(Global.latestTimestamp >= this.startMintTimestamp.value, 'Redemption not available yet');
  assert(Global.latestTimestamp <= this.maturityTimestamp.value, 'Maturity period ended');

  assert(gtxn.ApplicationCallTxn(2).groupIndex === Uint64(2), 'Must be transaction 2 in group');
  assert(Global.groupSize === Uint64(3), 'Group must have 3 transactions');

  const ptTransfer = gtxn.AssetTransferTxn(0);
  const ytTransfer = gtxn.AssetTransferTxn(1);

  assert(ptTransfer.xferAsset === Asset(this.ptAssetId.value), 'Must transfer PT asset');
  assert(ptTransfer.assetReceiver === Global.currentApplicationAddress, 'Must send PT to contract');

  assert(ytTransfer.xferAsset === Asset(this.ytAssetId.value), 'Must transfer YT asset');
  assert(ytTransfer.assetReceiver === Global.currentApplicationAddress, 'Must send YT to contract');

  assert(ptTransfer.assetAmount === ytTransfer.assetAmount, 'PT and YT amounts must match');
  assert(ptTransfer.sender === ytTransfer.sender, 'Sender mismatch');
  assert(ptTransfer.sender === gtxn.ApplicationCallTxn(2).sender, 'Caller mismatch');

  const redeemAmount = ptTransfer.assetAmount;

  assert(redeemAmount >= MIN_DEPOSIT_UNITS, 'Redemption too small (min 1 token)');

  assert(this.totalAlphaLocked.value >= redeemAmount, 'Insufficient locked Alpha for redemption');

  let feeAmount: uint64 = Uint64(0);
  let amountAfterFee: uint64 = redeemAmount;

  // Only apply fee if after the mint phase
  if (Global.latestTimestamp > this.mintEndTimestamp.value) {
    feeAmount = this.mulDivFloor(redeemAmount, EARLY_REDEEM_FEE_BPS, BPS_DIVISOR);
    amountAfterFee = redeemAmount - feeAmount;
    assert(amountAfterFee >= MIN_DEPOSIT_UNITS, 'Amount after fee too small');
  }

  this.totalAlphaLocked.value = this.totalAlphaLocked.value - redeemAmount;

  if (feeAmount > Uint64(0)) {
    itxn.assetTransfer({
      assetReceiver: this.creator.value,
      xferAsset: Asset(this.alphaAssetId.value),
      assetAmount: feeAmount,
      fee: Uint64(0),
    }).submit();
  }

  itxn.assetTransfer({
    assetReceiver: ptTransfer.sender,
    xferAsset: Asset(this.alphaAssetId.value),
    assetAmount: amountAfterFee,
    fee: Uint64(0),
  }).submit();
}

  //Phase 3: PT → Alpha 1:1 (no fee) 
  redeemPtMature(): void {
    assert(!this.isPaused.value, 'Redemption is paused');
    assert(Global.latestTimestamp > this.maturityTimestamp.value, 'Maturity not reached');

    assert(gtxn.ApplicationCallTxn(1).groupIndex === Uint64(1), 'Must be transaction 1 in group');
    assert(Global.groupSize === Uint64(2), 'Group must have 2 transactions');

    const ptTransfer = gtxn.AssetTransferTxn(0);

    assert(ptTransfer.xferAsset === Asset(this.ptAssetId.value), 'Must transfer PT asset');
    assert(ptTransfer.assetReceiver === Global.currentApplicationAddress, 'Must send PT to contract');
    assert(ptTransfer.sender === gtxn.ApplicationCallTxn(1).sender, 'Sender mismatch');

    const redeemAmount = ptTransfer.assetAmount;

    assert(redeemAmount >= MIN_DEPOSIT_UNITS, 'Redemption too small (min 1 token)');

    assert(this.totalAlphaLocked.value >= redeemAmount, 'Insufficient locked Alpha for mature redemption');

    this.totalAlphaLocked.value = this.totalAlphaLocked.value - redeemAmount;

    itxn.assetTransfer({
      assetReceiver: ptTransfer.sender,
      xferAsset: Asset(this.alphaAssetId.value),
      assetAmount: redeemAmount,
      fee: Uint64(0),
    }).submit();
  }

  // Phase 3: Claim USDC yield with YT (based on YT circulating supply)
  claimYtYield(): void {
    assert(!this.isPaused.value, 'Redemption is paused');
    assert(Global.latestTimestamp > this.maturityTimestamp.value, 'Maturity not reached');

    assert(gtxn.ApplicationCallTxn(1).groupIndex === Uint64(1), 'Must be transaction 1 in group');
    assert(Global.groupSize === Uint64(2), 'Group must have 2 transactions');

    const ytTransfer = gtxn.AssetTransferTxn(0);

    assert(ytTransfer.xferAsset === Asset(this.ytAssetId.value), 'Must transfer YT asset');
    assert(ytTransfer.assetReceiver === Global.currentApplicationAddress, 'Must send YT to contract');
    assert(ytTransfer.sender === gtxn.ApplicationCallTxn(1).sender, 'Sender mismatch');

    const userYtAmount = ytTransfer.assetAmount;

    assert(userYtAmount > Uint64(0), 'YT amount must be positive');

    const appAddr: Account = Global.currentApplicationAddress;

    const usdcBalance = Asset(this.usdcAssetId.value).balance(appAddr);
    assert(usdcBalance >= Uint64(1), 'No USDC available');

    const ytAsset = Asset(this.ytAssetId.value);
    const ytTotalSupply = ytAsset.total;

    const contractYtBalanceAfter = ytAsset.balance(appAddr);
    const contractYtBalanceBefore: uint64 = contractYtBalanceAfter - userYtAmount;

    const circulatingSupply: uint64 = ytTotalSupply - contractYtBalanceBefore;
    assert(circulatingSupply > Uint64(0), 'No circulating supply');
    assert(circulatingSupply >= userYtAmount, 'Invalid circulating supply calculation');

    const userShare: uint64 = this.mulDivFloor(userYtAmount, usdcBalance, circulatingSupply);
  assert(userShare > Uint64(0), 'Share must be positive');

  assert(userShare <= usdcBalance, 'Insufficient USDC balance');

    itxn.assetTransfer({
      assetReceiver: ytTransfer.sender,
      xferAsset: Asset(this.usdcAssetId.value),
      assetAmount: userShare,
      fee: Uint64(0),
    }).submit();
  }

  // Creator: withdraw any leftovers (creator only, ≥30d after maturity) 
  withdrawAllBalances(): void {
    assert(Global.creatorAddress === this.creator.value, 'Only creator can withdraw');

    assert(
      Global.latestTimestamp > this.maturityTimestamp.value + THIRTY_DAYS_SEC,
      'Must wait 30 days after maturity'
    );

    const appAddr: Account = Global.currentApplicationAddress;

    const alphaBalance = Asset(this.alphaAssetId.value).balance(appAddr);
    if (alphaBalance > Uint64(0)) {
      itxn.assetTransfer({
        assetReceiver: this.creator.value,
        xferAsset: Asset(this.alphaAssetId.value),
        assetAmount: alphaBalance,
        fee: Uint64(0),
      }).submit();
    }

    const usdcBalance = Asset(this.usdcAssetId.value).balance(appAddr);
    if (usdcBalance > Uint64(0)) {
      itxn.assetTransfer({
        assetReceiver: this.creator.value,
        xferAsset: Asset(this.usdcAssetId.value),
        assetAmount: usdcBalance,
        fee: Uint64(0),
      }).submit();
    }

    const ptBalance = Asset(this.ptAssetId.value).balance(appAddr);
    if (ptBalance > Uint64(0)) {
      itxn.assetTransfer({
        assetReceiver: this.creator.value,
        xferAsset: Asset(this.ptAssetId.value),
        assetAmount: ptBalance,
        fee: Uint64(0),
      }).submit();
    }

    const ytBalance = Asset(this.ytAssetId.value).balance(appAddr);
    if (ytBalance > Uint64(0)) {
      itxn.assetTransfer({
        assetReceiver: this.creator.value,
        xferAsset: Asset(this.ytAssetId.value),
        assetAmount: ytBalance,
        fee: Uint64(0),
      }).submit();
    }
  }

  // Admin options - for testing, and should be enabled/disabled appropriately for any mainnet deploy

  // pause minting/redemption
setPaused(paused: boolean): void {
  assert(Global.creatorAddress === this.creator.value, 'Only creator can pause/resume');
  this.isPaused.value = paused;
}

// update approval program
updateApplication(): void {
  assert(Global.creatorAddress === this.creator.value, 'Only creator can update');
  assert(TemplateVar<boolean>('UPDATABLE'), 'App is immutable');
}

// delete application
deleteApplication(): void {
  assert(Global.creatorAddress === this.creator.value, 'Only creator can delete');
  assert(TemplateVar<boolean>('DELETABLE'), 'App is permanent');
}
}
