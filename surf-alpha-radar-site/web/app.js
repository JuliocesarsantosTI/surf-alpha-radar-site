/* ============ Surf Alpha Radar — local web app logic ============ */
const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);
const API = ""; // same origin (the connector)
let MODE = "instant";
let lastData = null;
let lastQuery = "";

/* ---------- boot ---------- */
async function init() {
  bindNav();
  renderHistory();
  renderRankingsIdle();
  checkHealth();
  route();
  window.addEventListener("hashchange", route);
}

function bindNav() {
  $$(".nav-i[data-view]").forEach((a) => a.addEventListener("click", () => { location.hash = a.dataset.view; }));
  $("#send").addEventListener("click", () => submit($("#ask").value));
  $("#ask").addEventListener("keydown", (e) => { if (e.key === "Enter") submit($("#ask").value); });
  $$(".chip").forEach((c) => c.addEventListener("click", () => { $("#ask").value = c.dataset.q; submit(c.dataset.q); }));
  $$(".mode").forEach((m) => m.addEventListener("click", () => {
    $$(".mode").forEach((x) => x.classList.remove("active")); m.classList.add("active"); MODE = m.dataset.mode;
  }));
  $("#rankDate").textContent = new Date().toISOString().slice(0, 10);
}

function route() {
  const h = (location.hash || "#home").slice(1);
  $$(".view").forEach((v) => v.classList.add("hidden"));
  if (h === "pulse") { $("#view-pulse").classList.remove("hidden"); loadPulse(); }
  else if (h === "about") { $("#view-about").classList.remove("hidden"); }
  else if (h === "result") { $("#view-result").classList.remove("hidden"); }
  else { $("#view-home").classList.remove("hidden"); }
}

/* ---------- health ---------- */
async function checkHealth() {
  const el = $("#sideStatus");
  try {
    const r = await fetch(API + "/health"); await r.json();
    el.textContent = "● connected · Surf CLI"; el.className = "foot-note on";
  } catch { el.textContent = "● connector offline"; el.className = "foot-note off"; }
}

/* ---------- rankings (click-to-load + browser cache; idle = 0 credits) ---------- */
const RANK_CACHE_KEY = "sar_rankings_v1";
const PANEL_TTL = 30 * 60 * 1000; // reuse cached panel data for 30 min

function renderRankingsIdle() {
  // If we have a fresh cached copy, show it for free; otherwise show a Load button.
  const cached = readPanelCache(RANK_CACHE_KEY);
  if (cached) return paintRankings(cached.data, cached.at);
  $("#rankGrid").innerHTML = `<div class="panel-idle">
      <p>Signal Rankings use live Surf data (a few credits).</p>
      <button class="load-btn" onclick="loadRankings()">Load Signal Rankings</button>
    </div>`;
}

async function loadRankings() {
  $("#rankGrid").innerHTML = '<div class="panel-idle">Loading…</div>';
  try {
    const r = await fetch(API + "/rankings"); const d = await r.json();
    if (!r.ok) throw new Error(d && d.error || "failed");
    writePanelCache(RANK_CACHE_KEY, d);
    paintRankings(d, Date.now());
  } catch (e) {
    $("#rankGrid").innerHTML = `<div class="panel-idle"><p>Rankings unavailable (connector offline).</p>
      <button class="load-btn" onclick="loadRankings()">Retry</button></div>`;
  }
}

function paintRankings(d, at) {
  const g = $("#rankGrid"); g.innerHTML = "";
  d.rows.forEach((row) => {
    const el = document.createElement("div");
    el.className = "rank-row";
    const chc = row.chg >= 0 ? "up" : "down";
    el.innerHTML = `<div class="rank-n ${row.rank <= 3 ? "top" : ""}">${row.rank}</div>
      <div class="rank-main">
        <div class="rank-top"><span class="rank-sym">${row.sym}</span>
          <span class="rank-px">$${fmtNum(row.price)}</span>
          <span class="rank-chg ${chc}">${row.chg >= 0 ? "+" : ""}${row.chg}%</span></div>
        <div class="rank-note">${row.note || ""}</div>
      </div>`;
    el.style.cursor = "pointer";
    el.addEventListener("click", () => { $("#ask").value = "Analyze " + row.sym; submit("Analyze " + row.sym); });
    g.appendChild(el);
  });
  const foot = document.createElement("div");
  foot.className = "panel-foot";
  foot.innerHTML = `<span>cached ${timeAgo(at)}</span><a onclick="loadRankings()">↻ Refresh</a>`;
  g.appendChild(foot);
}

/* browser panel cache helpers */
function readPanelCache(key) {
  try { const c = JSON.parse(localStorage.getItem(key) || "null"); if (c && Date.now() - c.at < PANEL_TTL) return c; } catch {}
  return null;
}
function writePanelCache(key, data) { try { localStorage.setItem(key, JSON.stringify({ at: Date.now(), data })); } catch {} }

/* ---------- submit / scan ---------- */
async function submit(q) {
  q = (q || "").trim(); if (!q) return;
  lastQuery = q;
  location.hash = "result";
  $("#resQ").textContent = q;
  $("#resStatus").innerHTML = '<span class="dot"></span> Surf is scanning signals…';
  $("#resBody").innerHTML = ""; $("#resRail").innerHTML = "";

  const t0 = performance.now();
  try {
    const r = await fetch(API + "/scan", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query: q, mode: MODE }) });
    const data = await r.json();
    if (!r.ok) throw new Error(data && data.error || "scan failed");
    lastData = data;
    const secs = ((performance.now() - t0) / 1000).toFixed(1);
    if (data.kind === "compare") renderCompare(data, secs);
    else if (data.kind === "answer") renderAnswer(data, secs);
    else renderResult(data, secs);
    if (data.kind !== "answer" || (data.results && data.results.length)) saveResult(q, MODE, data);
  } catch (e) {
    $("#resStatus").textContent = "";
    $("#resBody").innerHTML = `<div class="alpha" style="color:var(--red)">Scan failed: ${escapeHtml(String(e.message || e))}</div>
      <p class="bd-cap">Make sure the connector is running and Surf CLI is authenticated.</p>`;
  }
}

/* ---------- render single token ---------- */
function renderResult(d, secs) {
  const s = d.subject;
  const modeTxt = d.mode === "research" ? "Research" : "Instant";
  const srcTxt = d.source === "Surf CLI" ? `${modeTxt} scan · ${secs}s · ${d.credits || 0} credits` : "Preview (sample data)";
  $("#resStatus").innerHTML = `✓ ${srcTxt}`;
  $("#resStatus").style.color = "var(--green)";

  const sym = s.symbol || (s.address ? short(s.address) : "—");
  const body = $("#resBody");
  const researchHint = (d.mode !== "research" && d.source === "Surf CLI")
    ? `<div class="deep-hint">⚡ Instant scan (price · technicals · sentiment). <a onclick="runResearch()">Run full Research →</a> for social, on-chain, ETF flows & derivatives.</div>` : "";
  body.innerHTML = `
    <h1 class="res-title">${sym} — Signal Analysis</h1>
    <p class="res-sub">${s.name || ""}</p>

    ${d.tldr ? `<div class="tldr"><div class="tldr-h">TL;DR</div><p>${d.tldr}</p></div>` : ""}
    ${researchHint}

    <div class="sec" id="sec-score">
      <div class="sec-h"><span class="num">1</span> Alpha Score</div>
      <div class="alpha">
        <div class="alpha-num" style="color:${scoreColor(d.score)}">${d.score}</div>
        <div class="alpha-meta">
          <div class="alpha-verdict" style="color:${scoreColor(d.score)}">${d.verdict}</div>
          <div class="gauge">${gaugeSegs(d.breakdown)}</div>
          <div class="bd">${d.breakdown.map(bdRow).join("")}</div>
          ${d.breakdown.some(b => b.est) ? `<div class="bd-cap">${d.mode === "research" ? "~ estimated (endpoint unavailable for this token)" : "~ estimated in Instant mode — run Research for live social, on-chain, ETF & derivatives"}</div>` : ""}
        </div>
      </div>
    </div>

    <div class="sec" id="sec-why">
      <div class="sec-h"><span class="num">2</span> Signal Read</div>
      <ul class="why">${d.why.map(whyRow).join("")}</ul>
    </div>

    <div class="sec" id="sec-risk">
      <div class="sec-h"><span class="num">3</span> Risk Scan <span class="risk-badge ${rbClass(d.risk.level)}">${d.risk.level.toUpperCase()} RISK</span></div>
      <div class="risk-grid">${d.risk.items.map(riskItem).join("")}</div>
    </div>`;

  // right rail
  const chg = s.change24h;
  $("#resRail").innerHTML = `
    <div class="rail-card">
      <div class="rail-tok"><div class="rail-ava">${(sym[0] || "?")}</div>
        <div><div class="rail-sym">${sym}</div><div class="rail-name">${s.name || ""}</div></div></div>
      ${s.price != null ? `<div class="rail-price">$${fmtNum(s.price)}</div>
        <div class="rail-chg ${chg >= 0 ? "up" : "down"}">${chg >= 0 ? "▲ +" : "▼ "}${Math.abs(chg).toFixed(2)}% · 24h</div>
        <div class="rail-spark">${sparkline(seededSeries(sym, chg), chg >= 0 ? "var(--green)" : "var(--red)")}</div>` : ""}
      <div class="rail-nav">
        <a onclick="document.getElementById('sec-score').scrollIntoView({behavior:'smooth'})">1 · Alpha Score</a>
        <a onclick="document.getElementById('sec-why').scrollIntoView({behavior:'smooth'})">2 · Signal Read</a>
        <a onclick="document.getElementById('sec-risk').scrollIntoView({behavior:'smooth'})">3 · Risk Scan</a>
      </div>
      <button class="share-btn" onclick="copyShare()">Copy summary</button>
    </div>`;
}

function bdRow(b) {
  return `<div class="bd-row">
    <span class="lab">${b.label}${b.est ? " <em>~</em>" : ""}</span>
    <span class="bd-bar"><span style="width:${Math.round(b.value / b.max * 100)}%;background:${b.color}"></span></span>
    <span class="v">${b.value}/${b.max}</span></div>`;
}
function gaugeSegs(bd) {
  return bd.map((b) => `<span style="width:${b.value}%;background:${b.color}"></span>`).join("")
    + `<span style="flex:1;background:transparent"></span>`;
}
function whyRow(w) {
  const mk = w.tone === "pos" ? "pos" : w.tone === "neg" ? "neg" : "neu";
  const g = mk === "pos" ? "+" : mk === "neg" ? "!" : "•";
  return `<li><span class="mk ${mk}">${g}</span><span>${w.html}</span></li>`;
}
function riskItem(it) {
  const dc = it.state === "ok" ? "d-ok" : it.state === "warn" ? "d-warn" : "d-bad";
  return `<div class="risk-item"><span class="d ${dc}"></span><span class="t"><b>${it.label}</b>${it.note}</span></div>`;
}
function rbClass(l) { return l === "low" ? "rb-low" : l === "med" ? "rb-med" : "rb-high"; }

/* ---------- web-search answer ---------- */
function renderAnswer(d, secs) {
  const isWeb = d.source === "Surf CLI" && d.results && d.results.length;
  $("#resStatus").innerHTML = isWeb ? `✓ Web search · ${secs}s · ${d.credits || 0} credits` : "General question";
  $("#resStatus").style.color = isWeb ? "var(--green)" : "var(--muted)";
  $("#resRail").innerHTML = "";
  const body = $("#resBody");
  if (!isWeb) {
    body.innerHTML = `<h1 class="res-title">Not a token query</h1>
      <div class="tldr" style="margin-top:4px"><p>${escapeHtml(d.note || "")}</p></div>
      <div class="chips" style="justify-content:flex-start;margin-top:16px">
        <button class="chip" onclick="sendPromptLocal('Analyze SOL')">Analyze SOL</button>
        <button class="chip" onclick="sendPromptLocal('Compare AAVE and LINK')">Compare AAVE · LINK</button>
        <button class="chip" onclick="location.hash='pulse'">Open Crypto Pulse</button>
      </div>`;
    return;
  }
  body.innerHTML = `
    <h1 class="res-title">Web results</h1>
    <p class="res-sub">${escapeHtml(d.query || "")}</p>
    <div class="web-list">
      ${d.results.map((r) => `
        <a class="web-item" ${r.url ? `href="${escapeHtml(r.url)}" target="_blank" rel="noopener"` : ""}>
          <div class="web-title">${escapeHtml(r.title)}</div>
          ${r.snippet ? `<div class="web-snippet">${escapeHtml(r.snippet)}</div>` : ""}
          ${r.source ? `<div class="web-source">${escapeHtml(r.source)}</div>` : ""}
        </a>`).join("")}
    </div>
    <p class="bd-cap" style="margin-top:14px">Web search via Surf. For deep token analysis, try <b>Analyze &lt;symbol&gt;</b>.</p>`;
}
window.sendPromptLocal = function (q) { $("#ask").value = q; submit(q); };

/* ---------- compare ---------- */
function renderCompare(d, secs) {
  $("#resStatus").innerHTML = `✓ Surf completed in ${secs}s · ${d.credits || 0} credits`;
  $("#resStatus").style.color = "var(--green)";
  const rows = [...d.items].sort((a, b) => b.score - a.score);
  $("#resBody").innerHTML = `<h1 class="res-title">Comparison</h1>
    <div class="sec"><div class="bd">${rows.map((it) => `
      <div class="bd-row" style="grid-template-columns:80px 1fr 60px 70px">
        <span class="lab" style="font-weight:700">${it.symbol}</span>
        <span class="bd-bar"><span style="width:${it.score}%;background:${scoreColor(it.score)}"></span></span>
        <span class="v" style="color:${scoreColor(it.score)};font-weight:800">${it.score}</span>
        <span class="rank-chg ${it.change24h >= 0 ? "up" : "down"}" style="text-align:right">${it.change24h >= 0 ? "+" : ""}${it.change24h.toFixed(1)}%</span>
      </div>`).join("")}</div></div>`;
  $("#resRail").innerHTML = "";
}

/* ---------- pulse (click-to-load + browser cache) ---------- */
const PULSE_CACHE_KEY = "sar_pulse_v1";

function loadPulse() {
  const cached = readPanelCache(PULSE_CACHE_KEY);
  if (cached) return paintPulse(cached.data, cached.at);
  $("#pulseWrap").innerHTML = `<div class="panel-idle big">
      <h2>Crypto Pulse</h2>
      <p>Live market Fear &amp; Greed, mindshare sentiment and top mindshare leaders — pulled from Surf (a few credits).</p>
      <button class="load-btn" onclick="fetchPulse()">Load Crypto Pulse</button>
    </div>`;
}

async function fetchPulse() {
  $("#pulseWrap").innerHTML = '<div class="loading-pulse">Loading Crypto Pulse…</div>';
  try {
    const r = await fetch(API + "/pulse"); const d = await r.json();
    if (!r.ok) throw new Error(d && d.error || "failed");
    writePanelCache(PULSE_CACHE_KEY, d);
    paintPulse(d, Date.now());
  } catch (e) {
    $("#pulseWrap").innerHTML = `<div class="panel-idle big"><p>Crypto Pulse unavailable — is the connector running?</p>
      <button class="load-btn" onclick="fetchPulse()">Retry</button></div>`;
  }
}

function paintPulse(d, at) {
  const wrap = $("#pulseWrap");
  const fg = d.fearGreed, se = d.sentiment || {};
  wrap.innerHTML = `
      <div class="pulse-bar"><span>Snapshot cached ${timeAgo(at)}</span><a class="refresh-link" onclick="fetchPulse()">↻ Refresh</a></div>
      <div class="pulse-top">
        <div class="card">
          <div class="card-h">Market Fear & Greed ${fg.live ? '<span class="live-tag">live</span>' : '<span class="sample-tag">offline</span>'}</div>
          <div class="fg-wrap">
            ${fgGauge(fg.value == null ? 50 : fg.value)}
            <div class="fg-val" style="color:${fgColor(fg.value)}">${fg.value == null ? "—" : fg.value}</div>
            <div class="fg-lab" style="color:${fgColor(fg.value)}">${fg.label}</div>
            ${fg.points && fg.points.length ? `<div style="width:100%;margin-top:6px">${sparkline(fg.points, fgColor(fg.value), 300, 46)}</div>` : ""}
          </div>
        </div>
        <div class="card">
          <div class="card-h">Mindshare Sentiment ${se.live ? '<span class="live-tag">live</span>' : '<span class="sample-tag">offline</span>'}</div>
          <div class="mind-top"><span class="mind-val" style="color:${se.value >= 50 ? "var(--green)" : "var(--amber)"}">${se.value == null ? "—" : se.value}</span><span class="mind-max">/100</span></div>
          <p class="bd-cap" style="margin-top:6px">${se.total ? `${se.positive} of top ${se.total} mindshare leaders are positive right now (24h).` : "Sentiment across the top mindshare leaders."}</p>
          <div class="sent-bar"><span style="width:${se.value || 0}%"></span></div>
          <div class="sent-legend"><span>positive</span><span>${se.value == null ? "" : se.value + "%"}</span></div>
        </div>
      </div>

      <div class="card">
        <div class="card-h"><i class="ic ic-rank"></i> Top Mindshare — 24h <span class="live-tag">live</span></div>
        <div class="asked-grid">${(d.leaders || []).map((a) => `
          <div class="asked-row">
            <span class="n">${a.rank}</span>
            <span class="s">${a.sym}${a.name && a.name !== a.sym ? ` <em style="color:var(--muted-2);font-style:normal;font-weight:500">${a.name}</em>` : ""}</span>
            <span class="sent-pill ${a.sentiment}">${a.sentiment}</span>
          </div>`).join("")}</div>
      </div>`;
}

/* ---------- small SVG widgets ---------- */
function fgGauge(v) {
  const a0 = -110, a1 = 110, ang = a0 + (a1 - a0) * (v / 100);
  const seg = (from, to, col) => `<path d="${arc(90, 82, 62, from, to)}" stroke="${col}" stroke-width="12" fill="none" stroke-linecap="round"/>`;
  const rad = (ang - 90) * Math.PI / 180, nx = 90 + 44 * Math.cos(rad), ny = 82 + 44 * Math.sin(rad);
  return `<svg viewBox="0 0 180 110" width="180" height="110">
    ${seg(-110, -55, "#ea3943")}${seg(-53, -18, "#f0a020")}${seg(-16, 16, "#e8c14a")}${seg(18, 53, "#7cc576")}${seg(55, 110, "#16c784")}
    <line x1="90" y1="82" x2="${nx}" y2="${ny}" stroke="#17171c" stroke-width="3" stroke-linecap="round"/>
    <circle cx="90" cy="82" r="5" fill="#17171c"/></svg>`;
}
function arc(cx, cy, r, a0, a1) {
  const p = (a) => { const rad = (a - 90) * Math.PI / 180; return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)]; };
  const [x0, y0] = p(a0), [x1, y1] = p(a1); const large = (a1 - a0) > 180 ? 1 : 0;
  return `M ${x0} ${y0} A ${r} ${r} 0 ${large} 1 ${x1} ${y1}`;
}
function sparkline(pts, color, w = 220, h = 54) {
  if (!pts || !pts.length) return "";
  const min = Math.min(...pts), max = Math.max(...pts), rng = (max - min) || 1;
  const step = w / (pts.length - 1);
  const d = pts.map((v, i) => `${i === 0 ? "M" : "L"} ${(i * step).toFixed(1)} ${(h - 6 - (v - min) / rng * (h - 12)).toFixed(1)}`).join(" ");
  const area = d + ` L ${w} ${h} L 0 ${h} Z`;
  const id = "g" + Math.random().toString(36).slice(2, 7);
  return `<svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}" preserveAspectRatio="none">
    <defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${color}" stop-opacity=".18"/><stop offset="1" stop-color="${color}" stop-opacity="0"/></linearGradient></defs>
    <path d="${area}" fill="url(#${id})"/><path d="${d}" fill="none" stroke="${color}" stroke-width="2"/></svg>`;
}
function seededSeries(sym, chg) {
  const r = rng(hash(sym)); const out = []; let v = 100;
  for (let i = 0; i < 24; i++) { v += (r() - 0.5) * 6 + chg / 24; out.push(v); } return out;
}

/* ---------- history (full results cached in localStorage — real page, not sandbox) ----------
   Each entry stores the whole scan result so reopening an old chat costs ZERO credits.
   Capped at 50 entries; oldest are dropped. Data is a snapshot from scan time. */
const HIST_KEY = "sar_hist_v2";
const HIST_MAX = 50;

function loadHist() { try { return JSON.parse(localStorage.getItem(HIST_KEY) || "[]"); } catch { return []; } }
function saveHist(h) { try { localStorage.setItem(HIST_KEY, JSON.stringify(h.slice(0, HIST_MAX))); } catch { /* quota */ } }

function saveResult(query, mode, data) {
  const h = loadHist();
  const id = "h_" + Date.now();
  const entry = { id, query, mode, at: Date.now(), data };
  // de-dupe by query+mode: replace an existing one
  const filtered = h.filter((e) => !(e.query === query && e.mode === mode));
  saveHist([entry, ...filtered]);
  renderHistory();
  return id;
}

function renderHistory() {
  const h = loadHist();
  const box = $("#hist");
  if (!h.length) { box.innerHTML = '<div class="foot-note" style="padding:0 10px">No scans yet.</div>'; return; }
  box.innerHTML = h.map((e) => `<div class="hist-i" data-id="${e.id}" title="${escapeHtml(e.query)}">
      <span class="hist-q">${escapeHtml(e.query)}</span>
      <span class="hist-t">${timeAgo(e.at)}</span>
    </div>`).join("");
  $$("#hist .hist-i").forEach((el) => el.addEventListener("click", () => openHistory(el.dataset.id)));
}

function openHistory(id) {
  const e = loadHist().find((x) => x.id === id);
  if (!e) return;
  lastQuery = e.query; lastData = e.data;
  $("#ask").value = e.query;
  location.hash = "result";
  $("#resQ").textContent = e.query;
  // Render straight from cache — no fetch, no credits.
  if (e.data.kind === "compare") renderCompare(e.data, "0.0");
  else if (e.data.kind === "answer") renderAnswer(e.data, "0.0");
  else renderResult(e.data, "0.0");
  // mark as cached snapshot
  $("#resStatus").innerHTML = `✓ Saved scan · ${timeAgo(e.at)} · 0 credits <a class="refresh-link" onclick="refreshCurrent()">↻ Refresh</a>`;
  $("#resStatus").style.color = "var(--muted)";
}

window.refreshCurrent = function () { if (lastQuery) submit(lastQuery); };

function timeAgo(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return Math.floor(s / 60) + "m ago";
  if (s < 86400) return Math.floor(s / 3600) + "h ago";
  return Math.floor(s / 86400) + "d ago";
}

/* ---------- rerun in research mode ---------- */
window.runResearch = function () {
  MODE = "research";
  $$(".mode").forEach((m) => m.classList.toggle("active", m.dataset.mode === "research"));
  if (lastQuery) submit(lastQuery);
};

/* ---------- share ---------- */
window.copyShare = function () {
  if (!lastData) return;
  const d = lastData, s = d.subject;
  const txt = `${s.symbol || "scan"} — Alpha Score ${d.score}/100 (${d.verdict})\n`
    + d.breakdown.map((b) => `• ${b.label}: ${b.value}/${b.max}`).join("\n")
    + `\nRisk: ${d.risk.level.toUpperCase()}\n— via Surf Alpha Radar · asksurf.ai`;
  navigator.clipboard.writeText(txt).then(() => {
    const b = document.querySelector(".share-btn"); if (b) { b.textContent = "Copied ✓"; setTimeout(() => b.textContent = "Copy summary", 1400); }
  });
};

/* ---------- helpers ---------- */
function scoreColor(s) { return s >= 75 ? "#16c784" : s >= 55 ? "#3aa0ff" : s >= 40 ? "#f0a020" : "#ea3943"; }
function fgColor(v) { return v == null ? "#8b8b96" : v < 25 ? "#ea3943" : v < 45 ? "#f0a020" : v < 55 ? "#c8a020" : v < 75 ? "#7cc576" : "#16c784"; }
function fmtNum(p) { if (p >= 1000) return Math.round(p).toLocaleString(); if (p >= 1) return p.toFixed(2); return p.toPrecision(3); }
function short(a) { return a.slice(0, 6) + "…" + a.slice(-4); }
function escapeHtml(s) { return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
function hash(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
function rng(seed) { let s = seed; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }

/* boot after all declarations are initialized */
init();
