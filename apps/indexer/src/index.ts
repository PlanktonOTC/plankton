import pino from 'pino';
import { parseAbi, parseEventLogs, type Log } from 'viem';
import { loadDeployment, loadEnv, requireDatabaseUrl } from '@plankton/config';
import { blockAtOrAfter, createChainClient, exchangeAbi, readRangeSplitting, vaultAbi } from '@plankton/chain';
import { and, counterActivity, counterNavSnapshots, createDb, desc, eq, indexerCursor, lte, orders, positions, sql, trades } from '@plankton/db';

// Copies Exchange events into Postgres: positions (current state), trades (history) and order cancels.
// The chain stays the source of truth: wipe the tables and set the cursor back to replay from the deploy block.

const env = loadEnv();
const log = pino({ level: env.LOG_LEVEL });
const dep = loadDeployment();
const client = createChainClient(env.RPC_URLS);
const { db } = createDb(requireDatabaseUrl(env), { max: 4 });

const CURSOR = 'exchange';
const ACTIVITY_CURSOR = 'counter-activity';
const STEP = 5_000n; // blocks per getLogs call; halved automatically if the node objects
const REORG_DEPTH = 20n; // re-read this many blocks each loop; every write is idempotent
const POLL_MS = 2_000;
const ACTIVITY_LOOKBACK_SEC = 30 * 24 * 60 * 60;
const feeRouterAbi = parseAbi(['event Routed(uint256 fee, uint256 referral, uint256 counter, uint256 backstop, uint256 junior, uint256 treasury)']);

const blockTimes = new Map<bigint, Date>();
async function blockTime(n: bigint): Promise<Date> {
  let t = blockTimes.get(n);
  if (!t) {
    const b = await client.getBlock({ blockNumber: n });
    t = new Date(Number(b.timestamp) * 1000);
    blockTimes.set(n, t);
    if (blockTimes.size > 5_000) blockTimes.delete(blockTimes.keys().next().value!);
  }
  return t;
}

const getLogs = (fromBlock: bigint, toBlock: bigint): Promise<Log[]> =>
  readRangeSplitting(fromBlock, toBlock, (a, b) => client.getLogs({ address: dep.exchange, fromBlock: a, toBlock: b }));

const getFeeRouterLogs = (fromBlock: bigint, toBlock: bigint): Promise<Log[]> =>
  readRangeSplitting(fromBlock, toBlock, (a, b) => client.getLogs({ address: dep.feeRouter, fromBlock: a, toBlock: b }));

async function recordActivity(event: Log, kind: string, amountUsdg: bigint, marketId: string | null, details: Record<string, string>) {
  const block = event.blockNumber!;
  await db.insert(counterActivity).values({
    txHash: event.transactionHash!,
    logIndex: event.logIndex!,
    block,
    at: await blockTime(block),
    kind,
    marketId,
    amountUsdg: amountUsdg.toString(),
    details,
  }).onConflictDoNothing();
}

async function handle(logs: Log[]): Promise<void> {
  const events = parseEventLogs({ abi: exchangeAbi, logs });
  for (const e of events) {
    const block = e.blockNumber!;
    switch (e.eventName) {
      case 'TradeExecuted': {
        const a = e.args;
        await db
          .insert(trades)
          .values({
            txHash: e.transactionHash!,
            logIndex: e.logIndex!,
            block,
            at: await blockTime(block),
            trader: a.trader.toLowerCase(),
            marketId: a.marketId.toLowerCase(),
            sizeDeltaE18: a.sizeDeltaE18.toString(),
            priceE18: a.priceE18.toString(),
            feeUsdg: a.feeUsdg.toString(),
            realizedPnlUsdg: a.realizedPnlUsdg.toString(),
            path: a.path,
          })
          .onConflictDoNothing();
        break;
      }
      case 'PositionUpdated': {
        const a = e.args;
        const trader = a.trader.toLowerCase();
        const marketId = a.marketId.toLowerCase();
        if (a.sizeE18 === 0n) {
          await db.delete(positions).where(and(eq(positions.trader, trader), eq(positions.marketId, marketId), lte(positions.updatedBlock, block)));
        } else {
          await db
            .insert(positions)
            .values({
              trader,
              marketId,
              sizeE18: a.sizeE18.toString(),
              entryE18: a.entryE18.toString(),
              marginUsdg: a.marginUsdg.toString(),
              openedAt: await blockTime(block),
              updatedBlock: block,
            })
            .onConflictDoUpdate({
              target: [positions.trader, positions.marketId],
              set: { sizeE18: a.sizeE18.toString(), entryE18: a.entryE18.toString(), marginUsdg: a.marginUsdg.toString(), updatedBlock: block },
              setWhere: lte(positions.updatedBlock, block),
            });
        }
        break;
      }
      case 'OrderCancelled': {
        const a = e.args;
        await db
          .update(orders)
          .set({ status: 'cancelled' })
          .where(and(eq(orders.trader, a.trader.toLowerCase()), eq(orders.nonce, BigInt(a.nonce)), eq(orders.status, 'open')));
        break;
      }
      default:
        break;
    }
  }
}

async function handleFeeRouter(logs: Log[]): Promise<void> {
  for (const event of parseEventLogs({ abi: feeRouterAbi, logs })) {
    const a = event.args;
    await recordActivity(event, 'fee_income', a.counter, null, {
      grossFees: a.fee.toString(),
      referralRebate: a.referral.toString(),
      counter: a.counter.toString(),
      backstop: a.backstop.toString(),
      firstLoss: a.junior.toString(),
      treasury: a.treasury.toString(),
    });
  }
}

async function handleExchangeActivity(logs: Log[]): Promise<void> {
  for (const event of parseEventLogs({ abi: exchangeAbi, logs })) {
    if (event.eventName === 'BadDebt') await recordActivity(event, 'bad_debt', event.args.amountUsdg, event.args.marketId.toLowerCase(), {});
    if (event.eventName === 'BadDebtCovered') await recordActivity(event, 'bad_debt_covered', event.args.amountUsdg, event.args.marketId.toLowerCase(), {});
  }
}

let startBlockCache: bigint | null = null;
async function startBlock(head: bigint): Promise<bigint> {
  // Two minutes of slack before the deploy: reading a little too early is harmless, too late would lose events.
  startBlockCache ??= await blockAtOrAfter(client, dep.deployedAt - 120, head);
  return startBlockCache;
}

async function loadCursor(head: bigint): Promise<bigint> {
  const row = await db.select().from(indexerCursor).where(eq(indexerCursor.name, CURSOR));
  return row[0]?.block ?? (await startBlock(head));
}

async function saveCursor(block: bigint): Promise<void> {
  await db
    .insert(indexerCursor)
    .values({ name: CURSOR, block })
    .onConflictDoUpdate({ target: indexerCursor.name, set: { block: sql`excluded.block` } });
}

let activityStartBlock: bigint | null = null;
async function loadActivityCursor(head: bigint): Promise<bigint> {
  const row = await db.select().from(indexerCursor).where(eq(indexerCursor.name, ACTIVITY_CURSOR));
  if (row[0]) return row[0].block;
  activityStartBlock ??= await blockAtOrAfter(client, Math.floor(Date.now() / 1_000) - ACTIVITY_LOOKBACK_SEC, head);
  return activityStartBlock;
}

async function saveActivityCursor(block: bigint): Promise<void> {
  await db.insert(indexerCursor).values({ name: ACTIVITY_CURSOR, block })
    .onConflictDoUpdate({ target: indexerCursor.name, set: { block: sql`excluded.block` } });
}

async function indexCounterActivity(head: bigint): Promise<number> {
  const saved = await loadActivityCursor(head);
  activityStartBlock ??= await blockAtOrAfter(client, Math.floor(Date.now() / 1_000) - ACTIVITY_LOOKBACK_SEC, head);
  const start = activityStartBlock;
  let from = saved > REORG_DEPTH + start ? saved - REORG_DEPTH : start;
  let processed = 0;
  while (from <= head) {
    const to = from + STEP - 1n < head ? from + STEP - 1n : head;
    const [exchangeLogs, feeLogs] = await Promise.all([getLogs(from, to), getFeeRouterLogs(from, to)]);
    await Promise.all([handleExchangeActivity(exchangeLogs), handleFeeRouter(feeLogs)]);
    processed += exchangeLogs.length + feeLogs.length;
    from = to + 1n;
  }
  await saveActivityCursor(head);
  return processed;
}

let lastSnapshotHour: bigint | null = null;
async function saveCounterSnapshot(blockNumber: bigint): Promise<void> {
  const block = await client.getBlock({ blockNumber });
  const hour = block.timestamp / 3_600n;
  if (lastSnapshotHour !== null && hour <= lastSnapshotHour) return;
  const [navUsdg, navPerShareE18, totalShares] = await client.multicall({
    allowFailure: false,
    blockNumber,
    contracts: [
      { address: dep.vault, abi: vaultAbi, functionName: 'navUsdg' },
      { address: dep.vault, abi: vaultAbi, functionName: 'navPerShareE18' },
      { address: dep.vault, abi: vaultAbi, functionName: 'totalSupply' },
    ],
  });
  await db.insert(counterNavSnapshots).values({
    hour,
    block: blockNumber,
    at: new Date(Number(block.timestamp) * 1_000),
    navUsdg: navUsdg.toString(),
    navPerShareE18: navPerShareE18.toString(),
    totalShares: totalShares.toString(),
  }).onConflictDoUpdate({
    target: counterNavSnapshots.hour,
    set: { block: blockNumber, at: new Date(Number(block.timestamp) * 1_000), navUsdg: navUsdg.toString(), navPerShareE18: navPerShareE18.toString(), totalShares: totalShares.toString() },
  });
  lastSnapshotHour = hour;
}

async function tick(): Promise<void> {
  const head = await client.getBlockNumber();
  await saveCounterSnapshot(head);
  const saved = await loadCursor(head);
  const start = await startBlock(head);
  let from = saved > REORG_DEPTH + start ? saved - REORG_DEPTH : start;
  if (from > head) return;

  let processed = 0;
  while (from <= head) {
    const to = from + STEP - 1n < head ? from + STEP - 1n : head;
    const logs = await getLogs(from, to);
    await handle(logs);
    processed += logs.length;
    from = to + 1n;
  }
  processed += await indexCounterActivity(head);
  await saveCursor(head);
  if (processed > 0) log.info({ head, logs: processed }, 'indexed');
}

let running = false;
async function loop(): Promise<void> {
  if (running) return;
  running = true;
  try {
    await tick();
  } catch (err) {
    log.warn({ err: (err as Error).message }, 'index tick failed, will retry');
  } finally {
    running = false;
  }
}

log.info({ exchange: dep.exchange, deployedAt: dep.deployedAt }, 'indexer started');
void db.select({ hour: counterNavSnapshots.hour }).from(counterNavSnapshots).orderBy(desc(counterNavSnapshots.hour)).limit(1)
  .then((rows) => { lastSnapshotHour = rows[0]?.hour ?? null; return loop(); })
  .catch((err) => log.warn({ err: (err as Error).message }, 'counter history bootstrap failed'));
setInterval(loop, POLL_MS);
