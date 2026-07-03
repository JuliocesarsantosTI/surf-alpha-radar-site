/* ==================================================================
   surf.js — intent detection, REAL Surf CLI integration, scoring.

   analyze(query) returns the schema the extension renders:
     { kind, source, credits, subject, score, breakdown, verdict, why, risk }
   compare:
     { kind:"compare", source, credits, items:[{symbol,score,change24h,risk}] }

   LIVE DATA (per token scan, ~3 credits, from the user's own CLI):
     • market-price            -> real price + momentum (summary.last / change_pct)
     • market-fear-greed       -> real market sentiment (0..100)
     • market-price-indicator  -> real RSI (technical strength)
   ESTIMATED (until social/on-chain endpoints are wired): on-chain, social, news.
   Estimated components are flagged { est:true } and shown dimmed in the UI.

   If market-price fails (CLI missing / not authed / no credits) the scan
   returns an error so the user sees the real reason — never fake data
   dressed up as live.
================================================================== */

const NAMES = { SOL:"Solana", ETH:"Ethereum", BTC:"Bitcoin", AAVE:"Aave", LINK:"Chainlink", PEPE:"Pepe", ARB:"Arbitrum", OP:"Optimism", SUI:"Sui", DOGE:"Dogecoin" };
const COL = { momentum:"#6fd1ff", tech:"#38e1c6", sentiment:"#f5b54a", onchain:"#7fead4", social:"#8b8cf0", news:"#c58bf0" };
const MAJORS = ["SOL","ETH","BTC","AAVE","LINK"];

/* ---------- entry ---------- */
const STOPWORDS = new Set("what which best top is are the a an how why when where who for crypto dex token coin price of in on to should buy sell market vs and or this that tell me about analyze analyse scan check compare good bad now today will can does do latest news trend trending explain".split(" "));

function resolveSymbol(query) {
  const q = query.trim();
  let m = q.match(/\$([A-Za-z][A-Za-z0-9]{1,9})\b/);              // $TICKER
  if (m) return m[1].toUpperCase();
  m = q.match(/^(?:analyze|analyse|scan|check)\s+\$?([A-Za-z][A-Za-z0-9]{1,9})\s*\??$/i);  // "analyze X"
  if (m) return m[1].toUpperCase();
  const known = symbolsIn(q); if (known.length) return known[0];  // known ticker anywhere
  const words = q.replace(/[?.!,]/g, "").split(/\s+/).filter(Boolean);  // a bare short token
  if (words.length === 1 && /^[A-Za-z][A-Za-z0-9]{1,9}$/.test(words[0]) && !STOPWORDS.has(words[0].toLowerCase())) return words[0].toUpperCase();
  return null;
}
function tickersFor(query) {
  return query.replace(/[?.,]/g, "").split(/\s+/)
    .filter((w) => /^\$?[A-Za-z][A-Za-z0-9]{1,9}$/.test(w) && !STOPWORDS.has(w.toLowerCase()))
    .map((w) => w.replace("$", "").toUpperCase());
}

async function analyze(query, mode) {
  const wallet = walletIn(query);
  if (wallet) return scoreWallet(wallet);

  if (/\bcompare\b/i.test(query)) {
    const list = (tickersFor(query).length ? tickersFor(query) : ["SOL", "ETH"]).slice(0, 4);
    const items = []; let credits = 0; let anyLive = false;
    for (const sym of list) {
      try { const d = await scoreToken(sym, "instant"); items.push({ symbol:sym, score:d.score, change24h:d.subject.change24h, risk:d.risk.level }); credits += d.credits||0; if(d.source==="Surf CLI") anyLive=true; }
      catch (e) { /* skip */ }
    }
    if (!items.length) throw new Error("No data — check `surf auth` / credits.");
    return { kind:"compare", source: anyLive ? "Surf CLI" : "demo", credits, items };
  }

  const sym = resolveSymbol(query);
  if (sym) return scoreToken(sym, mode === "research" ? "research" : "instant");
  return answerQuestion(query);   // free-form question → web search
}

/* ---------- free-form Q&A via search-web ---------- */
async function answerQuestion(query) {
  try {
    const raw = await surf(["search-web", "--q", query, "--limit", "6", "--include-content", "-o", "json"]);
    const parsed = parseWebSearch(raw);
    if (parsed && parsed.results.length) return { kind:"answer", source:"Surf CLI", credits:parsed.credits, query, ...parsed };
  } catch (e) { /* fall through */ }
  return { kind:"answer", source:"none", credits:0, query, results: [], note:
    "This looks like a general question. Surf Alpha Radar focuses on token, wallet and comparison analysis. Try `Analyze SOL`, paste a wallet address, or `Compare AAVE and LINK`." };
}

function parseWebSearch(raw) {
  const b = unwrap(raw);
  const arr = Array.isArray(b && b.data) ? b.data : (Array.isArray(b) ? b : []);
  if (!arr.length) return null;
  const results = arr.slice(0, 6).map((r) => ({
    title: r.title || r.name || r.url || "result",
    url: r.url || r.link || "",
    source: r.source || r.site || (r.url ? hostOf(r.url) : ""),
    snippet: (r.snippet || r.summary || r.content || r.description || "").toString().slice(0, 320)
  })).filter((r) => r.title || r.snippet);
  return { results, credits: num(b && b.meta && b.meta.credits_used) || 0 };
}
function hostOf(u){ try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; } }

/* ---------- Surf CLI runner ----------
   On Windows, `npm start` is launched from Git Bash, but Node's exec uses
   cmd.exe — which can't run a Git-Bash `surf` script (output came back empty).
   So on Windows we run surf THROUGH bash and add ~/.local/bin to PATH:
     • bash   — run surf via Git Bash (default on Windows)
     • direct — run surf.exe directly (native Windows install)
     • cmd    — cmd/sh with file redirect (Linux/macOS)
   Overrides: SURF_BIN (full path to surf), SURF_BASH (full path to bash.exe). */
const { exec, execFile } = require("child_process");
const os = require("os");
const fs = require("fs");
const path = require("path");

const SURF_BIN = process.env.SURF_BIN || "surf";
const IS_WIN = process.platform === "win32";
const q = (a) => `"${String(a).replace(/"/g, "")}"`;                 // cmd double-quote
const shq = (a) => `'${String(a).replace(/'/g, `'\\''`)}'`;          // bash single-quote
let STRATEGY = null;

function bashCandidates() {
  const c = [];
  if (process.env.SURF_BASH) c.push(process.env.SURF_BASH);
  if (process.env.EXEPATH) { c.push(path.join(process.env.EXEPATH, "bin", "bash.exe")); c.push(path.join(process.env.EXEPATH, "usr", "bin", "bash.exe")); }
  c.push("C:\\Program Files\\Git\\bin\\bash.exe");
  c.push("C:\\Program Files\\Git\\usr\\bin\\bash.exe");
  c.push("C:\\Program Files (x86)\\Git\\bin\\bash.exe");
  if (process.env.LOCALAPPDATA) c.push(path.join(process.env.LOCALAPPDATA, "Programs", "Git", "bin", "bash.exe"));
  if (process.env.USERPROFILE) c.push(path.join(process.env.USERPROFILE, "scoop", "apps", "git", "current", "bin", "bash.exe"));
  return c.filter((p) => { try { return fs.existsSync(p); } catch { return false; } });
}

function execStrategy(strategy, args) {
  return new Promise((resolve) => {
    const tmp = path.join(os.tmpdir(), `surf_${Date.now()}_${Math.random().toString(36).slice(2)}.out`);
    const finish = (piped, err, stderr) => {
      let text = piped || "";
      if (!text) { try { text = fs.readFileSync(tmp, "utf8"); } catch {} }
      try { fs.unlinkSync(tmp); } catch {}
      resolve({ text: (text || "").trim(), error: err || null, stderr: (stderr || "").toString() });
    };
    const opts = { timeout: 25000, maxBuffer: 32 * 1024 * 1024, windowsHide: true, env: { ...process.env, NO_COLOR: "1", CLICOLOR: "0", CLICOLOR_FORCE: "0", FORCE_COLOR: "0", TERM: "dumb" } };
    if (strategy.type === "direct") {
      execFile(SURF_BIN, args, opts, (err, so, se) => finish(so, err, se));
    } else if (strategy.type === "bash") {
      const tmpU = tmp.replace(/\\/g, "/").replace(/^([A-Za-z]):/, (_m, d) => "/" + d.toLowerCase());
      const inner = 'export NO_COLOR=1 CLICOLOR=0 FORCE_COLOR=0; export PATH="$HOME/.local/bin:$HOME/bin:$PATH"; '
        + [SURF_BIN, ...args].map(shq).join(" ") + " > " + shq(tmpU);
      execFile(strategy.bash, ["-lc", inner], opts, (err, _so, se) => finish("", err, se));
    } else { // cmd / sh with redirect
      const cmd = [SURF_BIN, ...args].map(q).join(" ") + " > " + q(tmp);
      exec(cmd, opts, (err, so, se) => finish(so, err, se));
    }
  });
}

async function detectStrategy() {
  if (STRATEGY) return STRATEGY;
  if (IS_WIN) {
    const bashes = bashCandidates();
    // surf is typically a Git-Bash script (unix path), so prefer bash; fall back to bash.exe on PATH.
    STRATEGY = { type: "bash", bash: bashes[0] || "bash.exe" };
    if (!bashes.length && /\.exe$/i.test(SURF_BIN)) STRATEGY = { type: "direct" };
  } else {
    STRATEGY = { type: "cmd" };
  }
  console.log("  surf runner:", STRATEGY.type + (STRATEGY.bash ? " (" + STRATEGY.bash + ")" : ""));
  return STRATEGY;
}

async function runRaw(args) {
  const s = await detectStrategy();
  return execStrategy(s, args);
}

async function surf(args) {
  const { text, error, stderr } = await runRaw(args);
  if (!text) { const e = new Error(error ? String(error.message || error) : "empty output from surf"); e.stderr = stderr; throw e; }
  return extractJSON(text);
}
// Tolerate ANSI codes or a banner/notice line printed before/after the JSON.
function extractJSON(text) {
  const clean = String(text).replace(/\x1b\[[0-9;]*m/g, "").trim();
  try { return JSON.parse(clean); } catch {}
  const s = clean.indexOf("{"), e = clean.lastIndexOf("}");
  if (s >= 0 && e > s) { try { return JSON.parse(clean.slice(s, e + 1)); } catch {} }
  return clean; // couldn't parse — return cleaned text so callers can show a snippet
}
const unwrap = (o) => (o && typeof o === "object" && o.body && typeof o.body === "object") ? o.body : o;

/* ---------- parsers (pure, testable) ---------- */
function parsePrice(raw) {
  const b = unwrap(raw);
  if (!b || typeof b !== "object") return null;
  const last = num(b.summary && b.summary.last);
  if (last == null) return null;
  let chg = num(b.summary && b.summary.change_pct);
  const data = Array.isArray(b.data) ? b.data : null;
  if (data && data.length > 26) {                 // approx 24h from the tail
    const lv = num(data[data.length - 1].value);
    const pv = num(data[data.length - 25].value);
    if (lv != null && pv) chg = ((lv - pv) / pv) * 100;
  }
  return { last, chg: chg == null ? 0 : chg, credits: num((b.meta && b.meta.credits_used)) || 0 };
}
function parseSeriesValue(raw, keys) {
  const b = unwrap(raw);
  const arr = Array.isArray(b && b.data) ? b.data : (Array.isArray(b) ? b : null);
  if (!arr || !arr.length) return { value:null, credits:num(b && b.meta && b.meta.credits_used)||0 };
  const p = arr[arr.length - 1];
  let v = null;
  for (const k of keys) { const n = num(p[k]); if (n != null) { v = n; break; } }
  return { value:v, credits:num(b && b.meta && b.meta.credits_used)||0 };
}

/* ---------- live fetch ---------- */
const SLUG = { SOL:"solana", ETH:"ethereum", BTC:"bitcoin", AAVE:"aave", LINK:"chainlink", PEPE:"pepe", ARB:"arbitrum", OP:"optimism", SUI:"sui", DOGE:"dogecoin" };

function parseNews(raw) {
  const b = unwrap(raw);
  const arr = Array.isArray(b && b.data) ? b.data : [];
  const credits = num(b && b.meta && b.meta.credits_used) || 0;
  if (!arr.length) return null;
  const now = Date.now() / 1000;
  const recent = arr.filter((a) => now - num(a.published_at) < 3 * 86400).length;
  const score = clamp(Math.round(2 + recent * 0.9), 0, 10);
  const latest = { title: arr[0].title, source: arr[0].source };
  return { score, recent, count: arr.length, latest, credits };
}

async function fetchNews(sym) {
  const slug = SLUG[sym] || sym.toLowerCase();
  try { return parseNews(await surf(["news-feed", "--project", slug, "--limit", "10", "-o", "json"])); }
  catch { return null; }
}

/* Social attention — smart-follower reach + sentiment (social-detail) */
function parseSocial(raw) {
  const b = unwrap(raw); const d = b && b.data;
  if (!d || typeof d !== "object") return null;
  const smart = num(d.smart_followers && d.smart_followers.count);
  const sent = num(d.sentiment && d.sentiment.score);
  if (smart == null && sent == null) return null;
  const attn = smart != null ? clamp(Math.round(Math.log10(smart + 1) / 4 * 14), 0, 14) : 7;
  const sb = sent != null ? clamp(Math.round((sent + 1) / 2 * 6), 0, 6) : 3;
  return { score: clamp(attn + sb, 0, 20), smart, sentiment: sent, credits: num(b.meta && b.meta.credits_used) || 0 };
}
async function fetchSocial(sym) {
  const slug = SLUG[sym] || sym.toLowerCase();
  try { return parseSocial(await surf(["social-detail", "--q", slug, "-o", "json"])); } catch { return null; }
}

/* On-chain activity — transfer stats (EVM only, needs contract address) */
const ADDR = {
  LINK: { a: "0x514910771AF9Ca656af840dff83E8264EcF986CA", c: "ethereum" },
  AAVE: { a: "0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9", c: "ethereum" },
  UNI:  { a: "0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984", c: "ethereum" },
  PEPE: { a: "0x6982508145454Ce325dDbE47a25d4ec3d2311933", c: "ethereum" },
  ARB:  { a: "0x912CE59144191C1204E64559FE8253a0e49E6548", c: "arbitrum" },
};
function parseOnchain(raw) {
  const b = unwrap(raw); const d = b && b.data;
  if (!d || typeof d !== "object" || d.total_transfers == null) return null;
  const t = num(d.total_transfers), rc = num(d.unique_receivers), usd = num(d.total_amount_usd);
  return { score: clamp(Math.round(Math.log10((t || 0) + 1) / 6 * 20), 0, 20), transfers: t, receivers: rc, usd, credits: num(b.meta && b.meta.credits_used) || 0 };
}
async function fetchOnchain(sym) {
  const m = ADDR[sym]; if (!m) return null;
  try { return parseOnchain(await surf(["token-transfer-stats", "--address", m.a, "--chain", m.c, "--time-range", "7d", "-o", "json"])); } catch { return null; }
}

/* Derivatives & flows — ETF net flow, long/short ratio, open interest & funding */
const ETF_SYMS = ["BTC", "ETH"];
const PERP_SYMS = ["BTC", "ETH", "SOL", "LINK", "AAVE", "ARB", "OP", "SUI", "DOGE", "BNB", "XRP", "ADA", "AVAX"];

function parseEtf(raw) {
  const b = unwrap(raw); const arr = Array.isArray(b && b.data) ? b.data : [];
  if (!arr.length || arr[0].flow_usd == null) return null;
  const net = num(arr[0].flow_usd);
  let streak = 0;
  for (const d of arr) { const f = num(d.flow_usd); if (f == null) break; if ((net < 0 && f < 0) || (net > 0 && f > 0)) streak++; else break; }
  const etfs = [...(arr[0].etfs || [])].sort((a, b) => num(a.flow_usd) - num(b.flow_usd));
  return { net, streak, topOut: etfs[0], topIn: etfs[etfs.length - 1], credits: num(b.meta && b.meta.credits_used) || 0 };
}
async function fetchEtf(sym) {
  if (!ETF_SYMS.includes(sym)) return null;
  try { return parseEtf(await surf(["market-etf", "--symbol", sym, "-o", "json"])); } catch { return null; }
}

function parseLongShort(raw) {
  const b = unwrap(raw); const arr = Array.isArray(b && b.data) ? b.data : [];
  if (!arr.length) return null;
  const last = arr[arr.length - 1];                 // ascending — newest last
  return { ratio: num(last.long_short_ratio), credits: num(b.meta && b.meta.credits_used) || 0 };
}
function parsePerp(raw) {
  const b = unwrap(raw); const d = b && b.data;
  if (!d || typeof d !== "object") return null;
  const oi = d.open_interest && num(d.open_interest.open_interest_usd);
  const funding = d.funding && num(d.funding.funding_rate);
  if (oi == null && funding == null) return null;
  return { oiUsd: oi, funding, credits: num(b.meta && b.meta.credits_used) || 0 };
}
async function fetchDerivs(sym) {
  if (!PERP_SYMS.includes(sym)) return { ls: null, perp: null, credits: 0 };
  const pair = sym + "/USDT";
  const [lsR, pR] = await Promise.allSettled([
    surf(["exchange-long-short-ratio", "--pair", pair, "--interval", "1d", "--limit", "30", "-o", "json"]).then(parseLongShort),
    surf(["exchange-perp", "--pair", pair, "-o", "json"]).then(parsePerp)
  ]);
  const ls = lsR.status === "fulfilled" ? lsR.value : null;
  const perp = pR.status === "fulfilled" ? pR.value : null;
  return { ls, perp, credits: (ls && ls.credits || 0) + (perp && perp.credits || 0) };
}

async function fetchSignals(sym, mode) {
  const deep = mode === "research";
  // Fire all CLI calls concurrently to keep total latency low.
  const pricePromise = surf(["market-price", "--symbol", sym, "-o", "json"]);
  const fgPromise = surf(["market-fear-greed", "-o", "json"])
    .then((r) => parseSeriesValue(r, ["value", "index", "score", "fng", "fear_greed", "v"]))
    .catch(() => ({ value: null, credits: 0 }));
  const rsiPromise = surf(["market-price-indicator", "--indicator", "RSI", "--symbol", sym, "--interval", "1d", "-o", "json"])
    .then((r) => parseSeriesValue(r, ["value", "rsi", "RSI", "v"]))
    .catch(() => ({ value: null, credits: 0 }));
  // Heavy signals only in Research mode (saves credits on Instant scans).
  const newsPromise = deep ? fetchNews(sym).catch(() => null) : Promise.resolve(null);
  const socialPromise = deep ? fetchSocial(sym).catch(() => null) : Promise.resolve(null);
  const onchainPromise = deep ? fetchOnchain(sym).catch(() => null) : Promise.resolve(null);
  const etfPromise = deep ? fetchEtf(sym).catch(() => null) : Promise.resolve(null);
  const derivsPromise = deep ? fetchDerivs(sym).catch(() => ({ ls: null, perp: null, credits: 0 })) : Promise.resolve({ ls: null, perp: null, credits: 0 });

  let priceRaw;
  try {
    priceRaw = await pricePromise;
  } catch (e) {
    const msg = String(e && e.message || e);
    const extra = e && e.stderr ? " [" + String(e.stderr).slice(0, 200).trim() + "]" : "";
    if (msg.startsWith("Could not run")) throw e;
    if (msg.includes("ENOENT")) throw new Error("Surf CLI not found on PATH. In Git Bash run `which surf`, then start: SURF_BIN=\"<path>\" npm start");
    throw new Error("Surf CLI error — run `surf auth` or check daily credits." + extra);
  }
  const price = parsePrice(priceRaw);
  if (!price) {
    const snip = (typeof priceRaw === "string" ? priceRaw : JSON.stringify(priceRaw)).slice(0, 180).replace(/\s+/g, " ");
    throw new Error("Got output from surf but no price field. Output was: " + snip);
  }

  const fgR = await fgPromise, rsiR = await rsiPromise, news = await newsPromise;
  const social = await socialPromise, onchain = await onchainPromise;
  const etf = await etfPromise, derivs = await derivsPromise;
  const credits = price.credits + (fgR.credits || 0) + (rsiR.credits || 0) + (news && news.credits || 0)
    + (social && social.credits || 0) + (onchain && onchain.credits || 0) + (etf && etf.credits || 0) + (derivs && derivs.credits || 0);
  return { price: price.last, chg: price.chg, fg: fgR.value, rsi: rsiR.value, news, social, onchain, etf, ls: derivs.ls, perp: derivs.perp, credits };
}

/* ---------- token scoring ---------- */
async function scoreToken(sym, mode) {
  const sig = await fetchSignals(sym, mode);
  if (!sig) throw new Error(`Surf CLI returned no price for ${sym}. Try: surf auth  (or check daily credits).`);

  const r = rng(hash(sym + "-live"));
  const chg = sig.chg;

  // real momentum from 24h change
  const momentum = clamp(Math.round(10 + chg * 0.66), 0, 20);
  // real technicals from RSI (peak near 60, penalise overbought / oversold)
  const tech = sig.rsi != null ? clamp(Math.round(15 - Math.abs(sig.rsi - 60) / 60 * 15), 0, 15) : Math.round(15 * (0.4 + r() * 0.5));
  // real market sentiment from Fear & Greed
  const sentiment = sig.fg != null ? clamp(Math.round(sig.fg / 100 * 15), 0, 15) : Math.round(15 * (0.4 + r() * 0.5));

  const est = (max) => Math.round(max * (0.35 + r() * 0.6));
  const newsLive = sig.news && sig.news.score != null;
  const socialLive = sig.social && sig.social.score != null;
  const onchainLive = sig.onchain && sig.onchain.score != null;
  const breakdown = [
    { key:"momentum",  label:"Price momentum",   value:momentum,   max:20, color:COL.momentum,  est:false },
    { key:"tech",      label:"Technicals · RSI", value:tech,       max:15, color:COL.tech,      est:sig.rsi == null },
    { key:"sentiment", label:"Market sentiment", value:sentiment,  max:15, color:COL.sentiment, est:sig.fg == null },
    { key:"onchain",   label:"On-chain activity",value:onchainLive ? sig.onchain.score : est(20), max:20, color:COL.onchain, est:!onchainLive },
    { key:"social",    label:"Social attention", value:socialLive ? sig.social.score : est(20), max:20, color:COL.social, est:!socialLive },
    { key:"news",      label:"News attention",   value:newsLive ? sig.news.score : est(10), max:10, color:COL.news, est:!newsLive },
  ];
  const score = breakdown.reduce((a, b) => a + b.value, 0);
  const verdict = score >= 75 ? "STRONG SIGNAL" : score >= 60 ? "ON WATCHLIST" : score >= 42 ? "NEUTRAL" : "WEAK SIGNAL";

  const why = [
    { tone: chg >= 0 ? "pos" : "neg", html:`Price is <b>${chg >= 0 ? "up" : "down"} ${Math.abs(chg).toFixed(2)}%</b> (24h) at ${fmt(sig.price)}.` },
  ];
  if (sig.fg != null) why.push({ tone: sig.fg >= 55 ? "pos" : sig.fg <= 30 ? "neg" : "neu", html:`Market <b>Fear &amp; Greed at ${Math.round(sig.fg)}</b> — ${sig.fg >= 55 ? "greed" : sig.fg <= 30 ? "fear" : "neutral"}.` });
  if (sig.rsi != null) why.push({ tone: sig.rsi > 70 ? "neg" : sig.rsi >= 45 ? "pos" : "neu", html:`<b>RSI ${Math.round(sig.rsi)}</b> — ${sig.rsi > 70 ? "overbought" : sig.rsi < 30 ? "oversold" : "healthy range"}.` });
  if (socialLive) why.push({ tone: sig.social.sentiment >= 0.1 ? "pos" : sig.social.sentiment <= -0.1 ? "neg" : "neu", html:`Social: <b>${(sig.social.smart || 0).toLocaleString()} smart followers</b>, sentiment ${sig.social.sentiment >= 0 ? "+" : ""}${(sig.social.sentiment || 0).toFixed(2)} (7d).` });
  if (onchainLive) why.push({ tone:"pos", html:`On-chain: <b>${(sig.onchain.transfers || 0).toLocaleString()} transfers</b>, ${(sig.onchain.receivers || 0).toLocaleString()} receivers, ${fmtUsd(sig.onchain.usd)} moved (7d).` });
  if (sig.etf && sig.etf.net != null) why.push({ tone: sig.etf.net >= 0 ? "pos" : "neg", html:`Spot ${sym} ETFs: net <b>${fmtUsdSigned(sig.etf.net)}</b> today${sig.etf.streak > 1 ? ` (${sig.etf.streak}d of ${sig.etf.net >= 0 ? "inflows" : "outflows"})` : ""}${sig.etf.topOut && sig.etf.topOut.ticker ? `, ${sig.etf.topOut.ticker} led` : ""}.` });
  if (sig.perp && sig.perp.oiUsd != null) why.push({ tone:"neu", html:`Perp <b>open interest ${fmtUsd(sig.perp.oiUsd)}</b>${sig.perp.funding != null ? `, funding ${(sig.perp.funding * 100).toFixed(3)}% (${sig.perp.funding >= 0 ? "longs pay" : "shorts pay"})` : ""}.` });
  if (sig.ls && sig.ls.ratio != null) why.push({ tone: sig.ls.ratio > 2 ? "neg" : "neu", html:`Long/short ratio <b>${sig.ls.ratio.toFixed(2)}</b> — ${sig.ls.ratio > 1.2 ? "longs crowded" : sig.ls.ratio < 0.8 ? "shorts crowded" : "balanced"}.` });
  if (newsLive && sig.news.latest && sig.news.latest.title) why.push({ tone:"neu", html:`Latest news: <b>${escapeHtml(sig.news.latest.title)}</b> — ${escapeHtml(sig.news.latest.source || "")}.` });

  const liveList = ["price", "technicals", "market sentiment"]
    .concat(socialLive ? ["social"] : []).concat(onchainLive ? ["on-chain"] : []).concat(newsLive ? ["news"] : []);
  const estList = breakdown.filter((b) => b.est).map((b) => b.label.toLowerCase());
  why.push({ tone:"neu", html: estList.length
    ? `Live from Surf CLI: <b>${liveList.join(", ")}</b>. Estimated: ${estList.join(", ")} (shown dimmed).`
    : `All inputs live from Surf CLI: <b>${liveList.join(", ")}</b>.` });

  const tldr = buildTLDR(sym, score, verdict, chg, sig, { socialLive, onchainLive, newsLive });

  return { kind:"token", source:"Surf CLI", mode: mode === "research" ? "research" : "instant", credits:sig.credits, subject:{ symbol:sym, name:NAMES[sym] || sym, price:sig.price, change24h:chg }, score, breakdown, verdict, why, tldr, risk:riskFor(sym, r) };
}

/* Compose a short narrative summary from the real signals (no extra credits) */
function buildTLDR(sym, score, verdict, chg, sig, live) {
  const bias = score >= 70 ? "constructive" : score >= 55 ? "mixed-to-positive" : score >= 42 ? "neutral" : "cautious";
  const parts = [];
  parts.push(`<b>${sym}</b> reads <b>${bias}</b> right now (Alpha Score ${score}/100, ${verdict.toLowerCase()}).`);
  const px = `Price is ${chg >= 0 ? "up" : "down"} ${Math.abs(chg).toFixed(2)}% over 24h at ${fmt(sig.price)}`;
  const rsiBit = sig.rsi != null ? `, with RSI ${Math.round(sig.rsi)} (${sig.rsi > 70 ? "overbought" : sig.rsi < 30 ? "oversold" : "mid-range"})` : "";
  parts.push(px + rsiBit + ".");
  if (sig.fg != null) {
    const fgw = sig.fg <= 30 ? "fear" : sig.fg >= 55 ? "greed" : "neutral";
    const tension = (chg >= 0 && sig.fg <= 30) ? " — price is holding up despite a fearful tape" : (chg < 0 && sig.fg >= 55) ? " — price is soft even as the market leans greedy" : "";
    parts.push(`The broader market sits in <b>${fgw}</b> (F&amp;G ${Math.round(sig.fg)})${tension}.`);
  }
  const extras = [];
  if (live.onchainLive) extras.push(`${(sig.onchain.transfers || 0).toLocaleString()} on-chain transfers and ${fmtUsd(sig.onchain.usd)} moved (7d)`);
  if (live.socialLive) extras.push(`${(sig.social.smart || 0).toLocaleString()} smart followers tracking it`);
  if (extras.length) parts.push(`Under the surface: ${extras.join(", ")}${live.newsLive ? ", and fresh news flow" : ""}.`);
  else if (live.newsLive) parts.push(`News flow is active on ${sym}.`);
  // Derivatives & flows sentence
  const flow = [];
  if (sig.etf && sig.etf.net != null) flow.push(`spot ETFs net <b>${fmtUsdSigned(sig.etf.net)}</b>${sig.etf.streak > 1 ? ` (${sig.etf.streak}d ${sig.etf.net >= 0 ? "in" : "out"})` : ""}`);
  if (sig.ls && sig.ls.ratio != null) flow.push(`long/short ${sig.ls.ratio.toFixed(2)}`);
  if (sig.perp && sig.perp.oiUsd != null) flow.push(`OI ${fmtUsd(sig.perp.oiUsd)}`);
  if (flow.length) parts.push(`Derivatives & flows: ${flow.join(", ")}.`);
  return parts.join(" ");
}
function fmtUsdSigned(v){ v = num(v) || 0; const s = v < 0 ? "-" : "+"; return s + fmtUsd(Math.abs(v)); }

function riskFor(sym, r) {
  const major = MAJORS.includes(sym);
  const liq = major || r() > .3, creatorClean = major || r() > .45, honeypot = !major && r() > .8, concentrated = !major && r() > .5;
  const items = [
    { label:"Liquidity",      state: liq ? "ok" : "warn",          note: liq ? "locked" : "unlocked" },
    { label:"Creator wallet", state: creatorClean ? "ok" : "bad",  note: creatorClean ? "no flags" : "flagged" },
    { label:"Honeypot",       state: honeypot ? "bad" : "ok",      note: honeypot ? "pattern found" : "none detected" },
    { label:"Holders",        state: concentrated ? "warn" : "ok", note: concentrated ? "top-heavy" : "healthy spread" },
  ];
  const bad = items.filter((i) => i.state === "bad").length, warn = items.filter((i) => i.state === "warn").length;
  return { level: bad ? "high" : warn ? "med" : "low", items };
}

/* ---------- wallet (estimated until wallet endpoints wired) ---------- */
async function scoreWallet(addr) {
  const r = rng(hash(addr)); const mk = (m) => Math.round(m * (0.3 + r() * 0.65));
  const breakdown = [
    { key:"pnl", label:"Realized PnL", value:mk(30), max:30, color:COL.tech, est:true },
    { key:"timing", label:"Entry timing", value:mk(25), max:25, color:COL.momentum, est:true },
    { key:"activity", label:"Recent activity", value:mk(20), max:20, color:COL.social, est:true },
    { key:"holdings", label:"Holdings quality", value:mk(15), max:15, color:COL.sentiment, est:true },
    { key:"copy", label:"Copy-trade value", value:mk(10), max:10, color:COL.news, est:true },
  ];
  const score = breakdown.reduce((a, b) => a + b.value, 0);
  const lab = ["smart money", "fund", "active trader", "whale"][Math.floor(r() * 4)];
  return { kind:"wallet", source:"demo", credits:0, subject:{ address:addr, name:lab, price:null }, score,
    breakdown, verdict: score >= 70 ? "SMART MONEY" : score >= 50 ? "ACTIVE" : "LOW SIGNAL",
    why:[{ tone:"neu", html:`Wallet scan is estimated — wire <b>wallet-detail</b> / <b>hyperliquid-account</b> to make it live.` }],
    risk:{ level:"low", items:[{label:"Label",state:"ok",note:lab},{label:"Sanctions",state:"ok",note:"none"},{label:"Mixer use",state:"ok",note:"none"},{label:"Age",state:"ok",note:(1+Math.floor(r()*4))+"y"}] } };
}

/* ---------- helpers ---------- */
function symbolsIn(q){ const up = q.toUpperCase(); return Object.keys(NAMES).filter((k) => new RegExp("\\b" + k + "\\b").test(up)); }
function walletIn(q){ const m = q.match(/0x[a-fA-F0-9]{6,}/); return m ? m[0] : null; }
function guessSym(q){ const m = q.match(/[A-Za-z]{2,6}/g); return (m && m[0]) ? m[0].toUpperCase() : "SOL"; }
function num(v){ const n = typeof v === "string" ? parseFloat(v) : v; return Number.isFinite(n) ? n : null; }
function escapeHtml(s){ return String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;" }[c])); }
function clamp(v, a, b){ return Math.max(a, Math.min(b, v)); }
function fmt(p){ if(p>=1000) return "$"+Math.round(p).toLocaleString(); if(p>=1) return "$"+p.toFixed(2); return "$"+p.toPrecision(3); }
function fmtUsd(v){ v=num(v)||0; if(v>=1e9) return "$"+(v/1e9).toFixed(1)+"B"; if(v>=1e6) return "$"+(v/1e6).toFixed(1)+"M"; if(v>=1e3) return "$"+(v/1e3).toFixed(0)+"K"; return "$"+Math.round(v); }
function hash(s){ let h = 2166136261; for (let i = 0; i < s.length; i++){ h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
function rng(seed){ let s = seed; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }

/* ---------- parsers for pulse/rankings ---------- */
function fgLabel(v){ return v == null ? "—" : v < 25 ? "Extreme Fear" : v < 45 ? "Fear" : v < 55 ? "Neutral" : v < 75 ? "Greed" : "Extreme Greed"; }

function parseFearGreed(raw){
  const b = unwrap(raw);
  const arr = Array.isArray(b && b.data) ? b.data : [];
  const credits = num(b && b.meta && b.meta.credits_used) || 0;
  if (!arr.length) return { value: null, label: "—", points: [], live: false, credits };
  const value = Math.round(num(arr[0].value));                 // data is newest-first
  const points = arr.slice(0, 30).map((d) => num(d.value)).filter((v) => v != null).reverse();
  return { value, label: arr[0].classification || fgLabel(value), points, live: value != null, credits };
}

function parseSignalProjects(raw){
  const b = unwrap(raw);
  const arr = Array.isArray(b && b.data) ? b.data : [];
  const credits = num(b && b.meta && b.meta.credits_used) || 0;
  const rows = arr.slice(0, 6).map((it) => {
    const pcp = it.price_change_percent;
    const chg = pcp && typeof pcp === "object" ? num(pcp["24h"]) : num(pcp);
    const note = [it.core_state && it.core_state.state, it.driver].filter(Boolean).join(" · ") || (it.metric || "");
    return { rank: it.rank, sym: it.symbol, name: it.name, price: num(it.price), chg: chg == null ? 0 : +chg.toFixed(1), heat: Math.round(num(it.score) || 0), note };
  });
  return { rows, sample: false, credits };
}

function parseSocialRanking(raw){
  const b = unwrap(raw);
  const arr = Array.isArray(b && b.data) ? b.data : [];
  const credits = num(b && b.meta && b.meta.credits_used) || 0;
  const leaders = arr.slice(0, 12).map((it) => ({
    rank: it.rank,
    sym: (it.token && it.token.symbol) || (it.project && it.project.name) || "—",
    name: (it.project && it.project.name) || "",
    sentiment: it.sentiment || "neutral",
    tag: (it.tags && it.tags[0]) || ""
  }));
  const pos = leaders.filter((l) => l.sentiment === "positive").length;
  const sentimentPct = leaders.length ? Math.round(pos / leaders.length * 100) : null;
  return { leaders, sentimentPct, positive: pos, total: leaders.length, credits };
}

/* ---------- Crypto Pulse (all live from Surf CLI) ---------- */
async function getPulse(){
  let fg = { value: null, label: "—", points: [], live: false, credits: 0 };
  let sr = { leaders: [], sentimentPct: null, positive: 0, total: 0, credits: 0 };
  const [fgR, srR] = await Promise.allSettled([
    surf(["market-fear-greed", "-o", "json"]).then(parseFearGreed),
    surf(["social-ranking", "--time-range", "24h", "--limit", "12", "-o", "json"]).then(parseSocialRanking)
  ]);
  if (fgR.status === "fulfilled") fg = fgR.value;
  if (srR.status === "fulfilled") sr = srR.value;
  return {
    fearGreed: { value: fg.value, label: fg.label, points: fg.points, live: fg.live },
    sentiment: { value: sr.sentimentPct, positive: sr.positive, total: sr.total, live: sr.sentimentPct != null },
    leaders: sr.leaders,
    credits: (fg.credits || 0) + (sr.credits || 0)
  };
}

/* ---------- Signal Rankings (live from signal-projects) ---------- */
async function getRankings(){
  try {
    const parsed = parseSignalProjects(await surf(["signal-projects", "--time-range", "24h", "--limit", "6", "-o", "json"]));
    if (parsed.rows.length) return { rows: parsed.rows, sample: false, credits: parsed.credits };
  } catch (e) { /* fall through to sample */ }
  // fallback sample if the call fails
  return { sample: true, rows: [
    { rank:1, sym:"—", name:"", price:0, chg:0, heat:0, note:"Signal Rankings unavailable — check connector / credits." }
  ] };
}

module.exports = { analyze, parsePrice, parseSeriesValue, runRaw, getPulse, getRankings };
