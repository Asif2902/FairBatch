import { parseAbi } from 'viem';

/**
 * Hand-authored ABI for the deployed Fe 26.5.0 FairBatch contract.
 *
 * Fe emits ABI structs as tuples. The contract exposes one tuple return per
 * view, so these signatures must stay in sync with `src/types.fe` and the
 * `FairBatchMsg` selectors in `src/lib.fe`.
 */
export const fairBatchAbi = parseAbi([
  'function seedReserves(uint256 amountBase, uint256 amountQuote) returns (uint256 sharesMinted)',
  'function addLiquidity(uint256 amountBase, uint256 amountQuote) returns (uint256 sharesMinted)',
  'function removeLiquidity(uint256 shares) returns (uint256 amountBase, uint256 amountQuote)',
  'function commitOrder(uint256 commitmentHash) payable returns (uint256 commitId)',
  'function revealOrder(uint256 commitId, uint8 side, uint256 amountIn, uint256 limitPrice, uint256 salt) returns (uint256 orderId)',
  'function submitDirectOrder(uint8 side, uint256 amountIn, uint256 limitPrice) returns (uint256 orderId)',
  'function submitSignedIntent((address trader, uint8 side, uint256 amountIn, uint256 limitPrice, uint256 batchId, uint256 nonce, uint256 deadline) order, bytes signature) returns (uint256 orderId)',
  'function slashUnrevealed(uint256 batchId, uint256 commitId) returns (uint256 forfeitedBond)',
  'function settleBatch() returns ((uint256 batchId, bool settled, uint256 clearingPrice, uint256 totalSellBase, uint256 totalBuyQuote, uint256 cowMatchedBase, uint256 cowMatchedQuote, uint256 reserveBaseAfter, uint256 reserveQuoteAfter, uint256 orderCount))',
  'function claim(uint256 batchId, uint256 orderId) returns (uint256 payoutBase, uint256 payoutQuote)',
  'function currentBatch() view returns ((uint256 batchId, uint256 startTime, uint256 commitDeadline, uint256 revealDeadline, uint256 orderCount, uint256 commitCount, uint8 phase))',
  'function getReserves() view returns ((uint256 reserveBase, uint256 reserveQuote, uint256 totalShares, uint256 spotPriceWad))',
  'function getBatchSummary(uint256 batchId) view returns ((uint256 batchId, bool settled, uint256 clearingPrice, uint256 totalSellBase, uint256 totalBuyQuote, uint256 cowMatchedBase, uint256 cowMatchedQuote, uint256 reserveBaseAfter, uint256 reserveQuoteAfter, uint256 orderCount))',
  'function getOrderReceipt(uint256 batchId, uint256 orderId) view returns ((uint256 orderId, address trader, uint8 side, uint256 amountIn, uint256 limitPrice, uint256 amountFilled, uint256 payoutBase, uint256 payoutQuote, bool settled, bool claimed))',
  'function getCommitment(uint256 batchId, uint256 commitId) view returns ((uint256 commitId, address trader, uint256 commitmentHash, uint256 bond, bool revealed, bool slashed))',
  'function getNonce(address trader) view returns (uint256)',
  'function getLpShares(address provider) view returns (uint256)',
  'function domainSeparator() view returns (uint256)',
  'function computeCommitmentHash(uint256 batchId, address trader, uint8 side, uint256 amountIn, uint256 limitPrice, uint256 salt) view returns (uint256)',
  'function computeIntentDigest((address trader, uint8 side, uint256 amountIn, uint256 limitPrice, uint256 batchId, uint256 nonce, uint256 deadline) order) view returns (uint256)',
  'function multicall(bytes[] data) returns (bytes[] results)',
]);

export const fairBatchEvents = parseAbi([
  'event LiquidityAdded(address indexed provider, uint256 amountBase, uint256 amountQuote, uint256 sharesMinted)',
  'event LiquidityRemoved(address indexed provider, uint256 amountBase, uint256 amountQuote, uint256 sharesBurned)',
  'event OrderCommitted(uint256 indexed batchId, uint256 indexed commitId, address indexed trader, uint256 commitmentHash, uint256 bond)',
  'event OrderRevealed(uint256 indexed batchId, uint256 indexed orderId, address indexed trader, uint256 commitId, uint8 side, uint256 amountIn, uint256 limitPrice)',
  'event OrderSubmitted(uint256 indexed batchId, uint256 indexed orderId, address indexed trader, uint8 side, uint256 amountIn, uint256 limitPrice, uint8 mode)',
  'event CommitmentSlashed(uint256 indexed batchId, uint256 indexed commitId, address indexed trader, uint256 forfeitedBond)',
  'event BatchSettled(uint256 indexed batchId, uint256 clearingPrice, uint256 totalSellBase, uint256 totalBuyQuote, uint256 cowMatchedBase, uint256 cowMatchedQuote, uint256 reserveBaseAfter, uint256 reserveQuoteAfter, uint256 orderCount)',
  'event OrderClaimed(uint256 indexed batchId, uint256 indexed orderId, address indexed trader, uint256 payoutBase, uint256 payoutQuote)',
]);

export const erc20Abi = parseAbi([
  'function decimals() view returns (uint8)',
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address account) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function transferFrom(address from, address to, uint256 amount) returns (bool)',
  'function mint(address to, uint256 amount) returns (bool)',
  'function mintAndApprove(address owner, address spender, uint256 amount) returns (bool)',
]);
