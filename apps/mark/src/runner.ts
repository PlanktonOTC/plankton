import type { Logger } from 'pino';
import {
  DEFAULT_PRICING_CONFIG,
  checkEligibility,
  newEngineState,
  sessionAt,
  statusName,
  stepMark,
  type Calendar,
  type Eligibility,
  type EngineState,
  type MarketData,
  type MarkDecision,
  type MarketClass,
  type Observation,
  type PricingConfig,
  type SourceName,
} from '@plankton/core';
import { eligibilityMode, loadMarketData, type Env, type MarketConfig } from '@plankton/config';
import { readChainlink, ROBINHOOD_CHAIN_ID, type ChainClient } from '@plankton/chain';
import {
  activeHalts,
  corporateActionFreeze,
  fetchHalts,
  fetchRhAssets,
  fetchRhCorpActions,
  fetchRhPrices,
  rhReading,
  type Halt,
  type RhCorpAction,
  type RhIssue,
} from '@plankton/ingest';

/** Jump that makes the contract set its breaker (spec: micro 3000 bps, small 2000 bps). */
const JUMP_BPS: Record<MarketClass, number> = { micro: 3_000, small: 2_000, smid: 2_000, index: 1_500 };

/** Robinhood problems that mean "do not price this market", as opposed to "one source is missing". */
const FREEZE_ISSUES: RhIssue[] = ['wrong_contract', 'pending_multiplier', 'asset_inactive', 'multiplier_mismatch'];

/**
 * Where decisions go. The contract-facing publisher implements this later; until then decisions are only logged
 * and served over HTTP.
 */
export interface MarkSink {
  onDecision(symbol: string, decision: MarkDecision, now: number): void | Promise<void>;
}

interface Runtime {
  cfg: MarketConfig;
  engine: EngineState;
  obs: Map<SourceName, Observation>;
  rhIssues: RhIssue[];
  rhHalted: boolean;
  decision: MarkDecision | null;
  decidedAt: number | null;
  session: { status: number; openGuard: boolean; reason: string } | null;
  freezeReasons: string[];
  eligibility: Eligibility | null;
  warnedIneligible: boolean;
}

export interface RunnerDeps {
  env: Env;
  markets: MarketConfig[];
  calendar: Calendar;
  client: ChainClient;
  sink: MarkSink;
  log: Logger;
}

export class MarkRunner {
  private readonly rt = new Map<string, Runtime>();
  private halts = new Map<string, Halt>();
  private corp: RhCorpAction[] = [];
  private marketData: Record<string, MarketData> = {};
  readonly lastOk: Record<'robinhood' | 'chainlink' | 'halts' | 'corporateActions' | 'tick', number> = {
    robinhood: 0,
    chainlink: 0,
    halts: 0,
    corporateActions: 0,
    tick: 0,
  };

  constructor(private readonly d: RunnerDeps) {
    for (const cfg of d.markets) {
      this.rt.set(cfg.symbol, {
        cfg,
        engine: newEngineState(),
        obs: new Map(),
        rhIssues: [],
        rhHalted: false,
        decision: null,
        decidedAt: null,
        session: null,
        freezeReasons: [],
        eligibility: null,
        warnedIneligible: false,
      });
    }
  }

  /**
   * Start-up: take the last mark the oracle holds as the held price, so a restart over a weekend or halt keeps pricing
   * from what is already on-chain instead of waiting for the next regular session.
   */
  seed(symbol: string, priceE18: bigint): void {
    const r = this.rt.get(symbol);
    if (!r || priceE18 <= 0n) return;
    r.engine.lastGoodE18 ??= priceE18;
    r.engine.refCloseE18 ??= priceE18;
  }

  async pollRobinhood(): Promise<void> {
    const [quotes, assets] = await Promise.all([fetchRhPrices(this.d.env.RH_API_BASE), fetchRhAssets(this.d.env.RH_API_BASE)]);
    for (const r of this.rt.values()) {
      const reading = rhReading(r.cfg.symbol, r.cfg.stockToken, ROBINHOOD_CHAIN_ID, quotes, assets);
      r.rhIssues = reading.issues;
      r.rhHalted = reading.halted;
      if (reading.observation) r.obs.set('rh_quote', reading.observation);
      else r.obs.delete('rh_quote');
    }
    this.lastOk.robinhood = Date.now();
  }

  async pollChainlink(): Promise<void> {
    const feeds = [...this.rt.values()].map((r) => ({ symbol: r.cfg.symbol, feed: r.cfg.chainlinkFeed as `0x${string}` }));
    const readings = await readChainlink(this.d.client, feeds);
    for (const [symbol, obs] of readings) {
      const r = this.rt.get(symbol)!;
      if (obs) r.obs.set('chainlink', obs);
      else r.obs.delete('chainlink');
    }
    this.lastOk.chainlink = Date.now();
  }

  async pollHalts(): Promise<void> {
    this.halts = activeHalts(await fetchHalts(this.d.env.NASDAQ_HALTS_URL), Date.now());
    this.lastOk.halts = Date.now();
  }

  /** Re-read config/market-data.json so an edit takes effect without a restart. */
  async pollMarketData(): Promise<void> {
    this.marketData = loadMarketData();
  }

  eligibility() {
    return [...this.rt.values()].map((r) => ({
      symbol: r.cfg.symbol,
      eligible: r.eligibility?.eligible ?? null,
      reasons: r.eligibility?.reasons ?? [],
      warnings: r.eligibility?.warnings ?? [],
      absOiCapUsdg: r.eligibility?.absOiCapUsdg ?? 0n,
      mode: eligibilityMode(this.d.env),
      data: this.marketData[r.cfg.symbol] ?? null,
    }));
  }

  async pollCorporateActions(): Promise<void> {
    this.corp = await fetchRhCorpActions(this.d.env.RH_API_BASE);
    this.lastOk.corporateActions = Date.now();
  }

  /** Evaluate every market once. Cheap and synchronous apart from the sink. */
  async tick(now = Date.now()): Promise<void> {
    for (const r of this.rt.values()) {
      const symbol = r.cfg.symbol;
      const session = sessionAt(now, this.d.calendar, { windowTz: this.d.env.STOCK_TOKEN_WINDOW_TZ, openGuardMinutes: 20 });
      r.session = session;

      const reasons: string[] = [];
      const blocking = r.rhIssues.filter((i) => FREEZE_ISSUES.includes(i));
      if (blocking.length > 0) reasons.push(`robinhood: ${blocking.join(',')}`);
      if (corporateActionFreeze(this.corp, symbol, now)) reasons.push('corporate action pending');
      r.freezeReasons = reasons;

      const halted = r.rhHalted || this.halts.has(symbol);
      const pricing: PricingConfig = {
        ...DEFAULT_PRICING_CONFIG,
        agreeBps: r.cfg.agreeBps ?? DEFAULT_PRICING_CONFIG.agreeBps,
        maxAgeMs: {
          ...DEFAULT_PRICING_CONFIG.maxAgeMs,
          chainlink: r.cfg.chainlinkMaxAgeSec ? r.cfg.chainlinkMaxAgeSec * 1000 : DEFAULT_PRICING_CONFIG.maxAgeMs.chainlink,
        },
      };
      // Cold start on a closed session: the newest Chainlink answer, if it is under 4 days old, opens the weekend hold.
      const cl = r.obs.get('chainlink');
      const seed = cl && now - cl.sourceUpdatedAt <= 4 * 86_400_000 ? cl.priceE18 : null;
      // The listing rule. In enforce mode a market that fails it publishes marks no open can pass; exits are untouched.
      const priceSource = r.obs.get('rh_quote') ?? r.obs.get('chainlink');
      r.eligibility = checkEligibility(symbol, r.cfg.class, this.marketData[symbol], priceSource ? Number(priceSource.priceE18) / 1e18 : null, now);
      const mode = eligibilityMode(this.d.env);
      if (!r.eligibility.eligible && mode !== 'off' && !r.warnedIneligible) {
        r.warnedIneligible = true;
        this.d.log.warn({ symbol, mode, reasons: r.eligibility.reasons }, 'fails the listing rule');
      }
      if (r.eligibility.eligible) r.warnedIneligible = false;
      const reduceOnly = !r.eligibility.eligible && mode === 'enforce' ? `listing rule: ${r.eligibility.reasons.join(', ')}` : null;

      const step = stepMark(
        r.engine,
        { observations: [...r.obs.values()], now, session: session.status, halted, frozen: reasons.length > 0, seedPriceE18: seed, reduceOnly },
        pricing,
        JUMP_BPS[r.cfg.class],
      );
      r.engine = step.state;
      if (!step.decision) continue;

      if (step.decision.jump) this.d.log.warn({ symbol, price: step.decision.priceE18.toString() }, 'mark jump above breaker limit');
      r.decision = step.decision;
      r.decidedAt = now;
      try {
        await this.d.sink.onDecision(symbol, step.decision, now);
      } catch (err) {
        this.d.log.error({ err, symbol }, 'sink failed');
      }
    }
    this.lastOk.tick = now;
  }

  marks() {
    return [...this.rt.values()].map((r) => ({
      symbol: r.cfg.symbol,
      class: r.cfg.class,
      status: r.decision ? statusName(r.decision.status) : null,
      priceE18: r.decision?.priceE18 ?? null,
      refCloseE18: r.decision?.refCloseE18 ?? null,
      confidenceBps: r.decision?.confidenceBps ?? null,
      dispersionBps: r.decision?.dispersionBps ?? null,
      sources: r.decision?.sources ?? [],
      reason: r.decision?.reason ?? null,
      openGuard: r.session?.openGuard ?? false,
      session: r.session?.reason ?? null,
      freezeReasons: r.freezeReasons,
      eligible: r.eligibility?.eligible ?? null,
      eligibilityReasons: r.eligibility?.reasons ?? [],
      eligibilityWarnings: r.eligibility?.warnings ?? [],
      decidedAt: r.decidedAt,
    }));
  }

  sources(symbol: string, now = Date.now()) {
    const r = this.rt.get(symbol);
    if (!r) return null;
    return {
      symbol,
      halted: r.rhHalted || this.halts.has(symbol),
      haltReason: this.halts.get(symbol)?.reasonCode ?? null,
      robinhoodIssues: r.rhIssues,
      sources: [...r.obs.values()].map((o) => ({
        source: o.source,
        priceE18: o.priceE18,
        bidE18: o.bidE18 ?? null,
        askE18: o.askE18 ?? null,
        ageMs: now - o.sourceUpdatedAt,
      })),
    };
  }

  health(now = Date.now()) {
    const age = (t: number) => (t === 0 ? null : now - t);
    return {
      robinhoodAgeMs: age(this.lastOk.robinhood),
      chainlinkAgeMs: age(this.lastOk.chainlink),
      haltsAgeMs: age(this.lastOk.halts),
      corporateActionsAgeMs: age(this.lastOk.corporateActions),
      tickAgeMs: age(this.lastOk.tick),
      markets: this.rt.size,
    };
  }
}
