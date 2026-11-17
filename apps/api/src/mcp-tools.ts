import { z } from 'zod';
import { tool, type McpTool } from './mcp.ts';

// The tools the MCP server offers. Each one reads a public API route through `get`, so an agent sees exactly what the
// website sees, under the same rate limit as the caller. Prices on the API are fixed point; the tools add plain decimals
// beside them so an agent does not have to scale numbers itself.

type Get = (path: string) => Promise<any>;

const symbol = z.string().regex(/^[A-Za-z.]{1,10}$/, 'a ticker such as RCAT').transform((s) => s.toUpperCase());
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'a 0x wallet address');

const e18 = (v: unknown): number | null => (v === null || v === undefined || v === '' ? null : Number(BigInt(String(v))) / 1e18);
const usdg = (v: unknown): number | null => (v === null || v === undefined || v === '' ? null : Number(BigInt(String(v))) / 1e6);
const enc = encodeURIComponent;

const SCANNER_SORTS = {
  change: (r: any) => r.changePct,
  extended: (r: any) => (r.extended ? Math.abs(r.extended.changePct) : null),
  gap: (r: any) => (r.gapPct === null ? null : Math.abs(r.gapPct)),
  relative_volume: (r: any) => r.relativeVolume,
  float_turnover: (r: any) => r.floatTurnoverPct,
} as const;

export function planktonTools(get: Get): McpTool[] {
  return [
    tool({
      name: 'list_markets',
      title: 'List markets',
      description:
        'Every Plankton perpetual market: its live mark price and status (open, extended, weekend, frozen, halted), the reason when new positions are paused, and the limits in force (max leverage, fees, open-interest room). Markets are small-cap Stock Token perpetuals on Robinhood Chain, settled in USDG.',
      input: z.object({}),
      run: async () => {
        const rows = await get('/v1/markets');
        return {
          markets: rows.map((m: any) => ({
            symbol: m.symbol,
            class: m.class,
            stockToken: m.stockToken,
            marketId: m.marketId,
            priceServiceUp: m.markFeedUp,
            status: m.mark?.status ?? null,
            price: e18(m.mark?.priceE18),
            confidenceBps: m.mark?.confidenceBps ?? null,
            reason: m.mark?.reason ?? null,
            openGuard: m.mark?.openGuard ?? false,
            freezeReasons: m.mark?.freezeReasons ?? [],
            eligible: m.mark?.eligible ?? null,
            limits: m.trading
              ? {
                  opensAllowed: m.trading.opensAllowed,
                  maxLeverage: m.trading.maxLeverage,
                  feeBps: m.trading.feeBps,
                  openSpreadBps: m.trading.openSpreadBps,
                  borrowBaseBpsPerHour: m.trading.borrowBaseBpsPerHour,
                  maintenanceMarginBps: m.trading.maintenanceMarginBps,
                  positionCapUsdg: usdg(m.trading.positionCapUsdg),
                  longRoomUsdg: usdg(m.trading.longRoomUsdg),
                  shortRoomUsdg: usdg(m.trading.shortRoomUsdg),
                }
              : null,
          })),
        };
      },
    }),
    tool({
      name: 'get_prices',
      title: 'On-chain prices',
      description:
        'The latest price each market has on-chain in the MarkOracle contract, with its age in seconds and whether it is fresh. Marks are published when someone trades, so a quiet market can be minutes old. Pass a symbol for one market.',
      input: z.object({ symbol: symbol.optional() }),
      run: async ({ symbol: s }) => (s ? get(`/v1/feed/${enc(s)}`) : get('/v1/feed')),
    }),
    tool({
      name: 'get_price_sources',
      title: 'Why this mark',
      description: 'The sources behind one market’s mark right now (Robinhood quote, Chainlink where available): each price, bid/ask, age, and any reason a source was dropped.',
      input: z.object({ symbol }),
      run: async ({ symbol: s }) => get(`/v1/markets/${enc(s)}/sources`),
    }),
    tool({
      name: 'get_scanner',
      title: 'Runner scanner',
      description:
        'How each listed stock is trading in its latest session: % change against the previous close, opening gap, pre-market/after-hours move, volume against the 30-day average, float turnover and the 52-week range, with tags such as runner, gap_up, high_volume and extended_mover. Sort by change, extended, gap, relative_volume or float_turnover.',
      input: z.object({
        sort: z.enum(Object.keys(SCANNER_SORTS) as [keyof typeof SCANNER_SORTS, ...(keyof typeof SCANNER_SORTS)[]]).optional(),
        tag: z.string().optional(),
        limit: z.number().int().min(1).max(50).optional(),
      }),
      run: async ({ sort = 'change', tag, limit = 50 }) => {
        const body = await get('/v1/scanner');
        const key = SCANNER_SORTS[sort];
        const rows = body.rows
          .filter((r: any) => !tag || r.tags.includes(tag))
          .sort((a: any, b: any) => (key(b) ?? -Infinity) - (key(a) ?? -Infinity))
          .slice(0, limit);
        return { updatedAt: body.updatedAt, sort, rows };
      },
    }),
    tool({
      name: 'get_halts',
      title: 'Trading halts',
      description:
        'US trading halts from Nasdaq over the last few days, newest first: symbol, reason in words (news pending, volatility pause, regulatory concern…), when it started, whether trading has resumed, and whether the stock is a Plankton market.',
      input: z.object({ listed_only: z.boolean().optional(), symbol: symbol.optional(), active_only: z.boolean().optional() }),
      run: async ({ listed_only, symbol: s, active_only }) => {
        const body = await get(`/v1/halts${listed_only ? '?listed=1' : ''}`);
        const halts = body.halts.filter((h: any) => (!s || h.symbol === s) && (!active_only || h.state !== 'resumed'));
        return { updatedAt: body.updatedAt, halts };
      },
    }),
    tool({
      name: 'get_filings',
      title: 'SEC filings',
      description:
        'Recent SEC EDGAR filings for Plankton’s markets, newest first, each tagged: offering, shelf, dilution, charter_change (reverse splits are filed this way), listing_notice, late_filing, delisting, financing, earnings, insider_sale and more, with importance and a link to the document. Pass a symbol for one company, flagged_only for medium and high importance.',
      input: z.object({ symbol: symbol.optional(), flagged_only: z.boolean().optional(), limit: z.number().int().min(1).max(100).optional() }),
      run: async ({ symbol: s, flagged_only, limit = 30 }) => {
        const q = new URLSearchParams({ limit: String(limit), ...(flagged_only ? { flagged: '1' } : {}) });
        return s ? get(`/v1/filings/${enc(s)}?${q}`) : get(`/v1/filings?${q}`);
      },
    }),
    tool({
      name: 'get_catalysts',
      title: 'Catalyst calendar',
      description:
        'Upcoming earnings for every Plankton market (date, before the open or after the close, whether the date is confirmed, EPS estimate), the last reported quarter with its EPS surprise, and Stock Token corporate actions (splits, dividends) that are recent or scheduled.',
      input: z.object({}),
      run: async () => get('/v1/catalysts'),
    }),
    tool({
      name: 'preview_trade',
      title: 'Preview a trade',
      description:
        'What opening a position would cost right now, by the same rules a signed quote uses: execution price, fee, notional, spread, max leverage and liquidation price. Read only: it signs and sends nothing. Margin is in USDG. Pass a trader address to include an existing position and collateral.',
      input: z.object({
        market: symbol,
        side: z.enum(['long', 'short']),
        margin_usdg: z.number().positive().max(10_000_000),
        leverage: z.number().min(1).max(20),
        trader: address.optional(),
      }),
      run: async ({ market, side, margin_usdg, leverage, trader }) => {
        const q = new URLSearchParams({
          market,
          side,
          marginUsdg: String(Math.round(margin_usdg * 1e6)),
          leverage: String(Math.round(leverage * 1000) / 1000),
          ...(trader ? { trader } : {}),
        });
        const r = await get(`/v1/quote/preview?${q}`);
        if (!r.ok) return r;
        return {
          ...r,
          execPrice: e18(r.execPriceE18),
          mark: e18(r.markE18),
          liquidationPrice: e18(r.liquidationE18),
          fee: usdg(r.feeUsdg),
          notional: usdg(r.notionalUsdg),
          maxLeverage: e18(r.maxLeverageE18),
        };
      },
    }),
    tool({
      name: 'get_account',
      title: 'Account state',
      description: 'A wallet’s Plankton account read from the contracts: deposited USDG collateral, wallet USDG balance, Counter shares, and each open position with entry, mark, PnL, margin and liquidation price.',
      input: z.object({ address }),
      run: async ({ address: a }) => get(`/v1/accounts/${enc(a)}/state`),
    }),
    tool({
      name: 'get_leaderboard',
      title: 'Weekly leaderboard',
      description: 'This UTC week’s traders ranked by realized P&L after recorded fees (open P&L excluded).',
      input: z.object({}),
      run: async () => get('/v1/leaderboard'),
    }),
    tool({
      name: 'get_solvency',
      title: 'Solvency and capacity',
      description: 'The Counter pool’s NAV, a 25% stress test, and per-market long/short open interest, caps and room, read straight from the contracts.',
      input: z.object({}),
      run: async () => get('/v1/ledger'),
    }),
    tool({
      name: 'get_listing_rules',
      title: 'Listing rule check',
      description: 'Which markets pass the listing rule (market cap under $2B, price at least $1, average dollar volume at least $2M) and why any do not.',
      input: z.object({}),
      run: async () => get('/v1/eligibility'),
    }),
  ];
}

export const MCP_INSTRUCTIONS =
  'Plankton is a desk for small-cap Stock Token perpetuals on Robinhood Chain, settled in USDG. These tools are read only. ' +
  'Start with list_markets for symbols and status. Use get_scanner, get_halts, get_filings and get_catalysts for market context, ' +
  'and preview_trade to price a position before a person places it on the website. Leveraged trading carries risk.';
