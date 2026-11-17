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

export function formatToken(value: number, maxDecimals = 4, minDecimals = 2): string {
  if (!Number.isFinite(value)) return '0.00';
  return value.toLocaleString('en-US', {
    minimumFractionDigits: minDecimals,
    maximumFractionDigits: Math.max(minDecimals, maxDecimals),
  });
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
  switch (chainId) {
    case 1:
      return 'Ethereum Mainnet';
    case 11155111:
      return 'Ethereum Sepolia';
    case 560048:
      return 'Ethereum Hoodi';
    case 31337:
      return 'Anvil Local EVM';
    default:
      return `Chain #${chainId}`;
  }
}
