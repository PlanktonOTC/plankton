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
]), ...contractErrors];

export const vaultAbi = [...parseAbi([
  'function requestDeposit(uint256 assets) returns (uint256 id)',
  'function requestDepositWithPermit(uint256 assets, uint256 deadline, uint8 v, bytes32 r, bytes32 s) returns (uint256 id)',
  'function requestWithdraw(uint256 shares) returns (uint256 id)',
]), ...contractErrors];

export const payoutDeskAbi = [...parseAbi(['function claim(uint256 id)']), ...contractErrors];

export { erc20Abi };
