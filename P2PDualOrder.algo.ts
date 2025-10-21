// P2PDualOrder.algo.ts - P2P trading with 2 orders per user, partial fills, cancelation
// PT orders trade in ALPHA, YT orders trade in USDC

import {
    Contract,
    GlobalState,
    LocalState,
    itxn,
    gtxn,
    Global,
    assert,
    Uint64,
    uint64,
    Account,
    Asset,
    baremethod
  } from '@algorandfoundation/algorand-typescript';
  import { mulw, divmodw } from '@algorandfoundation/algorand-typescript/op';
  
  const PLATFORM_FEE_BPS: uint64 = Uint64(50); // 0.50%
  const BPS_DIVISOR: uint64 = Uint64(10_000);
  const ONE_YEAR_SECONDS: uint64 = Uint64(31_536_000); // 365 * 24 * 60 * 60
  const MIN_ORDER_UNITS: uint64 = Uint64(1_000_000); // 1 token with 6 decimals
  
  // Order types
  const ORDER_TYPE_PT: uint64 = Uint64(0);
  const ORDER_TYPE_YT: uint64 = Uint64(1);
  
  // Order slots
  const ORDER_SLOT_1: uint64 = Uint64(1);
  const ORDER_SLOT_2: uint64 = Uint64(2);
  
  export class P2PDualOrder extends Contract {
    // Global State 
    emergencyAdmin = GlobalState<Account>();
    alphaAssetId = GlobalState<uint64>();
    ptAssetId = GlobalState<uint64>();
    ytAssetId = GlobalState<uint64>();
    usdcAssetId = GlobalState<uint64>();
    withdrawalTimestamp = GlobalState<uint64>();
  
    // Local State (per user, 2 order slots) 
    // Order 1
    order1Id = LocalState<uint64>();
    order1Type = LocalState<uint64>();
    order1Qty = LocalState<uint64>();
    order1PricePerUnit = LocalState<uint64>();
    order1FilledQty = LocalState<uint64>();
  
    // Order 2
    order2Id = LocalState<uint64>();
    order2Type = LocalState<uint64>();
    order2Qty = LocalState<uint64>();
    order2PricePerUnit = LocalState<uint64>();
    order2FilledQty = LocalState<uint64>();
  
    // 128-bit multiplication and division using mulw and divmodw to prevent overflow/underflow issues
    private mulDivFloor(n1: uint64, n2: uint64, d: uint64): uint64 {
      const [hi, lo] = mulw(n1, n2);
      const [q_hi, q_lo, _r_hi, _r_lo] = divmodw(hi, lo, Uint64(0), d);
      assert(q_hi === Uint64(0), 'mulDiv overflow');
      return q_lo;
    }
  
    // Create Application 
    createApplication(
      alphaId: uint64,
      ptId: uint64,
      ytId: uint64,
      usdcId: uint64
    ): void {
      this.emergencyAdmin.value = Global.creatorAddress;
      this.alphaAssetId.value = alphaId;
      this.ptAssetId.value = ptId;
      this.ytAssetId.value = ytId;
      this.usdcAssetId.value = usdcId;
      
      // Set withdrawal timestamp to 1 year from now
      this.withdrawalTimestamp.value = Global.latestTimestamp + ONE_YEAR_SECONDS;
    }

    @baremethod({ allowActions: 'OptIn' })
    optIn(): void {
      // Handles bare App opt-ins to initialize localstate
    }
  
    // Opt-in to Assets (creator only) 
    optInAssets(): void {
      assert(gtxn.ApplicationCallTxn(0).sender === Global.creatorAddress, 'Only creator can opt-in');
  
      const appAddr: Account = Global.currentApplicationAddress;
  
      // Opt into Alpha
      itxn.assetTransfer({
        assetReceiver: appAddr,
        xferAsset: Asset(this.alphaAssetId.value),
        assetAmount: Uint64(0),
        fee: Uint64(0),
      }).submit();
  
      // Opt into PT
      itxn.assetTransfer({
        assetReceiver: appAddr,
        xferAsset: Asset(this.ptAssetId.value),
        assetAmount: Uint64(0),
        fee: Uint64(0),
      }).submit();
  
      // Opt into YT
      itxn.assetTransfer({
        assetReceiver: appAddr,
        xferAsset: Asset(this.ytAssetId.value),
        assetAmount: Uint64(0),
        fee: Uint64(0),
      }).submit();
  
      // Opt into USDC
      itxn.assetTransfer({
        assetReceiver: appAddr,
        xferAsset: Asset(this.usdcAssetId.value),
        assetAmount: Uint64(0),
        fee: Uint64(0),
      }).submit();
    }
  
    //Create Order
createOrder(
  assetType: uint64,
  quantity: uint64,
  pricePerUnit: uint64,
  orderId: uint64
): void {
  assert(Global.groupSize === Uint64(2), 'Must be 2-transaction group');
  assert(gtxn.ApplicationCallTxn(1).groupIndex === Uint64(1), 'App call must be txn 1');

  const depositTxn = gtxn.AssetTransferTxn(0);
  const sender = gtxn.ApplicationCallTxn(1).sender;

  assert(depositTxn.sender === sender, 'Sender mismatch');
  assert(depositTxn.assetReceiver === Global.currentApplicationAddress, 'Must send to contract');
  assert(depositTxn.assetAmount === quantity, 'Amount mismatch');

  const expectedAsset = assetType === ORDER_TYPE_PT 
    ? Asset(this.ptAssetId.value) 
    : Asset(this.ytAssetId.value);
  assert(depositTxn.xferAsset === expectedAsset, 'Wrong asset type');

  assert(quantity >= MIN_ORDER_UNITS, 'Order too small (min 1 token)');
  assert(pricePerUnit > Uint64(0), 'Price must be positive');
  assert(orderId > Uint64(0), 'Order ID must be positive');
  assert(
    assetType === ORDER_TYPE_PT || assetType === ORDER_TYPE_YT,
    'Invalid asset type'
  );

  // Check if order1 exists and is available 
  const order1Exists = this.order1Qty(sender).hasValue;
  const order1Qty = order1Exists ? this.order1Qty(sender).value : Uint64(0);
  const order1Filled = order1Exists ? this.order1FilledQty(sender).value : Uint64(0);
  const order1Available = !order1Exists || order1Filled >= order1Qty;

  if (order1Available) {
    // Use slot 1
    this.order1Id(sender).value = orderId;
    this.order1Type(sender).value = assetType;
    this.order1Qty(sender).value = quantity;
    this.order1PricePerUnit(sender).value = pricePerUnit;
    this.order1FilledQty(sender).value = Uint64(0);
  } else {
    // Check slot 2 
    const order2Exists = this.order2Qty(sender).hasValue;
    const order2Qty = order2Exists ? this.order2Qty(sender).value : Uint64(0);
    const order2Filled = order2Exists ? this.order2FilledQty(sender).value : Uint64(0);
    const order2Available = !order2Exists || order2Filled >= order2Qty;

    assert(order2Available, 'No order slots available');

    // Use slot 2
    this.order2Id(sender).value = orderId;
    this.order2Type(sender).value = assetType;
    this.order2Qty(sender).value = quantity;
    this.order2PricePerUnit(sender).value = pricePerUnit;
    this.order2FilledQty(sender).value = Uint64(0);
  }
}
  
    // Fill Order (Partial or Full)
    fillOrder(
      seller: Account,
      orderSlot: uint64,  // 1 or 2
      orderId: uint64,
      fillQty: uint64     // Amount to buy
    ): void {
      assert(Global.groupSize === Uint64(2), 'Must be 2-transaction group');
      assert(gtxn.ApplicationCallTxn(1).groupIndex === Uint64(1), 'App call must be txn 1');
  
      const paymentTxn = gtxn.AssetTransferTxn(0);
      const buyer = gtxn.ApplicationCallTxn(1).sender;
  
      assert(paymentTxn.sender === buyer, 'Sender mismatch');
      assert(paymentTxn.assetReceiver === Global.currentApplicationAddress, 'Must pay to contract');
  
      // Validate inputs
      assert(fillQty >= MIN_ORDER_UNITS, 'Fill amount too small (min 1 token)');
      assert(orderSlot === ORDER_SLOT_1 || orderSlot === ORDER_SLOT_2, 'Invalid order slot');
  
      // Get order details based on slot
      let orderIdStored: uint64;
      let orderType: uint64;
      let orderQty: uint64;
      let pricePerUnit: uint64;
      let filledQty: uint64;
  
      if (orderSlot === ORDER_SLOT_1) {
        orderIdStored = this.order1Id(seller).value;
        orderType = this.order1Type(seller).value;
        orderQty = this.order1Qty(seller).value;
        pricePerUnit = this.order1PricePerUnit(seller).value;
        filledQty = this.order1FilledQty(seller).value;
      } else {
        orderIdStored = this.order2Id(seller).value;
        orderType = this.order2Type(seller).value;
        orderQty = this.order2Qty(seller).value;
        pricePerUnit = this.order2PricePerUnit(seller).value;
        filledQty = this.order2FilledQty(seller).value;
      }
  
      // Verify order exists and matches
      assert(orderIdStored === orderId, 'Order ID mismatch');
      assert(orderIdStored > Uint64(0), 'Order does not exist');
  
      // Calculate remaining quantity 
      const remainingQty: uint64 = orderQty - filledQty;
      assert(remainingQty > Uint64(0), 'Order fully filled');
      assert(fillQty <= remainingQty, 'Fill exceeds remaining quantity');
  
      // Calculate required payment using mulDivFloor
      const requiredPayment: uint64 = this.mulDivFloor(fillQty, pricePerUnit, Uint64(1_000_000));
      assert(requiredPayment > Uint64(0), 'Payment too small');
  
      // Verify payment asset and amount
      const expectedPaymentAsset = orderType === ORDER_TYPE_PT
        ? Asset(this.alphaAssetId.value)  // PT orders pay in ALPHA
        : Asset(this.usdcAssetId.value);   // YT orders pay in USDC
      
      assert(paymentTxn.xferAsset === expectedPaymentAsset, 'Wrong payment asset');
      assert(paymentTxn.assetAmount === requiredPayment, 'Payment amount mismatch');
  
      // Calculate platform fee using mulDivFloor
      const platformFee: uint64 = this.mulDivFloor(requiredPayment, PLATFORM_FEE_BPS, BPS_DIVISOR);
      
      const sellerPayment: uint64 = requiredPayment - platformFee;
  
      // Update filled quantity 
      const newFilledQty: uint64 = filledQty + fillQty;
      if (orderSlot === ORDER_SLOT_1) {
        this.order1FilledQty(seller).value = newFilledQty;
      } else {
        this.order2FilledQty(seller).value = newFilledQty;
      }
  
      // Send payment to seller (minus fee)
      itxn.assetTransfer({
        assetReceiver: seller,
        xferAsset: expectedPaymentAsset,
        assetAmount: sellerPayment,
        fee: Uint64(0),
      }).submit();
  
      // Send platform fee to admin
      if (platformFee > Uint64(0)) {
        itxn.assetTransfer({
          assetReceiver: this.emergencyAdmin.value,
          xferAsset: expectedPaymentAsset,
          assetAmount: platformFee,
          fee: Uint64(0),
        }).submit();
      }
  
      // Send PT/YT to buyer
      const assetToSend = orderType === ORDER_TYPE_PT
        ? Asset(this.ptAssetId.value)
        : Asset(this.ytAssetId.value);
  
      itxn.assetTransfer({
        assetReceiver: buyer,
        xferAsset: assetToSend,
        assetAmount: fillQty,
        fee: Uint64(0),
      }).submit();
    }
  
    // Cancel Order 
    cancelOrder(seller: Account, orderSlot: uint64): void {
      assert(gtxn.ApplicationCallTxn(0).groupIndex === Uint64(0), 'Must be transaction 0 in group');
      assert(Global.groupSize === Uint64(1), 'Must be single transaction');
  
      const caller = gtxn.ApplicationCallTxn(0).sender;
  
      // Authorization check
      const isSellerOrAdmin = caller === seller || caller === this.emergencyAdmin.value;
      assert(isSellerOrAdmin, 'Only seller or admin can cancel');
  
      assert(orderSlot === ORDER_SLOT_1 || orderSlot === ORDER_SLOT_2, 'Invalid order slot');
  
      // Get order details
      let orderType: uint64;
      let orderQty: uint64;
      let filledQty: uint64;
  
      if (orderSlot === ORDER_SLOT_1) {
        orderType = this.order1Type(seller).value;
        orderQty = this.order1Qty(seller).value;
        filledQty = this.order1FilledQty(seller).value;
      } else {
        orderType = this.order2Type(seller).value;
        orderQty = this.order2Qty(seller).value;
        filledQty = this.order2FilledQty(seller).value;
      }
  
      // Calculate remaining quantity 
      const remainingQty: uint64 = orderQty - filledQty;
      assert(remainingQty > Uint64(0), 'Nothing to cancel');
  
      // Return remaining tokens to seller
      const assetToReturn = orderType === ORDER_TYPE_PT
        ? Asset(this.ptAssetId.value)
        : Asset(this.ytAssetId.value);
  
      itxn.assetTransfer({
        assetReceiver: seller,
        xferAsset: assetToReturn,
        assetAmount: remainingQty,
        fee: Uint64(0),
      }).submit();
  
      // Mark order as fully filled (effectively canceling it)
      if (orderSlot === ORDER_SLOT_1) {
        this.order1FilledQty(seller).value = orderQty;
      } else {
        this.order2FilledQty(seller).value = orderQty;
      }
    }
  
    // Batch Cancel: Cancel Both Orders at Once
    cancelBothOrders(seller: Account): void {
      assert(gtxn.ApplicationCallTxn(0).groupIndex === Uint64(0), 'Must be transaction 0 in group');
      assert(Global.groupSize === Uint64(1), 'Must be single transaction');
  
      const caller = gtxn.ApplicationCallTxn(0).sender;
  
      // Authorization check
      const isSellerOrAdmin = caller === seller || caller === this.emergencyAdmin.value;
      assert(isSellerOrAdmin, 'Only seller or admin can cancel');
  
      let anyCanceled = false;
  
      // Try to cancel Order 1
      const order1Qty: uint64 = this.order1Qty(seller).value;
      const order1Filled: uint64 = this.order1FilledQty(seller).value;
      const order1Remaining: uint64 = order1Qty - order1Filled;
      
      if (order1Remaining > Uint64(0)) {
        const order1Type: uint64 = this.order1Type(seller).value;
        const assetToReturn = order1Type === ORDER_TYPE_PT
          ? Asset(this.ptAssetId.value)
          : Asset(this.ytAssetId.value);
        
        itxn.assetTransfer({
          assetReceiver: seller,
          xferAsset: assetToReturn,
          assetAmount: order1Remaining,
          fee: Uint64(0),
        }).submit();
        
        this.order1FilledQty(seller).value = order1Qty;
        anyCanceled = true;
      }
  
      // Try to cancel Order 2
      const order2Qty: uint64 = this.order2Qty(seller).value;
      const order2Filled: uint64 = this.order2FilledQty(seller).value;
      const order2Remaining: uint64 = order2Qty - order2Filled;
      
      if (order2Remaining > Uint64(0)) {
        const order2Type: uint64 = this.order2Type(seller).value;
        const assetToReturn = order2Type === ORDER_TYPE_PT
          ? Asset(this.ptAssetId.value)
          : Asset(this.ytAssetId.value);
        
        itxn.assetTransfer({
          assetReceiver: seller,
          xferAsset: assetToReturn,
          assetAmount: order2Remaining,
          fee: Uint64(0),
        }).submit();
        
        this.order2FilledQty(seller).value = order2Qty;
        anyCanceled = true;
      }
  
      assert(anyCanceled, 'No active orders to cancel');
    }
  
    //Withdraw Funds (creator after 1 year - safety feature) 
withdrawFunds(assetType: uint64, amount: uint64): void {
    assert(gtxn.ApplicationCallTxn(0).groupIndex === Uint64(0), 'Must be transaction 0 in group');
    assert(Global.groupSize === Uint64(1), 'Must be single transaction');
  
    const caller = gtxn.ApplicationCallTxn(0).sender;
  
    // Authorization check
    const isAuthorized = caller === Global.creatorAddress || caller === this.emergencyAdmin.value;
    assert(isAuthorized, 'Only creator or admin can withdraw');
  
    // Time check
    assert(Global.latestTimestamp >= this.withdrawalTimestamp.value, 'Withdrawal locked for 1 year');
  
    // Validate inputs
    assert(amount > Uint64(0), 'Amount must be positive');
  
    // Map asset type to asset ID
    let assetId: Asset;
    if (assetType === Uint64(0)) {
      assetId = Asset(this.ptAssetId.value);
    } else if (assetType === Uint64(1)) {
      assetId = Asset(this.ytAssetId.value);
    } else if (assetType === Uint64(2)) {
      assetId = Asset(this.usdcAssetId.value);
    } else if (assetType === Uint64(3)) {
      assetId = Asset(this.alphaAssetId.value);
    } else {
      assert(false, 'Invalid asset type');
    }
  
    // Send asset to caller
    itxn.assetTransfer({
      assetReceiver: caller,
      xferAsset: assetId,
      assetAmount: amount,
      fee: Uint64(0),
    }).submit();
  }
  }
