// emBET fair-close collector.
//
// Runs from the 5-minute GitHub Actions trigger. For every tracked record whose
// game starts soon, it asks the embet-data Worker for Pinnacle's current price
// and the record's own book, strips the margin (Shin's method, same as the app),
// and stores the result. The last observation before kickoff is the "fair
// close". The app then scores each pick's entry price against it:
//
//   fair-close CLV = Pinnacle no-vig close probability − entry implied probability
//
// Same-book CLV (what the app measured before) says the book moved toward you.
// Fair-close CLV says whether the price you took was better than the market's
// own final, margin-free estimate. Only the second one establishes an edge.
//
// Output: fairclose.json on the `data` branch. Record ids and prices only — no
// team names, no game ids — because this repository is public.
//
// Usage: node scripts/fair-close.mjs <path-to-fairclose.json>
// Env:   WORKER_URL, SYNC_SECRET

import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const WORKER = process.env.WORKER_URL || 'https://embet-data.bradpeds76.workers.dev';
const SECRET = process.env.SYNC_SECRET;
const OUT = process.argv[2] || 'fairclose.json';

// First look when a game is this close to starting, then one refresh once it is
// inside the final window. Two fetches per sport per kickoff cluster at most.
const FIRST_MS = 30 * 60 * 1000;
const FINAL_MS = 12 * 60 * 1000;
// Leave this many Odds API requests for the Worker's own close capture.
const BUDGET_RESERVE = 30;

const MKT_KEY = { ML: 'h2h', Spread: 'spreads', Total: 'totals' };
const BOOK_KEY = {
  betrivers: 'betrivers', draftkings: 'draftkings', fanduel: 'fanduel',
  betmgm: 'betmgm', caesars: 'williamhill_us', williamhill_us: 'williamhill_us',
  pointsbetus: 'pointsbetus', pinnacle: 'pinnacle'
};
const bookKeyOf = title => BOOK_KEY[String(title || '').toLowerCase().replace(/\s+/g, '')] || null;

const iP = o => o < 0 ? -o / (-o + 100) : 100 / (o + 100);

// Shin's method for any number of outcomes. With two outcomes this matches the
// app's shinProb(). Falls back to proportional if the book has no margin.
export function shinFair(prices) {
  const q = prices.map(iP);
  const Q = q.reduce((a, b) => a + b, 0);
  if (!(Q > 1)) return q.map(x => x / Q);
  const pAt = (z, qi) => (Math.sqrt(z * z + 4 * (1 - z) * qi * qi / Q) - z) / (2 * (1 - z));
  const f = z => q.reduce((s, qi) => s + pAt(z, qi), 0) - 1;
  let lo = 0, hi = 0.999999, flo = f(lo);
  if (flo <= 0 || flo * f(hi) > 0) return q.map(x => x / Q);
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2, fm = f(mid);
    if ((flo > 0) === (fm > 0)) { lo = mid; flo = fm; } else { hi = mid; }
  }
  const z = (lo + hi) / 2;
  const p = q.map(qi => pAt(z, qi));
  const t = p.reduce((a, b) => a + b, 0);
  return p.map(x => x / t);
}

// "Team (+1.5)" → {name:'Team', point:1.5}; "Over (+8.5)" → {name:'Over', point:8.5}
export function parseBet(mkt, bet) {
  if (mkt === 'ML') return { name: String(bet).trim(), point: null };
  const m = String(bet).match(/^(.*?)\s*\(([+-]?\d+(?:\.\d+)?)\)\s*$/);
  if (!m) return null;
  return { name: m[1].trim(), point: Number(m[2]) };
}

// Fair probability of one selection in one book's market, plus that book's price.
export function fairFor(bookmaker, mktKey, sel) {
  const market = bookmaker?.markets?.find(m => m.key === mktKey);
  if (!market?.outcomes?.length) return { status: 'no-market' };
  const same = o => o.name === sel.name && (sel.point == null || Number(o.point) === sel.point);
  const idx = market.outcomes.findIndex(same);
  if (idx < 0) {
    const moved = market.outcomes.find(o => o.name === sel.name);
    return { status: 'point-moved', point: moved?.point ?? null };
  }
  let outcomes = market.outcomes;
  if (mktKey !== 'h2h') {
    // Two-sided at the same number: the matching opposite selection.
    const o = market.outcomes[idx];
    const opp = market.outcomes.filter((x, i) => i !== idx &&
      (mktKey === 'totals' ? Number(x.point) === Number(o.point) : Number(x.point) === -Number(o.point)));
    if (opp.length !== 1) return { status: 'one-sided' };
    outcomes = [o, opp[0]];
  }
  if (outcomes.some(o => !Number.isFinite(o.price) || Math.abs(o.price) < 100)) return { status: 'bad-price' };
  const fair = shinFair(outcomes.map(o => o.price));
  const at = outcomes.indexOf(market.outcomes[idx]);
  return { status: 'ok', fair: fair[at], price: market.outcomes[idx].price, quoteAt: market.last_update || bookmaker.last_update || null };
}

async function api(path) {
  const r = await fetch(WORKER + path, { headers: { authorization: 'Bearer ' + SECRET } });
  if (!r.ok) throw new Error(`${path} → ${r.status} ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

const r4 = x => Math.round(x * 1e6) / 1e6;

async function main() {
  if (!SECRET) throw new Error('SYNC_SECRET is not set');
  const store = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : { version: 1, entries: {} };
  store.entries ||= {};
  const now = Date.now();

  const state = await api('/api/state?since=0');
  const due = (state.records || []).filter(r => {
    if (r.deleted || !r.gameId || !r.sportKey || !MKT_KEY[r.mkt]) return false;
    const ms = Date.parse(r.commenceTime) - now;
    if (!(ms > 0 && ms <= FIRST_MS)) return false;
    const prev = store.entries[r.id];
    if (!prev) return true;
    // One refresh inside the final window, from whichever earlier look we had.
    return ms <= FINAL_MS && prev.msToStart > FINAL_MS;
  });

  if (!due.length) { console.log('fair-close: nothing due'); return; }

  const health = await api('/api/health');
  const used = health.oddsUsageToday?.requests ?? 0, cap = health.dailyCap ?? 200;
  const bySport = new Map();
  for (const r of due) (bySport.get(r.sportKey) || bySport.set(r.sportKey, []).get(r.sportKey)).push(r);
  if (used + bySport.size > cap - BUDGET_RESERVE) {
    // Count skipped games once per record, so the app can say how many were
    // lost to the budget (and the file only changes when something new is lost).
    store.budgetSkipped ||= {};
    let fresh = 0;
    for (const r of due) if (!store.budgetSkipped[r.id] && !store.entries[r.id]) { store.budgetSkipped[r.id] = 1; fresh++; }
    console.log(`fair-close: skipped, odds budget ${used}/${cap} (reserve ${BUDGET_RESERVE}), ${fresh} newly lost`);
    if (fresh) writeFileSync(OUT, JSON.stringify(store));
    return;
  }

  let written = 0;
  for (const [sport, recs] of bySport) {
    const eventIds = [...new Set(recs.map(r => r.gameId))];
    const markets = [...new Set(recs.map(r => MKT_KEY[r.mkt]))];
    const books = [...new Set(['pinnacle', ...recs.map(r => bookKeyOf(r.book)).filter(Boolean)])];
    const qs = new URLSearchParams({ sport, eventIds: eventIds.join(','), markets: markets.join(','), bookmakers: books.join(',') });
    let events;
    try { events = await api('/api/odds/events?' + qs); }
    catch (e) { console.log(`fair-close: ${sport} fetch failed: ${e.message}`); continue; }
    const observedAt = new Date().toISOString();
    const byId = new Map((events || []).map(e => [e.id, e]));

    for (const r of recs) {
      const msToStart = Date.parse(r.commenceTime) - Date.parse(observedAt);
      if (msToStart <= 0) continue;
      const ev = byId.get(r.gameId);
      const sel = parseBet(r.mkt, r.bet);
      const entry = { observedAt, msToStart };
      if (!ev) entry.status = 'event-missing';
      else if (!sel) entry.status = 'unparsed';
      else {
        const mk = MKT_KEY[r.mkt];
        const pin = fairFor(ev.bookmakers?.find(b => b.key === 'pinnacle'), mk, sel);
        const bk = bookKeyOf(r.book);
        const own = fairFor(ev.bookmakers?.find(b => b.key === bk || b.title === r.book), mk, sel);
        entry.status = pin.status === 'ok' ? 'ok' : 'pin-' + pin.status;
        if (pin.status === 'ok') { entry.pinFair = r4(pin.fair); entry.pinPrice = pin.price; entry.pinQuoteAt = pin.quoteAt; }
        if (pin.status === 'point-moved') entry.pinPoint = pin.point;
        if (own.status === 'ok') { entry.bookFair = r4(own.fair); entry.bookPrice = own.price; }
      }
      const prev = store.entries[r.id];
      // A later failure never replaces an earlier good observation.
      if (prev?.status === 'ok' && entry.status !== 'ok') continue;
      store.entries[r.id] = entry;
      if (store.budgetSkipped) delete store.budgetSkipped[r.id];
      written++;
    }
  }
  store.updatedAt = new Date().toISOString();
  writeFileSync(OUT, JSON.stringify(store));
  console.log(`fair-close: ${due.length} due across ${bySport.size} sport(s), ${written} written`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(e => { console.error('fair-close failed:', e.message); process.exit(1); });
}
