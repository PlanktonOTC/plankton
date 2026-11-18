// PLANKTON content model. Source documents are product specifications, not proof of a live deployment.
// Expansion plan (checked 2026-10-27) supersedes the older Overview/Backend where explicitly stated.
// All operational metrics in a frontend demonstration must be separately labelled as sample data.

export const brand = {
  name: 'PLANKTON',
  tagline: 'MICRO CAP PERPETUALS',
  status: 'Live beta',
  chain: 'Robinhood Chain',
  settlement: 'USDG',
  tokenNotice: 'PLKT is live on Robinhood Chain.',
};

export const siteCopy = {
  hero: {
    eyebrow: 'SMALL-CAP MARKETS. A WIDER VIEW.',
    title: 'See the tape.\nTrade the small caps.',
    body: 'A trading desk for small-cap Stock Token perpetuals. Long or short with isolated USDG margin, with the mark, market state and available capacity in view.',
    primaryCta: 'Explore the terminal',
    secondaryCta: 'How PLANKTON works',
    qualifier: 'Live beta on Robinhood Chain mainnet. Small caps, small sizes. Trading carries risk.',
  },
  about: {
    eyebrow: 'THE SMALL-CAP DESK',
    title: 'The names matter.\nSo does the price.',
    body: 'PLANKTON is being built around a defined small-cap listing rule, prices from two independent sources and a Counter pool that sets the trading capacity. The expansion adds a market-intelligence feed, sector baskets and access for other front-ends.',
  },
  pricing: {
    title: 'Two sources. One accountable mark.',
    body: 'Each market shows its price sources. Markets with one source show it plainly. Options require two independent sources.',
    qualifier: 'Per-ticker feed coverage and data permissions must be confirmed before listing.',
  },
  counter: {
    title: 'Capacity starts with the Counter.',
    body: 'Every position trades against one USDG pool. Caps follow its loss budget. A Backstop Fund and a First-Loss tranche sit ahead of Counter LPs in the loss waterfall.',
    qualifier: 'Counter LPs take the other side of traders and can lose capital. Public deposits are a later, gated release.',
  },
  exits: {
    title: 'Keep the way out in view.',
    body: 'The planned contract supports partial closes and full closes in every market state. If a quote cannot be served, closeAtMark uses the on-chain mark directly.',
    qualifier: 'Fallback marks can be stale and spreads wider. Same-block restrictions, profit limits and deferred payouts still apply.',
  },
  tape: {
    title: 'Follow the filing.\nWatch the halt.',
    body: 'Halts, offering filings, reverse-split notices and a catalyst calendar belong beside the chart. Planned alerts reach Telegram, email or a webhook, including when the browser is closed.',
    qualifier: 'The Tape is planned for non-traders too. Alerts in this preview do not send messages.',
  },
  caseStudy: {
    eyebrow: 'AN ILLUSTRATIVE TRADE',
    title: 'One position,\na visible set of limits.',
    body: 'Select RCAT, inspect the source agreement and available capacity, then choose margin and leverage. After opening, the position keeps its liquidation level, PnL and close controls together.',
    example: 'At a hypothetical $100,000 Counter NAV, the v1 single-position cap is $1,000. A $250 margin position at 3x is $750 notional, before fees and spreads.',
    qualifier: 'Illustrative mechanics only. This is not a historical trade, performance result or confirmed market listing.',
  },
  roadmap: {
    eyebrow: 'OPTIONS FIRST',
    title: 'One gate at a time.\nOptions first.',
    body: 'See what is live on Plankton, then the options phases and the gate each one must pass.',
    qualifier: 'November entries reflect shipped work. Later entries show target windows and gates, not release dates.',
  },
  closing: {
    title: 'Get a feel for\nthe small-cap desk.',
    body: 'Explore the markets, the order ticket and the risk information in the interactive preview.',
    cta: 'Open the terminal',
  },
};

export const productPillars = [
  { id: 'board', number: '01', title: 'The Board', subtitle: 'A defined universe.', body: 'Small-cap singles first. A planned $2–5B Smid tier and six equal-weight baskets widen the board without relying on thin pool prices.', status: 'Planned', source: 'Expansion pp.1, 4–5, 7–8' },
  { id: 'tape', number: '02', title: 'The Tape', subtitle: 'Context beside the chart.', body: 'Halts, filings, dilution and offering flags, reverse splits, a catalyst calendar and a runner scanner. Planned alerts are available without an open position.', status: 'Planned', source: 'Expansion pp.1, 3, 7–8' },
  { id: 'rails', number: '03', title: 'The Rails', subtitle: 'More ways into the desk.', body: 'Builder codes, bridge-and-deposit through Relay, a plain Telegram bot and an MCP server extend access to front-ends, bots and agents.', status: 'Planned', source: 'Expansion pp.1, 7–8' },
];

export const marketCandidates = [
  { symbol: 'WYFI', marketCapBillions: 0.49 },
  { symbol: 'NNE', marketCapBillions: 0.67 },
  { symbol: 'RCAT', marketCapBillions: 0.73 },
  { symbol: 'TE', marketCapBillions: 0.76 },
  { symbol: 'POET', marketCapBillions: 0.99 },
  { symbol: 'INOD', marketCapBillions: 1.51 },
  { symbol: 'QUBT', marketCapBillions: 1.57 },
  { symbol: 'RUN', marketCapBillions: 1.83 },
].map((market) => ({ ...market, tier: 'Small', status: 'Candidate', asOf: '2026-10-27', source: 'Expansion p.2', note: 'Historical source-document snapshot; feed coverage, share counts and listing eligibility require confirmation.' }));

export const baskets = [
  { name: 'Quantum', symbols: ['QUBT', 'INFQ', 'RGTI', 'QBTS'] },
  { name: 'Power & Nuclear', symbols: ['NNE', 'SMR', 'TE', 'RUN'] },
  { name: 'Chips & Sensors', symbols: ['POET', 'AEHR', 'NVTS', 'AMBA', 'AXTI', 'OUST'] },
  { name: 'Retail Runners', symbols: ['AMC', 'KSS', 'BULL', 'CLOV', 'SOUN'] },
  { name: 'Defense Supply', symbols: ['RCAT', 'FLY', 'USAR'] },
  { name: 'Small-cap 8', sourceName: 'SUB-8', symbols: ['WYFI', 'NNE', 'RCAT', 'TE', 'POET', 'INOD', 'QUBT', 'RUN'] },
].map((basket) => ({ ...basket, status: 'Planned', weighting: 'Equal weight', rebalance: 'Monthly', source: 'Expansion pp.4–5', note: 'Membership is a 27 October 2026 planning snapshot. A halted or suspended constituent is removed and reweighted at the next mark.' }));

const weekly = (week, dates, start, end, title, summary, deliverables, gate, source, planningNote = '', status = 'Planned') => ({
  id: `week-${String(week).padStart(2, '0')}`, week, label: `Week ${String(week).padStart(2, '0')}`, dates, dateRange: dates,
  start, end, title, summary, description: summary, deliverables, gate, source,
  status, planningNote,
});

export const roadmapWeeks = [
  weekly(1, '9–15 NOV 2026', '2026-11-09', '2026-11-15', 'Trading and liquidity flows',
    'The core terminal flows are live: connect a wallet, manage Counter liquidity, open positions, and reduce or close them.',
    ['Wallet connection and Robinhood Chain actions', 'Counter liquidity provision and withdrawal requests', 'Position opening, trimming and closing', 'Ledger view of account activity'],
    'Trading and liquidity carry risk. Market availability, price freshness and Counter capacity still govern each action.',
    'Production workflows confirmed during November', '', 'Live'),
  weekly(2, '16–22 NOV 2026', '2026-11-16', '2026-11-22', 'Ship clearer controls and records',
    'Recent releases add position planning, solvency visibility, public price data and tools for reviewing activity.',
    ['Editable take-profit and stop-loss presets', 'Live solvency view and public Plankton price feed', 'Trade history CSV and tax report exports', 'Weekly public leaderboard ranked by realized P&L after fees', '$PLKT deployed on 16 November', 'The Tape: runner scanner, trading halts, SEC filing flags and an earnings calendar', 'Public market-data routes and a read-only MCP server for agents and bots'],
    'The leaderboard ranks weekly realized P&L after recorded fees; it does not include open P&L or borrow.',
    'November 2026 product releases', '', 'Shipped'),
];

const phase = (n, window, title, summary, deliverables, gate, status = 'Planned') => ({
  id: `phase-${n}`, label: `Phase ${n}`, dates: window, dateRange: window,
  title, summary, description: summary, deliverables, gate,
  source: 'Options-first plan, November 2026', status, planningNote: '',
});

export const optionsPhases = [
  phase(0, 'NOW · ABOUT TWO WEEKS', 'Fix the foundations',
    'Make the site match the chain, and make every price Plankton will settle on stand on two feet.',
    ['Site and docs updated to match the live mainnet contracts', 'A second independent price source for every ticker that gets options', 'Price signers on separate hosts, run by separate operators', 'Counter reservation upgrade announced through the 48-hour public delay', 'External review in progress: findings closed and listed', 'Beta caps realigned with the published spec'],
    'No ticker gets options until it has two independent price sources and no single host can sign its prices.', 'In progress'),
  phase(1, 'TARGET WINDOW: DEC 2026 – JAN 2027', 'Bell',
    'One question a day: will it close above or below? Fixed payout, known cost, settled on the close.',
    ['Bell: above or below the reference close, 1 USDG per ticket', 'Bell ladder: closes beyond ±10%, ±25% or ±50%', '3–5 tickers that pass the two-source gate, with small caps', 'Every ticket’s maximum payout reserved in the Counter at open', 'Every settlement published: close, 30-minute average and the path used'],
    'Counter reservation upgrade live. Ten shadow settlement sessions per ticker. Options test suite green. External review in progress with no open High or Medium findings on the options contracts. Small caps first, raised only on a clean record.'),
  phase(2, 'TARGET WINDOW: Q1 2027', 'Day and Week contracts',
    'Capped call and put spreads. Moved up from March so they follow Bell directly.',
    ['Maximum loss is the premium you pay', 'Capped gain, no liquidation, no funding', 'Week contracts settle on the last close of the week', 'Day contracts settle on the same day’s close', 'Spread width capped at 100% of the strike'],
    'The public Counter has run for 60 days. At least 20 Bell sessions settled with zero settlement incidents, and options losses inside the 2% weekly stop. The external review has no open High or Medium findings on the spread code.'),
  phase(3, 'TARGET WINDOW: AFTER 4–8 WEEKS OF BELL', 'Gap tickets, boosts and agents',
    'Price the squeeze from real data, let the community add depth to a ticker, and open options to agents.',
    ['Gap tickets: pays if the close is +50% or +100% from yesterday, or −50%', 'Ticker boosts: add USDG to one ticker to raise its options capacity; it takes that ticker’s losses first', '$PLKT ticker votes and fee tiers, proposed for community review', 'Options in the API and the MCP server for agents'],
    'Jump frequency published for every Gap ticker. Boost loss-order tests passing. Agents get no limits that people do not have.'),
  phase(4, 'TARGET WINDOW: AFTER 60–90 DAYS OF OPTIONS RECORD', 'Turbos and writing',
    'More ways in, with the same caps and the same full reservation.',
    ['Capped turbos at 5×: knock-out only on a confirmed mark, never a single tick', 'Covered writing for users, fully collateralised', 'Open quoting for makers who lock their full maximum payout'],
    'Sixty to ninety days of options settlements on record. Separate external review for each product.'),
];

export const laterRoadmap = optionsPhases;

export const futureExpansion = [
  { id: 'board-after-options', window: 'After Phase 2', title: 'A wider board', body: 'More small caps, a Smid tier and sector baskets, once options run cleanly on the first names.', gate: 'Two independent price sources per name. Counter capacity first.', status: 'Planned', source: 'Options-first plan' },
  { id: 'holder-tools', window: 'After Phase 2', title: 'Holder tools', body: 'A one-click hedge for Stock Token holders, built on Week contracts.', gate: 'Counter NAV of at least $1M and 90 days of NAV history.', status: 'Gated', source: 'Options-first plan' },
  { id: 'stop-rules', window: 'Always on', title: 'The stop rules', body: 'New options opens stop if options lose more than 2% of Counter NAV in a week. Settlement, claims and exits never stop.', gate: 'A settlement error halts new opens until a public post-mortem is out.', status: 'Rule', source: 'Options-first plan' },
];

export const tokenGates = [
  { label: 'Weekly active traders', threshold: '1,000+', source: 'Overview p.10' },
  { label: 'Average daily notional', threshold: '$1M+', source: 'Overview p.10' },
  { label: 'Counter NAV', threshold: '$250K+', source: 'Overview p.10' },
  { label: 'Day-7 retention', threshold: '25%+', source: 'Overview p.10' },
  { label: 'Top-10 wallet volume share', threshold: '40% or less', source: 'Overview p.10' },
  { label: 'Oracle or settlement incidents', threshold: 'Zero', source: 'Overview p.10' },
  { label: 'Dark-week fee-paying volume', threshold: 'At least 50% of prior four-week average', source: 'Expansion p.5' },
];

export const listingRules = [
  { label: 'Eligible instrument', value: 'Canonical Robinhood Stock Token', source: 'Expansion p.4' },
  { label: 'Price floor', value: '$1', source: 'Expansion p.4' },
  { label: 'Underlying dollar ADV', value: 'At least $2M', source: 'Expansion p.4' },
  { label: 'Price-feed requirement', value: 'Each market shows its sources and whether they are fresh. Options require two independent price sources.', source: 'Options-first plan, November 2026' },
  { label: 'Small tier', value: 'Below $2B market cap; 2–3x planned maximum leverage', source: 'Expansion p.4' },
  { label: 'Smid tier', value: '$2–5B at listing; up to 5x; planned E2', source: 'Expansion pp.4, 7' },
  { label: 'Tier transition', value: '20 consecutive sessions above $2B before moving to Smid leverage', source: 'Expansion p.4' },
  { label: 'Market-cap close-only rule', value: '20 consecutive sessions above $10B', source: 'Expansion p.4' },
];

export const feeSchedule = {
  status: 'Specification reference; live configuration not connected',
  smallBase: { bps: 8, rangeBps: [6, 8], label: '0.08% reference open/close fee' },
  microBase: { bps: 12, rangeBps: [10, 15], label: 'No confirmed micro-tier candidates in the expansion snapshot' },
  notes: [
    'Spread, skew impact and continuous borrow can apply in addition to the base trade fee.',
    'The dominant side pays borrow according to its share of the net-skew cap.',
    'A minimum borrow applies to both sides when gross open interest exceeds 80% of its cap.',
    'Fallback and frozen closes can carry wider spreads; show the actual quote before an action.',
  ],
  source: 'Overview pp.12–13; Backend pp.10, 20',
};

export const faqs = [
  { question: 'What do I trade on PLANKTON?', answer: 'The planned product is a synthetic perpetual settled in USDG. You take a long or short position on a Stock Token price; you do not own or receive shares or Stock Tokens, and the position has no shareholder rights.', source: 'Overview p.1' },
  { question: 'Which markets are planned?', answer: 'The launch focus is eligible small-cap Stock Tokens under $2B. The expansion plan adds a $2–5B Smid tier and six equal-weight baskets. Every listing depends on a canonical token, a price of at least $1, at least $2M in underlying dollar average daily volume and confirmed price-feed coverage.', source: 'Expansion pp.2, 4–5, 7' },
  { question: 'Where does the price come from?', answer: 'Each market shows its available price sources and their status. Some markets currently have one source; options will only be enabled on names with two independent sources. On-chain pools do not contribute to Plankton marks.', source: 'Options-first plan, November 2026' },
  { question: 'How does weekend trading work?', answer: 'The planned weekend mode uses the held Friday mark, a wider spread and a smaller per-wallet allowance. It does not discover a fresh weekend equity price. Borrow still accrues, so margin-only liquidation can occur; price-driven liquidation waits for fresh source agreement.', source: 'Overview pp.5, 12, 18; Backend pp.10, 17, 20' },
  { question: 'Can I close when a market is halted?', answer: 'The contract design keeps partial and full closes available in halted, frozen and close-only states. If the quote service is unavailable, closeAtMark is the direct on-chain fallback. A fallback can use a stale mark and a wider spread; same-block restrictions and profit limits still apply.', source: 'Overview pp.11–12, 18; Backend pp.8–10, 17' },
  { question: 'What is the Counter?', answer: 'The Counter is the USDG pool that takes the other side of trader positions. Its NAV and loss budget set the caps. Deposits and withdrawals use a two-step process settled at the next mark, with pro-rata fills when cash is short. Public Counter access is a later, gated release, and LPs can lose capital.', source: 'Overview pp.6–9, 18; Backend pp.3, 9–10' },
  { question: 'What is $PLKT?', answer: '$PLKT is Plankton’s token on Robinhood Chain, live since November 2026. The 18 January roadmap checkpoint is a review of the product’s next phase, not the token launch date. Follow official channels for updates about integrations and ecosystem plans.', source: 'November 2026 roadmap' },
  { question: 'Do I need a position to use the Tape?', answer: 'No open position is required in the plan. Halts, filings, offering flags, reverse-split notices, a catalyst calendar and alerts are intended for non-traders too. The current website is a preview; its alert controls do not send real notifications.', source: 'Expansion pp.1, 7–8; current frontend implementation boundary' },
  { question: 'Is this a live trading application?', answer: 'Plankton is live in beta on Robinhood Chain mainnet. Contract addresses are listed in the docs. Markets, size limits and available actions depend on current feeds, market state and Counter capacity.', source: 'Options-first plan, November 2026' },
  { question: 'Where is the planned service available?', answer: 'The supplied specification excludes US persons and residents of the US, Canada, UK, Switzerland, UAE, EU retail and sanctioned jurisdictions. This preview does not establish eligibility or provide access to a live financial service.', source: 'Overview p.1; Backend p.20' },
];

export const dashboardRequirements = {
  implementationMode: 'Interactive preview with explicitly labelled sample data',
  primaryTabs: ['Trade', 'Markets', 'Portfolio', 'Orders', 'Counter', 'Tape', 'Pennies', 'Penny Cup', 'Ledger', 'Status'],
  marketHeader: ['Symbol', 'Tier', 'Session state', 'Mark', 'Source agreement', 'Mark age', 'Long capacity', 'Short capacity', 'Maximum position'],
  ticket: ['Long / Short', 'Market / Limit / Stop', 'USDG margin', 'Leverage', 'Notional', 'Fee and spread preview', 'TP/SL or bracket', 'Capacity validation'],
  positions: ['Side', 'Size', 'Entry', 'Mark', 'Margin', 'Unrealised PnL', 'Liquidation level', 'Borrow', 'Add margin', 'Trim by % or size', 'Close', 'Close at mark'],
  orders: ['Limit', 'Stop', 'Take profit', 'Stop loss', 'Bracket', 'TWAP slices', 'Cancel'],
  counter: ['NAV', 'Free cash', 'Deposit request', 'Withdraw request', 'Pending queue', 'Oldest pending age', 'Loss waterfall'],
  ledger: ['Solvency', '25% stress test', 'Unrealised PnL in NAV', 'Buffer health', 'Per-market open interest versus caps', '90-day losing-account share', 'Fee split', 'Deferred claims'],
  states: ['Open', 'Extended', 'Weekend', 'Frozen', 'Halted', 'Close-only'],
  exclusions: ['No fabricated order-book depth', 'No funding-rate substitution for borrow', 'No real signatures, deposits or trades without connected contracts', 'No claiming a live status or uptime from mock data', 'No Telegram Mini App', 'No live micro-tier listing implied by brand tagline'],
  source: 'Backend pp.6, 8–10, 15–18, 20; Expansion pp.2, 4, 7–8',
};

export const footerDisclosure = 'PLANKTON is an independent project. $PLKT is live on Robinhood Chain. Synthetic perpetuals do not confer share ownership. No affiliation or endorsement by Robinhood, Chainlink or Uniswap is implied.';

