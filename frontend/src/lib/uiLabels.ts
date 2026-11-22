/**
 * Single canonical registry of UI button labels used across Simple mode, Pro mode,
 * tooltips, in-app /docs, and README.md.
 *
 * `frontend/src/__tests__/labelParity.test.ts` enforces that documentation never
 * cites a button label outside this file.
 */
export const UI_LABELS = {
  // Wallet & Faucet
  connectWallet: 'Connect wallet',
  connectWalletToSwap: 'Connect wallet to swap',
  switchToSepolia: 'Switch to Sepolia',
  getFreeTestTokens: 'Get free test tokens',

  // Simple Swap & Round Actions
  swap: 'Swap',
  swapNowSignAndSend: 'Swap now (sign & send)',
  signAndRelaySwap: 'Sign & relay swap (no submission gas)',
  placePrivateSwap: 'Place private swap',
  startNextRound: 'Start next round',
  startNextRoundAndSwap: 'Start next round & Swap',
  startNextRoundAndPlacePrivateSwap: 'Start next round & place private swap',
  submitItMyself: 'Submit it myself',
  revealNow: 'Reveal now',

  // Simple Collect Actions
  collectTokens: 'Collect tokens',
  collectAllOrders: (count: number) => `Collect all ${count} orders`,
  collectAllOrdersPattern: 'Collect all N orders',

  // Pro Settlement, Claims & Slashing Actions
  settleBatchAndOpenNext: (batchId: number) => `Settle Batch #${batchId} & open next`,
  settleBatchAndOpenNextPattern: 'Settle Batch #N & open next',
  multicallMyClaims: (count: number) => `Multicall My Claims (${count})`,
  multicallMyClaimsPattern: 'Multicall My Claims (N)',
  claimPayout: 'Claim Payout',
  slashAndClaimBounty: 'Slash & claim bounty',

  // Liquidity / Earn Actions
  addLiquidity: 'Add liquidity',
  removeLiquidity: 'Remove liquidity',
  withdraw: 'Withdraw',
} as const;

/**
 * Flat set of canonical static button labels permitted in documentation,
 * tooltips, and README UI instructions.
 */
export const CANONICAL_DOC_BUTTON_LABELS: ReadonlySet<string> = new Set([
  UI_LABELS.connectWallet,
  UI_LABELS.connectWalletToSwap,
  UI_LABELS.switchToSepolia,
  UI_LABELS.getFreeTestTokens,
  UI_LABELS.swap,
  UI_LABELS.swapNowSignAndSend,
  UI_LABELS.signAndRelaySwap,
  UI_LABELS.placePrivateSwap,
  UI_LABELS.startNextRound,
  UI_LABELS.startNextRoundAndSwap,
  UI_LABELS.startNextRoundAndPlacePrivateSwap,
  UI_LABELS.submitItMyself,
  UI_LABELS.revealNow,
  UI_LABELS.collectTokens,
  UI_LABELS.collectAllOrdersPattern,
  UI_LABELS.settleBatchAndOpenNextPattern,
  UI_LABELS.multicallMyClaimsPattern,
  UI_LABELS.claimPayout,
  UI_LABELS.slashAndClaimBounty,
  UI_LABELS.addLiquidity,
  UI_LABELS.removeLiquidity,
  UI_LABELS.withdraw,
]);

/**
 * Former / drifted button labels that must NEVER reappear in docs, tooltips, or README.
 */
export const FORBIDDEN_STALE_LABELS: ReadonlyArray<string> = [
  'Finish Round',
  'Collect all N orders (one click)',
  'Get Test Tokens',
  'Claim Faucet',
  'Multicall Claim',
  'Settle manually',
  'Settle now',
];
