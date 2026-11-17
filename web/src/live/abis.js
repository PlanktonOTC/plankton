import { erc20Abi, parseAbi } from 'viem';
import { contractErrors } from './contract-errors.js';

// Only the contract functions a trader's wallet calls. packages/chain/test/web-abi.test.ts checks every signature here
// against the ABIs generated from the Solidity, so a contract change cannot silently break the site.

export const exchangeAbi = [...parseAbi([
  'struct TradeQuote { bytes32 marketId; address trader; int256 sizeDeltaE18; uint256 execPriceE18; uint256 feeUsdg; uint64 maxLeverageE18; uint64 markSequence; uint64 nonce; uint64 expiry; }',
  'function deposit(uint256 amount)',
  'function depositWithPermit(uint256 amount, uint256 deadline, uint8 v, bytes32 r, bytes32 s)',
  'function withdraw(uint256 amount)',
  'function addMargin(bytes32 marketId, uint128 amount)',
  'function execute(TradeQuote q, bytes quoteSig, uint128 marginUsdg)',
  'function permitAndExecute(uint256 amount, uint256 deadline, uint8 v, bytes32 r, bytes32 s, TradeQuote q, bytes quoteSig, uint128 marginUsdg)',
  'function closeAtMark(bytes32 marketId, uint16 sizeBps)',
  'function cancelOrder(uint64 nonce)',
  'function setReferrer(address referrer)',
  'function referrerOf(address trader) view returns (address)',
]), ...contractErrors];

export const feeRouterAbi = parseAbi([
  'function referralBps() view returns (uint16)',
]);

export const vaultAbi = [...parseAbi([
  'function requestDeposit(uint256 assets) returns (uint256 id)',
  'function requestDepositWithPermit(uint256 assets, uint256 deadline, uint8 v, bytes32 r, bytes32 s) returns (uint256 id)',
  'function requestWithdraw(uint256 shares) returns (uint256 id)',
  'function optionsBook() view returns (address)',
  'function optionReserveUsdg() view returns (uint256)',
  'function owner() view returns (address)',
  'function pendingImplementation() view returns (address)',
  'function upgradeEta() view returns (uint64)',
  'function scheduleUpgrade(address implementation)',
  'function upgradeToAndCall(address newImplementation, bytes data) payable',
  'function linkOptionsBook(address book)',
  'function requests(uint256 id) view returns (address owner, bool isDeposit, bool done, uint64 requestedAt, uint128 amount, uint128 filled, uint256 epoch, uint256 npsE18)',
  'event DepositRequested(uint256 indexed id, address indexed owner, uint256 assets)',
  'event WithdrawRequested(uint256 indexed id, address indexed owner, uint256 shares)',
  'event Settled(uint256 indexed id, address indexed owner, bool deposit, uint256 assets, uint256 shares)',
]), ...contractErrors];

export const bellOptionsBookAbi = [...parseAbi([
  'struct Quote { address trader; bytes32 marketId; uint64 expiry; uint256 strikeE18; uint8 optionType; uint256 payoutUsdg; uint256 premiumUsdg; uint64 markSequence; uint64 validUntil; uint256 nonce; }',
  'function buy(Quote q, bytes signature) returns (uint256 ticketId)',
  'function resolve(uint256 ticketId)',
  'function claim(uint256 ticketId)',
  'function tickets(uint256 ticketId) view returns (address buyer, bytes32 marketId, uint64 expiry, uint256 strikeE18, uint256 payoutUsdg, uint256 premiumUsdg, uint256 reservedUsdg, uint8 optionType, uint8 outcome, bool claimed)',
  'function opensEnabled() view returns (bool)',
  'function nextTicketId() view returns (uint256)',
  'function quoteSigner() view returns (address)',
  'function settlementOracle() view returns (address)',
  'event TicketBought(uint256 indexed ticketId, address indexed buyer, bytes32 indexed marketId, uint64 expiry, uint256 strikeE18, uint256 payoutUsdg, uint256 premiumUsdg, uint8 optionType)',
  'event TicketResolved(uint256 indexed ticketId, uint8 outcome, uint256 liabilityUsdg, uint256 settlementPriceE18)',
  'event TicketClaimed(uint256 indexed ticketId, address indexed buyer, uint256 amountUsdg)',
]), ...contractErrors];

export const bellSettlementOracleAbi = parseAbi([
  'function referenceOf(bytes32 marketId, uint64 expiry) view returns (uint256 closeE18, uint64 observedAt, bool exists)',
  'function settlementOf(bytes32 marketId, uint64 expiry) view returns (uint256 priceE18, bool resolved)',
]);

export const payoutDeskAbi = [...parseAbi(['function claim(uint256 id)']), ...contractErrors];

export { erc20Abi };
