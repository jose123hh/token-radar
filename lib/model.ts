// Token radar model: a sealed snapshot in, a ranked board out.
//
// The board ranks pre-token protocols by an implied value that is calibrated
// from the snapshot's OWN market data, not from a hand-kept list of names:
//
//   1. Comps: for every category, the median market-cap/TVL ratio of the
//      protocols in that category whose token already trades AND that are
//      not themselves wrapped, staked or bridged products: a wrapped
//      product's ratio is the token it wraps, not a peer multiple. A
//      pre-token protocol is worth what its traded peers are worth per
//      dollar of TVL. Categories with few traded peers are shrunk toward
//      the global median, so one outlier cannot set a price; categories
//      with none use it.
//   2. Growth: the 7-day TVL change, clamped, moves the value up or down.
//   3. Maturity: the longer a protocol has run with no token, the closer its
//      implied value sits to the full comps value; young protocols are
//      discounted for the risk that the record is new.
//   4. Reach: a protocol live on more chains gets a small premium, capped.
//
// The model is tested blind before it is trusted, twice: the traded
// protocols are split in two by slug order, the multiples are fitted on
// one half only and the other half's market caps are predicted without
// ever touching calibration — then the halves swap, so every traded
// protocol is predicted exactly once by a fit that never saw it.
// validateOutOfSample() reports both splits and the pooled miss. Every farm plan
// ends in a netted verdict: the low end of the comps band, a stated share
// of a stated community allocation, against the plan's own gas and fees.
// FARM, THIN or SKIP, with the arithmetic on the page.
//
// Wrapped, staked and bridged products of tokens that already trade are
// never ranked as early finds and never calibrate a multiple: the house's
// own watchlist rule (its excluded categories, wrapped/staked names,
// version markers and exchange names) keeps them out of the early set and
// out of the comps, while every watchlist slug is ranked.
//
//   implied = TVL x categoryMultiple x growthMult x maturityMult x chainMult
//
// Every row states the inputs it was scored from, so the dashboard can show
// the derivation and a reader can re-derive any rank by hand. No protocol
// name is ever special-cased: one function scores every row.

/** One protocol entry: exactly the ten fields the sealed snapshot carries. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The whole snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** The model's constants, stated in the dashboard next to the formula. */
export interface ModelConstants {
  growth_weight: number;
  growth_floor: number;
  growth_cap: number;
  maturity_floor: number;
  maturity_range: number;
  maturity_days: number;
  unknown_age_days: number;
  multiple_floor: number;
  multiple_cap: number;
  shrink_prior: number;
  chain_step: number;
  chain_max_steps: number;
  farm_share: number;
  farmers: number;
  plan_txs: number;
  flat_cost_usd: number;
  farm_ratio: number;
  thin_ratio: number;
}

export const MODEL: ModelConstants = {
  growth_weight: 0.5,
  growth_floor: -60,
  growth_cap: 120,
  maturity_floor: 0.6,
  maturity_range: 0.4,
  maturity_days: 1095,
  unknown_age_days: 365,
  multiple_floor: 0.05,
  multiple_cap: 2.5,
  shrink_prior: 3,
  chain_step: 0.04,
  chain_max_steps: 5,
  farm_share: 0.05,
  farmers: 1000,
  plan_txs: 6,
  flat_cost_usd: 5,
  farm_ratio: 10,
  thin_ratio: 2,
};

/** The model's version label, shown in the dashboard. */
export const MODEL_VERSION = 'radar-comps-3';

/** How many live-token protocols the Live token view carries, by market cap. */
export const LIVE_ROWS = 24;

/** A farm step: the action, what it costs, and how long it takes. */
export interface FarmStep {
  text: string;
  cost: string;
  time: string;
}

/** One row of board.json. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  token_status: 'pre-token';
  age_days: number | null;
  implied_value_usd: number;
  model: {
    category_multiple: number;
    comps_count: number;
    growth_pct: number;
    growth_multiplier: number;
    maturity_multiplier: number;
    chain_multiplier: number;
    age_days: number | null;
  };
  farm_steps: string[];
}

/** A board row's compact form for data.js. */
export interface RadarRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  age_days: number | null;
  implied_value_usd: number;
  category_multiple: number;
  comps_count: number;
  growth_multiplier: number;
  maturity_multiplier: number;
  chain_multiplier: number;
}

/** A live-token protocol: the market's own value, never a model's. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
}

/** The comps calibration: one multiple per category, plus the global fallback. */
export interface CompsTable {
  by_category: Record<string, number>;
  counts: Record<string, number>;
  global: number;
  global_count: number;
}

/** A traded protocol as the dashboard receives it: the raw record the comps and the holdout recompute from. */
export interface CompProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number;
  listed_at: string | null;
}

/** One category's comps band: the 25th and 75th percentiles of its traded ratios. */
export interface BandRow {
  low: number;
  high: number;
  n: number;
}

/** The comps band: one low/high pair per category, plus the global fallback. */
export interface BandTable {
  by_category: Record<string, BandRow>;
  global: { low: number; high: number };
  global_count: number;
}

/** One blind-holdout prediction: the market's value against the model's, on a protocol calibration never saw. */
export interface ValidationPrediction {
  slug: string;
  name: string;
  actual: number;
  predicted: number;
  abs_error: number;
}

/** One direction of the blind holdout: fitted on one half, tested on the other. */
export interface ValidationSplit {
  fit_count: number;
  test_count: number;
  median_abs_error: number;
  within_2x: number;
  within_3x: number;
  predictions: ValidationPrediction[];
}

/** The blind holdout's result: both directions, plus every protocol predicted once. */
export interface ValidationResult {
  splits: ValidationSplit[];
  pooled: {
    count: number;
    median_abs_error: number;
    within_2x: number;
    within_3x: number;
    predictions: ValidationPrediction[];
  };
}

/** A farm plan's netted verdict: FARM with conviction, THIN with a small position, or SKIP. */
export type VerdictLabel = 'FARM' | 'THIN' | 'SKIP';

/** The verdict and the arithmetic behind it: the low end of the band, the expected take, the cost, the ratio. */
export interface Verdict {
  verdict: VerdictLabel;
  band_low: number;
  prize_low: number;
  cost_usd: number;
  ratio: number;
}

/** Everything the dashboard needs. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model: ModelConstants;
  model_version: string;
  comps: CompsTable;
  comp_protocols: CompProtocol[];
  bands: BandTable;
  validation: ValidationResult;
  watchlist: string[];
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  rows: RadarRow[];
  live: LiveRow[];
}

/** Why the snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;

/** A finite number, else `fallback`. */
function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** The median of a sorted list of numbers; the mean of the two middles when even. */
function median(sorted: number[]): number {
  const n = sorted.length;
  if (n === 0) return NaN;
  const mid = Math.floor(n / 2);
  return n % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * The protocols that calibrate the model: traded (a market cap over a
 * positive TVL) and not wrapped products. A wrapped, staked or bridged
 * product's market-cap/TVL ratio is the token it wraps, not a peer
 * multiple, so the house's watchlist rule keeps them out of the comps.
 */
export function compProtocols(snapshot: Snapshot): (SnapshotProtocol & { mcap_usd: number })[] {
  return snapshot.protocols.filter(
    (p): p is SnapshotProtocol & { mcap_usd: number } =>
      p.mcap_usd !== null && p.tvl_usd > 0 && p.mcap_usd > 0 && !isWrappedProduct(p),
  );
}

/**
 * Calibrate the comps table from the snapshot's traded protocols: for each
 * category, the median market-cap/TVL ratio of its protocols whose token
 * already trades, shrunk toward the global median by a prior of
 * `shrink_prior` phantom protocols at the global value, so a category with
 * one or two traded peers cannot set an extreme price. Multiples are
 * clamped so one outlier cannot set a price.
 */
export function calibrateComps(snapshot: Snapshot, model: ModelConstants = MODEL): CompsTable {
  const byCategory = new Map<string, number[]>();
  const all: number[] = [];
  // One comp's ratio is winsorised before it can move a median: a protocol
  // with a tiny TVL and a large market cap must not set its category's price.
  const RATIO_WINSOR = 3;
  for (const p of compProtocols(snapshot)) {
    const ratio = Math.min(RATIO_WINSOR, Math.max(model.multiple_floor, p.mcap_usd / p.tvl_usd));
    if (!Number.isFinite(ratio) || ratio <= 0) continue;
    all.push(ratio);
    const key = p.category ?? '(uncategorised)';
    const list = byCategory.get(key) ?? [];
    list.push(ratio);
    byCategory.set(key, list);
  }
  all.sort((a, b) => a - b);
  const globalRaw = median(all);
  const global = Number.isFinite(globalRaw)
    ? Math.min(model.multiple_cap, Math.max(model.multiple_floor, globalRaw))
    : 0.25;
  const table: CompsTable = { by_category: {}, counts: {}, global, global_count: all.length };
  for (const [key, list] of [...byCategory.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    list.sort((a, b) => a - b);
    const raw = median(list);
    const shrunk = (list.length * raw + model.shrink_prior * global) / (list.length + model.shrink_prior);
    table.by_category[key] = Math.min(model.multiple_cap, Math.max(model.multiple_floor, shrunk));
    table.counts[key] = list.length;
  }
  return table;
}

/** The multiple a protocol's category calibrates to, or the global fallback. */
export function multipleFor(p: SnapshotProtocol, comps: CompsTable): { multiple: number; count: number } {
  const key = p.category ?? '(uncategorised)';
  const own = comps.by_category[key];
  if (own !== undefined) return { multiple: own, count: comps.counts[key] ?? 0 };
  return { multiple: comps.global, count: comps.global_count };
}

/** The q-th quantile of a sorted list, linearly interpolated. */
function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

/**
 * The comps band: per category, the 25th and 75th percentiles of the traded
 * protocols' winsorised market-cap/TVL ratios, shrunk toward the global
 * percentiles with the same prior as the medians. The low end is what the
 * netted verdict prices from: a farm plan should pay at the band's low
 * end, not at its middle.
 */
export function calibrateBands(snapshot: Snapshot, model: ModelConstants = MODEL): BandTable {
  const byCategory = new Map<string, number[]>();
  const all: number[] = [];
  const RATIO_WINSOR = 3;
  for (const p of compProtocols(snapshot)) {
    const ratio = Math.min(RATIO_WINSOR, Math.max(model.multiple_floor, p.mcap_usd / p.tvl_usd));
    if (!Number.isFinite(ratio) || ratio <= 0) continue;
    all.push(ratio);
    const key = p.category ?? '(uncategorised)';
    const list = byCategory.get(key) ?? [];
    list.push(ratio);
    byCategory.set(key, list);
  }
  all.sort((a, b) => a - b);
  const g25 = quantile(all, 0.25);
  const g75 = quantile(all, 0.75);
  const clamp = (n: number): number => Math.min(model.multiple_cap, Math.max(model.multiple_floor, n));
  const table: BandTable = {
    by_category: {},
    global: {
      low: Number.isFinite(g25) ? clamp(g25) : model.multiple_floor,
      high: Number.isFinite(g75) ? clamp(g75) : 0.25,
    },
    global_count: all.length,
  };
  for (const [key, list] of [...byCategory.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    list.sort((a, b) => a - b);
    const low = (list.length * quantile(list, 0.25) + model.shrink_prior * g25) / (list.length + model.shrink_prior);
    const high = (list.length * quantile(list, 0.75) + model.shrink_prior * g75) / (list.length + model.shrink_prior);
    table.by_category[key] = { low: clamp(low), high: clamp(high), n: list.length };
  }
  return table;
}

/**
 * The blind holdout, run both ways: the traded protocols, sorted by slug,
 * split into alternating halves; the multiples are fitted on one half
 * only and the other half's market caps are predicted with the same
 * impliedValue() the board uses — then the halves swap. Nothing in a
 * test half touches its calibration, and every traded protocol is
 * predicted exactly once, so the pooled miss is the model's honest miss
 * on unseen protocols and neither direction can hide behind a lucky split.
 */
export function validateOutOfSample(snapshot: Snapshot, model: ModelConstants = MODEL): ValidationResult {
  const sorted = compProtocols(snapshot).sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  const runSplit = (
    fit: (SnapshotProtocol & { mcap_usd: number })[],
    test: (SnapshotProtocol & { mcap_usd: number })[],
  ): ValidationSplit => {
    const fitComps = calibrateComps({ ...snapshot, protocols: fit }, model);
    const predictions: ValidationPrediction[] = test.map((p) => {
      const predicted = impliedValue(p, snapshot.as_of, fitComps, model).implied;
      const actual = p.mcap_usd;
      return { slug: p.slug, name: p.name, actual, predicted, abs_error: Math.abs(predicted - actual) / actual };
    });
    predictions.sort((a, b) => a.abs_error - b.abs_error || (a.slug < b.slug ? -1 : 1));
    const errors = predictions.map((p) => p.abs_error).sort((a, b) => a - b);
    const n = errors.length;
    return {
      fit_count: fit.length,
      test_count: test.length,
      median_abs_error: n === 0 ? NaN : median(errors),
      within_2x: n === 0 ? 0 : errors.filter((e) => e <= 1).length / n,
      within_3x: n === 0 ? 0 : errors.filter((e) => e <= 2).length / n,
      predictions,
    };
  };
  const even = sorted.filter((_, i) => i % 2 === 0);
  const odd = sorted.filter((_, i) => i % 2 === 1);
  const splits = [runSplit(even, odd), runSplit(odd, even)];
  const pooledPredictions = [...splits[0].predictions, ...splits[1].predictions].sort(
    (a, b) => a.abs_error - b.abs_error || (a.slug < b.slug ? -1 : 1),
  );
  const pooledErrors = pooledPredictions.map((p) => p.abs_error).sort((a, b) => a - b);
  const n = pooledErrors.length;
  return {
    splits,
    pooled: {
      count: n,
      median_abs_error: n === 0 ? NaN : median(pooledErrors),
      within_2x: n === 0 ? 0 : pooledErrors.filter((e) => e <= 1).length / n,
      within_3x: n === 0 ? 0 : pooledErrors.filter((e) => e <= 2).length / n,
      predictions: pooledPredictions,
    },
  };
}

/** Whole days from `listedAt` to `asOf`, clamped at zero; null when unknown or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** The multipliers and the implied value one protocol gets. */
export function impliedValue(
  protocol: SnapshotProtocol,
  asOf: string,
  comps: CompsTable,
  model: ModelConstants = MODEL,
): { implied: number; multiple: number; compsCount: number; growthPct: number; growthMult: number; maturityMult: number; chainMult: number; age: number | null } {
  const age = ageDays(asOf, protocol.listed_at);
  const { multiple, count } = multipleFor(protocol, comps);
  const rawGrowth = finite(protocol.change_7d, 0);
  const growthPct = Math.min(model.growth_cap, Math.max(model.growth_floor, rawGrowth));
  const growthMult = 1 + (growthPct / 100) * model.growth_weight;
  const ageForModel = age ?? model.unknown_age_days;
  const maturityMult =
    model.maturity_floor +
    (Math.min(Math.max(ageForModel, 0), model.maturity_days) / model.maturity_days) * model.maturity_range;
  const extraChains = Math.min(Math.max(protocol.chains.length - 1, 0), model.chain_max_steps);
  const chainMult = 1 + extraChains * model.chain_step;
  const implied = Math.max(1, Math.round(protocol.tvl_usd * multiple * growthMult * maturityMult * chainMult));
  return { implied, multiple, compsCount: count, growthPct, growthMult, maturityMult, chainMult, age };
}

/** DefiLlama's version-marker rule: a name ending in a release is a pool of another protocol. */
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/** Categories the house's watchlist rule treats as wrapped, staked or bridged products. */
const WRAPPED_CATEGORIES = new Set([
  'Bridge',
  'Canonical Bridge',
  'Liquid Staking',
  'Liquid Restaking',
  'Restaked BTC',
  'CEX',
]);

/** A whole word wrapped, staked or staking anywhere in a name, in any case. */
const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;

/** Names beginning with an exchange's name are that exchange's product. */
const EXCHANGE_NAMES = ['Binance', 'Coinbase', 'Bybit', 'Kraken', 'Bitget', 'OKX', 'Bitfinex', 'Gemini'];

/** Whether a protocol looks like a wrapped, staked or bridged product of a token that already trades. */
export function isWrappedProduct(p: SnapshotProtocol): boolean {
  if (p.category !== null && WRAPPED_CATEGORIES.has(p.category)) return true;
  if (WRAPPED_WORD.test(p.name)) return true;
  if (VERSIONED.test(p.name)) return true;
  const lower = p.name.toLowerCase();
  return EXCHANGE_NAMES.some((e) => lower.startsWith(e.toLowerCase()));
}

/** Whether a protocol records no token at all. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** Whether a protocol is one the early radar may rank: pre-token and not a wrapped product. */
export function isRankable(p: SnapshotProtocol): boolean {
  return isPreToken(p) && !isWrappedProduct(p);
}

/** The protocols the board ranks, strongest first, with ranks 1..n. */
export function buildBoard(snapshot: Snapshot, model: ModelConstants = MODEL): BoardRow[] {
  const comps = calibrateComps(snapshot, model);
  const bands = calibrateBands(snapshot, model);
  const index = new Map(snapshot.protocols.map((p) => [p.slug, p]));
  const chosen = new Map<string, SnapshotProtocol>();
  // The watchlist is the floor: every slug it names is ranked.
  for (const slug of snapshot.watchlist) {
    const p = index.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }
  // The early radar: every other rankable pre-token protocol, whatever its
  // TVL. The ranking, not a cutoff, decides what is worth a reader's time.
  for (const p of snapshot.protocols) {
    if (!chosen.has(p.slug) && isRankable(p)) chosen.set(p.slug, p);
  }
  const scored = [...chosen.values()].map((p) => {
    const v = impliedValue(p, snapshot.as_of, comps, model);
    return { p, ...v };
  });
  scored.sort((a, b) => b.implied - a.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  return scored.map((s, i) => ({
    rank: i + 1,
    slug: s.p.slug,
    name: s.p.name,
    category: s.p.category,
    chains: s.p.chains,
    tvl_usd: s.p.tvl_usd,
    change_7d: s.p.change_7d,
    mcap_usd: s.p.mcap_usd,
    listed_at: s.p.listed_at,
    gecko_id: s.p.gecko_id,
    symbol: s.p.symbol,
    token_status: 'pre-token',
    age_days: s.age,
    implied_value_usd: s.implied,
    model: {
      category_multiple: round4(s.multiple),
      comps_count: s.compsCount,
      growth_pct: s.growthPct,
      growth_multiplier: round4(s.growthMult),
      maturity_multiplier: round4(s.maturityMult),
      chain_multiplier: round4(s.chainMult),
      age_days: s.age,
    },
    farm_steps: farmSteps(s.p, s.age, verdictFor(s.p, s, bands, model), model).map(stepText),
  }));
}

const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

/** A step as one string: action, cost and time, within the gate's 20..600 characters. */
export function stepText(step: FarmStep): string {
  let s = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Hold the position and check the protocol's own page.`;
  return s;
}

/** The first chain a protocol names, or a neutral phrase. */
function chainOf(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/** Typical gas for one simple transaction on a chain, as a rough estimate. */
function gasEstimate(chain: string): string {
  const c = chain.toLowerCase();
  if (c.includes('ethereum')) return 'about $8 of gas';
  if (c.includes('solana')) return 'under $0.10 of gas';
  if (c.includes('arbitrum') || c.includes('optimism') || c.includes('base') || c.includes('zksync') || c.includes('linea') || c.includes('scroll') || c.includes('blast') || c.includes('mode')) return 'under $1 of gas';
  if (c.includes('bsc') || c.includes('bnb')) return 'about $0.50 of gas';
  if (c.includes('polygon')) return 'under $0.20 of gas';
  if (c.includes('avalanche')) return 'about $1 of gas';
  if (c.includes('sui') || c.includes('aptos') || c.includes('near') || c.includes('sei')) return 'under $0.10 of gas';
  if (c.includes('bitcoin') || c.includes('lightning')) return 'about $2 of fees';
  return 'about $2 of gas';
}

/** The same gas table as numbers: the stated ceiling of each estimate, for the netted verdict. */
export function gasUsd(chain: string): number {
  const c = chain.toLowerCase();
  if (c.includes('ethereum')) return 8;
  if (c.includes('solana')) return 0.1;
  if (c.includes('arbitrum') || c.includes('optimism') || c.includes('base') || c.includes('zksync') || c.includes('linea') || c.includes('scroll') || c.includes('blast') || c.includes('mode')) return 1;
  if (c.includes('bsc') || c.includes('bnb')) return 0.5;
  if (c.includes('polygon')) return 0.2;
  if (c.includes('avalanche')) return 1;
  if (c.includes('sui') || c.includes('aptos') || c.includes('near') || c.includes('sei')) return 0.1;
  if (c.includes('bitcoin') || c.includes('lightning')) return 2;
  return 2;
}

/**
 * The netted verdict: the protocol at the LOW end of its comps band, a
 * stated share of a stated community allocation split among a stated
 * number of farmers, against the farm plan's own gas and fees. FARM when
 * the expected take clears the cost tenfold, THIN when it clears it
 * twofold, SKIP otherwise. The assumptions are the model's constants,
 * stated on the page next to every verdict.
 */
export function verdictFor(
  p: SnapshotProtocol,
  mults: { growthMult: number; maturityMult: number; chainMult: number },
  bands: BandTable,
  model: ModelConstants = MODEL,
): Verdict {
  const key = p.category ?? '(uncategorised)';
  const band = bands.by_category[key] ?? bands.global;
  const bandLow = Math.max(1, Math.round(p.tvl_usd * band.low * mults.growthMult * mults.maturityMult * mults.chainMult));
  const prizeLow = (bandLow * model.farm_share) / model.farmers;
  const costUsd = gasUsd(chainOf(p)) * model.plan_txs + model.flat_cost_usd;
  const ratio = prizeLow / costUsd;
  return {
    verdict: ratio >= model.farm_ratio ? 'FARM' : ratio >= model.thin_ratio ? 'THIN' : 'SKIP',
    band_low: bandLow,
    prize_low: prizeLow,
    cost_usd: costUsd,
    ratio,
  };
}

/** How much capital one farm position needs, from the protocol's own TVL. */
function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 5_000_000_000) return 250;
  if (p.tvl_usd >= 1_000_000_000) return 150;
  if (p.tvl_usd >= 100_000_000) return 100;
  return 50;
}

/** How long to hold, from the protocol's age: younger protocols get a longer qualifying window. */
function holdDaysFor(age: number | null): number {
  if (age === null) return 30;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

/** The category's main action, in words a farmer can follow. */
function actionFor(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return `Supply $${capital} of USDC to ${name} on ${chain} as collateral and keep the position open.`;
  if (c.includes('dex') || c.includes('exchange')) return `Provide $${capital} of liquidity to ${name}'s highest-volume pool on ${chain} and keep the position open.`;
  if (c.includes('yield') || c.includes('leveraged farm') || c.includes('farm')) return `Deposit $${capital} into ${name}'s main yield vault on ${chain} and keep the shares.`;
  if (c.includes('bridge') || c.includes('cross-chain')) return `Bridge $${capital} of USDC through ${name} to ${chain} and use the bridged funds in its app.`;
  if (c.includes('liquid staking') || c.includes('restak') || c.includes('staking')) return `Stake $${capital} of the chain's staking asset through ${name} on ${chain} and keep the receipt token.`;
  if (c.includes('perpetual') || c.includes('derivative') || c.includes('options')) return `Deposit $${capital} of USDC as margin on ${name} on ${chain} and open one small hedged position.`;
  if (c.includes('prediction')) return `Fund $${capital} and place one small position on a ${name} market on ${chain}.`;
  if (c.includes('curator') || c.includes('allocator') || c.includes('index')) return `Deposit $${capital} into a ${name} vault on ${chain} and keep the shares.`;
  if (c.includes('stable')) return `Mint or deposit $${capital} of the stable asset through ${name} on ${chain} and hold it.`;
  if (c.includes('rwa') || c.includes('real world')) return `Mint $${capital} of the protocol's yield-bearing asset on ${chain} and hold it.`;
  if (c.includes('insurance')) return `Buy $${capital} of cover from ${name} on ${chain} and keep the policy active.`;
  if (c.includes('launchpad') || c.includes('launch')) return `Stake or hold $${capital} through ${name}'s launch allocation on ${chain} and join one sale.`;
  if (c.includes('ai') || c.includes('compute') || c.includes('depin')) return `Run or rent $${capital} of the resource ${name} coordinates on ${chain} and keep it online.`;
  if (c.includes('gam')) return `Fund $${capital} into ${name}'s game economy on ${chain} and play one full session.`;
  if (c.includes('nft')) return `List or buy one ${name} item on ${chain} for about $${capital} and hold it.`;
  if (c.includes('privacy') || c.includes('mixer')) return `Route $${capital} through ${name} on ${chain} in two separate transactions a week apart.`;
  if (c.includes('social')) return `Create a profile on ${name}, fund it with $${capital} and post once a week.`;
  return `Deposit $${capital} of USDC into ${name} on ${chain} and keep the position open.`;
}

/** $1,234,567: whole dollars with separators, the same in the model and the page. */
function intUsd(n: number): string {
  return `$${Math.round(n).toLocaleString('en-US')}`;
}

/** $12,345.67: separators and two decimals, the same in the model and the page. */
function money(n: number): string {
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * A protocol's farm plan: eight steps, each an action with a cost and a
 * time, derived from the protocol's own record (category, chains, TVL, age),
 * never from a hand-written list of names. The eighth step is the netted
 * verdict, with its arithmetic.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null, verdict: Verdict, model: ModelConstants = MODEL): FarmStep[] {
  const chain = chainOf(p);
  const capital = capitalFor(p);
  const hold = holdDaysFor(age);
  const gas = gasEstimate(chain);
  return [
    {
      text: `Use a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline on paper.`,
      cost: 'nothing to set up',
      time: '5 minutes',
    },
    {
      text: `Fund the wallet with $${capital} of USDC plus a little of ${chain}'s gas token, from an exchange withdrawal or a bridge you already trust.`,
      cost: `${gas} for the first transaction`,
      time: '15 minutes',
    },
    {
      text: actionFor(p, capital, chain),
      cost: `$${capital} of capital and ${gas}`,
      time: '20 minutes to set up',
    },
    {
      text: `Make one qualifying action each week, such as a deposit, a borrow, a swap or a vote, so the wallet stays active across snapshots.`,
      cost: `${gas} a week`,
      time: '10 minutes a week',
    },
    {
      text: `Hold the position for at least ${hold} days so the activity is counted in more than one snapshot window.`,
      cost: `the $${capital} stays in the position`,
      time: `${hold} days`,
    },
    {
      text: `Once a month, open the protocol's own points or rewards page from its official site and check the wallet's standing; claim only from links the protocol itself publishes.`,
      cost: 'no fee to check, and never pay to claim',
      time: '10 minutes a month',
    },
    {
      text: `Write the wallet, the dates and every transaction hash in a farm log, and plan the exit before you need it: note any unstaking delay or withdrawal fee.`,
      cost: 'nothing but the log',
      time: '5 minutes',
    },
    {
      text: `Verdict: ${verdict.verdict} — at the low end of the comps band this protocol is worth ${intUsd(verdict.band_low)}; a ${Math.round(model.farm_share * 100)}% community allocation split among ${model.farmers.toLocaleString('en-US')} farmers pays about ${money(verdict.prize_low)} against about ${money(verdict.cost_usd)} of gas and fees, a ${verdict.ratio.toFixed(1)}x return on cost.`,
      cost: 'counted in the verdict',
      time: 'decided before you start',
    },
  ];
}

/** The live-token protocols, by market cap, for the dashboard's Live token view. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !isPreToken(p) && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : 1))
    .slice(0, LIVE_ROWS)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
    }));
}

/** A board row's compact form for data.js. */
export function radarRow(row: BoardRow): RadarRow {
  return {
    rank: row.rank,
    slug: row.slug,
    name: row.name,
    category: row.category,
    chains: row.chains,
    tvl_usd: row.tvl_usd,
    change_7d: row.change_7d,
    mcap_usd: row.mcap_usd,
    listed_at: row.listed_at,
    age_days: row.age_days,
    implied_value_usd: row.implied_value_usd,
    category_multiple: row.model.category_multiple,
    comps_count: row.model.comps_count,
    growth_multiplier: row.model.growth_multiplier,
    maturity_multiplier: row.model.maturity_multiplier,
    chain_multiplier: row.model.chain_multiplier,
  };
}

/** Everything the dashboard renders, from the snapshot. */
export function buildRadar(snapshot: Snapshot, model: ModelConstants = MODEL): { board: BoardRow[]; radar: RadarData } {
  const comps = calibrateComps(snapshot, model);
  const board = buildBoard(snapshot, model);
  const live = liveRows(snapshot);
  const early = board.filter((r) => !snapshot.watchlist.includes(r.slug)).length;
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model,
    model_version: MODEL_VERSION,
    comps,
    comp_protocols: compProtocols(snapshot).map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      change_7d: p.change_7d,
      mcap_usd: p.mcap_usd,
      listed_at: p.listed_at,
    })),
    bands: calibrateBands(snapshot, model),
    validation: validateOutOfSample(snapshot, model),
    watchlist: snapshot.watchlist,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: early,
    live_size: live.length,
    rows: board.map(radarRow),
    live,
  };
  return { board, radar };
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return {
    as_of: o.as_of,
    source: o.source,
    floor_usd: o.floor_usd,
    protocols,
    watchlist: o.watchlist as string[],
  };
}

/** Why a board is not one the gate will take, or null. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value $${board[0]!.implied_value_usd}: a board that ranks nothing by value is not a ranking`;
  }
  for (const r of board) {
    const steps = r.farm_steps;
    if (steps.length < 3 || steps.length > 12) return `${r.slug} has ${steps.length} farm steps`;
    for (const s of steps) if (s.trim().length < 20 || s.trim().length > 600) return `${r.slug} has a farm step of ${s.trim().length} characters`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
    if (r.implied_value_usd > 100_000_000_000_000) return `${r.slug} has implied value over the gate cap`;
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
