// PLANKTON content model. Source documents are product specifications, not proof of a live deployment.
// Expansion plan (checked 2026-10-27) supersedes the older Overview/Backend where explicitly stated.
// All operational metrics in a frontend demonstration must be separately labelled as sample data.

export const brand = {
  name: 'PLANKTON',
  tagline: 'MICRO CAP PERPETUALS',
  status: 'Platform preview',
  chain: 'Robinhood Chain',
  settlement: 'USDG',
  tokenNotice: 'No token yet.',
  launchTarget: '12 November 2026',
};

export const siteCopy = {
  hero: {
    eyebrow: 'SMALL-CAP MARKETS. A WIDER VIEW.',
    title: 'See the tape.\nTrade the small caps.',
    body: 'A trading desk for small-cap Stock Token perpetuals. Long or short with isolated USDG margin, with the mark, market state and available capacity in view.',
    primaryCta: 'Explore the terminal',
    secondaryCta: 'How PLANKTON works',
    qualifier: 'Platform preview. Trading and market data are simulated.',
  },
  about: {
    eyebrow: 'THE SMALL-CAP DESK',
    title: 'The names matter.\nSo does the price.',
    body: 'PLANKTON is being built around a defined small-cap listing rule, prices from two independent sources and a Counter pool that sets the trading capacity. The expansion adds a market-intelligence feed, sector baskets and access for other front-ends.',
  },
  pricing: {
    title: 'Two sources. One accountable mark.',
    body: 'Chainlink equity feeds and Robinhood Stock Token quotes must agree before a new position opens. Thin on-chain pools are monitored as a sanity check and carry zero weight in the mark.',
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
    eyebrow: 'THE EXPANSION',
    title: 'A wider board.\nWeek by week.',
    body: 'Start with small-cap singles and the Tape. Expand into the Smid tier, sector baskets and builder access only when the published gates are met.',
    qualifier: 'Indicative weekly sequence from the supplied expansion plan. Dates are targets, not release confirmations. Where a target precedes its gate, the gate takes precedence.',
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

const weekly = (week, dates, start, end, title, summary, deliverables, gate, source, planningNote = '') => ({
  id: `week-${String(week).padStart(2, '0')}`, week, label: `Week ${String(week).padStart(2, '0')}`, dates, dateRange: dates,
  start, end, title, summary, description: summary, deliverables, gate, source,
  status: 'Planned', planningNote,
});

export const roadmapWeeks = [
  weekly(1, '9–15 NOV 2026', '2026-11-09', '2026-11-15', 'Open in guarded mode',
    'The plan targets a guarded beta on 9 November and soft launch on 12 November.',
    ['Shadow marks on all 26 candidates', 'Up to eight eligible small-tier singles at launch', 'Season 0, Tape v1 and a plain Telegram bot'],
    'Contracts deployed, internal re-audit target met, fork checks green and 72 incident-free beta hours before soft launch.',
    'Overview pp.8, 14; Expansion pp.5, 7'),
  weekly(2, '16–22 NOV 2026', '2026-11-16', '2026-11-22', 'Put the Tape to work',
    'Focus the first full week on the launch board, filings, halts and alert use.',
    ['Dilution and offering flags', 'Reverse splits, catalyst calendar and runner scanner', 'Alerts for traders and non-traders'],
    'Continue only within confirmed feed coverage and Counter capacity; source failures stop new opens.',
    'Expansion pp.1, 7–8', 'The focus is a weekly allocation within E1, not a separately promised release.'),
  weekly(3, '23–29 NOV 2026', '2026-11-23', '2026-11-29', 'Penny Cup and the first gate',
    'The Penny Cup target is 23 November. The first operating review is dated 26 November.',
    ['Weekly PnL% ranking on maximum margin used', '$25 minimum fees per week for eligibility', 'Public REST/WS API and referral codes in the launch phase'],
    'Day-14 targets: 150 weekly traders, $100K average daily notional, 99.5% quote availability and zero incidents. Cup activation follows the gate if it is not met by the target date.',
    'Overview pp.14, 17; Expansion p.7', 'The source dates put the Cup target before its day-14 gate. Gate precedence is retained.'),
  weekly(4, '30 NOV–6 DEC 2026', '2026-11-30', '2026-12-06', 'Make the record visible',
    'Publish the operating record and prepare the expansion review.',
    ['Weekly transparency report', 'Coverage table with ticker-level evidence', 'Capacity, fees, source freshness and fallback-close reporting'],
    'Every published operating number must come from a contract read, transaction or indexed event.',
    'Launch Posts pp.2–3; Overview pp.7, 14; Expansion p.5', 'Reporting work is assigned to this week within the source launch phase.'),
  weekly(5, '7–13 DEC 2026', '2026-12-07', '2026-12-13', 'Review before widening',
    'Season 1 is targeted from 7 December. The dated day-30 review on 12 December decides the next expansion.',
    ['Season 1 fee-based Pennies weights', '30-day shadow-mark record targeted by 9 December', 'Alert adoption and retention review'],
    'Pass the day-30 review. If fewer than 20% of weekly active users use alerts, rework the Tape before E2. Season 1 timing is subject to its gate.',
    'Overview pp.14, 17; Expansion pp.5, 7', 'The source Season 1 target precedes its day-30 gate. Do not present 7 December as an unconditional launch.'),
  weekly(6, '14–20 DEC 2026', '2026-12-14', '2026-12-20', 'Widen the board',
    'E2 begins no earlier than 14 December, adding the Smid tier and the planned basket set.',
    ['$2–5B Smid tier', 'Five sector baskets and the eight-name small-cap basket', 'Equal-weight construction and monthly rebalancing'],
    'Day-30 review passed and 30 clean days of marks for every basket constituent.',
    'Expansion pp.4–5, 7–8'),
  weekly(7, '21–27 DEC 2026', '2026-12-21', '2026-12-27', 'Open the builder routes',
    'Give front-ends, bots and agents access to the same board and execution information.',
    ['Builder codes with a per-fill fee share', 'Relay bridge-and-deposit', 'MCP access for agents'],
    'E2 operating gates remain in force. Each integration needs its actual provider and contract connection before activation.',
    'Expansion pp.1, 7–8', 'These E2 items are sequenced here for the weekly view; their exact shipping week is not specified in the source.'),
  weekly(8, '28 DEC 2026–3 JAN 2027', '2026-12-28', '2027-01-03', 'Prepare the retention test',
    'Announce the January dark week and keep the comparison period visible.',
    ['Publish the zero-Pennies week in advance', 'Track the prior four-week fee-paying volume average', 'Keep alerts, trading and reporting available'],
    'The dark week is announced before it begins. No claim that points guarantee a token.',
    'Expansion p.5', 'Preparation is placed in the preceding week; the source fixes the test dates, not the announcement date.'),
  weekly(9, '4–10 JAN 2027', '2027-01-04', '2027-01-10', 'Run the dark week',
    'Pennies accrue zero for one announced week, measuring demand without the points incentive.',
    ['Zero Pennies accrual from 4–10 January', 'Measure fee-paying trading activity', 'Compare with the prior four-week average'],
    'Fee-paying volume must reach at least 50% of the prior four-week average to satisfy the added token gate.',
    'Expansion pp.5, 7'),
  weekly(10, '11–17 JAN 2027', '2027-01-11', '2027-01-17', 'Read the results',
    'The day-60 check is dated 11 January. Review the dark-week result, basket demand and public-Counter readiness.',
    ['Day-60 token-gate review', 'Basket share review after four weeks', 'Public Counter only after the R3 gate'],
    'If baskets stay below 10% of volume after four weeks, freeze new baskets. A day-60 token-gate miss greater than 50% means no token for this book. Public Counter requires 60 clean days, a completed contest audit with High/Medium fixes and a live bounty.',
    'Overview pp.8, 14, 17; Expansion p.7'),
  weekly(11, '18–24 JAN 2027', '2027-01-18', '2027-01-24', 'A decision, not a deadline',
    '18 January is the earliest token decision window. It is conditional on the product meeting every published gate.',
    ['Two consecutive weeks above the original operating gates', 'Dark-week retention gate', 'Keep Pennies non-transferable'],
    'All token gates must pass together, including concentration and zero oracle or settlement incidents. Failure means no token launch.',
    'Overview pp.9–10, 14; Expansion pp.5, 7'),
  weekly(12, '25–31 JAN 2027', '2027-01-25', '2027-01-31', 'Measure the wider desk',
    'Close E2 by measuring breadth, basket use, alerts and external distribution.',
    ['Target: at least 25 live markets', 'Target: baskets at least 20% of notional', 'Target: alerts used by at least 30% of weekly actives', 'Target: three external front-ends or bots routing through builder codes'],
    'These are 31 January targets from the plan, not achieved metrics. Expansion remains limited by verified feeds and Counter capacity.',
    'Expansion pp.7–8'),
];

export const laterRoadmap = [
  ...[
    [13, '1–7 FEB 2027', '2027-02-01', '2027-02-07'],
    [14, '8–14 FEB 2027', '2027-02-08', '2027-02-14'],
    [15, '15–21 FEB 2027', '2027-02-15', '2027-02-21'],
    [16, '22–28 FEB 2027', '2027-02-22', '2027-02-28'],
    [17, '1–7 MAR 2027', '2027-03-01', '2027-03-07'],
    [18, '8–14 MAR 2027', '2027-03-08', '2027-03-14'],
  ].map(([week, dates, start, end]) => weekly(week, dates, start, end, 'Build the operating record',
    'Continue the desk and its public record while the defined-risk product remains gated.',
    ['Record Counter NAV and incidents', 'Keep closes, trims and withdrawals available', 'Prepare the defined-risk release against its published gate'],
    'Week contracts require the public Counter to have been live for 60 days and the contest audit completed with High/Medium findings fixed.',
    'Expansion p.7; Overview pp.14–15', 'No individual February or early-March delivery is promised in the source. These are observation weeks, not invented feature launches.')),
  weekly(19, '15–21 MAR 2027', '2027-03-15', '2027-03-21', 'Defined risk, baskets first',
    'The earliest Week-contract window begins on 15 March, starting with baskets.',
    ['Margin equals maximum loss', 'Capped gain and no liquidation', 'Friday two-source settlement mark; last two-source mark if halted'],
    'Public Counter live for 60 days and contest-audit High/Medium findings fixed. Stop new Week-contract opens if product losses exceed 2% of Counter NAV in a week.',
    'Expansion pp.7–8'),
  weekly(20, '22–28 MAR 2027', '2027-03-22', '2027-03-28', 'Observe the first weekly cycle',
    'Review defined-risk settlement and loss budgets before adding more exposure.',
    ['Basket Week contracts remain subject to the release gate', 'Friday settlement uses the two-source mark', 'Existing perpetuals remain without expiry'],
    'The 2% weekly Counter-loss stop applies to new Week-contract opens. Holders retain the ability to close at mark.',
    'Expansion p.7', 'Observation is assigned to this week within E3; it is not a separate source-dated release.'),
  weekly(21, '29 MAR–4 APR 2027', '2027-03-29', '2027-04-04', 'Single-name review',
    'Single-name Week contracts enter the plan from April, after the basket-first release.',
    ['Review single-name eligibility', 'Retain capped loss and capped gain', 'Apply the same settlement and product-loss rules'],
    'April is a planning window, not a guaranteed launch date. E3 gates must still hold.',
    'Expansion p.7'),
  ...[
    [22, '5–11 APR 2027', '2027-04-05', '2027-04-11'],
    [23, '12–18 APR 2027', '2027-04-12', '2027-04-18'],
    [24, '19–25 APR 2027', '2027-04-19', '2027-04-25'],
    [25, '26 APR–2 MAY 2027', '2027-04-26', '2027-05-02'],
  ].map(([week, dates, start, end]) => weekly(week, dates, start, end, 'Review the holder-tool gate',
    'The Q2 plan adds holder tools and infrastructure access when the Counter has the required record.',
    ['One-click Stock Token holder hedge', 'Stock Token margin with large-cap haircuts', 'Mark, halt and corporate-action feed; white-label widget'],
    'Counter NAV at least $1M and 90 days of NAV history. If no integrator signs up within 60 days, stop B2B outreach and retain the public feed.',
    'Expansion pp.7–8', 'The source gives Q2, not a specific week. These weekly reviews do not claim the tools ship before their gate.')),
];

export const futureExpansion = [
  { id: 'q2-holder-tools', window: 'Q2 2027', title: 'Holder tools and infrastructure', body: 'One-click hedge, Stock Token margin with haircuts, a mark/halt/corporate-action feed and a white-label widget.', gate: 'Counter NAV of at least $1M and 90 days of NAV history.', status: 'Gated', source: 'Expansion pp.7–8' },
  { id: 'h2-oracle-only', window: 'H2 2027', title: 'Oracle-only names, conditionally', body: 'Consider small caps without a Stock Token only if two independent feeds can be obtained without KYB and coverage is confirmed.', gate: 'If these conditions cannot be met, this product does not proceed.', status: 'Optional', source: 'Expansion pp.7–8' },
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
  { label: 'Price-feed requirement', value: 'Live Chainlink feed plus agreement with the second primary source', source: 'Expansion p.4; Overview p.6' },
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
  { question: 'Where does the price come from?', answer: 'The design requires Chainlink equity feeds and Robinhood Stock Token quotes to agree before a new position opens. On-chain pools have zero weight in the mark. Chainlink feeds are already in token terms; the Robinhood quote is converted using the token multiplier.', source: 'Overview p.6; Backend pp.10–11' },
  { question: 'How does weekend trading work?', answer: 'The planned weekend mode uses the held Friday mark, a wider spread and a smaller per-wallet allowance. It does not discover a fresh weekend equity price. Borrow still accrues, so margin-only liquidation can occur; price-driven liquidation waits for fresh source agreement.', source: 'Overview pp.5, 12, 18; Backend pp.10, 17, 20' },
  { question: 'Can I close when a market is halted?', answer: 'The contract design keeps partial and full closes available in halted, frozen and close-only states. If the quote service is unavailable, closeAtMark is the direct on-chain fallback. A fallback can use a stale mark and a wider spread; same-block restrictions and profit limits still apply.', source: 'Overview pp.11–12, 18; Backend pp.8–10, 17' },
  { question: 'What is the Counter?', answer: 'The Counter is the USDG pool that takes the other side of trader positions. Its NAV and loss budget set the caps. Deposits and withdrawals use a two-step process settled at the next mark, with pro-rata fills when cash is short. Public Counter access is a later, gated release, and LPs can lose capital.', source: 'Overview pp.6–9, 18; Backend pp.3, 9–10' },
  { question: 'Is there a PLANKTON token?', answer: 'No token yet. Pennies are non-transferable points. A token decision is conditional on all operating gates being met together for two weeks, plus the dark-week test. Points do not guarantee a token or an airdrop.', source: 'Overview pp.9–10; Expansion pp.5, 7' },
  { question: 'Do I need a position to use the Tape?', answer: 'No open position is required in the plan. Halts, filings, offering flags, reverse-split notices, a catalyst calendar and alerts are intended for non-traders too. The current website is a preview; its alert controls do not send real notifications.', source: 'Expansion pp.1, 7–8; current frontend implementation boundary' },
  { question: 'Is this a live trading application?', answer: 'This build is an interactive frontend preview with sample market and account data. It does not submit transactions, accept deposits, execute orders or provide live alerts. Production access requires the contracts, APIs, feeds, wallet configuration and eligibility controls to be connected and verified.', source: 'Current implementation boundary; Backend pp.15–18' },
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

export const footerDisclosure = 'PLANKTON is an independent project. The planned product uses Robinhood Chain public contracts; no affiliation or endorsement by Robinhood, Chainlink or Uniswap is implied. Synthetic perpetuals do not confer share ownership. This website is an interactive preview with simulated data and no real execution. No token yet.';

