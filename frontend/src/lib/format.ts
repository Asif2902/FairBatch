export function formatPrice(value: number, decimals = 2): string {
  if (!Number.isFinite(value)) return '0.00';
  return value.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

export function formatUsd(value: number, decimals = 2): string {
  if (!Number.isFinite(value)) return '$0.00';
  const sign = value < 0 ? '-' : '';
  return (
    sign +
    '$' +
    Math.abs(value).toLocaleString('en-US', {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    })
  );
}

/**
 * Formats a token quantity without ever displaying "0.00" or "-0.00" for a
 * strictly non-zero amount (shows "<0.0001" / "<0.01" below display precision).
 */
export function formatToken(value: number, maxDecimals = 4, minDecimals = 2): string {
  const cap = Math.max(minDecimals, maxDecimals);
  if (!Number.isFinite(value) || value === 0) {
    return (0).toLocaleString('en-US', {
      minimumFractionDigits: minDecimals,
      maximumFractionDigits: cap,
    });
  }
  const abs = Math.abs(value);
  const threshold = Math.pow(10, -cap);
  if (abs < threshold) {
    const label = `<${threshold.toFixed(cap)}`;
    return value < 0 ? `-${label}` : label;
  }
  return value.toLocaleString('en-US', {
    minimumFractionDigits: minDecimals,
    maximumFractionDigits: cap,
  });
}

export type TokenFormatKind = 'base' | 'quote' | 'eth' | 'shares';

/**
 * Single shared token-amount formatter used across balance rows, inputs,
 * receipts, and order lists so decimals stay consistent and non-zero amounts
 * never round to "0.00" or "-0.00".
 */
export function formatTokenAmount(
  value: number,
  kind: TokenFormatKind = 'base',
  overrideDecimals?: number,
): string {
  if (overrideDecimals !== undefined) {
    return formatToken(value, overrideDecimals, overrideDecimals);
  }
  switch (kind) {
    case 'quote':
      return formatToken(value, 2, 2);
    case 'base':
    case 'eth':
    case 'shares':
      return formatToken(value, 4, 2);
  }
}

/**
 * Formats a signed order delta (e.g. "−0.001 fWETH", "−<0.0001 fWETH", "+50.00 fUSDC")
 * without ever rendering "−0.00" for a non-zero order.
 */
export function formatSignedOrderAmount(
  value: number,
  kind: 'base' | 'quote',
  direction: '-' | '+',
): string {
  const abs = Math.abs(value);
  const sign = direction === '-' ? '−' : '+';
  if (!Number.isFinite(abs) || abs === 0) {
    return `${sign}${formatTokenAmount(0, kind)}`;
  }
  return `${sign}${formatTokenAmount(abs, kind)}`;
}

/**
 * Picks the smallest decimal count in [minDecimals, maxDecimals] at which:
 *   1. No strictly non-zero row rounds down to zero, AND
 *   2. The sum of individually rounded row amounts equals the rounded total,
 * so displayed rows always reconcile cleanly with the displayed headline total.
 */
export function pickReconciledDecimals(
  values: number[],
  minDecimals = 2,
  maxDecimals = 6,
): number {
  const nonZero = values.filter((v) => Number.isFinite(v) && Math.abs(v) > 0);
  if (nonZero.length === 0) return minDecimals;
  const exactTotal = nonZero.reduce((acc, v) => acc + v, 0);
  for (let d = minDecimals; d <= maxDecimals; d += 1) {
    const scale = Math.pow(10, d);
    const allVisible = nonZero.every((v) => Math.round(Math.abs(v) * scale) >= 1);
    if (!allVisible) continue;
    const roundedSum = nonZero.reduce((acc, v) => acc + Math.round(v * scale), 0);
    const totalRounded = Math.round(exactTotal * scale);
    if (roundedSum === totalRounded) {
      return d;
    }
  }
  return maxDecimals;
}

export function formatInvariant(k: number): string {
  if (!Number.isFinite(k) || k <= 0) return '0';
  if (k >= 1_000_000_000) return `${(k / 1_000_000_000).toFixed(3)}B`;
  if (k >= 1_000_000) return `${(k / 1_000_000).toFixed(3)}M`;
  if (k >= 1_000) return `${(k / 1_000).toFixed(2)}K`;
  return k.toFixed(2);
}

export function shortenAddress(addr: string): string {
  if (!addr || addr.length < 12) return addr || '0x0000…0000';
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export function getChainLabel(chainId: number): string {
  if (chainId === 11155111) return 'Ethereum Sepolia';
  return `Chain #${chainId}`;
}

export function formatDuration(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) return '0s';
  const secs = Math.floor(totalSeconds);
  const days = Math.floor(secs / 86_400);
  const hours = Math.floor((secs % 86_400) / 3_600);
  const minutes = Math.floor((secs % 3_600) / 60);
  const rem = secs % 60;
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  if (minutes > 0) return rem > 0 ? `${minutes}m ${String(rem).padStart(2, '0')}s` : `${minutes}m`;
  return `${rem}s`;
}
