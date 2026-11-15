/* Token Radar: the dashboard.
 *
 * The board ranks protocols that record no token yet, by an implied value
 * calibrated from the snapshot's own traded market. The model lives here in
 * the open, in impliedValue(), and the page re-derives every row from the
 * snapshot figures in data.js, so what the screenshots show is what the code
 * computes. The farm plan in farmSteps() is derived the same way: from the
 * protocol's category, chains, TVL and age, never from a list of names.
 *
 * Implied value, in words:
 *   fitted market cap x growth multiplier x maturity multiplier x chain multiplier
 * The fitted market cap comes from a least-squares line in logs,
 * ln(mcap) = intercept + slope x ln(TVL), fitted on the traded protocols,
 * plus one shrunk offset per category. See the Model view for the line,
 * the offsets and the table behind them.
 *
 * The model is tested blind in validateOutOfSample(), twice: the line
 * fitted on half the traded protocols, the other half predicted unseen,
 * then the halves swap, so every traded protocol is predicted exactly
 * once by a fit that never saw it. Every farm plan ends in a netted
 * verdict from verdictFor(): the low end of the comps band against the
 * plan's own gas and fees, FARM, THIN or SKIP.
 */
(function () {
  'use strict';

  var DAY_MS = 86400000;

  /* ---------- the model (mirrors lib/model.ts: same inputs, same math) ---------- */

  function finite(value, fallback) {
    return typeof value === 'number' && isFinite(value) ? value : fallback;
  }

  function ageDays(asOf, listedAt) {
    if (listedAt === null || listedAt === undefined) return null;
    var a = Date.parse(asOf + 'T00:00:00Z');
    var b = Date.parse(listedAt + 'T00:00:00Z');
    if (!isFinite(a) || !isFinite(b)) return null;
    return Math.max(0, Math.floor((a - b) / DAY_MS));
  }

  /* The implied value one protocol gets. Every factor is shown in its detail view. */
  function impliedValue(row, asOf, fit, model) {
    var age = ageDays(asOf, row.listed_at);
    var key = row.category === null || row.category === undefined ? '(uncategorised)' : row.category;
    var offset = fit.offsets[key] === undefined ? 0 : fit.offsets[key];
    var count = fit.counts[key] || 0;
    var tvl = Math.max(row.tvl_usd, 1);
    var fitted = Math.exp(fit.intercept + fit.slope * Math.log(tvl) + offset);
    var multiple = fitted / tvl;
    var rawGrowth = finite(row.change_7d, 0);
    var growthPct = Math.min(model.growth_cap, Math.max(model.growth_floor, rawGrowth));
    var growthMult = 1 + (growthPct / 100) * model.growth_weight;
    var ageForModel = age === null ? model.unknown_age_days : age;
    var maturityMult = model.maturity_floor +
      (Math.min(Math.max(ageForModel, 0), model.maturity_days) / model.maturity_days) * model.maturity_range;
    var extraChains = Math.min(Math.max(row.chains.length - 1, 0), model.chain_max_steps);
    var chainMult = 1 + extraChains * model.chain_step;
    var implied = Math.max(1, Math.round(fitted * growthMult * maturityMult * chainMult));
    return { implied: implied, fitted: fitted, multiple: multiple, offset: offset, compsCount: count, growthPct: growthPct,
      growthMult: growthMult, maturityMult: maturityMult, chainMult: chainMult, age: age };
  }

  function median(sorted) {
    var n = sorted.length;
    if (n === 0) return NaN;
    var mid = Math.floor(n / 2);
    return n % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  function quantile(sorted, q) {
    if (sorted.length === 0) return NaN;
    var pos = (sorted.length - 1) * q;
    var lo = Math.floor(pos);
    var hi = Math.ceil(pos);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
  }

  /* The line fitted on one list of traded protocols: least squares of
     ln(mcap) on ln(TVL), then one offset per category, the median of its
     residuals shrunk toward zero. Mirrors fitRegression() in
     lib/model.ts; the holdout fits it on half the traded protocols only.
     The list arrives pre-filtered: wrapped, staked and bridged products
     never calibrate the fit. */
  function fitRegression(list, model) {
    var usable = [], i, p;
    for (i = 0; i < list.length; i++) {
      p = list[i];
      if (p.mcap_usd > 0 && p.tvl_usd > 0) usable.push(p);
    }
    var n = usable.length;
    if (n === 0) return { intercept: Math.log(0.25), slope: 1, offsets: {}, counts: {}, fit_count: 0 };
    var sumX = 0, sumY = 0;
    for (i = 0; i < n; i++) { sumX += Math.log(usable[i].tvl_usd); sumY += Math.log(usable[i].mcap_usd); }
    var meanX = sumX / n, meanY = sumY / n;
    var sxy = 0, sxx = 0, dx;
    for (i = 0; i < n; i++) {
      dx = Math.log(usable[i].tvl_usd) - meanX;
      sxy += dx * (Math.log(usable[i].mcap_usd) - meanY);
      sxx += dx * dx;
    }
    var slope = sxx === 0 ? 0 : sxy / sxx;
    var intercept = meanY - slope * meanX;
    var byCategory = {}, key;
    for (i = 0; i < n; i++) {
      p = usable[i];
      var residual = Math.log(p.mcap_usd) - (intercept + slope * Math.log(p.tvl_usd));
      key = p.category === null || p.category === undefined ? '(uncategorised)' : p.category;
      if (!byCategory[key]) byCategory[key] = [];
      byCategory[key].push(residual);
    }
    var offsets = {}, counts = {};
    var keys = Object.keys(byCategory).sort();
    for (i = 0; i < keys.length; i++) {
      key = keys[i];
      var residuals = byCategory[key].sort(function (a, b) { return a - b; });
      offsets[key] = (residuals.length * median(residuals)) / (residuals.length + model.shrink_prior);
      counts[key] = residuals.length;
    }
    return { intercept: intercept, slope: slope, offsets: offsets, counts: counts, fit_count: n };
  }

  /* The residual band: per category, the 25th and 75th percentiles of the
     traded residuals from the fitted line, in log points, shrunk toward
     the global percentiles. Mirrors calibrateBands() in lib/model.ts. */
  function bandTable(list, fit, model) {
    var byCategory = {};
    var all = [];
    var i, p, residual, key;
    for (i = 0; i < list.length; i++) {
      p = list[i];
      if (!(p.mcap_usd > 0) || !(p.tvl_usd > 0)) continue;
      key = p.category === null || p.category === undefined ? '(uncategorised)' : p.category;
      residual = Math.log(p.mcap_usd) - (fit.intercept + fit.slope * Math.log(Math.max(p.tvl_usd, 1)) + (fit.offsets[key] === undefined ? 0 : fit.offsets[key]));
      if (!isFinite(residual)) continue;
      all.push(residual);
      if (!byCategory[key]) byCategory[key] = [];
      byCategory[key].push(residual);
    }
    all.sort(function (a, b) { return a - b; });
    var g25 = quantile(all, 0.25);
    var g75 = quantile(all, 0.75);
    var table = { by_category: {}, global: { low: isFinite(g25) ? Math.min(g25, 0) : 0, high: isFinite(g75) ? g75 : 0 }, global_count: all.length };
    var keys = Object.keys(byCategory).sort();
    for (i = 0; i < keys.length; i++) {
      key = keys[i];
      var residuals = byCategory[key].sort(function (a, b) { return a - b; });
      var low = (residuals.length * quantile(residuals, 0.25) + model.shrink_prior * g25) / (residuals.length + model.shrink_prior);
      var high = (residuals.length * quantile(residuals, 0.75) + model.shrink_prior * g75) / (residuals.length + model.shrink_prior);
      table.by_category[key] = { low: Math.min(low, 0), high: high, n: residuals.length };
    }
    return table;
  }

  /* The blind holdout, run both ways: traded protocols sorted by slug,
     split into alternating halves; the line fitted on one half only,
     the other half's market caps predicted with impliedValue() — then
     the halves swap, so every traded protocol is predicted exactly once.
     Mirrors validateOutOfSample() in lib/model.ts. */
  function validateOutOfSample(comps, asOf, model) {
    var sorted = comps.slice().sort(function (a, b) { return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0; });
    function runSplit(fit, test) {
      var fitLine = fitRegression(fit, model);
      var predictions = test.map(function (p) {
        var predicted = impliedValue(p, asOf, fitLine, model).implied;
        return { slug: p.slug, name: p.name, actual: p.mcap_usd, predicted: predicted, abs_error: Math.abs(predicted - p.mcap_usd) / p.mcap_usd };
      });
      predictions.sort(function (a, b) { return a.abs_error - b.abs_error || (a.slug < b.slug ? -1 : 1); });
      var errors = predictions.map(function (p) { return p.abs_error; }).sort(function (a, b) { return a - b; });
      var n = errors.length, within2 = 0, within3 = 0, i;
      for (i = 0; i < n; i++) { if (errors[i] <= 1) within2++; if (errors[i] <= 2) within3++; }
      return { fit_count: fit.length, test_count: test.length, median_abs_error: n === 0 ? NaN : median(errors),
        within_2x: n === 0 ? 0 : within2 / n, within_3x: n === 0 ? 0 : within3 / n, predictions: predictions };
    }
    var even = [], odd = [], i;
    for (i = 0; i < sorted.length; i++) { if (i % 2 === 0) even.push(sorted[i]); else odd.push(sorted[i]); }
    var splits = [runSplit(even, odd), runSplit(odd, even)];
    var pooledPredictions = splits[0].predictions.concat(splits[1].predictions).sort(
      function (a, b) { return a.abs_error - b.abs_error || (a.slug < b.slug ? -1 : 1); });
    var pooledErrors = pooledPredictions.map(function (p) { return p.abs_error; }).sort(function (a, b) { return a - b; });
    var n = pooledErrors.length, within2 = 0, within3 = 0;
    for (i = 0; i < n; i++) { if (pooledErrors[i] <= 1) within2++; if (pooledErrors[i] <= 2) within3++; }
    return { splits: splits, pooled: { count: n, median_abs_error: n === 0 ? NaN : median(pooledErrors),
      within_2x: n === 0 ? 0 : within2 / n, within_3x: n === 0 ? 0 : within3 / n, predictions: pooledPredictions } };
  }

  /* ---------- the farm plan (mirrors lib/model.ts: same steps, same costs) ---------- */

  function chainOf(row) {
    return row.chains.length > 0 ? row.chains[0] : 'its main chain';
  }

  function gasEstimate(chain) {
    var c = String(chain).toLowerCase();
    if (c.indexOf('ethereum') !== -1) return 'about $8 of gas';
    if (c.indexOf('solana') !== -1) return 'under $0.10 of gas';
    if (c.indexOf('arbitrum') !== -1 || c.indexOf('optimism') !== -1 || c.indexOf('base') !== -1 ||
        c.indexOf('zksync') !== -1 || c.indexOf('linea') !== -1 || c.indexOf('scroll') !== -1 ||
        c.indexOf('blast') !== -1 || c.indexOf('mode') !== -1) return 'under $1 of gas';
    if (c.indexOf('bsc') !== -1 || c.indexOf('bnb') !== -1) return 'about $0.50 of gas';
    if (c.indexOf('polygon') !== -1) return 'under $0.20 of gas';
    if (c.indexOf('avalanche') !== -1) return 'about $1 of gas';
    if (c.indexOf('sui') !== -1 || c.indexOf('aptos') !== -1 || c.indexOf('near') !== -1 || c.indexOf('sei') !== -1) return 'under $0.10 of gas';
    if (c.indexOf('bitcoin') !== -1 || c.indexOf('lightning') !== -1) return 'about $2 of fees';
    return 'about $2 of gas';
  }

  /* The same gas table as numbers: the stated ceiling of each estimate, for the netted verdict. */
  function gasUsd(chain) {
    var c = String(chain).toLowerCase();
    if (c.indexOf('ethereum') !== -1) return 8;
    if (c.indexOf('solana') !== -1) return 0.1;
    if (c.indexOf('arbitrum') !== -1 || c.indexOf('optimism') !== -1 || c.indexOf('base') !== -1 ||
        c.indexOf('zksync') !== -1 || c.indexOf('linea') !== -1 || c.indexOf('scroll') !== -1 ||
        c.indexOf('blast') !== -1 || c.indexOf('mode') !== -1) return 1;
    if (c.indexOf('bsc') !== -1 || c.indexOf('bnb') !== -1) return 0.5;
    if (c.indexOf('polygon') !== -1) return 0.2;
    if (c.indexOf('avalanche') !== -1) return 1;
    if (c.indexOf('sui') !== -1 || c.indexOf('aptos') !== -1 || c.indexOf('near') !== -1 || c.indexOf('sei') !== -1) return 0.1;
    if (c.indexOf('bitcoin') !== -1 || c.indexOf('lightning') !== -1) return 2;
    return 2;
  }

  /* The netted verdict. Mirrors verdictFor() in lib/model.ts: the protocol
     at the low end of its comps band, a stated share of a stated community
     allocation, against the plan's own gas and fees. */
  function verdictFor(row, v, bands, model) {
    var key = row.category === null || row.category === undefined ? '(uncategorised)' : row.category;
    var band = bands.by_category[key] !== undefined ? bands.by_category[key] : bands.global;
    var bandLow = Math.max(1, Math.round(v.fitted * Math.exp(band.low) * v.growthMult * v.maturityMult * v.chainMult));
    var prizeLow = (bandLow * model.farm_share) / model.farmers;
    var costUsd = gasUsd(chainOf(row)) * model.plan_txs + model.flat_cost_usd;
    var ratio = prizeLow / costUsd;
    return { verdict: ratio >= model.farm_ratio ? 'FARM' : ratio >= model.thin_ratio ? 'THIN' : 'SKIP',
      band_low: bandLow, prize_low: prizeLow, cost_usd: costUsd, ratio: ratio };
  }

  /* $1,234,567: whole dollars with separators, the same in the model and the page. */
  function intUsd(n) {
    return '$' + Math.round(n).toLocaleString('en-US');
  }

  /* $12,345.67: separators and two decimals, the same in the model and the page. */
  function money(n) {
    return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function capitalFor(row) {
    if (row.tvl_usd >= 5000000000) return 250;
    if (row.tvl_usd >= 1000000000) return 150;
    if (row.tvl_usd >= 100000000) return 100;
    return 50;
  }

  function holdDaysFor(age) {
    if (age === null) return 30;
    if (age < 180) return 60;
    if (age < 365) return 45;
    return 30;
  }

  function actionFor(row, capital, chain) {
    var c = String(row.category || '').toLowerCase();
    var name = row.name;
    if (c.indexOf('lend') !== -1 || c.indexOf('cdp') !== -1 || c.indexOf('collateral') !== -1) return 'Supply $' + capital + ' of USDC to ' + name + ' on ' + chain + ' as collateral and keep the position open.';
    if (c.indexOf('dex') !== -1 || c.indexOf('exchange') !== -1) return 'Provide $' + capital + ' of liquidity to ' + name + '\'s highest-volume pool on ' + chain + ' and keep the position open.';
    if (c.indexOf('yield') !== -1 || c.indexOf('leveraged farm') !== -1 || c.indexOf('farm') !== -1) return 'Deposit $' + capital + ' into ' + name + '\'s main yield vault on ' + chain + ' and keep the shares.';
    if (c.indexOf('bridge') !== -1 || c.indexOf('cross-chain') !== -1) return 'Bridge $' + capital + ' of USDC through ' + name + ' to ' + chain + ' and use the bridged funds in its app.';
    if (c.indexOf('liquid staking') !== -1 || c.indexOf('restak') !== -1 || c.indexOf('staking') !== -1) return 'Stake $' + capital + ' of the chain\'s staking asset through ' + name + ' on ' + chain + ' and keep the receipt token.';
    if (c.indexOf('perpetual') !== -1 || c.indexOf('derivative') !== -1 || c.indexOf('options') !== -1) return 'Deposit $' + capital + ' of USDC as margin on ' + name + ' on ' + chain + ' and open one small hedged position.';
    if (c.indexOf('prediction') !== -1) return 'Fund $' + capital + ' and place one small position on a ' + name + ' market on ' + chain + '.';
    if (c.indexOf('curator') !== -1 || c.indexOf('allocator') !== -1 || c.indexOf('index') !== -1) return 'Deposit $' + capital + ' into a ' + name + ' vault on ' + chain + ' and keep the shares.';
    if (c.indexOf('stable') !== -1) return 'Mint or deposit $' + capital + ' of the stable asset through ' + name + ' on ' + chain + ' and hold it.';
    if (c.indexOf('rwa') !== -1 || c.indexOf('real world') !== -1) return 'Mint $' + capital + ' of the protocol\'s yield-bearing asset on ' + chain + ' and hold it.';
    if (c.indexOf('insurance') !== -1) return 'Buy $' + capital + ' of cover from ' + name + ' on ' + chain + ' and keep the policy active.';
    if (c.indexOf('launchpad') !== -1 || c.indexOf('launch') !== -1) return 'Stake or hold $' + capital + ' through ' + name + '\'s launch allocation on ' + chain + ' and join one sale.';
    if (c.indexOf('ai') !== -1 || c.indexOf('compute') !== -1 || c.indexOf('depin') !== -1) return 'Run or rent $' + capital + ' of the resource ' + name + ' coordinates on ' + chain + ' and keep it online.';
    if (c.indexOf('gam') !== -1) return 'Fund $' + capital + ' into ' + name + '\'s game economy on ' + chain + ' and play one full session.';
    if (c.indexOf('nft') !== -1) return 'List or buy one ' + name + ' item on ' + chain + ' for about $' + capital + ' and hold it.';
    if (c.indexOf('privacy') !== -1 || c.indexOf('mixer') !== -1) return 'Route $' + capital + ' through ' + name + ' on ' + chain + ' in two separate transactions a week apart.';
    if (c.indexOf('social') !== -1) return 'Create a profile on ' + name + ', fund it with $' + capital + ' and post once a week.';
    return 'Deposit $' + capital + ' of USDC into ' + name + ' on ' + chain + ' and keep the position open.';
  }

  /* Eight steps, each an action with a cost and a time, from the row's own record. The eighth is the netted verdict. */
  function farmSteps(row, verdict, model) {
    var chain = chainOf(row);
    var capital = capitalFor(row);
    var hold = holdDaysFor(row.age_days);
    var gas = gasEstimate(chain);
    return [
      { text: 'Use a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline on paper.', cost: 'nothing to set up', time: '5 minutes' },
      { text: 'Fund the wallet with $' + capital + ' of USDC plus a little of ' + chain + '\'s gas token, from an exchange withdrawal or a bridge you already trust.', cost: gas + ' for the first transaction', time: '15 minutes' },
      { text: actionFor(row, capital, chain), cost: '$' + capital + ' of capital and ' + gas, time: '20 minutes to set up' },
      { text: 'Make one qualifying action each week, such as a deposit, a borrow, a swap or a vote, so the wallet stays active across snapshots.', cost: gas + ' a week', time: '10 minutes a week' },
      { text: 'Hold the position for at least ' + hold + ' days so the activity is counted in more than one snapshot window.', cost: 'the $' + capital + ' stays in the position', time: hold + ' days' },
      { text: 'Once a month, open the protocol\'s own points or rewards page from its official site and check the wallet\'s standing; claim only from links the protocol itself publishes.', cost: 'no fee to check, and never pay to claim', time: '10 minutes a month' },
      { text: 'Write the wallet, the dates and every transaction hash in a farm log, and plan the exit before you need it: note any unstaking delay or withdrawal fee.', cost: 'nothing but the log', time: '5 minutes' },
      { text: 'Verdict: ' + verdict.verdict + ' — at the low end of the comps band this protocol is worth ' + intUsd(verdict.band_low) + '; a ' + Math.round(model.farm_share * 100) + '% community allocation split among ' + model.farmers.toLocaleString('en-US') + ' farmers pays about ' + money(verdict.prize_low) + ' against about ' + money(verdict.cost_usd) + ' of gas and fees, a ' + verdict.ratio.toFixed(1) + 'x return on cost.', cost: 'counted in the verdict', time: 'decided before you start' }
    ];
  }

  function stepText(step) {
    var s = step.text + ' Cost: ' + step.cost + '. Time: ' + step.time + '.';
    if (s.length > 600) s = s.slice(0, 596) + '...';
    if (s.length < 20) s += ' Hold the position and check the protocol\'s own page.';
    return s;
  }

  /* ---------- formatting ---------- */

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function usd(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    var abs = Math.abs(n);
    if (abs >= 1e12) return '$' + (n / 1e12).toFixed(2) + 'T';
    if (abs >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (abs >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (abs >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
    return '$' + Math.round(n);
  }

  function pct(v) {
    if (v === null || v === undefined || !isFinite(v)) return 'n/a';
    var sign = v > 0 ? '+' : '';
    var digits = Math.abs(v) < 1 ? 2 : 1;
    return sign + v.toFixed(digits) + '%';
  }

  function pctPlain(v) {
    if (v === null || v === undefined || !isFinite(v)) return 'n/a';
    return v.toFixed(1) + '%';
  }

  function pctClass(v) {
    if (v === null || v === undefined || !isFinite(v) || v === 0) return 'flat';
    return v > 0 ? 'up' : 'down';
  }

  function mult4(n) {
    return (Math.round(n * 1e4) / 1e4).toFixed(4);
  }

  /* Expose the pure functions for the offline agreement check (node). */
  var api = { impliedValue: impliedValue, farmSteps: farmSteps, stepText: stepText, ageDays: ageDays,
    verdictFor: verdictFor, bandTable: bandTable, validateOutOfSample: validateOutOfSample,
    fitRegression: fitRegression, gasUsd: gasUsd };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;

  /* ---------- the page (browser only) ---------- */
  if (typeof document === 'undefined') return;

  var R = window.RADAR;
  var rows = R.rows.slice();
  var bySlug = {};
  rows.forEach(function (r) { bySlug[r.slug] = r; });
  var watchSet = {};
  (R.watchlist || []).forEach(function (s) { watchSet[s] = true; });

  /* The page re-derives the bands, the holdout and every verdict from the
     raw records in data.js, with the same functions the model ran: what
     the screenshots show is what this source computes. */
  var bands = bandTable(R.comp_protocols, R.regression, R.model);
  var validation = validateOutOfSample(R.comp_protocols, R.as_of, R.model);
  var farmCount = 0, thinCount = 0, skipCount = 0;
  rows.forEach(function (r) {
    var v = impliedValue(r, R.as_of, R.regression, R.model);
    r.verdict = verdictFor(r, v, bands, R.model);
    r.verdict_rank = r.verdict.verdict === 'FARM' ? 0 : r.verdict.verdict === 'THIN' ? 1 : 2;
    if (r.verdict.verdict === 'FARM') farmCount++;
    else if (r.verdict.verdict === 'THIN') thinCount++;
    else skipCount++;
  });

  var state = {
    view: 'board',
    detail: null,
    query: '',
    category: '',
    chain: '',
    verdict: '',
    watchOnly: false,
    minTvl: 0,
    sortKey: 'rank',
    sortDir: 1
  };

  function isWatchlisted(row) {
    return !!watchSet[row.slug];
  }

  function filtered() {
    var q = state.query.trim().toLowerCase();
    var out = rows.filter(function (r) {
      if (q && (r.name.toLowerCase().indexOf(q) === -1 && r.slug.indexOf(q) === -1 && String(r.category || '').toLowerCase().indexOf(q) === -1)) return false;
      if (state.category && r.category !== state.category) return false;
      if (state.chain && r.chains.indexOf(state.chain) === -1) return false;
      if (state.verdict && r.verdict.verdict !== state.verdict) return false;
      if (state.watchOnly && !isWatchlisted(r)) return false;
      if (r.tvl_usd < state.minTvl) return false;
      return true;
    });
    var k = state.sortKey;
    var d = state.sortDir;
    out.sort(function (a, b) {
      var va = a[k], vb = b[k];
      if (va === null || va === undefined) return 1;
      if (vb === null || vb === undefined) return -1;
      if (typeof va === 'string') return va.localeCompare(vb) * d;
      if (va !== vb) return (va - vb) * d;
      return a.rank - b.rank;
    });
    return out;
  }

  function renderStats() {
    var el = document.getElementById('stats');
    el.innerHTML =
      stat(R.board_size, 'protocols ranked') +
      stat(R.watchlist_size, 'watchlist covered') +
      stat(R.early_size, 'early finds below the floor') +
      stat(farmCount, 'rows net a FARM verdict') +
      stat(R.live_size, 'live tokens set aside') +
      stat(usd(maxTvl()), 'largest TVL on the board');
    document.getElementById('asof').textContent = R.as_of;
  }

  function stat(value, label) {
    return '<div class="stat"><b>' + esc(value) + '</b><span>' + esc(label) + '</span></div>';
  }

  function maxTvl() {
    var m = 0;
    rows.forEach(function (r) { if (r.tvl_usd > m) m = r.tvl_usd; });
    return m;
  }

  function renderControls() {
    var el = document.getElementById('controls');
    var cats = {}, chains = {};
    rows.forEach(function (r) {
      if (r.category) cats[r.category] = true;
      r.chains.forEach(function (c) { chains[c] = true; });
    });
    var catOpts = Object.keys(cats).sort().map(function (c) {
      return '<option value="' + esc(c) + '"' + (state.category === c ? ' selected' : '') + '>' + esc(c) + '</option>';
    }).join('');
    var chainOpts = Object.keys(chains).sort().map(function (c) {
      return '<option value="' + esc(c) + '"' + (state.chain === c ? ' selected' : '') + '>' + esc(c) + '</option>';
    }).join('');
    el.innerHTML =
      '<label class="field">Search<input id="f-q" type="search" value="' + esc(state.query) + '" placeholder="Name, slug or category"></label>' +
      '<label class="field">Category<select id="f-cat"><option value="">All categories</option>' + catOpts + '</select></label>' +
      '<label class="field">Chain<select id="f-chain"><option value="">All chains</option>' + chainOpts + '</select></label>' +
      '<label class="field">Min TVL<select id="f-tvl">' +
      '<option value="0"' + (state.minTvl === 0 ? ' selected' : '') + '>Any TVL</option>' +
      '<option value="50000000"' + (state.minTvl === 50000000 ? ' selected' : '') + '>$50M+</option>' +
      '<option value="100000000"' + (state.minTvl === 100000000 ? ' selected' : '') + '>$100M+</option>' +
      '<option value="500000000"' + (state.minTvl === 500000000 ? ' selected' : '') + '>$500M+</option>' +
      '<option value="1000000000"' + (state.minTvl === 1000000000 ? ' selected' : '') + '>$1B+</option></select></label>' +
      '<label class="field">Verdict<select id="f-verdict">' +
      '<option value=""' + (state.verdict === '' ? ' selected' : '') + '>All verdicts</option>' +
      '<option value="FARM"' + (state.verdict === 'FARM' ? ' selected' : '') + '>FARM (' + farmCount + ')</option>' +
      '<option value="THIN"' + (state.verdict === 'THIN' ? ' selected' : '') + '>THIN (' + thinCount + ')</option>' +
      '<option value="SKIP"' + (state.verdict === 'SKIP' ? ' selected' : '') + '>SKIP (' + skipCount + ')</option></select></label>' +
      '<label class="field check"><input id="f-watch" type="checkbox"' + (state.watchOnly ? ' checked' : '') + '> Watchlist only</label>' +
      '<span class="count" id="f-count"></span>';
    document.getElementById('f-q').addEventListener('input', function (e) { state.query = e.target.value; renderView(); });
    document.getElementById('f-cat').addEventListener('change', function (e) { state.category = e.target.value; renderView(); });
    document.getElementById('f-chain').addEventListener('change', function (e) { state.chain = e.target.value; renderView(); });
    document.getElementById('f-tvl').addEventListener('change', function (e) { state.minTvl = Number(e.target.value); renderView(); });
    document.getElementById('f-verdict').addEventListener('change', function (e) { state.verdict = e.target.value; renderView(); });
    document.getElementById('f-watch').addEventListener('change', function (e) { state.watchOnly = e.target.checked; renderView(); });
  }

  function sortArrow(key) {
    if (state.sortKey !== key) return '';
    return state.sortDir === 1 ? ' ▲' : ' ▼';
  }

  function boardHtml(list) {
    if (list.length === 0) return '<p class="empty">No protocol matches these filters.</p>';
    var head = '<table><thead><tr>' +
      '<th class="sortable" data-sort="rank">Rank' + sortArrow('rank') + '</th>' +
      '<th class="sortable" data-sort="name">Protocol' + sortArrow('name') + '</th>' +
      '<th class="num sortable" data-sort="tvl_usd">TVL' + sortArrow('tvl_usd') + '</th>' +
      '<th class="num sortable" data-sort="change_7d">7d' + sortArrow('change_7d') + '</th>' +
      '<th class="num sortable" data-sort="implied_value_usd">Implied value' + sortArrow('implied_value_usd') + '</th>' +
      '<th class="num sortable" data-sort="fitted_multiple">Multiple' + sortArrow('fitted_multiple') + '</th>' +
      '<th class="sortable" data-sort="verdict_rank">Verdict' + sortArrow('verdict_rank') + '</th>' +
      '</tr></thead><tbody>';
    var body = list.map(function (r) {
      return '<tr data-slug="' + esc(r.slug) + '" tabindex="0">' +
        '<td><span class="rank' + (r.rank <= 3 ? ' top' : '') + '">' + r.rank + '</span></td>' +
        '<td><span class="name">' + esc(r.name) + '</span>' + (isWatchlisted(r) ? '<span class="badge">Watchlist</span>' : '') +
        '<div class="sub">' + esc(r.category || 'Uncategorised') + ' · ' + esc(r.chains.slice(0, 3).join(', ')) + (r.chains.length > 3 ? ' +' + (r.chains.length - 3) : '') + '</div></td>' +
        '<td class="num">' + usd(r.tvl_usd) + '</td>' +
        '<td class="num ' + pctClass(r.change_7d) + '">' + pct(r.change_7d) + '</td>' +
        '<td class="num"><b>' + usd(r.implied_value_usd) + '</b></td>' +
        '<td class="num">' + mult4(r.fitted_multiple) + '×</td>' +
        '<td><span class="verdict ' + r.verdict.verdict.toLowerCase() + '">' + r.verdict.verdict + '</span></td>' +
        '</tr>';
    }).join('');
    return head + body + '</tbody></table>';
  }

  function detailHtml(row) {
    var v = impliedValue(row, R.as_of, R.regression, R.model);
    var steps = farmSteps(row, row.verdict, R.model).map(function (s) {
      return '<li>' + esc(s.text) + ' <span class="cost">Cost: ' + esc(s.cost) + '. Time: ' + esc(s.time) + '.</span></li>';
    }).join('');
    var listed = row.listed_at || 'unknown';
    var age = v.age === null ? 'unknown' : v.age + ' days';
    return '<article class="detail">' +
      '<button type="button" class="back" id="back">← Back to the board</button>' +
      '<h2>' + esc(row.name) + (isWatchlisted(row) ? '<span class="badge">Watchlist</span>' : '<span class="badge">Early find</span>') + '<span class="verdict ' + row.verdict.verdict.toLowerCase() + '">' + row.verdict.verdict + '</span></h2>' +
      '<p class="meta">Rank #' + row.rank + ' · ' + esc(row.category || 'Uncategorised') + ' · ' + esc(row.chains.join(', ')) +
      ' · tracked since ' + esc(listed) + ' (' + esc(age) + ') · records no token</p>' +
      '<div class="grid">' +
      '<div class="cell"><span>Implied value</span><b>' + usd(row.implied_value_usd) + '</b></div>' +
      '<div class="cell"><span>TVL</span><b>' + usd(row.tvl_usd) + '</b></div>' +
      '<div class="cell"><span>7-day TVL change</span><b class="' + pctClass(row.change_7d) + '">' + pct(row.change_7d) + '</b></div>' +
      '<div class="cell"><span>Fitted multiple</span><b>' + mult4(v.multiple) + '×</b></div>' +
      '<div class="cell"><span>Traded comps</span><b>' + v.compsCount + '</b></div>' +
      '<div class="cell"><span>Chains</span><b>' + row.chains.length + '</b></div>' +
      '</div>' +
      '<h3>How the value is derived</h3>' +
      '<table class="breakdown"><tbody>' +
      '<tr><td>Fitted market cap (regression line + ' + esc(row.category || 'uncategorised') + ' offset ' + mult4(Math.exp(v.offset)) + '×, from ' + v.compsCount + ' traded peer' + (v.compsCount === 1 ? '' : 's') + ')</td><td>' + usd(v.fitted) + '</td></tr>' +
      '<tr><td>× growth multiplier (' + pct(v.growthPct) + ' over 7 days)</td><td>' + mult4(v.growthMult) + '×</td></tr>' +
      '<tr><td>× maturity multiplier (' + esc(age) + ' with no token)</td><td>' + mult4(v.maturityMult) + '×</td></tr>' +
      '<tr><td>× chain-reach multiplier (' + row.chains.length + ' chain' + (row.chains.length === 1 ? '' : 's') + ')</td><td>' + mult4(v.chainMult) + '×</td></tr>' +
      '<tr><td><b>Implied value</b></td><td><b>' + usd(row.implied_value_usd) + '</b></td></tr>' +
      '</tbody></table>' +
      '<p class="sub">Multipliers shown rounded to 4 places; the model is impliedValue() in this page\'s source.</p>' +
      '<h3>Netted verdict: ' + row.verdict.verdict + '</h3>' +
      '<div class="grid">' +
      '<div class="cell"><span>Low end of the band</span><b>' + usd(row.verdict.band_low) + '</b></div>' +
      '<div class="cell"><span>Expected take, low end</span><b>' + money(row.verdict.prize_low) + '</b></div>' +
      '<div class="cell"><span>Gas and fees</span><b>' + money(row.verdict.cost_usd) + '</b></div>' +
      '<div class="cell"><span>Return on cost</span><b>' + row.verdict.ratio.toFixed(1) + '×</b></div>' +
      '</div>' +
      '<p class="sub">Assumes a ' + Math.round(R.model.farm_share * 100) + '% community allocation split among ' + R.model.farmers.toLocaleString('en-US') + ' farmers, against ' + R.model.plan_txs + ' transactions plus $' + R.model.flat_cost_usd + ' of fees. FARM clears the cost ' + R.model.farm_ratio + '×, THIN ' + R.model.thin_ratio + '×. The verdict is verdictFor() in this page\'s source.</p>' +
      '<h3>Farm plan</h3>' +
      '<ol class="steps">' + steps + '</ol>' +
      '<p class="note">This protocol records no token in the snapshot. That is the record, not proof: it may still have one the record does not carry. Farm only what you can afford to lose, and claim only from links the protocol itself publishes.</p>' +
      '</article>';
  }

  function liveHtml() {
    var body = R.live.map(function (p) {
      var ratio = (p.mcap_usd !== null && p.tvl_usd > 0) ? (p.mcap_usd / p.tvl_usd) : null;
      return '<tr>' +
        '<td><span class="name">' + esc(p.name) + '</span><div class="sub">' + esc(p.category || 'Uncategorised') + '</div></td>' +
        '<td class="num">' + usd(p.tvl_usd) + '</td>' +
        '<td class="num">' + usd(p.mcap_usd) + '</td>' +
        '<td class="num">' + (ratio === null ? 'n/a' : mult4(ratio) + '×') + '</td>' +
        '<td class="num ' + pctClass(p.change_7d) + '">' + pct(p.change_7d) + '</td></tr>';
    }).join('');
    return '<p class="note">These protocols already trade, so the board shows the market\'s own value for them and never mixes them into the ranking. Their market-cap/TVL ratios are the comps that calibrate every implied value on the board.</p>' +
      '<table><thead><tr><th>Protocol</th><th class="num">TVL</th><th class="num">Market cap</th><th class="num">Mcap / TVL</th><th class="num">7d</th></tr></thead><tbody>' + body + '</tbody></table>';
  }

  function validationHtml() {
    var pooled = validation.pooled;
    var best = pooled.predictions.slice(0, 5);
    var worst = pooled.predictions.slice(-5).reverse();
    function predRows(list) {
      return list.map(function (p) {
        return '<tr><td><span class="name">' + esc(p.name) + '</span><div class="sub">' + esc(p.slug) + '</div></td>' +
          '<td class="num">' + usd(p.actual) + '</td><td class="num">' + usd(p.predicted) + '</td>' +
          '<td class="num">' + pctPlain(p.abs_error * 100) + '</td></tr>';
      }).join('');
    }
    var splitRows = validation.splits.map(function (s, i) {
      return '<tr><td>' + (i === 0 ? 'A: fitted on even slugs' : 'B: fitted on odd slugs') + '</td>' +
        '<td class="num">' + s.fit_count + '</td><td class="num">' + s.test_count + '</td>' +
        '<td class="num">' + pctPlain(s.median_abs_error * 100) + '</td>' +
        '<td class="num">' + pctPlain(s.within_2x * 100) + '</td>' +
        '<td class="num">' + pctPlain(s.within_3x * 100) + '</td></tr>';
    }).join('');
    return '<article class="detail"><h2>Validation: tested blind</h2>' +
      '<p class="meta">The regression is fitted on one half of the traded protocols and tested on the other half, which calibration never sees — then the halves swap, so every traded protocol is predicted exactly once by a fit that never saw it. The split is every second protocol in slug order, so anyone can reproduce it.</p>' +
      '<div class="grid">' +
      '<div class="cell"><span>Predicted blind</span><b>' + pooled.count + ' traded protocols</b></div>' +
      '<div class="cell"><span>Median miss</span><b>' + pctPlain(pooled.median_abs_error * 100) + '</b></div>' +
      '<div class="cell"><span>Within 2× of the market cap</span><b>' + pctPlain(pooled.within_2x * 100) + '</b></div>' +
      '<div class="cell"><span>Within 3×</span><b>' + pctPlain(pooled.within_3x * 100) + '</b></div>' +
      '</div>' +
      '<h3>Both directions</h3>' +
      '<table><thead><tr><th>Split</th><th class="num">Fitted on</th><th class="num">Tested on</th><th class="num">Median miss</th><th class="num">Within 2×</th><th class="num">Within 3×</th></tr></thead><tbody>' + splitRows + '</tbody></table>' +
      '<p class="sub">A fitted line is a rough instrument: the median unseen protocol is missed by about ' + pctPlain(pooled.median_abs_error * 100) + '. The board ranks by the same fitted line, so read the ranks as bands, not prices. The holdout is validateOutOfSample() in this page\'s source.</p>' +
      '<h3>Closest predictions</h3>' +
      '<table><thead><tr><th>Protocol</th><th class="num">Market cap</th><th class="num">Predicted</th><th class="num">Miss</th></tr></thead><tbody>' + predRows(best) + '</tbody></table>' +
      '<h3>Furthest predictions</h3>' +
      '<table><thead><tr><th>Protocol</th><th class="num">Market cap</th><th class="num">Predicted</th><th class="num">Miss</th></tr></thead><tbody>' + predRows(worst) + '</tbody></table></article>';
  }

  function modelHtml() {
    var m = R.model;
    var reg = R.regression;
    var offsets = Object.keys(reg.offsets).map(function (k) {
      return { cat: k, off: reg.offsets[k], n: reg.counts[k] || 0 };
    }).sort(function (a, b) { return b.off - a.off || a.cat.localeCompare(b.cat); });
    var offsetRows = offsets.map(function (c) {
      return '<tr><td>' + esc(c.cat) + '</td><td class="num">' + mult4(Math.exp(c.off)) + '×</td><td class="num">' + c.n + '</td></tr>';
    }).join('');
    return '<article class="detail"><h2>The model: ' + esc(R.model_version) + '</h2>' +
      '<p class="meta">One function scores every row. No protocol name is special-cased.</p>' +
      '<div class="formula">implied = exp(intercept + slope × ln(TVL) + offset) × growthMult × maturityMult × chainMult</div>' +
      '<h3>The fitted line</h3>' +
      '<p>Market cap grows slower than TVL, so the model is a least-squares line in logs: ln(market cap) = ' + reg.intercept.toFixed(4) + ' + ' + reg.slope.toFixed(4) + ' × ln(TVL), fitted on ' + reg.fit_count + ' traded protocols. ' +
      'A slope below 1 means a protocol ten times larger is worth about ' + Math.pow(10, reg.slope).toFixed(1) + '× as much, not 10×. ' +
      'Each category then gets an offset: the median of its residuals from the line, shrunk toward zero with a prior weight of ' + m.shrink_prior + ', so a category with one or two traded peers cannot set an extreme price. Categories with no traded peers use the line alone. ' +
      'The verdicts price each protocol at the low end of its residual band: the fitted value times the 25th percentile of its category\'s residuals from the line, shrunk toward the global 25th percentile, so the conservative case always sits below the fitted value. ' +
      'Wrapped, staked and bridged products never calibrate ' +
      'the fit: their ratios are the tokens they wrap, not peer values, so the fit counts ' + reg.fit_count + ' traded protocols, ' +
      'not every token that trades.</p>' +
      '<h3>Growth, maturity, reach</h3>' +
      '<p>Growth: the 7-day TVL change, clamped to ' + m.growth_floor + '%–' + m.growth_cap + '%, moves the value with weight ' + m.growth_weight + '. ' +
      'Maturity: ' + m.maturity_floor + ' plus up to ' + m.maturity_range + ' over ' + m.maturity_days + ' days of running with no token ' +
      '(unknown age counts as ' + m.unknown_age_days + ' days). Reach: +' + (m.chain_step * 100) + '% per extra chain, up to ' + m.chain_max_steps + '.</p>' +
      '<h3>What is never ranked early</h3>' +
      '<p>Wrapped, staked and bridged products of tokens that already trade are kept out of the early set and out of the comps by the house\'s own watchlist rule: ' +
      'bridge, liquid staking and restaking categories, wrapped/staked names, version markers and exchange names. Every watchlist slug is always ranked.</p>' +
      '<h3>Tested blind</h3>' +
      '<p>The regression is fitted twice: once on each half of the traded protocols, each half tested by a fit that never saw it, so all ' + validation.pooled.count + ' traded protocols are predicted blind. Median miss ' + pctPlain(validation.pooled.median_abs_error * 100) + ', ' + pctPlain(validation.pooled.within_2x * 100) + ' within 2× of the market cap. See the Validation view for the method and every prediction.</p>' +
      '<h3>Category offsets</h3>' +
      '<table><thead><tr><th>Category</th><th class="num">Offset, as a multiplier</th><th class="num">Traded peers</th></tr></thead><tbody>' +
      offsetRows +
      '</tbody></table></article>';
  }

  function renderView() {
    var view = document.getElementById('view');
    var controls = document.getElementById('controls');
    document.querySelectorAll('.tabs button').forEach(function (b) {
      if (b.getAttribute('data-view') === state.view && !state.detail) b.setAttribute('aria-current', 'page');
      else b.removeAttribute('aria-current');
    });
    if (state.detail && bySlug[state.detail]) {
      controls.style.display = 'none';
      view.innerHTML = detailHtml(bySlug[state.detail]);
      document.getElementById('back').addEventListener('click', function () { location.hash = '#board'; });
      return;
    }
    controls.style.display = state.view === 'board' ? '' : 'none';
    if (state.view === 'live') {
      view.innerHTML = liveHtml();
    } else if (state.view === 'model') {
      view.innerHTML = modelHtml();
    } else if (state.view === 'validation') {
      view.innerHTML = validationHtml();
    } else {
      var list = filtered();
      view.innerHTML = boardHtml(list);
      var count = document.getElementById('f-count');
      if (count) count.textContent = 'Showing ' + list.length + ' of ' + rows.length;
      view.querySelectorAll('th.sortable').forEach(function (th) {
        th.addEventListener('click', function () {
          var k = th.getAttribute('data-sort');
          if (state.sortKey === k) state.sortDir = -state.sortDir;
          else { state.sortKey = k; state.sortDir = (k === 'name') ? 1 : -1; }
          renderView();
        });
      });
      view.querySelectorAll('tbody tr').forEach(function (tr) {
        var open = function () { location.hash = '#detail/' + tr.getAttribute('data-slug'); };
        tr.addEventListener('click', open);
        tr.addEventListener('keydown', function (e) { if (e.key === 'Enter') open(); });
      });
    }
  }

  function route() {
    var h = location.hash || '#board';
    var dm = h.match(/^#detail\/(.+)$/);
    if (dm) {
      state.detail = decodeURIComponent(dm[1]);
      state.view = 'board';
    } else {
      state.detail = null;
      state.view = (h === '#live' || h === '#model' || h === '#validation') ? h.slice(1) : 'board';
    }
    renderView();
  }

  document.querySelectorAll('.tabs button').forEach(function (b) {
    b.addEventListener('click', function () { location.hash = '#' + b.getAttribute('data-view'); });
  });
  window.addEventListener('hashchange', route);

  renderStats();
  renderControls();
  route();
})();
