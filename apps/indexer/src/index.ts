import pino from 'pino';
import { parseEventLogs, type Log } from 'viem';
import { loadDeployment, loadEnv, requireDatabaseUrl } from '@plankton/config';
import { blockAtOrAfter, createChainClient, exchangeAbi, readRangeSplitting } from '@plankton/chain';
import { and, createDb, eq, indexerCursor, lte, orders, positions, sql, trades } from '@plankton/db';

// Copies Exchange events into Postgres: positions (current state), trades (history) and order cancels.
// The chain stays the source of truth: wipe the tables and set the cursor back to replay from the deploy block.

const env = loadEnv();
const log = pino({ level: env.LOG_LEVEL });
const dep = loadDeployment();
const client = createChainClient(env.RPC_URLS);
const { db } = createDb(requireDatabaseUrl(env), { max: 4 });

const CURSOR = 'exchange';
const STEP = 5_000n; // blocks per getLogs call; halved automatically if the node objects
const REORG_DEPTH = 20n; // re-read this many blocks each loop; every write is idempotent
const POLL_MS = 2_000;

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

async function tick(): Promise<void> {
  const head = await client.getBlockNumber();
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
void loop();
setInterval(loop, POLL_MS);
