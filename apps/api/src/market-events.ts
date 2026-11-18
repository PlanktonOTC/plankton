import { sessionAt, type Calendar } from '@plankton/core';

/** One announcement for subscribed Telegram chats. `id` is stable, so each event is sent once. `symbol` null means every market. */
export interface MarketEvent {
  id: string;
  symbol: string | null;
  text: string;
}

type HaltRow = { symbol: string; startedAt: number; resumesAt: number | null; reason: string; reasonCode: string; state: string; listed: boolean };
type EarningsRow = { symbol: string; next: { date: string; timing: 'am' | 'pm' | null } | null };
type ActionRow = { symbol: string; id: string; type: string; status: string; processDate: string | null };

const PENDING_ACTION = new Set(['pending', 'scheduled', 'announced', 'approved', 'processing', 'in_progress']);
/** Halts and resumptions older than this are history, not news: a restart must not announce them. */
const FRESH_MS = 30 * 60_000;
/** The close-only notice goes out this long before it starts. */
const CLOSE_ONLY_LEAD_MS = 15 * 60_000;
const DAY_MS = 86_400_000;

const nyDate = (ms: number) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(ms);
const nyTime = (ms: number) => new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' }).format(ms);
const nyWeekday = (ms: number) => new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short' }).format(ms);
const friendlyDate = (ymd: string) => new Date(`${ymd}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });

/**
 * The market events worth a message right now: listed halts starting or resuming, pending splits, earnings due today or
 * tomorrow, and the close-only evening about to begin. Pure: the caller dedupes by id and sends.
 */
export function marketEvents(input: {
  nowMs: number;
  halts: HaltRow[];
  earnings: EarningsRow[];
  corporateActions: ActionRow[];
  calendar: Calendar;
  windowTz: string;
}): MarketEvent[] {
  const { nowMs } = input;
  const out: MarketEvent[] = [];

  for (const h of input.halts) {
    if (!h.listed) continue;
    if (h.state === 'halted' && nowMs - h.startedAt <= FRESH_MS) {
      out.push({
        id: `halt:${h.symbol}:${h.startedAt}:${h.reasonCode}`,
        symbol: h.symbol,
        text: `⛔ ${h.symbol} is halted on Nasdaq (${h.reason}).\nNew positions are paused. You can still exit at the on-chain price.`,
      });
    }
    if (h.resumesAt !== null && h.resumesAt <= nowMs + FRESH_MS && nowMs - h.resumesAt <= FRESH_MS) {
      out.push({
        id: `resume:${h.symbol}:${h.startedAt}:${h.reasonCode}`,
        symbol: h.symbol,
        text: `▶️ ${h.symbol} ${h.resumesAt > nowMs ? `resumes trading at ${nyTime(h.resumesAt)} ET` : 'has resumed trading'}.`,
      });
    }
  }

  for (const a of input.corporateActions) {
    if (!/split/i.test(a.type) || !PENDING_ACTION.has(a.status.toLowerCase())) continue;
    out.push({
      id: `split:${a.id}`,
      symbol: a.symbol,
      text: `✂️ ${a.symbol} has a ${a.type.replace(/_/g, ' ')} pending${a.processDate ? ` (${friendlyDate(a.processDate)})` : ''}.\nNew positions freeze around it; open positions can still be closed.`,
    });
  }

  const today = nyDate(nowMs);
  const tomorrow = nyDate(nowMs + DAY_MS);
  for (const e of input.earnings) {
    const date = e.next?.date;
    if (!date || (date !== today && date !== tomorrow)) continue;
    const when = date === today ? 'today' : 'tomorrow';
    const timing = e.next?.timing === 'am' ? ' before the open' : e.next?.timing === 'pm' ? ' after the close' : '';
    out.push({
      id: `earnings:${e.symbol}:${date}`,
      symbol: e.symbol,
      text: `📊 ${e.symbol} reports earnings ${when}${timing} (${friendlyDate(date)}).\nExpect big moves. Leverage is capped at 1× around the report.`,
    });
  }

  const cfg = { windowTz: input.windowTz, openGuardMinutes: 20 };
  const soon = sessionAt(nowMs + CLOSE_ONLY_LEAD_MS, input.calendar, cfg);
  if (soon.closeOnly && !sessionAt(nowMs, input.calendar, cfg).closeOnly) {
    out.push({
      id: `close-only:${nyDate(nowMs + CLOSE_ONLY_LEAD_MS)}`,
      symbol: null,
      text: `🕓 New positions pause in 15 minutes, at the close, until the ${nyWeekday(nowMs) === 'Fri' ? 'weekend' : 'holiday'} hold begins.\nOpen positions can still be closed the whole time.`,
    });
  }
  return out;
}

/** Whether a chat subscribed to `symbols` (null: all markets) should get `event`. */
export const wantsEvent = (symbols: string[] | null, event: MarketEvent) => event.symbol === null || symbols === null || symbols.includes(event.symbol);
