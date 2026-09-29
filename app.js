"use strict";

/* ---------- Comparison operators allowed in achievements.csv ---------- */
const OPS = {
  ">=": (a, b) => a >= b,
  "<=": (a, b) => a <= b,
  ">": (a, b) => a > b,
  "<": (a, b) => a < b,
  "==": (a, b) => a === b,
  "!=": (a, b) => a !== b,
};

/* ---------- CSV reader (handles "quoted, values") ---------- */
function parseCSV(text) {
  text = text.replace(/^\uFEFF/, "");
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = ""; rows.push(row); row = [];
    } else field += c;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  const filled = rows.filter((r) => r.some((x) => x.trim() !== ""));
  if (!filled.length) return [];
  const header = filled.shift().map((h) => h.trim().toLowerCase());
  return filled.map((r) => {
    const obj = {};
    header.forEach((h, i) => { obj[h] = (r[i] ?? "").trim(); });
    return obj;
  });
}

/* ---------- Metrics you can use in the CSV ---------- */
// scope = gw: checked against every gameweek separately
function gwMetrics(row, prev) {
  const hasRanks = prev && prev.overall_rank != null && row.overall_rank != null;
  return {
    points: row.points,                                   // gameweek points (before hits)
    net_points: row.points - row.event_transfers_cost,    // gameweek points (after hits)
    points_on_bench: row.points_on_bench,
    transfers: row.event_transfers,
    transfer_cost: row.event_transfers_cost,
    gw_rank: row.rank,                                    // rank in that gameweek
    overall_rank: row.overall_rank,                       // overall rank after that gameweek
    rank_improvement: hasRanks ? prev.overall_rank - row.overall_rank : null,
    team_value: row.value / 10,                           // in millions
    bank: row.bank / 10,                                  // in millions
    total_points: row.total_points,
  };
}
const GW_METRIC_NAMES = Object.keys(gwMetrics({
  points: 0, event_transfers_cost: 0, points_on_bench: 0, event_transfers: 0,
  rank: 0, overall_rank: 0, value: 0, bank: 0, total_points: 0,
}));

// scope = season: one number for the whole season (or career)
function seasonMetrics(history) {
  const cur = history.current || [];
  const past = history.past || [];
  const last = cur[cur.length - 1];
  const nums = (arr) => arr.filter((x) => typeof x === "number");
  const min = (arr) => { const n = nums(arr); return n.length ? Math.min(...n) : null; };
  const max = (arr) => { const n = nums(arr); return n.length ? Math.max(...n) : null; };
  const sum = (arr) => nums(arr).reduce((a, b) => a + b, 0);
  return {
    gameweeks_played: cur.length,
    total_points: last ? last.total_points : 0,
    current_overall_rank: last ? last.overall_rank : null,
    best_overall_rank: min(cur.map((r) => r.overall_rank)),
    best_gw_points: max(cur.map((r) => r.points)),
    best_gw_rank: min(cur.map((r) => r.rank)),
    total_transfers: sum(cur.map((r) => r.event_transfers)),
    total_hits_cost: sum(cur.map((r) => r.event_transfers_cost)),
    total_bench_points: sum(cur.map((r) => r.points_on_bench)),
    chips_used: (history.chips || []).length,
    seasons_played: past.length,
    best_past_rank: min(past.map((p) => p.rank)),
    best_past_points: max(past.map((p) => p.total_points)),
  };
}
const SEASON_METRIC_NAMES = Object.keys(seasonMetrics({}));

/* ---------- Work out which achievements are unlocked ---------- */
function evaluate(achievements, history) {
  const cur = history.current || [];
  const perGw = cur.map((row, i) => ({ event: row.event, m: gwMetrics(row, cur[i - 1]) }));
  const season = seasonMetrics(history);

  return achievements.map((a) => {
    const result = { a, earned: false, gw: null, best: null, bestGw: null, error: null };
    const op = OPS[a.operator];
    const target = Number(a.value);
    const scope = (a.scope || "").toLowerCase();

    if (!op) { result.error = `Unknown operator "${a.operator}"`; return result; }
    if (a.value === "" || Number.isNaN(target)) { result.error = `Value "${a.value}" is not a number`; return result; }

    if (scope === "gw") {
      if (!GW_METRIC_NAMES.includes(a.metric)) { result.error = `Unknown gameweek metric "${a.metric}"`; return result; }
      const vals = perGw
        .map((x) => ({ event: x.event, v: x.m[a.metric] }))
        .filter((x) => typeof x.v === "number");
      const hit = vals.find((x) => op(x.v, target));
      if (hit) { result.earned = true; result.gw = hit.event; }
      if (vals.length && [">=", ">", "<=", "<"].includes(a.operator)) {
        const higherIsBetter = a.operator === ">=" || a.operator === ">";
        const pick = vals.reduce((b, x) => ((higherIsBetter ? x.v > b.v : x.v < b.v) ? x : b));
        result.best = pick.v;
        result.bestGw = pick.event;
      }
    } else if (scope === "season") {
      if (!SEASON_METRIC_NAMES.includes(a.metric)) { result.error = `Unknown season metric "${a.metric}"`; return result; }
      const v = season[a.metric];
      if (typeof v === "number") {
        result.earned = op(v, target);
        result.best = v;
      }
    } else {
      result.error = `Scope must be "gw" or "season" (got "${a.scope}")`;
    }
    return result;
  });
}

if (typeof module !== "undefined") {
  module.exports = { parseCSV, evaluate, gwMetrics, seasonMetrics };
}

/* ---------- Page code (only runs in a browser) ---------- */
if (typeof document !== "undefined") {
  const $ = (id) => document.getElementById(id);
  const fmt = (n) => (typeof n === "number" ? n.toLocaleString("en-GB") : "–");

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function setStatus(message, isError) {
    const box = $("status");
    box.textContent = message || "";
    box.className = isError ? "status error" : "status";
  }

  async function getJSON(path) {
    const res = await fetch(WORKER_URL.replace(/\/$/, "") + path);
    if (res.status === 404) throw new Error("Team not found. Double-check the Team ID.");
    if (res.status === 503) throw new Error("The FPL site is being updated right now. Try again in a few minutes.");
    if (!res.ok) throw new Error(`Something went wrong (error ${res.status}).`);
    return res.json();
  }

  async function getAchievements() {
    const res = await fetch("achievements.csv");
    if (!res.ok) throw new Error("Could not load achievements.csv");
    return parseCSV(await res.text());
  }

  function statBox(label, value) {
    const box = el("div", "stat");
    box.append(el("div", "stat-value", value), el("div", "stat-label", label));
    return box;
  }

  function badge(r) {
    const card = el("div", r.earned ? "badge earned" : "badge locked");
    card.append(el("div", "badge-icon", r.a.icon || "🏅"));
    const body = el("div", "badge-body");
    body.append(el("div", "badge-name", r.a.name), el("div", "badge-desc", r.a.description));
    let note = "";
    if (r.error) note = "Setup problem: " + r.error;
    else if (r.earned) note = r.gw ? `Unlocked in GW${r.gw}` : "Unlocked";
    else if (r.best !== null) note = r.gw === null && r.bestGw ? `Closest: ${fmt(r.best)} (GW${r.bestGw})` : `Currently: ${fmt(r.best)}`;
    body.append(el("div", r.error ? "badge-note problem" : "badge-note", note));
    card.append(body);
    return card;
  }

  function render(entry, results) {
    const out = $("results");
    out.replaceChildren();

    const head = el("div", "team-head");
    head.append(
      el("h2", "", entry.name),
      el("p", "muted", `${entry.player_first_name} ${entry.player_last_name}`)
    );
    out.append(head);

    const stats = el("div", "stats");
    stats.append(
      statBox("Total points", fmt(entry.summary_overall_points)),
      statBox("Overall rank", fmt(entry.summary_overall_rank)),
      statBox("Last GW points", fmt(entry.summary_event_points))
    );
    out.append(stats);

    const earned = results.filter((r) => r.earned).length;
    out.append(el("h3", "", `Achievements: ${earned} of ${results.length} unlocked`));

    const grid = el("div", "grid");
    [...results.filter((r) => r.earned), ...results.filter((r) => !r.earned)].forEach((r) => grid.append(badge(r)));
    out.append(grid);
  }

  async function lookup(id) {
    setStatus("Loading…");
    $("results").replaceChildren();
    try {
      if (typeof WORKER_URL === "undefined" || WORKER_URL.includes("YOUR-WORKER-NAME")) {
        throw new Error("Setup not finished: paste your Worker address into config.js.");
      }
      const [entry, history, achievements] = await Promise.all([
        getJSON(`/entry/${id}/`),
        getJSON(`/entry/${id}/history/`),
        getAchievements(),
      ]);
      render(entry, evaluate(achievements, history));
      setStatus("");
      try { localStorage.setItem("fpl-team-id", id); } catch (e) { /* storage unavailable */ }
    } catch (err) {
      setStatus(err.message, true);
    }
  }

  $("lookup-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const id = $("team-id").value.trim();
    if (!/^\d+$/.test(id)) { setStatus("Team ID should be a number, e.g. 395947.", true); return; }
    lookup(id);
  });

  // Pre-fill from ?id=123 in the address, or the last ID used
  let startId = new URLSearchParams(location.search).get("id");
  if (!startId) { try { startId = localStorage.getItem("fpl-team-id"); } catch (e) { /* ignore */ } }
  if (startId && /^\d+$/.test(startId)) { $("team-id").value = startId; lookup(startId); }
}
