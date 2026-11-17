const DAY_MS = 86_400_000;
const E18 = 10n ** 18n;

function newYorkDate(nowMs: number): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(nowMs);
  const part = (type: string) => parts.find((item) => item.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

/** One-day-before through earnings-day-plus-one: reduce new opens to 1x using the existing signed quote guard. */
export function earningsModeFor(earnings: Array<{ symbol: string; next?: { date: string } | null }>, symbol: string, nowMs: number) {
  const date = earnings.find((item) => item.symbol === symbol)?.next?.date;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return { active: false, earningsDate: null, maxLeverageE18: null };
  const distanceDays = Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${newYorkDate(nowMs)}T00:00:00Z`)) / DAY_MS);
  const active = distanceDays >= -1 && distanceDays <= 1;
  return { active, earningsDate: date, maxLeverageE18: active ? E18 : null };
}
