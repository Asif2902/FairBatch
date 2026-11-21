import { parseAbi } from 'viem';

/**
 * Shared ABI subset for FairBatch & MockERC20 matching `frontend/src/onchain/abi.ts`
 * and the frozen Fe 26.5.0 contracts in `src/`.
 */
export const fairBatchAbi = parseAbi([
  'function settleBatch() returns ((uint256 batchId, bool settled, uint256 clearingPrice, uint256 totalSellBase, uint256 totalBuyQuote, uint256 cowMatchedBase, uint256 cowMatchedQuote, uint256 reserveBaseAfter, uint256 reserveQuoteAfter, uint256 orderCount))',
  'function slashUnrevealed(uint256 batchId, uint256 commitId) returns (uint256 forfeitedBond)',
  'function submitSignedIntent((address trader, uint8 side, uint256 amountIn, uint256 limitPrice, uint256 batchId, uint256 nonce, uint256 deadline) order, bytes signature) returns (uint256 orderId)',
  'function currentBatch() view returns ((uint256 batchId, uint256 startTime, uint256 commitDeadline, uint256 revealDeadline, uint256 orderCount, uint256 commitCount, uint8 phase))',
  'function getBatchSummary(uint256 batchId) view returns ((uint256 batchId, bool settled, uint256 clearingPrice, uint256 totalSellBase, uint256 totalBuyQuote, uint256 cowMatchedBase, uint256 cowMatchedQuote, uint256 reserveBaseAfter, uint256 reserveQuoteAfter, uint256 orderCount))',
  'function getCommitment(uint256 batchId, uint256 commitId) view returns ((uint256 commitId, address trader, uint256 commitmentHash, uint256 bond, bool revealed, bool slashed))',
  'function getNonce(address trader) view returns (uint256)',
  'function domainSeparator() view returns (uint256)',
]);

export const fairBatchEvents = parseAbi([
  'event OrderCommitted(uint256 indexed batchId, uint256 indexed commitId, address indexed trader, uint256 commitmentHash, uint256 bond)',
  'event OrderSubmitted(uint256 indexed batchId, uint256 indexed orderId, address indexed trader, uint8 side, uint256 amountIn, uint256 limitPrice, uint8 mode)',
  'event BatchSettled(uint256 indexed batchId, uint256 clearingPrice, uint256 totalSellBase, uint256 totalBuyQuote, uint256 cowMatchedBase, uint256 cowMatchedQuote, uint256 reserveBaseAfter, uint256 reserveQuoteAfter, uint256 orderCount)',
  'event CommitmentSlashed(uint256 indexed batchId, uint256 indexed commitId, address indexed trader, address slasher, uint256 forfeitedBond)',
]);

export const erc20Abi = parseAbi([
  'function balanceOf(address account) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
]);
