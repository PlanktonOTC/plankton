import { randomBytes } from 'node:crypto';
import { sendNotification, setVapidDetails } from 'web-push';
import { acquireLease, releaseLease } from '@plankton/db';
import { and, eq, isNull, liquidationChallenges, liquidationWarningStates, lt, positions, pushSubscriptions, telegramLinks, type Db } from '@plankton/db';
import type { Env } from '@plankton/config';
import { notifyTelegramWallet } from './telegram.ts';

const randomNonce = () => randomBytes(24).toString('hex');
const E18 = 10n ** 18n;

export function createLiquidationChallenge(wallet: string, nonce: string, expires: number): string {
  return `Plankton liquidation alerts\nWallet: ${wallet.toLowerCase()}\nNonce: ${nonce}\nExpires: ${expires}`;
}

type PushPayload = { title: string; body: string; url: string; tag: string };

async function sendPush(env: Env, db: Db, wallet: string, payload: PushPayload): Promise<boolean> {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) return false;
  const rows = await db.select().from(pushSubscriptions).where(eq(pushSubscriptions.wallet, wallet));
  if (!rows.length) return false;
  setVapidDetails(env.VAPID_SUBJECT, env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY);
  const results = await Promise.allSettled(rows.map(async (sub) => {
    try {
      await sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, JSON.stringify(payload), { TTL: 300, urgency: 'high' });
      return true;
    } catch (error) {
      const status = (error as { statusCode?: number }).statusCode;
      if (status === 404 || status === 410) await db.delete(pushSubscriptions).where(and(eq(pushSubscriptions.wallet, wallet), eq(pushSubscriptions.endpoint, sub.endpoint)));
      throw new Error('push delivery failed');
    }
  }));
  return results.some((result) => result.status === 'fulfilled');
}

function distanceBps(size: bigint, mark: bigint, liquidation: bigint): bigint {
  if (mark <= 0n || liquidation <= 0n) return 100_000n;
  const signed = size > 0n ? mark - liquidation : liquidation - mark;
  return signed * 10_000n / mark;
}

/** Poll indexed positions against current, accepted marks. It only warns; it never changes a position. */
export function startLiquidationMonitor({
  env, db, symbolOf, riskFor, log,
}: {
  env: Env;
  db: () => Db;
  symbolOf: (marketId: string) => string | null;
  riskFor: (symbol: string) => Promise<{ markE18: bigint; maintenanceMarginBps: number; status: number; confidenceBps: number; borrowBaseBpsPerHour: number } | null>;
  log: { warn: (data: object, message: string) => void };
}) {
  if (!env.DATABASE_URL || (!env.TELEGRAM_BOT_TOKEN && !(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY))) return;
  const holder = randomBytes(12).toString('hex');
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    const database = db();
    let locked = false;
    try {
      locked = await acquireLease(database, 'liquidation-warning-monitor', holder, 60);
      if (!locked) return;
      const [rows, telegramWallets, pushWallets] = await Promise.all([
        database.select().from(positions),
        env.TELEGRAM_BOT_TOKEN ? database.select({ wallet: telegramLinks.wallet }).from(telegramLinks) : Promise.resolve([]),
        env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY ? database.select({ wallet: pushSubscriptions.wallet }).from(pushSubscriptions) : Promise.resolve([]),
      ]);
      const recipients = new Set([...telegramWallets, ...pushWallets].map((row) => row.wallet));
      const active = rows.filter((p) => BigInt(p.sizeE18) !== 0n && recipients.has(p.trader));
      const liveKeys = new Set<string>();
      const configs = new Map<string, Awaited<ReturnType<typeof riskFor>>>();
      for (const position of active) {
        const key = `${position.trader}:${position.marketId}`;
        liveKeys.add(key);
        const symbol = symbolOf(position.marketId);
        if (!symbol) continue;
        if (!configs.has(symbol)) configs.set(symbol, await riskFor(symbol).catch(() => null));
        const risk = configs.get(symbol);
        // Frozen and halted markets block liquidations. Open/extended marks must be accepted and confident;
        // weekend positions can still be margin-liquidated at the held mark, so those use an equity-buffer warning.
        if (!risk || ![1, 2, 3].includes(risk.status) || risk.markE18 <= 0n || (risk.status !== 3 && risk.confidenceBps > 500)) continue;

        const size = BigInt(position.sizeE18);
        const entry = BigInt(position.entryE18);
        const margin = BigInt(position.marginUsdg);
        const sizeAbs = size < 0n ? -size : size;
        const mm = BigInt(risk.maintenanceMarginBps);
        if (mm <= 0n || mm >= 10_000n) continue;
        const notionalAtEntry = sizeAbs * entry / E18 / 10n ** 12n;
        const elapsedSec = position.openedAt ? Math.max(0, Math.floor((Date.now() - position.openedAt.getTime()) / 1000)) : 0;
        // Use the configured base borrow rate as a conservative ceiling from the indexer's last position update.
        const borrowEstimate = notionalAtEntry * BigInt(risk.borrowBaseBpsPerHour) * BigInt(elapsedSec) / (10_000n * 3_600n);
        const estimatedMargin = borrowEstimate >= margin ? 0n : margin - borrowEstimate;
        const marginE18 = estimatedMargin * 10n ** 12n;
        const liquidation = size > 0n
          ? (() => { const num = (sizeAbs * entry - marginE18 * E18) * 10_000n; return num <= 0n ? 0n : num / (sizeAbs * (10_000n - mm)); })()
          : ((sizeAbs * entry + marginE18 * E18) * 10_000n) / (sizeAbs * (10_000n + mm));
        const distance = distanceBps(size, risk.markE18, liquidation);
        let warningDistance = distance;
        if (risk.status === 3) {
          const notional = sizeAbs * risk.markE18 / E18 / 10n ** 12n;
          const pnl = size * (risk.markE18 - entry) / E18 / 10n ** 12n;
          const equity = estimatedMargin + pnl;
          const maintenance = notional * mm / 10_000n;
          warningDistance = equity <= 0n ? -10_000n : (equity - maintenance) * 10_000n / equity;
        }
        const level = warningDistance <= 500n ? 2 : warningDistance <= 1_000n ? 1 : 0;
        const previous = await database.select({ level: liquidationWarningStates.level }).from(liquidationWarningStates)
          .where(and(eq(liquidationWarningStates.wallet, position.trader), eq(liquidationWarningStates.marketId, position.marketId))).limit(1);
        const oldLevel = previous[0]?.level ?? 0;
        if (level === 0) {
          if (oldLevel > 0 && warningDistance > 1_200n) await database.delete(liquidationWarningStates)
            .where(and(eq(liquidationWarningStates.wallet, position.trader), eq(liquidationWarningStates.marketId, position.marketId)));
          continue;
        }
        if (level <= oldLevel) continue;

        const side = size > 0n ? 'long' : 'short';
        const distanceText = risk.status === 3
          ? `${warningDistance < 0n ? 'below' : (Number(warningDistance) / 100).toFixed(1) + '%'} equity buffer above maintenance at the held mark`
          : `${distance < 0n ? 'past the estimated level' : `${(Number(distance) / 100).toFixed(1)}% from the estimated level`}`;
        const price = (value: bigint) => Number(value) / Number(E18);
        const title = `${symbol} ${side} liquidation warning`;
        const body = risk.status === 3
          ? `${distanceText}. Held mark $${price(risk.markE18).toFixed(4)}; estimated borrow since last position update is included. Consider reviewing the position.`
          : `${distanceText}. Live mark $${price(risk.markE18).toFixed(4)}; estimated liquidation $${price(liquidation).toFixed(4)}. Borrow estimate since last position update is included. Consider reviewing the position.`;
        const payload = { title, body, url: '/trade', tag: `liquidation-${position.marketId}-${level}` };
        const deliveries = await Promise.allSettled([
          sendPush(env, database, position.trader, payload),
          notifyTelegramWallet(env, database, position.trader, `${title}\n${body}\nThis is an estimate, not a guaranteed liquidation level.`),
        ]);
        if (!deliveries.some((delivery) => delivery.status === 'fulfilled' && delivery.value)) continue;
        await database.insert(liquidationWarningStates).values({ wallet: position.trader, marketId: position.marketId, level })
          .onConflictDoUpdate({ target: [liquidationWarningStates.wallet, liquidationWarningStates.marketId], set: { level, updatedAt: new Date() } });
      }
      const states = await database.select({ wallet: liquidationWarningStates.wallet, marketId: liquidationWarningStates.marketId }).from(liquidationWarningStates);
      for (const state of states) if (!liveKeys.has(`${state.wallet}:${state.marketId}`)) {
        await database.delete(liquidationWarningStates).where(and(eq(liquidationWarningStates.wallet, state.wallet), eq(liquidationWarningStates.marketId, state.marketId)));
      }
    } catch {
      // Never include private push endpoints, chat IDs, or bot credentials in logs.
      log.warn({ event: 'liquidation_warning_check_failed' }, 'liquidation warning check failed');
    } finally {
      if (locked) await releaseLease(database, 'liquidation-warning-monitor', holder).catch(() => {});
      busy = false;
    }
  };
  void tick();
  const timer = setInterval(() => void tick(), 30_000);
  timer.unref();
}

export async function createPushChallenge(db: Db, wallet: string) {
  await db.delete(liquidationChallenges).where(lt(liquidationChallenges.expiresAt, new Date()));
  const nonce = randomNonce();
  const expires = Math.floor(Date.now() / 1000) + 300;
  await db.insert(liquidationChallenges).values({ nonce, wallet: wallet.toLowerCase(), expiresAt: new Date(expires * 1000) });
  return { nonce, expires, message: createLiquidationChallenge(wallet, nonce, expires) };
}

export async function consumePushChallenge(db: Db, wallet: string, nonce: string, expires: number): Promise<boolean> {
  if (expires < Math.floor(Date.now() / 1000) || expires > Math.floor(Date.now() / 1000) + 300) return false;
  const rows = await db.update(liquidationChallenges).set({ consumedAt: new Date() })
    .where(and(eq(liquidationChallenges.nonce, nonce), eq(liquidationChallenges.wallet, wallet.toLowerCase()), eq(liquidationChallenges.expiresAt, new Date(expires * 1000)), isNull(liquidationChallenges.consumedAt)))
    .returning({ nonce: liquidationChallenges.nonce });
  return rows.length > 0;
}
