/** What the Counter looks like now, with its share price a day and a week ago (null before the history exists). */
export interface PoolView {
  navUsdg: bigint;
  navPerShareE18: bigint;
  totalShares: bigint;
  pps24hAgo: bigint | null;
  pps7dAgo: bigint | null;
}

const usdg = (raw: bigint) => `$${(Number(raw) / 1e6).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
/** Share price in USDG per share-dollar: 1e9 shares were minted per USDG, so 1e15 per share is $1.0000. */
const sharePrice = (pps: bigint) => (Number(pps) / 1e15).toFixed(4);
const valueOf = (shares: bigint, pps: bigint) => (shares * pps) / 10n ** 18n;

/** Signed percent change from `then` to `now`, e.g. "+0.12%", or null without history. */
export function pctChange(now: bigint, then: bigint | null): string | null {
  if (then === null || then === 0n) return null;
  const bps = Number(((now - then) * 1_000_000n) / then) / 10_000;
  return `${bps >= 0 ? '+' : ''}${bps.toFixed(2)}%`;
}

export function poolText(p: PoolView): string {
  const day = pctChange(p.navPerShareE18, p.pps24hAgo);
  const week = pctChange(p.navPerShareE18, p.pps7dAgo);
  return [
    '🏦 Plankton Counter (the LP pool)',
    `Pool value: ${usdg(p.navUsdg)}`,
    `Share price: ${sharePrice(p.navPerShareE18)}${day ? ` · 24h ${day}` : ''}${week ? ` · 7d ${week}` : ''}`,
    'LPs earn trading fees and take the other side of trades. Share price moves only with results, not deposits.',
  ].join('\n');
}

export function lpText(p: PoolView, shares: bigint): string {
  if (shares === 0n) return 'Your linked wallet holds no Counter shares. Deposit in Plankton under Counter to become an LP.';
  const value = valueOf(shares, p.navPerShareE18);
  const pctOfPool = p.totalShares > 0n ? Number((shares * 10_000n) / p.totalShares) / 100 : 0;
  const lines = [`💧 Your Counter position`, `Value: ${usdg(value)} · ${pctOfPool.toFixed(2)}% of the pool`];
  if (p.pps24hAgo !== null) {
    const diff = value - valueOf(shares, p.pps24hAgo);
    lines.push(`24h: ${diff >= 0n ? '+' : '-'}${usdg(diff < 0n ? -diff : diff)} (${pctChange(p.navPerShareE18, p.pps24hAgo)})`);
  }
  return lines.join('\n');
}

export function dailyText(p: PoolView, shares: bigint): string {
  return `📅 Daily LP summary\n\n${lpText(p, shares)}\n\n${poolText(p).split('\n').slice(1, 3).join('\n')}\n\n/daily off to stop these.`;
}

const ny = (ms: number) => {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false, weekday: 'short' })
      .formatToParts(ms)
      .map((x) => [x.type, x.value]),
  );
  return { ymd: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) % 24, weekday: parts.weekday as string };
};

/** The daily summary goes out once per New York weekday, after 17:00 ET (the day's trading is done). */
export function dailyDue(nowMs: number, lastSentYmd: string | null): { due: boolean; ymd: string } {
  const t = ny(nowMs);
  const weekday = t.weekday !== 'Sat' && t.weekday !== 'Sun';
  return { due: weekday && t.hour >= 17 && lastSentYmd !== t.ymd, ymd: t.ymd };
}
