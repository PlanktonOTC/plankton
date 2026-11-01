import { erc20Abi, type Address, type ContractFunctionReturnType, type Hex } from 'viem';
import { backstopAbi, exchangeAbi, oracleAbi, payoutDeskAbi, vaultAbi } from './abis.ts';
import type { ChainClient } from './client.ts';
import { USDG_ADDRESS } from './chain.ts';

/** Contract addresses after a deploy. Written to deployments/4663.json. */
export interface Deployment {
  usdg: Address;
  oracle: Address;
  exchange: Address;
  vault: Address;
  backstop: Address;
  firstLoss: Address;
  feeRouter: Address;
  payoutDesk: Address;
  /** Unix seconds of the deploy; the indexer finds its start block from this. */
  deployedAt: number;
}

export type OracleMark = ContractFunctionReturnType<typeof oracleAbi, 'view', 'markOf'>;
export type OracleConfig = ContractFunctionReturnType<typeof oracleAbi, 'view', 'configOf'>;
export type ExchangeConfig = ContractFunctionReturnType<typeof exchangeAbi, 'view', 'configOf'>;
export type ExchangePosition = ContractFunctionReturnType<typeof exchangeAbi, 'view', 'positionOf'>;

export interface MarketSnapshot {
  mark: OracleMark;
  cfg: ExchangeConfig;
  longOI: bigint;
  shortOI: bigint;
  longSize: bigint;
  shortSize: bigint;
  badDebt: bigint;
  navUsdg: bigint;
  deleveraging: boolean;
  totalAbsNet: bigint;
  /** Unix seconds the market last entered Open on-chain: the contract's open guard runs from here. */
  openSince: bigint;
}

/** Everything the quote builder needs about one market, in a single multicall. */
export async function readMarket(client: ChainClient, dep: Deployment, marketId: Hex): Promise<MarketSnapshot> {
  const [mark, cfg, info, navUsdg, deleveraging, totalAbsNet, refs] = await client.multicall({
    allowFailure: false,
    contracts: [
      { address: dep.oracle, abi: oracleAbi, functionName: 'markOf', args: [marketId] },
      { address: dep.exchange, abi: exchangeAbi, functionName: 'configOf', args: [marketId] },
      { address: dep.exchange, abi: exchangeAbi, functionName: 'marketInfo', args: [marketId] },
      { address: dep.vault, abi: vaultAbi, functionName: 'navUsdg' },
      { address: dep.vault, abi: vaultAbi, functionName: 'deleveraging' },
      { address: dep.exchange, abi: exchangeAbi, functionName: 'totalAbsNet' },
      { address: dep.oracle, abi: oracleAbi, functionName: 'referencesOf', args: [marketId] },
    ],
  });
  const [longOI, shortOI, longSize, shortSize, badDebt] = info;
  return {
    mark,
    cfg,
    longOI: BigInt(longOI),
    shortOI: BigInt(shortOI),
    longSize: BigInt(longSize),
    shortSize: BigInt(shortSize),
    badDebt: BigInt(badDebt),
    navUsdg,
    deleveraging,
    totalAbsNet,
    openSince: BigInt(refs[2]),
  };
}

export interface TraderSnapshot {
  position: ExchangePosition;
  collateralUsdg: bigint;
  walletNotionalUsdg: bigint;
}

export async function readTrader(client: ChainClient, dep: Deployment, marketId: Hex, trader: Address): Promise<TraderSnapshot> {
  const [position, collateralUsdg, walletNotionalUsdg] = await client.multicall({
    allowFailure: false,
    contracts: [
      { address: dep.exchange, abi: exchangeAbi, functionName: 'positionOf', args: [trader, marketId] },
      { address: dep.exchange, abi: exchangeAbi, functionName: 'collateral', args: [trader] },
      { address: dep.exchange, abi: exchangeAbi, functionName: 'walletNotional', args: [trader] },
    ],
  });
  return { position, collateralUsdg, walletNotionalUsdg };
}

export interface CounterSnapshot {
  navUsdg: bigint;
  cashUsdg: bigint;
  freeCashUsdg: bigint;
  totalShares: bigint;
  navPerShareE18: bigint;
  oldestPendingWithdrawAgeSec: bigint;
  deleveraging: boolean;
  traderUnrealizedPnlUsdg: bigint;
  reserveUsdg: bigint;
  deferredOutstandingUsdg: bigint;
  backstopUsdg: bigint;
  backstopTargetUsdg: bigint;
  firstLossUsdg: bigint;
  totalBadDebtUsdg: bigint;
  nextRequestId: bigint;
}

export async function readCounter(client: ChainClient, dep: Deployment): Promise<CounterSnapshot> {
  const r = await client.multicall({
    allowFailure: false,
    contracts: [
      { address: dep.vault, abi: vaultAbi, functionName: 'navUsdg' },
      { address: dep.vault, abi: vaultAbi, functionName: 'cashUsdg' },
      { address: dep.vault, abi: vaultAbi, functionName: 'freeCash' },
      { address: dep.vault, abi: vaultAbi, functionName: 'totalSupply' },
      { address: dep.vault, abi: vaultAbi, functionName: 'navPerShareE18' },
      { address: dep.vault, abi: vaultAbi, functionName: 'oldestPendingWithdrawAge' },
      { address: dep.vault, abi: vaultAbi, functionName: 'deleveraging' },
      { address: dep.exchange, abi: exchangeAbi, functionName: 'traderUnrealizedPnlUsdg' },
      { address: dep.exchange, abi: exchangeAbi, functionName: 'counterReserveUsdg' },
      { address: dep.payoutDesk, abi: payoutDeskAbi, functionName: 'outstanding' },
      { address: USDG_ADDRESS, abi: erc20Abi, functionName: 'balanceOf', args: [dep.backstop] },
      { address: dep.backstop, abi: backstopAbi, functionName: 'targetUsdg' },
      { address: USDG_ADDRESS, abi: erc20Abi, functionName: 'balanceOf', args: [dep.firstLoss] },
      { address: dep.exchange, abi: exchangeAbi, functionName: 'totalBadDebt' },
      { address: dep.vault, abi: vaultAbi, functionName: 'nextRequestId' },
    ],
  });
  return {
    navUsdg: r[0],
    cashUsdg: r[1],
    freeCashUsdg: r[2],
    totalShares: r[3],
    navPerShareE18: r[4],
    oldestPendingWithdrawAgeSec: BigInt(r[5]),
    deleveraging: r[6],
    traderUnrealizedPnlUsdg: r[7],
    reserveUsdg: r[8],
    deferredOutstandingUsdg: r[9],
    backstopUsdg: r[10],
    backstopTargetUsdg: r[11],
    firstLossUsdg: r[12],
    totalBadDebtUsdg: r[13],
    nextRequestId: r[14],
  };
}
