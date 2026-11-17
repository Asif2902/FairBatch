import type {
  BatchPhase,
  BatchSettlementDto,
  ClaimableDto,
  CommitmentDto,
  ComparisonDto,
  ContractAddressesDto,
  ContractConfigUpdatePayload,
  CurvePointDto,
  DemoWalletDto,
  ExecutionReceiptDto,
  FillOutcomeDto,
  FillStatus,
  HealthResponse,
  OrderDto,
  OrderSide,
  PresetId,
  ReserveSnapshotDto,
  ReservesDto,
  SignedDemoIntentResponse,
  StateResponse,
  SubmissionType,
} from '../types';
import {
  computeLocalCommitmentHash,
  computeLocalEip712Digest,
  keccak256Utf8,
} from './keccak';

const DEFAULT_RX = 100.0;
const DEFAULT_RY = 300_000.0;
const DEFAULT_FEE_BPS = 30;
const EPS = 1e-9;

export const DEMO_WALLETS: DemoWalletDto[] = [
  {
    index: 0,
    name: 'Alice (Retail)',
    address: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
  },
  {
    index: 1,
    name: 'Bob (DAO Treasury)',
    address: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
  },
  {
    index: 2,
    name: 'Carol (Desk)',
    address: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',
  },
  {
    index: 3,
    name: 'Dave (Quant)',
    address: '0x90F79bf6EB2c4f870365E785982E1f101E93b906',
  },
  {
    index: 4,
    name: 'Eve (Institutional)',
    address: '0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65',
  },
];

const MEV_BOT_ADDRESS = '0xDeaDbeefdEAdbeefdEadbEEFdeadbeEFdEaDbeeF';

function floor6(val: number): number {
  if (!Number.isFinite(val) || val <= 0) return 0;
  return Math.floor(val * 1e6 + 1e-7) / 1e6;
}

function makeReserves(rx: number, ry: number): ReservesDto {
  const spot = rx > EPS ? ry / rx : 0;
  return {
    rx,
    ry,
    spot_price: spot,
    k_invariant: rx * ry,
    base_symbol: 'WETH',
    quote_symbol: 'USDC',
    base_decimals: 18,
    quote_decimals: 6,
  };
}

function snapshotReserves(rx: number, ry: number): ReserveSnapshotDto {
  return {
    rx,
    ry,
    spot_price: rx > EPS ? ry / rx : 0,
    k_invariant: rx * ry,
  };
}

export function buildSupplyDemandCurves(
  orders: OrderDto[],
  spotPrice: number,
): { supply_curve: CurvePointDto[]; demand_curve: CurvePointDto[] } {
  const sellers = [...orders]
    .filter((o) => o.side === 'SellBase' && o.amount_in > 0)
    .sort((a, b) => a.limit_price - b.limit_price || a.order_id - b.order_id);

  const buyers = [...orders]
    .filter((o) => o.side === 'BuyBase' && o.amount_in > 0)
    .sort((a, b) => b.limit_price - a.limit_price || a.order_id - b.order_id);

  const supply_curve: CurvePointDto[] = [];
  let cumSellBase = 0;
  for (const s of sellers) {
    supply_curve.push({
      price: s.limit_price,
      cumulative_base: cumSellBase,
      label: s.label,
    });
    cumSellBase += s.amount_in;
    supply_curve.push({
      price: s.limit_price,
      cumulative_base: cumSellBase,
      label: s.label,
    });
  }

  const demand_curve: CurvePointDto[] = [];
  let cumBuyBase = 0;
  let cumBuyQuote = 0;
  for (const b of buyers) {
    const refPrice = b.limit_price > EPS ? b.limit_price : Math.max(spotPrice, 1);
    demand_curve.push({
      price: b.limit_price,
      cumulative_base: cumBuyBase,
      cumulative_quote: cumBuyQuote,
      label: b.label,
    });
    cumBuyQuote += b.amount_in;
    cumBuyBase += b.amount_in / refPrice;
    demand_curve.push({
      price: b.limit_price,
      cumulative_base: cumBuyBase,
      cumulative_quote: cumBuyQuote,
      label: b.label,
    });
  }

  return { supply_curve, demand_curve };
}

interface EquilibriumResult {
  clearingPrice: number;
  sellerFillFractions: Map<number, number>;
  buyerFillFractions: Map<number, number>;
  totalFilledSellBase: number;
  totalFilledBuyQuote: number;
}

function solveEquilibrium(
  rx: number,
  ry: number,
  orders: OrderDto[],
): EquilibriumResult {
  const sellers = [...orders]
    .filter((o) => o.side === 'SellBase' && o.amount_in > EPS)
    .sort((a, b) => a.limit_price - b.limit_price || a.order_id - b.order_id);

  const buyers = [...orders]
    .filter((o) => o.side === 'BuyBase' && o.amount_in > EPS)
    .sort((a, b) => b.limit_price - a.limit_price || a.order_id - b.order_id);

  const sellerFillFractions = new Map<number, number>();
  const buyerFillFractions = new Map<number, number>();

  if (sellers.length === 0 && buyers.length === 0) {
    return {
      clearingPrice: rx > EPS ? ry / rx : 0,
      sellerFillFractions,
      buyerFillFractions,
      totalFilledSellBase: 0,
      totalFilledBuyQuote: 0,
    };
  }

  // Pure P2P edge case (rx == 0 && ry == 0)
  if (rx <= EPS && ry <= EPS) {
    const totS = sellers.reduce((acc, s) => acc + s.amount_in, 0);
    const totD = buyers.reduce((acc, b) => acc + b.amount_in, 0);
    if (totS <= EPS || totD <= EPS) {
      return {
        clearingPrice: 0,
        sellerFillFractions,
        buyerFillFractions,
        totalFilledSellBase: 0,
        totalFilledBuyQuote: 0,
      };
    }
    const p = totD / totS;
    let sFill = 0;
    let dFill = 0;
    for (const s of sellers) {
      if (s.limit_price <= p + EPS) {
        sellerFillFractions.set(s.order_id, 1);
        sFill += s.amount_in;
      }
    }
    for (const b of buyers) {
      if (b.limit_price >= p - EPS) {
        buyerFillFractions.set(b.order_id, 1);
        dFill += b.amount_in;
      }
    }
    const effP = sFill > EPS && dFill > EPS ? dFill / sFill : 0;
    return {
      clearingPrice: effP,
      sellerFillFractions,
      buyerFillFractions,
      totalFilledSellBase: effP > 0 ? sFill : 0,
      totalFilledBuyQuote: effP > 0 ? dFill : 0,
    };
  }

  // Collect sorted unique positive limit prices
  const priceSet = new Set<number>();
  for (const s of sellers) {
    if (s.limit_price > 0) priceSet.add(s.limit_price);
  }
  for (const b of buyers) {
    if (b.limit_price > 0) priceSet.add(b.limit_price);
  }
  const uniquePrices = Array.from(priceSet).sort((a, b) => a - b);
  const boundaries = [0, ...uniquePrices, Number.POSITIVE_INFINITY];

  // 1. Check strict open intervals (p_low, p_high)
  for (let i = 0; i < boundaries.length - 1; i++) {
    const low = boundaries[i];
    const high = boundaries[i + 1];
    const sStrict = sellers
      .filter((s) => s.limit_price <= low + EPS)
      .reduce((acc, s) => acc + s.amount_in, 0);
    const dStrict = buyers
      .filter((b) => b.limit_price >= high - EPS)
      .reduce((acc, b) => acc + b.amount_in, 0);

    const denom = rx + 2 * sStrict;
    if (denom > EPS) {
      const pCand = (ry + 2 * dStrict) / denom;
      if (pCand > low + EPS && pCand < high - EPS) {
        for (const s of sellers) {
          if (s.limit_price <= low + EPS) sellerFillFractions.set(s.order_id, 1);
        }
        for (const b of buyers) {
          if (b.limit_price >= high - EPS) buyerFillFractions.set(b.order_id, 1);
        }
        return {
          clearingPrice: pCand,
          sellerFillFractions,
          buyerFillFractions,
          totalFilledSellBase: sStrict,
          totalFilledBuyQuote: dStrict,
        };
      }
    }
  }

  // 2. Check pinned limit-price tiers p = p_tier
  for (const pTier of uniquePrices) {
    const strictSellers = sellers.filter((s) => s.limit_price < pTier - EPS);
    const margSellers = sellers.filter((s) => Math.abs(s.limit_price - pTier) <= EPS);
    const strictBuyers = buyers.filter((b) => b.limit_price > pTier + EPS);
    const margBuyers = buyers.filter((b) => Math.abs(b.limit_price - pTier) <= EPS);

    const sStrict = strictSellers.reduce((acc, s) => acc + s.amount_in, 0);
    const sMarg = margSellers.reduce((acc, s) => acc + s.amount_in, 0);
    const dStrict = strictBuyers.reduce((acc, b) => acc + b.amount_in, 0);
    const dMarg = margBuyers.reduce((acc, b) => acc + b.amount_in, 0);

    const excessMax = ry + 2 * (dStrict + dMarg) - pTier * (rx + 2 * sStrict);
    const excessMin = ry + 2 * dStrict - pTier * (rx + 2 * (sStrict + sMarg));

    if (excessMin <= 1e-5 && excessMax >= -1e-5) {
      for (const s of strictSellers) sellerFillFractions.set(s.order_id, 1);
      for (const b of strictBuyers) buyerFillFractions.set(b.order_id, 1);

      const excessBoth =
        ry + 2 * (dStrict + dMarg) - pTier * (rx + 2 * (sStrict + sMarg));

      let sFilled = sStrict;
      let dFilled = dStrict;

      if (Math.abs(excessBoth) <= 1e-5) {
        for (const s of margSellers) sellerFillFractions.set(s.order_id, 1);
        for (const b of margBuyers) buyerFillFractions.set(b.order_id, 1);
        sFilled += sMarg;
        dFilled += dMarg;
      } else if (excessBoth < 0) {
        // Fill 100% of marginal buyers, pro-rata marginal sellers
        for (const b of margBuyers) buyerFillFractions.set(b.order_id, 1);
        dFilled += dMarg;
        const targetTotalS = Math.max(
          sStrict,
          ((ry + 2 * dFilled) / pTier - rx) / 2,
        );
        const sMargTarget = Math.max(0, Math.min(sMarg, targetTotalS - sStrict));
        const ratio = sMarg > EPS ? sMargTarget / sMarg : 0;
        for (const s of margSellers) {
          sellerFillFractions.set(s.order_id, ratio);
        }
        sFilled += sMarg * ratio;
      } else {
        // Fill 100% of marginal sellers, pro-rata marginal buyers
        for (const s of margSellers) sellerFillFractions.set(s.order_id, 1);
        sFilled += sMarg;
        const targetTotalD = Math.max(
          dStrict,
          (pTier * (rx + 2 * sFilled) - ry) / 2,
        );
        const dMargTarget = Math.max(0, Math.min(dMarg, targetTotalD - dStrict));
        const ratio = dMarg > EPS ? dMargTarget / dMarg : 0;
        for (const b of margBuyers) {
          buyerFillFractions.set(b.order_id, ratio);
        }
        dFilled += dMarg * ratio;
      }

      return {
        clearingPrice: pTier,
        sellerFillFractions,
        buyerFillFractions,
        totalFilledSellBase: sFilled,
        totalFilledBuyQuote: dFilled,
      };
    }
  }

  const fallbackSpot = rx > EPS ? ry / rx : 0;
  return {
    clearingPrice: fallbackSpot,
    sellerFillFractions,
    buyerFillFractions,
    totalFilledSellBase: 0,
    totalFilledBuyQuote: 0,
  };
}

function simulateSequentialAmm(
  initialRx: number,
  initialRy: number,
  orders: OrderDto[],
  feeBps: number,
  injectVirtualSandwich: boolean,
): {
  ammReceipts: ExecutionReceiptDto[];
  ammVictimAvgPrice: number;
  ammSandwichProfitQuote: number;
  ammLvrLossQuote: number;
} {
  const feeMult = (10_000 - feeBps) / 10_000;
  const spot0 = initialRx > EPS ? initialRy / initialRx : 3000;

  // Check if explicit attacker orders already exist in orders
  const hasExplicitAttacker = orders.some((o) => o.is_attacker);
  const victimOrders = orders.filter((o) => !o.is_attacker);

  let simOrders: OrderDto[] = [...orders];

  // If include_sandwich_bot requested in stateless compare without explicit attacker orders, synthesize sandwich
  if (injectVirtualSandwich && !hasExplicitAttacker && victimOrders.length > 0) {
    const netSellBase = victimOrders
      .filter((o) => o.side === 'SellBase')
      .reduce((acc, o) => acc + o.amount_in, 0);
    const netBuyQuote = victimOrders
      .filter((o) => o.side === 'BuyBase')
      .reduce((acc, o) => acc + o.amount_in, 0);

    if (netSellBase * spot0 >= netBuyQuote) {
      const frontSell = Math.max(5, Math.min(initialRx * 0.15, netSellBase * 3));
      simOrders = [
        {
          order_id: 9001,
          trader: MEV_BOT_ADDRESS,
          label: 'MEV Bot (Front-Run)',
          side: 'SellBase',
          amount_in: frontSell,
          limit_price: 1,
          submission_type: 'Direct',
          is_attacker: true,
        },
        ...victimOrders,
        {
          order_id: 9002,
          trader: MEV_BOT_ADDRESS,
          label: 'MEV Bot (Back-Run)',
          side: 'BuyBase',
          amount_in: frontSell * spot0,
          limit_price: spot0 * 2,
          submission_type: 'Direct',
          is_attacker: true,
        },
      ];
    } else {
      const frontBuyQuote = Math.max(10_000, Math.min(initialRy * 0.15, netBuyQuote * 2.5));
      simOrders = [
        {
          order_id: 9001,
          trader: MEV_BOT_ADDRESS,
          label: 'MEV Bot (Front-Run)',
          side: 'BuyBase',
          amount_in: frontBuyQuote,
          limit_price: spot0 * 2,
          submission_type: 'Direct',
          is_attacker: true,
        },
        ...victimOrders,
        {
          order_id: 9002,
          trader: MEV_BOT_ADDRESS,
          label: 'MEV Bot (Back-Run)',
          side: 'SellBase',
          amount_in: frontBuyQuote / spot0,
          limit_price: 1,
          submission_type: 'Direct',
          is_attacker: true,
        },
      ];
    }
  }

  let rx = initialRx;
  let ry = initialRy;
  const ammReceipts: ExecutionReceiptDto[] = [];

  let botBaseDelta = 0;
  let botQuoteDelta = 0;

  // Special exact round-trip accounting if first & last are attacker front/back pair
  const attackerOrders = simOrders.filter((o) => o.is_attacker);
  const isSellSandwich =
    attackerOrders.length >= 2 &&
    attackerOrders[0].side === 'SellBase' &&
    attackerOrders[attackerOrders.length - 1].side === 'BuyBase';
  const isBuySandwich =
    attackerOrders.length >= 2 &&
    attackerOrders[0].side === 'BuyBase' &&
    attackerOrders[attackerOrders.length - 1].side === 'SellBase';

  let frontSoldBase = 0;
  let frontBoughtBase = 0;

  simOrders.forEach((order, idx) => {
    const preSpot = rx > EPS ? ry / rx : spot0;

    if (order.side === 'SellBase') {
      // If back-run of a buy sandwich, sell exact base acquired in front-run
      const sellAmt =
        order.is_attacker && isBuySandwich && idx === simOrders.length - 1 && frontBoughtBase > 0
          ? frontBoughtBase
          : order.amount_in;

      const dxWithFee = sellAmt * feeMult;
      const dyOut = rx + dxWithFee > EPS ? (ry * dxWithFee) / (rx + dxWithFee) : 0;
      const effPrice = sellAmt > EPS ? dyOut / sellAmt : 0;

      // Victim limit check on sequential AMM (if attacker order, always executes)
      if (!order.is_attacker && effPrice + EPS < order.limit_price) {
        ammReceipts.push({
          order_id: order.order_id,
          arrival_index: idx + 1,
          trader: order.trader,
          label: order.label,
          side: order.side,
          amount_in: order.amount_in,
          amount_filled: 0,
          amount_out: 0,
          refund_in: order.amount_in,
          effective_price: 0,
          price_impact_pct: 0,
          slippage_pct: 0,
          status: 'Reverted / Limit',
          is_attacker: order.is_attacker,
        });
        return;
      }

      rx += sellAmt;
      ry -= dyOut;
      if (order.is_attacker) {
        botBaseDelta -= sellAmt;
        botQuoteDelta += dyOut;
        if (idx === 0) frontSoldBase = sellAmt;
      }

      const slipPct = spot0 > EPS ? ((effPrice - spot0) / spot0) * 100 : 0;
      const impactPct = preSpot > EPS ? ((effPrice - preSpot) / preSpot) * 100 : 0;

      ammReceipts.push({
        order_id: order.order_id,
        arrival_index: idx + 1,
        trader: order.trader,
        label: order.label,
        side: order.side,
        amount_in: sellAmt,
        amount_filled: sellAmt,
        amount_out: dyOut,
        refund_in: 0,
        effective_price: effPrice,
        price_impact_pct: impactPct,
        slippage_pct: slipPct,
        status: 'Executed (Seq)',
        is_attacker: order.is_attacker,
      });
    } else {
      // BuyBase
      // If back-run of a sell sandwich, buy back exact frontSoldBase so bot finishes flat in WETH!
      let quoteIn = order.amount_in;
      let dxOut = 0;

      if (
        order.is_attacker &&
        isSellSandwich &&
        idx === simOrders.length - 1 &&
        frontSoldBase > 0 &&
        frontSoldBase < rx - EPS
      ) {
        dxOut = frontSoldBase;
        quoteIn = (ry * dxOut) / ((rx - dxOut) * feeMult);
      } else {
        const dyWithFee = quoteIn * feeMult;
        dxOut = ry + dyWithFee > EPS ? (rx * dyWithFee) / (ry + dyWithFee) : 0;
      }

      const effPrice = dxOut > EPS ? quoteIn / dxOut : 0;

      if (!order.is_attacker && order.limit_price > 0 && effPrice - EPS > order.limit_price) {
        ammReceipts.push({
          order_id: order.order_id,
          arrival_index: idx + 1,
          trader: order.trader,
          label: order.label,
          side: order.side,
          amount_in: order.amount_in,
          amount_filled: 0,
          amount_out: 0,
          refund_in: order.amount_in,
          effective_price: 0,
          price_impact_pct: 0,
          slippage_pct: 0,
          status: 'Reverted / Limit',
          is_attacker: order.is_attacker,
        });
        return;
      }

      ry += quoteIn;
      rx -= dxOut;
      if (order.is_attacker) {
        botBaseDelta += dxOut;
        botQuoteDelta -= quoteIn;
        if (idx === 0) frontBoughtBase = dxOut;
      }

      const slipPct = spot0 > EPS ? ((spot0 - effPrice) / spot0) * 100 : 0;
      const impactPct = preSpot > EPS ? ((preSpot - effPrice) / preSpot) * 100 : 0;

      ammReceipts.push({
        order_id: order.order_id,
        arrival_index: idx + 1,
        trader: order.trader,
        label: order.label,
        side: order.side,
        amount_in: quoteIn,
        amount_filled: quoteIn,
        amount_out: dxOut,
        refund_in: 0,
        effective_price: effPrice,
        price_impact_pct: impactPct,
        slippage_pct: slipPct,
        status: 'Executed (Seq)',
        is_attacker: order.is_attacker,
      });
    }
  });

  const postSpot = rx > EPS ? ry / rx : spot0;
  const rawSandwichProfit = botQuoteDelta + botBaseDelta * postSpot;
  const ammSandwichProfitQuote =
    attackerOrders.length > 0 ? Math.max(0, rawSandwichProfit) : 0;

  const victimExecuted = ammReceipts.filter((r) => !r.is_attacker && (r.amount_filled ?? 0) > EPS);
  let weightedPriceSum = 0;
  let totalBaseWeight = 0;
  for (const vr of victimExecuted) {
    const baseVol = vr.side === 'SellBase' ? (vr.amount_filled ?? vr.amount_in) : vr.amount_out;
    weightedPriceSum += vr.effective_price * baseVol;
    totalBaseWeight += baseVol;
  }
  const ammVictimAvgPrice = totalBaseWeight > EPS ? weightedPriceSum / totalBaseWeight : spot0;

  // LVR approximation: arbitrage profit from post-trade pool mispricing vs equilibrium
  const ammLvrLossQuote = Math.abs(rx * postSpot - initialRx * spot0) * 0.015;

  return {
    ammReceipts,
    ammVictimAvgPrice,
    ammSandwichProfitQuote,
    ammLvrLossQuote,
  };
}

export function computeBatchSettlement(
  batchId: number,
  rx: number,
  ry: number,
  orders: OrderDto[],
  slashedBondsCount = 0,
  feeBps = DEFAULT_FEE_BPS,
  includeVirtualSandwich = false,
): BatchSettlementDto {
  const reserves_before = snapshotReserves(rx, ry);
  const eq = solveEquilibrium(rx, ry, orders);
  const p = eq.clearingPrice;

  const fills: FillOutcomeDto[] = [];
  const fairbatchReceipts: ExecutionReceiptDto[] = [];

  orders.forEach((order, idx) => {
    const frac =
      order.side === 'SellBase'
        ? (eq.sellerFillFractions.get(order.order_id) ?? 0)
        : (eq.buyerFillFractions.get(order.order_id) ?? 0);

    let status: FillStatus = 'OutOfMoneyRefund';
    if (frac >= 1 - 1e-6) {
      status = 'Filled';
    } else if (frac > 1e-6) {
      status = 'PartialFill';
    }

    const amount_filled =
      status === 'Filled'
        ? order.amount_in
        : status === 'PartialFill'
          ? floor6(order.amount_in * frac)
          : 0;
    const refund_in =
      status === 'Filled'
        ? 0
        : status === 'OutOfMoneyRefund'
          ? order.amount_in
          : Math.max(0, floor6(order.amount_in - amount_filled));

    const payout_out =
      amount_filled > EPS && p > EPS
        ? order.side === 'SellBase'
          ? floor6(amount_filled * p)
          : floor6(amount_filled / p)
        : 0;

    const effective_price = amount_filled > EPS ? p : 0;

    fills.push({
      order_id: order.order_id,
      trader: order.trader,
      label: order.label,
      side: order.side,
      status,
      amount_in: order.amount_in,
      amount_filled,
      payout_out,
      refund_in,
      limit_price: order.limit_price,
      effective_price,
      is_attacker: order.is_attacker,
    });

    const spot0 = reserves_before.spot_price > EPS ? reserves_before.spot_price : p;
    const slipPct =
      amount_filled > EPS && spot0 > EPS
        ? order.side === 'SellBase'
          ? ((p - spot0) / spot0) * 100
          : ((spot0 - p) / spot0) * 100
        : 0;

    fairbatchReceipts.push({
      order_id: order.order_id,
      arrival_index: idx + 1,
      trader: order.trader,
      label: order.label,
      side: order.side,
      amount_in: order.amount_in,
      amount_filled,
      amount_out: payout_out,
      refund_in,
      effective_price,
      price_impact_pct: slipPct,
      slippage_pct: slipPct,
      status:
        status === 'Filled'
          ? '100% Filled'
          : status === 'PartialFill'
            ? 'Pro-Rata Partial'
            : 'Refunded (OTM)',
      is_attacker: order.is_attacker,
    });
  });

  const sFilled = eq.totalFilledSellBase;
  const dFilled = eq.totalFilledBuyQuote;
  const dFilledInBase = p > EPS ? dFilled / p : 0;

  const cow_matched_base = Math.min(sFilled, dFilledInBase);
  const cow_matched_quote = cow_matched_base * p;

  const grossBaseFlow = sFilled + dFilledInBase;
  const cow_ratio_pct =
    grossBaseFlow > EPS
      ? Math.min(100, ((2 * cow_matched_base) / grossBaseFlow) * 100)
      : 0;

  const pool_delta_base = sFilled - dFilledInBase;
  const pool_delta_quote = dFilled - p * sFilled;

  const rxAfter = Math.max(0, rx + pool_delta_base);
  const ryAfter = Math.max(0, ry + pool_delta_quote);
  const reserves_after = snapshotReserves(rxAfter, ryAfter);

  const k_invariant_growth = Math.max(
    0,
    reserves_after.k_invariant - reserves_before.k_invariant,
  );
  const k_invariant_growth_pct =
    reserves_before.k_invariant > EPS
      ? (k_invariant_growth / reserves_before.k_invariant) * 100
      : 0;

  const { supply_curve, demand_curve } = buildSupplyDemandCurves(
    orders,
    reserves_before.spot_price,
  );

  const ammSim = simulateSequentialAmm(rx, ry, orders, feeBps, includeVirtualSandwich);

  // Compute total victim value saved in Quote (USDC) on FairBatch vs Sequential AMM
  let fairbatchVictimQuoteValue = 0;
  let ammVictimQuoteValue = 0;

  for (const fb of fairbatchReceipts) {
    if (fb.is_attacker) continue;
    if (fb.side === 'SellBase') {
      fairbatchVictimQuoteValue += fb.amount_out + (fb.refund_in ?? 0) * p;
    } else {
      fairbatchVictimQuoteValue += fb.amount_out * p + (fb.refund_in ?? 0);
    }
  }
  for (const am of ammSim.ammReceipts) {
    if (am.is_attacker) continue;
    if (am.side === 'SellBase') {
      ammVictimQuoteValue += am.amount_out + (am.refund_in ?? 0) * p;
    } else {
      ammVictimQuoteValue += am.amount_out * p + (am.refund_in ?? 0);
    }
  }

  const user_value_saved_quote = Math.max(0, fairbatchVictimQuoteValue - ammVictimQuoteValue);

  const comparison: ComparisonDto = {
    fee_bps: feeBps,
    amm_victim_avg_price: ammSim.ammVictimAvgPrice,
    fairbatch_uniform_price: p,
    user_value_saved_quote,
    amm_sandwich_profit_quote: ammSim.ammSandwichProfitQuote,
    fairbatch_sandwich_profit_quote: 0.0,
    amm_lvr_loss_quote: ammSim.ammLvrLossQuote,
    amm_receipts: ammSim.ammReceipts,
    fairbatch_receipts: fairbatchReceipts,
  };

  return {
    batch_id: batchId,
    clearing_price: p,
    total_sell_base_eligible: sFilled,
    total_buy_quote_eligible: dFilled,
    cow_matched_base,
    cow_matched_quote,
    cow_ratio_pct,
    pool_delta_base,
    pool_delta_quote,
    reserves_before,
    reserves_after,
    k_invariant_growth,
    k_invariant_growth_pct,
    slashed_bonds_count: slashedBondsCount,
    fills,
    supply_curve,
    demand_curve,
    comparison,
  };
}

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const SEPOLIA_WETH_DEFAULT = '0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14';
const SEPOLIA_USDC_DEFAULT = '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238';

export interface ViteEnvShape {
  VITE_CHAIN_ID?: string;
  VITE_RPC_URL?: string;
  VITE_FAIRBATCH_ADDRESS?: string;
  VITE_BASE_TOKEN_ADDRESS?: string;
  VITE_QUOTE_TOKEN_ADDRESS?: string;
}

export function resolveEnvHealthDefaults(envInput?: ViteEnvShape): {
  rpcUrl: string | null;
  chainId: number;
  contracts: ContractAddressesDto;
} {
  const metaEnv: ViteEnvShape | undefined =
    envInput ??
    (typeof import.meta !== 'undefined' &&
    typeof (import.meta as unknown as { env?: ViteEnvShape }).env === 'object'
      ? (import.meta as unknown as { env?: ViteEnvShape }).env
      : undefined);

  const parsedChain = Number.parseInt(metaEnv?.VITE_CHAIN_ID ?? '', 10);
  const chainId =
    Number.isFinite(parsedChain) && parsedChain > 0 ? parsedChain : 11155111;

  const rawRpc = metaEnv?.VITE_RPC_URL?.trim() ?? '';
  const rpcUrl = rawRpc.length > 0 ? rawRpc : null;

  const rawFairBatch = metaEnv?.VITE_FAIRBATCH_ADDRESS?.trim() ?? '';
  const fair_batch =
    /^0x[0-9a-fA-F]{40}$/.test(rawFairBatch) ? rawFairBatch : ZERO_ADDRESS;

  const rawBase = metaEnv?.VITE_BASE_TOKEN_ADDRESS?.trim() ?? '';
  const base_token =
    /^0x[0-9a-fA-F]{40}$/.test(rawBase) && rawBase !== ZERO_ADDRESS
      ? rawBase
      : SEPOLIA_WETH_DEFAULT;

  const rawQuote = metaEnv?.VITE_QUOTE_TOKEN_ADDRESS?.trim() ?? '';
  const quote_token =
    /^0x[0-9a-fA-F]{40}$/.test(rawQuote) && rawQuote !== ZERO_ADDRESS
      ? rawQuote
      : SEPOLIA_USDC_DEFAULT;

  return {
    rpcUrl,
    chainId,
    contracts: {
      fair_batch,
      base_token,
      quote_token,
      deployed: fair_batch !== ZERO_ADDRESS,
    },
  };
}

class BrowserFallbackStore {
  private batchId = 1;
  private phase: BatchPhase = 'Open';
  private rx = DEFAULT_RX;
  private ry = DEFAULT_RY;
  private nextOrderId = 1;
  private nextCommitId = 1;
  private commitments: CommitmentDto[] = [];
  private orders: OrderDto[] = [];
  private claimable: ClaimableDto[] = [];
  private settledHistory: BatchSettlementDto[] = [];
  private nonces = new Map<string, number>();

  private rpcUrl: string | null;
  private chainId: number;
  private contracts: ContractAddressesDto;

  constructor() {
    const defaults = resolveEnvHealthDefaults();
    this.rpcUrl = defaults.rpcUrl;
    this.chainId = defaults.chainId;
    this.contracts = defaults.contracts;
    this.loadPreset('five_sellers', false, { rx: DEFAULT_RX, ry: DEFAULT_RY });
  }

  getHealth(): HealthResponse {
    const deployed =
      Boolean(this.contracts.fair_batch) &&
      this.contracts.fair_batch !== '0x0000000000000000000000000000000000000000';
    return {
      status: 'ok',
      execution_mode: 'browser_fallback',
      rpc_url: this.rpcUrl,
      chain_id: this.chainId,
      contracts: {
        ...this.contracts,
        deployed,
      },
      fe_artifacts_present: true,
      fe_artifacts: [
        'FairBatch.abi.json',
        'FairBatch.bin',
        'FairBatch.runtime.bin',
      ],
    };
  }

  updateContractConfig(cfg: ContractConfigUpdatePayload): HealthResponse {
    if (cfg.rpc_url !== undefined) {
      this.rpcUrl = cfg.rpc_url.trim() || null;
    }
    if (cfg.chain_id !== undefined && Number.isFinite(cfg.chain_id)) {
      this.chainId = cfg.chain_id;
    }
    if (cfg.fair_batch !== undefined) {
      this.contracts.fair_batch = cfg.fair_batch.trim();
    }
    if (cfg.base_token !== undefined) {
      this.contracts.base_token = cfg.base_token.trim();
    }
    if (cfg.quote_token !== undefined) {
      this.contracts.quote_token = cfg.quote_token.trim();
    }
    this.contracts.deployed =
      Boolean(this.contracts.fair_batch) &&
      this.contracts.fair_batch !== '0x0000000000000000000000000000000000000000';
    return this.getHealth();
  }

  getState(): StateResponse {
    return {
      batch_id: this.batchId,
      phase: this.phase,
      commit_duration_secs: 60,
      reveal_duration_secs: 45,
      phase_remaining_secs: this.phase === 'Open' ? 48 : 34,
      reserves: makeReserves(this.rx, this.ry),
      demo_wallets: DEMO_WALLETS.map((w) => ({ ...w })),
      commitments: this.commitments.map((c) => ({ ...c })),
      orders: this.orders.map((o) => ({ ...o })),
      claimable: this.claimable.map((c) => ({ ...c })),
      settled_history: this.settledHistory.map((s) => ({ ...s })),
    };
  }

  private pushOrder(params: {
    trader: string;
    label: string;
    side: OrderSide;
    amount_in: number;
    limit_price: number;
    submission_type: SubmissionType;
    is_attacker?: boolean;
  }): void {
    this.orders.push({
      order_id: this.nextOrderId++,
      trader: params.trader,
      label: params.label,
      side: params.side,
      amount_in: params.amount_in,
      limit_price: params.limit_price,
      submission_type: params.submission_type,
      is_attacker: Boolean(params.is_attacker),
    });
  }

  addDirectOrder(params: {
    trader: string;
    label?: string;
    side: OrderSide;
    amount_in: number;
    limit_price: number;
  }): StateResponse {
    const walletMatch = DEMO_WALLETS.find(
      (w) => w.address.toLowerCase() === params.trader.toLowerCase(),
    );
    const label =
      params.label ||
      walletMatch?.name ||
      `${params.trader.slice(0, 6)}…${params.trader.slice(-4)}`;

    this.pushOrder({
      trader: params.trader,
      label,
      side: params.side,
      amount_in: params.amount_in,
      limit_price: params.limit_price,
      submission_type: 'Direct',
      is_attacker: false,
    });
    return this.getState();
  }

  commitOrder(params: {
    trader: string;
    commitment_hash: string;
    bond_eth: number;
  }): { commit_id: number; state: StateResponse } {
    const commit_id = this.nextCommitId++;
    this.commitments.push({
      commit_id,
      trader: params.trader,
      commitment_hash: params.commitment_hash,
      bond_eth: params.bond_eth,
      revealed: false,
      slashed: false,
    });
    return { commit_id, state: this.getState() };
  }

  revealOrder(params: {
    commit_id: number;
    trader: string;
    side: OrderSide;
    amount_in: number;
    limit_price: number;
    salt: string;
    label?: string;
  }): StateResponse {
    const found = this.commitments.find((c) => c.commit_id === params.commit_id);
    if (!found) {
      throw new Error(`Commitment #${params.commit_id} not found`);
    }
    if (found.revealed) {
      throw new Error(`Commitment #${params.commit_id} already revealed`);
    }
    const expectedHash = computeLocalCommitmentHash({
      batch_id: this.batchId,
      trader: params.trader,
      side: params.side,
      amount_in: params.amount_in,
      limit_price: params.limit_price,
      salt: params.salt,
    });
    if (expectedHash.toLowerCase() !== found.commitment_hash.toLowerCase()) {
      throw new Error('Commitment hash mismatch: invalid reveal secret or parameters');
    }

    found.revealed = true;
    const walletMatch = DEMO_WALLETS.find(
      (w) => w.address.toLowerCase() === params.trader.toLowerCase(),
    );
    this.pushOrder({
      trader: params.trader,
      label: params.label || walletMatch?.name || 'Revealed Trader',
      side: params.side,
      amount_in: params.amount_in,
      limit_price: params.limit_price,
      submission_type: 'CommitReveal',
      is_attacker: false,
    });
    return this.getState();
  }

  signDemoIntent(params: {
    demo_account_index: number;
    side: OrderSide;
    amount_in: number;
    limit_price: number;
    batch_id: number;
    deadline: number;
  }): SignedDemoIntentResponse {
    const wallet =
      DEMO_WALLETS[params.demo_account_index] ?? DEMO_WALLETS[0];
    const key = wallet.address.toLowerCase();
    const nonce = this.nonces.get(key) ?? 0;

    const digest = computeLocalEip712Digest({
      chain_id: this.chainId,
      verifying_contract: this.contracts.fair_batch,
      trader: wallet.address,
      side: params.side,
      amount_in: params.amount_in,
      limit_price: params.limit_price,
      batch_id: params.batch_id,
      nonce,
      deadline: params.deadline,
    });

    const sigPartR = keccak256Utf8(`sig_r:${wallet.address}:${digest}`).slice(2);
    const sigPartS = keccak256Utf8(`sig_s:${wallet.address}:${digest}`).slice(2);
    const signature = `0x${sigPartR}${sigPartS}1b`;

    return {
      trader: wallet.address,
      nonce,
      deadline: params.deadline,
      signature,
      digest,
    };
  }

  submitSignedIntent(params: {
    trader: string;
    side: OrderSide;
    amount_in: number;
    limit_price: number;
    batch_id: number;
    nonce: number;
    deadline: number;
    signature: string;
    label?: string;
  }): StateResponse {
    if (!params.signature || !params.signature.startsWith('0x') || params.signature.length < 130) {
      throw new Error('Invalid EIP-712 ECDSA signature length');
    }
    const key = params.trader.toLowerCase();
    const currentNonce = this.nonces.get(key) ?? 0;
    this.nonces.set(key, Math.max(currentNonce + 1, params.nonce + 1));

    const walletMatch = DEMO_WALLETS.find(
      (w) => w.address.toLowerCase() === key,
    );

    this.pushOrder({
      trader: params.trader,
      label: params.label || walletMatch?.name || 'EIP-712 Relayed',
      side: params.side,
      amount_in: params.amount_in,
      limit_price: params.limit_price,
      submission_type: 'Eip712Intent',
      is_attacker: false,
    });
    return this.getState();
  }

  advancePhase(): StateResponse {
    if (this.phase === 'Open') {
      this.phase = 'Reveal';
    }
    return this.getState();
  }

  settleBatch(): { settlement: BatchSettlementDto; state: StateResponse } {
    let slashedCount = 0;
    for (const c of this.commitments) {
      if (!c.revealed && !c.slashed) {
        c.slashed = true;
        slashedCount++;
      }
    }

    const settlement = computeBatchSettlement(
      this.batchId,
      this.rx,
      this.ry,
      this.orders,
      slashedCount,
    );

    this.rx = settlement.reserves_after.rx;
    this.ry = settlement.reserves_after.ry;

    for (const f of settlement.fills) {
      if (f.payout_out > EPS || f.refund_in > EPS) {
        this.claimable.push({
          batch_id: this.batchId,
          order_id: f.order_id,
          trader: f.trader,
          label: f.label,
          side: f.side,
          status: f.status,
          amount_in: f.amount_in,
          amount_filled: f.amount_filled,
          payout_out: f.payout_out,
          refund_in: f.refund_in,
          effective_price: f.effective_price,
          claimed: false,
        });
      }
    }

    this.settledHistory = [settlement, ...this.settledHistory];
    this.batchId += 1;
    this.phase = 'Open';
    this.orders = [];
    this.commitments = [];

    return {
      settlement,
      state: this.getState(),
    };
  }

  claimBatch(params: {
    trader: string;
    claims: Array<{ batch_id: number; order_id: number }>;
  }): { claimed_base: number; claimed_quote: number; state: StateResponse } {
    let claimed_base = 0;
    let claimed_quote = 0;

    for (const req of params.claims) {
      const entry = this.claimable.find(
        (c) =>
          c.batch_id === req.batch_id &&
          c.order_id === req.order_id &&
          !c.claimed &&
          (!params.trader ||
            params.trader === '*' ||
            c.trader.toLowerCase() === params.trader.toLowerCase()),
      );
      if (entry) {
        entry.claimed = true;
        if (entry.side === 'SellBase') {
          claimed_quote += entry.payout_out;
          claimed_base += entry.refund_in;
        } else {
          claimed_base += entry.payout_out;
          claimed_quote += entry.refund_in;
        }
      }
    }

    return {
      claimed_base,
      claimed_quote,
      state: this.getState(),
    };
  }

  loadPreset(
    preset: PresetId,
    includeSandwichBot: boolean,
    resetReserves?: { rx: number; ry: number },
  ): StateResponse {
    if (resetReserves) {
      this.rx = resetReserves.rx;
      this.ry = resetReserves.ry;
    } else {
      this.rx = DEFAULT_RX;
      this.ry = DEFAULT_RY;
    }

    this.phase = 'Open';
    this.orders = [];
    this.commitments = [];

    const addFrontBackSandwich = (
      victimCreator: () => void,
      frontSide: OrderSide,
      frontAmt: number,
      backAmt: number,
    ) => {
      if (includeSandwichBot) {
        this.pushOrder({
          trader: MEV_BOT_ADDRESS,
          label: 'MEV Bot (Front-Run)',
          side: frontSide,
          amount_in: frontAmt,
          limit_price: frontSide === 'SellBase' ? 1500 : 4500,
          submission_type: 'Direct',
          is_attacker: true,
        });
      }
      victimCreator();
      if (includeSandwichBot) {
        const backSide: OrderSide = frontSide === 'SellBase' ? 'BuyBase' : 'SellBase';
        this.pushOrder({
          trader: MEV_BOT_ADDRESS,
          label: 'MEV Bot (Back-Run)',
          side: backSide,
          amount_in: backAmt,
          limit_price: backSide === 'BuyBase' ? 4500 : 1500,
          submission_type: 'Direct',
          is_attacker: true,
        });
      }
    };

    if (preset === 'five_sellers') {
      addFrontBackSandwich(
        () => {
          const subTypes: SubmissionType[] = [
            'Direct',
            'Direct',
            'Eip712Intent',
            'Direct',
            'CommitReveal',
          ];
          DEMO_WALLETS.forEach((w, idx) => {
            this.pushOrder({
              trader: w.address,
              label: `${w.name.split(' ')[0]} (#${idx + 1})`,
              side: 'SellBase',
              amount_in: 1.0,
              limit_price: 2350,
              submission_type: subTypes[idx] ?? 'Direct',
              is_attacker: false,
            });
          });
        },
        'SellBase',
        7.7,
        21_000.0,
      );
    } else if (preset === 'cow_balanced') {
      addFrontBackSandwich(
        () => {
          this.pushOrder({
            trader: DEMO_WALLETS[0].address,
            label: 'Alice (Sell 2.0 WETH)',
            side: 'SellBase',
            amount_in: 2.0,
            limit_price: 2850,
            submission_type: 'Direct',
          });
          this.pushOrder({
            trader: DEMO_WALLETS[1].address,
            label: 'Bob (Sell 3.0 WETH)',
            side: 'SellBase',
            amount_in: 3.0,
            limit_price: 2900,
            submission_type: 'Eip712Intent',
          });
          this.pushOrder({
            trader: DEMO_WALLETS[2].address,
            label: 'Carol (Buy 6,000 USDC)',
            side: 'BuyBase',
            amount_in: 6000,
            limit_price: 3150,
            submission_type: 'Direct',
          });
          this.pushOrder({
            trader: DEMO_WALLETS[3].address,
            label: 'Dave (Buy 9,000 USDC)',
            side: 'BuyBase',
            amount_in: 9000,
            limit_price: 3100,
            submission_type: 'CommitReveal',
          });
        },
        'SellBase',
        10.0,
        30_000.0,
      );
    } else if (preset === 'marginal_pro_rata') {
      addFrontBackSandwich(
        () => {
          this.pushOrder({
            trader: DEMO_WALLETS[0].address,
            label: 'Alice (ITM Sell)',
            side: 'SellBase',
            amount_in: 2.0,
            limit_price: 2600,
            submission_type: 'Direct',
          });
          this.pushOrder({
            trader: DEMO_WALLETS[1].address,
            label: 'Bob (Marginal @ 2,800)',
            side: 'SellBase',
            amount_in: 4.0,
            limit_price: 2800,
            submission_type: 'Direct',
          });
          this.pushOrder({
            trader: DEMO_WALLETS[2].address,
            label: 'Carol (Marginal @ 2,800)',
            side: 'SellBase',
            amount_in: 4.0,
            limit_price: 2800,
            submission_type: 'Eip712Intent',
          });
          this.pushOrder({
            trader: DEMO_WALLETS[3].address,
            label: 'Dave (OTM @ 3,150)',
            side: 'SellBase',
            amount_in: 2.0,
            limit_price: 3150,
            submission_type: 'Direct',
          });
          this.pushOrder({
            trader: DEMO_WALLETS[4].address,
            label: 'Eve (ITM Buy)',
            side: 'BuyBase',
            amount_in: 2800,
            limit_price: 3100,
            submission_type: 'Direct',
          });
        },
        'SellBase',
        5.0,
        14_000.0,
      );
    } else if (preset === 'whale_imbalance') {
      addFrontBackSandwich(
        () => {
          this.pushOrder({
            trader: DEMO_WALLETS[0].address,
            label: 'Alice Whale (Sell 20 WETH)',
            side: 'SellBase',
            amount_in: 20.0,
            limit_price: 1900,
            submission_type: 'Eip712Intent',
          });
          this.pushOrder({
            trader: DEMO_WALLETS[1].address,
            label: 'Bob (Sell 5 WETH)',
            side: 'SellBase',
            amount_in: 5.0,
            limit_price: 1950,
            submission_type: 'Direct',
          });
          this.pushOrder({
            trader: DEMO_WALLETS[2].address,
            label: 'Carol (Counter-Buy)',
            side: 'BuyBase',
            amount_in: 6_000,
            limit_price: 3050,
            submission_type: 'Direct',
          });
        },
        'SellBase',
        4.0,
        8_320.0,
      );
    }

    return this.getState();
  }

  reset(rx = DEFAULT_RX, ry = DEFAULT_RY): StateResponse {
    const defaults = resolveEnvHealthDefaults();
    this.rpcUrl = defaults.rpcUrl;
    this.chainId = defaults.chainId;
    this.contracts = defaults.contracts;
    this.batchId = 1;
    this.phase = 'Open';
    this.rx = rx;
    this.ry = ry;
    this.orders = [];
    this.commitments = [];
    this.claimable = [];
    this.settledHistory = [];
    this.nonces.clear();
    return this.loadPreset('five_sellers', false, { rx, ry });
  }
}

export const fallbackStore = new BrowserFallbackStore();
