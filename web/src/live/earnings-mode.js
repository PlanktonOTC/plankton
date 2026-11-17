const DAY_MS = 86_400_000;

function newYorkDate(now) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const part = (type) => parts.find((item) => item.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

export function earningsModeFor(earnings, symbol, now = Date.now()) {
  const date = (earnings ?? []).find((item) => item.symbol === symbol)?.next?.date;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return { active: false, earningsDate: null };
  const distanceDays = Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${newYorkDate(now)}T00:00:00Z`)) / DAY_MS);
  return { active: distanceDays >= -1 && distanceDays <= 1, earningsDate: date };
}
