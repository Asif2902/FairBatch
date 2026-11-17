import React, { useMemo, useState } from 'react';
import { Crosshair, GitMerge, Info } from 'lucide-react';
import type { BatchSettlementDto, CurvePointDto } from '../types';
import { formatPrice, formatToken } from '../lib/format';

interface PriceChartProps {
  settlement: BatchSettlementDto;
  isLivePreview: boolean;
}

interface HoverNode {
  kind: 'Supply' | 'Demand' | 'Equilibrium';
  price: number;
  baseVol: number;
  quoteVol: number;
  x: number;
  y: number;
  note: string;
}

function dedupeTiers(points: CurvePointDto[]): CurvePointDto[] {
  const out: CurvePointDto[] = [];
  for (const pt of points) {
    const prev = out[out.length - 1];
    if (
      prev &&
      Math.abs(prev.price - pt.price) < 1e-6 &&
      Math.abs(prev.cumulative_base - pt.cumulative_base) < 1e-6
    ) {
      continue;
    }
    if (prev && Math.abs(prev.price - pt.price) < 1e-6) {
      out[out.length - 1] = pt;
    } else {
      out.push(pt);
    }
  }
  return out;
}

export const PriceChart: React.FC<PriceChartProps> = ({
  settlement,
  isLivePreview,
}) => {
  const [hovered, setHovered] = useState<HoverNode | null>(null);

  const width = 780;
  const height = 340;
  const pad = { top: 26, right: 32, bottom: 44, left: 72 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;

  const chartData = useMemo(() => {
    const supplyTiers = dedupeTiers(
      settlement.supply_curve.filter((p) => p.cumulative_base > 0),
    );
    const demandTiers = dedupeTiers(
      settlement.demand_curve.filter((p) => p.cumulative_base > 0),
    );

    const spot0 = settlement.reserves_before.spot_price || 3000;
    const pStar = settlement.clearing_price || spot0;

    const allPrices: number[] = [spot0, pStar];
    for (const s of supplyTiers) if (s.price > 0) allPrices.push(s.price);
    for (const d of demandTiers) if (d.price > 0) allPrices.push(d.price);

    const rawMinP = Math.min(...allPrices);
    const rawMaxP = Math.max(...allPrices);
    const priceSpan = Math.max(250, rawMaxP - rawMinP);
    const yMin = Math.max(0, Math.floor((rawMinP - priceSpan * 0.22) / 50) * 50);
    const yMax = Math.ceil((rawMaxP + priceSpan * 0.22) / 50) * 50;

    const maxSupplyBase =
      supplyTiers.length > 0
        ? supplyTiers[supplyTiers.length - 1].cumulative_base
        : 0;
    const maxDemandBase =
      demandTiers.length > 0
        ? demandTiers[demandTiers.length - 1].cumulative_base
        : 0;
    const eqBase = Math.max(
      settlement.total_sell_base_eligible,
      pStar > 0 ? settlement.total_buy_quote_eligible / pStar : 0,
    );

    const xMax = Math.max(4, Math.max(maxSupplyBase, maxDemandBase, eqBase) * 1.25);

    const toX = (baseQty: number) =>
      pad.left + Math.min(1, Math.max(0, baseQty / xMax)) * plotW;
    const toY = (price: number) =>
      pad.top +
      (1 - Math.min(1, Math.max(0, (price - yMin) / Math.max(1, yMax - yMin)))) *
        plotH;

    // Build upward step path for Seller Supply S(p)
    let supplyPath = '';
    if (supplyTiers.length > 0) {
      let prevQ = 0;
      supplyTiers.forEach((tier, idx) => {
        const x0 = toX(prevQ);
        const x1 = toX(tier.cumulative_base);
        const y = toY(tier.price);
        if (idx === 0) {
          supplyPath += `M ${x0.toFixed(1)} ${y.toFixed(1)} L ${x1.toFixed(1)} ${y.toFixed(1)}`;
        } else {
          supplyPath += ` L ${x0.toFixed(1)} ${y.toFixed(1)} L ${x1.toFixed(1)} ${y.toFixed(1)}`;
        }
        prevQ = tier.cumulative_base;
      });
      supplyPath += ` L ${toX(prevQ).toFixed(1)} ${toY(yMax).toFixed(1)}`;
    }

    // Build downward step path for Buyer Demand D(p)
    let demandPath = '';
    if (demandTiers.length > 0) {
      let prevQ = 0;
      demandTiers.forEach((tier, idx) => {
        const x0 = toX(prevQ);
        const x1 = toX(tier.cumulative_base);
        const y = toY(tier.price);
        if (idx === 0) {
          demandPath += `M ${x0.toFixed(1)} ${y.toFixed(1)} L ${x1.toFixed(1)} ${y.toFixed(1)}`;
        } else {
          demandPath += ` L ${x0.toFixed(1)} ${y.toFixed(1)} L ${x1.toFixed(1)} ${y.toFixed(1)}`;
        }
        prevQ = tier.cumulative_base;
      });
      demandPath += ` L ${toX(prevQ).toFixed(1)} ${toY(yMin).toFixed(1)}`;
    }

    // Build smooth Hybrid FM-AMM + Buyer Absorption curve:
    // At price p, net Base capacity absorbed by (Pool + ITM Buyers) = max(0, ((R_y + 2*D_y(p))/p - R_x) / 2)
    const rx = settlement.reserves_before.rx;
    const ry = settlement.reserves_before.ry;
    let hybridPoolDemandPath = '';
    if (rx > 0 || ry > 0) {
      const samples = 36;
      for (let i = 0; i <= samples; i++) {
        const pSample = yMax - ((yMax - Math.max(100, yMin)) * i) / samples;
        const dQuoteAtP = demandTiers.reduce((acc, t) => {
          return t.price >= pSample - 1e-6 ? Math.max(acc, t.cumulative_quote ?? 0) : acc;
        }, 0);
        const absorbedBase = Math.max(0, ((ry + 2 * dQuoteAtP) / pSample - rx) / 2);
        const sx = toX(absorbedBase);
        const sy = toY(pSample);
        hybridPoolDemandPath += `${i === 0 ? 'M' : 'L'} ${sx.toFixed(1)} ${sy.toFixed(1)} `;
      }
    }

    return {
      supplyTiers,
      demandTiers,
      spot0,
      pStar,
      eqBase,
      yMin,
      yMax,
      xMax,
      toX,
      toY,
      supplyPath,
      demandPath,
      hybridPoolDemandPath,
    };
  }, [settlement, plotW, plotH, pad.left, pad.top]);

  const yTicks = useMemo(() => {
    const ticks: number[] = [];
    const count = 4;
    for (let i = 0; i <= count; i++) {
      ticks.push(
        chartData.yMin + ((chartData.yMax - chartData.yMin) * i) / count,
      );
    }
    return ticks;
  }, [chartData.yMin, chartData.yMax]);

  const xTicks = useMemo(() => {
    const ticks: number[] = [];
    const count = 4;
    for (let i = 0; i <= count; i++) {
      ticks.push((chartData.xMax * i) / count);
    }
    return ticks;
  }, [chartData.xMax]);

  const eqX = chartData.toX(chartData.eqBase);
  const eqY = chartData.toY(chartData.pStar);
  const cowX = chartData.toX(settlement.cow_matched_base);
  const spotY = chartData.toY(chartData.spot0);

  return (
    <section
      aria-label="Supply Demand Depth and Uniform Clearing Price Chart"
      className="rounded-2xl border border-slate-800/90 bg-[#0D1321]/95 p-4 shadow-xl"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 pb-3">
        <div>
          <div className="flex items-center gap-2">
            <Crosshair className="h-4 w-4 text-emerald-400" aria-hidden="true" />
            <h2 className="text-sm font-bold text-white">
              Uniform Equilibrium Depth &amp; CoW Overlap Visualizer
            </h2>
            <span
              className={`rounded px-2 py-0.5 font-mono text-[10px] font-semibold ${
                isLivePreview
                  ? 'border border-cyan-500/30 bg-cyan-500/10 text-cyan-300'
                  : 'border border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
              }`}
            >
              {isLivePreview
                ? 'LIVE BATCH PREVIEW'
                : `SETTLED BATCH #${settlement.batch_id}`}
            </span>
          </div>
          <p className="mt-0.5 text-xs text-slate-400">
            Sorted Seller Supply S(p) × Buyer Demand D(p) + FM-AMM Liquidity Absorption
          </p>
        </div>

        {/* Legend */}
        <div className="flex flex-wrap items-center gap-3 text-[11px] text-slate-300">
          <span className="inline-flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-sm bg-emerald-400" />
            <span>Seller Supply S(p)</span>
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-sm bg-cyan-400" />
            <span>Buyer Demand D(p)</span>
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="h-0.5 w-4 border-t border-dashed border-indigo-400" />
            <span>FM-AMM + Demand</span>
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-sm bg-emerald-500/30 border border-emerald-400/60" />
            <span>CoW P2P Zone</span>
          </span>
        </div>
      </div>

      {/* SVG Canvas */}
      <div className="relative overflow-hidden rounded-xl border border-slate-800/90 bg-[#070B14]">
        <svg
          role="img"
          aria-label="Batch Supply and Demand Depth Chart"
          viewBox={`0 0 ${width} ${height}`}
          className="h-auto w-full select-none"
          onMouseLeave={() => setHovered(null)}
        >
          <defs>
            <linearGradient id="cowZoneGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#10B981" stopOpacity="0.22" />
              <stop offset="100%" stopColor="#06B6D4" stopOpacity="0.06" />
            </linearGradient>
            <linearGradient id="ammZoneGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#6366F1" stopOpacity="0.16" />
              <stop offset="100%" stopColor="#6366F1" stopOpacity="0.03" />
            </linearGradient>
          </defs>

          {/* Grid lines */}
          {yTicks.map((pTick) => {
            const y = chartData.toY(pTick);
            return (
              <g key={`yt-${pTick}`}>
                <line
                  x1={pad.left}
                  y1={y}
                  x2={width - pad.right}
                  y2={y}
                  stroke="#1E293B"
                  strokeDasharray="3 3"
                  strokeWidth="1"
                />
                <text
                  x={pad.left - 10}
                  y={y + 4}
                  textAnchor="end"
                  className="fill-slate-400 font-mono text-[10px]"
                >
                  ${formatPrice(pTick, 0)}
                </text>
              </g>
            );
          })}

          {xTicks.map((xTick) => {
            const x = chartData.toX(xTick);
            return (
              <g key={`xt-${xTick}`}>
                <line
                  x1={x}
                  y1={pad.top}
                  x2={x}
                  y2={height - pad.bottom}
                  stroke="#1E293B"
                  strokeDasharray="3 3"
                  strokeWidth="1"
                />
                <text
                  x={x}
                  y={height - pad.bottom + 16}
                  textAnchor="middle"
                  className="fill-slate-400 font-mono text-[10px]"
                >
                  {formatToken(xTick, 1, 1)} WETH
                </text>
              </g>
            );
          })}

          {/* Shaded CoW Peer-to-Peer Overlap Zone */}
          {settlement.cow_matched_base > 0.001 && (
            <rect
              x={pad.left}
              y={pad.top}
              width={Math.max(0, cowX - pad.left)}
              height={plotH}
              fill="url(#cowZoneGrad)"
            />
          )}

          {/* Shaded FM-AMM Net Imbalance Absorption Zone */}
          {chartData.eqBase > settlement.cow_matched_base + 0.001 && (
            <rect
              x={cowX}
              y={pad.top}
              width={Math.max(0, eqX - cowX)}
              height={plotH}
              fill="url(#ammZoneGrad)"
            />
          )}

          {/* Pre-Batch Pool Spot Reference Line */}
          <line
            x1={pad.left}
            y1={spotY}
            x2={width - pad.right}
            y2={spotY}
            stroke="#475569"
            strokeDasharray="5 5"
            strokeWidth="1"
          />
          <text
            x={width - pad.right - 4}
            y={spotY - 5}
            textAnchor="end"
            className="fill-slate-400 font-mono text-[9px]"
          >
            Pre-Batch Spot ${formatPrice(chartData.spot0, 2)}
          </text>

          {/* Hybrid FM-AMM + Demand Absorption Curve */}
          {chartData.hybridPoolDemandPath && (
            <path
              d={chartData.hybridPoolDemandPath}
              fill="none"
              stroke="#818CF8"
              strokeWidth="1.75"
              strokeDasharray="5 4"
              opacity="0.85"
            />
          )}

          {/* Seller Supply Step Curve S(p) */}
          {chartData.supplyPath && (
            <path
              d={chartData.supplyPath}
              fill="none"
              stroke="#10B981"
              strokeWidth="2.75"
              strokeLinejoin="round"
            />
          )}

          {/* Buyer Demand Step Curve D(p) */}
          {chartData.demandPath && (
            <path
              d={chartData.demandPath}
              fill="none"
              stroke="#06B6D4"
              strokeWidth="2.75"
              strokeLinejoin="round"
            />
          )}

          {/* Uniform Clearing Price p* Crosshair */}
          <line
            x1={pad.left}
            y1={eqY}
            x2={width - pad.right}
            y2={eqY}
            stroke="#34D399"
            strokeDasharray="6 3"
            strokeWidth="1.5"
          />
          <line
            x1={eqX}
            y1={pad.top}
            x2={eqX}
            y2={height - pad.bottom}
            stroke="#34D399"
            strokeDasharray="6 3"
            strokeWidth="1.5"
          />

          {/* Interactive Supply Nodes */}
          {chartData.supplyTiers.map((tier, idx) => {
            const cx = chartData.toX(tier.cumulative_base);
            const cy = chartData.toY(tier.price);
            const isFilled = tier.price <= chartData.pStar + 1e-4;
            return (
              <circle
                key={`snode-${idx}`}
                cx={cx}
                cy={cy}
                r={4.5}
                className="cursor-pointer transition-all"
                fill={isFilled ? '#10B981' : '#334155'}
                stroke="#090D16"
                strokeWidth="1.5"
                onMouseEnter={() =>
                  setHovered({
                    kind: 'Supply',
                    price: tier.price,
                    baseVol: tier.cumulative_base,
                    quoteVol: tier.cumulative_base * tier.price,
                    x: cx,
                    y: cy,
                    note:
                      Math.abs(tier.price - chartData.pStar) < 0.01
                        ? 'Pinned Marginal Tier (Pro-Rata)'
                        : isFilled
                          ? 'In-the-Money Seller Tier'
                          : 'Out-of-the-Money (Refunded)',
                  })
                }
              />
            );
          })}

          {/* Interactive Demand Nodes */}
          {chartData.demandTiers.map((tier, idx) => {
            const cx = chartData.toX(tier.cumulative_base);
            const cy = chartData.toY(tier.price);
            const isFilled = tier.price >= chartData.pStar - 1e-4;
            return (
              <circle
                key={`dnode-${idx}`}
                cx={cx}
                cy={cy}
                r={4.5}
                className="cursor-pointer transition-all"
                fill={isFilled ? '#06B6D4' : '#334155'}
                stroke="#090D16"
                strokeWidth="1.5"
                onMouseEnter={() =>
                  setHovered({
                    kind: 'Demand',
                    price: tier.price,
                    baseVol: tier.cumulative_base,
                    quoteVol: tier.cumulative_quote ?? tier.cumulative_base * tier.price,
                    x: cx,
                    y: cy,
                    note:
                      Math.abs(tier.price - chartData.pStar) < 0.01
                        ? 'Pinned Marginal Tier (Pro-Rata)'
                        : isFilled
                          ? 'In-the-Money Buyer Tier'
                          : 'Out-of-the-Money (Refunded)',
                  })
                }
              />
            );
          })}

          {/* Equilibrium p* Lock Marker */}
          <g
            className="cursor-pointer"
            onMouseEnter={() =>
              setHovered({
                kind: 'Equilibrium',
                price: chartData.pStar,
                baseVol: chartData.eqBase,
                quoteVol: chartData.eqBase * chartData.pStar,
                x: eqX,
                y: eqY,
                note: 'Closed-form Uniform Clearing Equilibrium p*',
              })
            }
          >
            <circle cx={eqX} cy={eqY} r={10} fill="#10B981" opacity="0.22" />
            <circle
              cx={eqX}
              cy={eqY}
              r={5.5}
              fill="#34D399"
              stroke="#FFFFFF"
              strokeWidth="2"
            />
          </g>

          {/* Equilibrium Price Tag */}
          <g transform={`translate(${Math.min(width - 210, Math.max(pad.left + 8, eqX + 10))}, ${Math.max(pad.top + 6, eqY - 28)})`}>
            <rect
              width="192"
              height="24"
              rx="6"
              fill="#064E3B"
              stroke="#10B981"
              strokeWidth="1"
            />
            <text
              x="96"
              y="15.5"
              textAnchor="middle"
              className="fill-emerald-200 font-mono text-[11px] font-bold"
            >
              p* = ${formatPrice(chartData.pStar, 2)} USDC
            </text>
          </g>
        </svg>

        {/* Interactive Tooltip */}
        {hovered && (
          <div
            className="pointer-events-none absolute right-3 top-3 rounded-xl border border-slate-700 bg-[#0D1321]/95 px-3 py-2 text-xs shadow-xl"
          >
            <div className="font-bold text-white">
              {hovered.kind} Tier · ${formatPrice(hovered.price, 2)} USDC/WETH
            </div>
            <div className="font-mono text-[11px] text-slate-300 tabular-nums">
              Cum. Volume: {formatToken(hovered.baseVol, 3)} WETH ($
              {formatPrice(hovered.quoteVol, 0)} USDC)
            </div>
            <div className="text-[10px] text-emerald-300">{hovered.note}</div>
          </div>
        )}
      </div>

      {/* Closed-Form Formula Readout Bar */}
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-800 bg-[#090D16] px-3.5 py-2.5 text-xs">
        <div className="flex flex-wrap items-center gap-2 font-mono text-[11px] text-slate-300 tabular-nums">
          <Info className="h-3.5 w-3.5 text-cyan-400 shrink-0" aria-hidden="true" />
          <span className="text-slate-400">Closed-Form Equilibrium:</span>
          <span className="text-white">
            p* = (R_y + 2·D_y) / (R_x + 2·S_x) = ({formatPrice(settlement.reserves_before.ry, 0)} + 2×
            {formatPrice(settlement.total_buy_quote_eligible, 0)}) / (
            {formatToken(settlement.reserves_before.rx, 2)} + 2×
            {formatToken(settlement.total_sell_base_eligible, 2)}) =
          </span>
          <span
            data-testid="uniform-clearing-price-readout"
            className="rounded bg-emerald-500/15 px-2 py-0.5 font-bold text-emerald-300"
          >
            ${formatPrice(settlement.clearing_price, 2)} USDC/WETH
          </span>
        </div>

        <div className="flex items-center gap-3 font-mono text-[11px] tabular-nums">
          <span className="inline-flex items-center gap-1 text-cyan-300">
            <GitMerge className="h-3.5 w-3.5" />
            <span>
              CoW P2P: {formatToken(settlement.cow_matched_base, 2)} WETH (
              {formatPrice(settlement.cow_ratio_pct, 1)}%)
            </span>
          </span>
        </div>
      </div>
    </section>
  );
};
