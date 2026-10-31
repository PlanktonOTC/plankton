import { Status, type MarketClass } from './types.ts';

export interface CalendarDay {
  /** YYYY-MM-DD in America/New_York */
  day: string;
  holiday: boolean;
  earlyClose: boolean;
  /** HH:MM in ET */
  openEt: string;
  closeEt: string;
}
export type Calendar = Map<string, CalendarDay>;

export interface SessionCfg {
  /** Timezone of the Stock Token mint/burn window (Mon 02:00 to Sat 02:00). */
  windowTz: string;
  openGuardMinutes: number;
}
export const DEFAULT_SESSION_CFG: SessionCfg = { windowTz: 'Europe/Berlin', openGuardMinutes: 20 };

export interface SessionInfo {
  status: Status;
  /** True for the first minutes after the US open and after the Monday reopen. */
  openGuard: boolean;
  reason: string;
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function zoned(ts: number, tz: string): { day: string; minutes: number; dow: number } {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      weekday: 'short',
    });
    fmtCache.set(tz, f);
  }
  const p: Record<string, string> = {};
  for (const x of f.formatToParts(ts)) p[x.type] = x.value;
  return {
    day: `${p.year}-${p.month}-${p.day}`,
    minutes: (Number(p.hour) % 24) * 60 + Number(p.minute),
    dow: DOW.indexOf(p.weekday!),
  };
}

const hhmm = (s: string): number => {
  const [h, m] = s.split(':');
  return Number(h) * 60 + Number(m);
};

/**
 * Convert a wall-clock time in `tz` to a UTC timestamp (ms). `day` is YYYY-MM-DD, `time` is HH:MM[:SS[.mmm]].
 * Used for the Nasdaq halt feed, whose times are US Eastern with no zone marker.
 */
export function zonedTimeToUtc(day: string, time: string, tz: string): number {
  const [y, mo, d] = day.split('-').map(Number) as [number, number, number];
  const [hh = '0', mm = '0', ss = '0'] = time.split(':');
  const secs = Number(ss);
  const wallMs = Date.UTC(y, mo - 1, d, Number(hh), Number(mm), Math.floor(secs), Math.round((secs % 1) * 1000));
  let guess = wallMs;
  for (let i = 0; i < 2; i++) {
    const z = zoned(guess, tz);
    const [zy, zm, zd] = z.day.split('-').map(Number) as [number, number, number];
    const localAsUtc = Date.UTC(zy, zm - 1, zd, 0, z.minutes);
    const offset = localAsUtc - Math.floor(guess / 60_000) * 60_000;
    guess = wallMs - offset;
  }
  return guess;
}

/**
 * Session status at a timestamp.
 * - Weekend: Sat 02:00 to Mon 02:00 in the mint window timezone, plus exchange holidays.
 * - Open: US regular hours (early closes honoured).
 * - Extended: any other weekday time (Chainlink equity feeds run 24/5).
 * A weekday missing from the calendar is Frozen: we never guess a session.
 * Whether Extended is really live depends on the feeds being fresh; the mark engine downgrades to Frozen otherwise.
 */
export function sessionAt(ts: number, cal: Calendar, cfg: SessionCfg = DEFAULT_SESSION_CFG): SessionInfo {
  const w = zoned(ts, cfg.windowTz);
  if ((w.dow === 6 && w.minutes >= 120) || w.dow === 0 || (w.dow === 1 && w.minutes < 120)) {
    return { status: Status.Weekend, openGuard: false, reason: 'weekend window' };
  }
  const reopenGuard = w.dow === 1 && w.minutes < 120 + cfg.openGuardMinutes;

  const et = zoned(ts, 'America/New_York');
  const day = cal.get(et.day);
  if (!day) {
    if (et.dow === 0 || et.dow === 6) {
      return { status: Status.Extended, openGuard: reopenGuard, reason: 'overnight, no calendar row needed' };
    }
    return { status: Status.Frozen, openGuard: false, reason: `calendar missing ${et.day}` };
  }
  if (day.holiday) return { status: Status.Weekend, openGuard: false, reason: 'exchange holiday' };

  const open = hhmm(day.openEt);
  const close = hhmm(day.closeEt);
  if (et.minutes >= open && et.minutes < close) {
    return {
      status: Status.Open,
      openGuard: et.minutes - open < cfg.openGuardMinutes,
      reason: day.earlyClose ? 'regular session (early close)' : 'regular session',
    };
  }
  return { status: Status.Extended, openGuard: reopenGuard, reason: 'outside regular hours' };
}

/** Days of calendar coverage ahead of `now`. Fail a check when this drops under 400. */
export function calendarHorizonDays(cal: Calendar, nowMs: number): number {
  let last = 0;
  for (const k of cal.keys()) last = Math.max(last, Date.parse(`${k}T00:00:00Z`));
  return Math.floor((last - nowMs) / 86_400_000);
}

/** Default US equity calendar rows for weekdays; holidays/early closes come from the published calendar. */
export function buildCalendar(rows: CalendarDay[]): Calendar {
  return new Map(rows.map((r) => [r.day, r]));
}

// --- session profiles (Backend section 9; defaults, calibrate on tape) ---

export interface SessionProfileCfg {
  opensAllowed: boolean;
  /** Max leverage by class, before the Counter rung cap. */
  leverage: Record<MarketClass, number>;
  /** Max single position as bps of Counter NAV. */
  maxPositionBpsOfV: number;
  /** When true the position limit applies across all of a wallet's markets. */
  perWallet: boolean;
  extraSpreadBps: number;
  liquidation: 'two_source' | 'margin_only' | 'none';
}

const lev = (micro: number, small: number): Record<MarketClass, number> => ({ micro, small, smid: small, index: small });

export const DEFAULT_PROFILES: Record<Status, SessionProfileCfg> = {
  [Status.Unset]: { opensAllowed: false, leverage: lev(0, 0), maxPositionBpsOfV: 0, perWallet: false, extraSpreadBps: 0, liquidation: 'none' },
  [Status.Open]: { opensAllowed: true, leverage: lev(3, 3), maxPositionBpsOfV: 100, perWallet: false, extraSpreadBps: 0, liquidation: 'two_source' },
  [Status.Extended]: { opensAllowed: true, leverage: lev(1.5, 2.5), maxPositionBpsOfV: 50, perWallet: false, extraSpreadBps: 50, liquidation: 'two_source' },
  [Status.Weekend]: { opensAllowed: true, leverage: lev(1.5, 2), maxPositionBpsOfV: 25, perWallet: true, extraSpreadBps: 150, liquidation: 'margin_only' },
  [Status.Frozen]: { opensAllowed: false, leverage: lev(0, 0), maxPositionBpsOfV: 0, perWallet: false, extraSpreadBps: 200, liquidation: 'none' },
  [Status.Halted]: { opensAllowed: false, leverage: lev(0, 0), maxPositionBpsOfV: 0, perWallet: false, extraSpreadBps: 300, liquidation: 'none' },
};

/** Extra spread during the open guard (first minutes after the open / Monday reopen). */
export const OPEN_GUARD_EXTRA_SPREAD_BPS = 50;
