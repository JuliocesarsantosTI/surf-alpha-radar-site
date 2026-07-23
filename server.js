#!/usr/bin/env node
/* ==================================================================
   Surf Alpha Radar — Local Connector
   A tiny, zero-dependency bridge between the browser extension and
   Surf CLI. Runs on your machine, uses YOUR Surf credits, and never
   routes anything through a shared server.

     GET  /health   -> { ok: true }
     POST /scan     -> { ...structured result }  (body: { query })

   Start:  node server.js       (or: npm start)
   Port:   8787 (override with PORT env var)
================================================================== */

const http = require("http");
const fs = require("fs");
const path = require("path");
const { analyze, getPulse, getRankings, verifyToken } = require("./surf");

const PORT = process.env.PORT || 8787;
const cache = new Map();                 // query -> { at, data }
const TTL_MS = 5 * 60 * 1000;            // 5 min smart cache (saves credits)
let pulseCache = null;                    // { at, data }
let rankingsCache = null;                 // { at, data }
const WEB_DIR = path.join(__dirname, "web");
const MIME = { ".html":"text/html", ".css":"text/css", ".js":"text/javascript", ".json":"application/json", ".svg":"image/svg+xml", ".png":"image/png", ".ico":"image/x-icon" };

function cors(res) {
  // The extension calls from its service worker; these headers also allow
  // direct localhost calls during development.
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function json(res, code, obj) {
  cors(res);
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}

const server = http.createServer((req, res) => {
  if (req.method === "OPTIONS") { cors(res); res.writeHead(204); return res.end(); }

  if (req.method === "GET" && req.url === "/health") {
    return json(res, 200, { ok: true, service: "surf-alpha-radar", version: "1.0.0" });
  }

  if (req.method === "GET" && req.url === "/diag") {
    const { runRaw } = require("./surf");
    const variants = [
      ["market-price", "--symbol", "BTC", "-o", "json"],
      ["market-price", "--symbol", "BTC"],
      ["--version"]
    ];
    (async () => {
      const results = [];
      for (const v of variants) {
        const r = await runRaw(v).catch((e) => ({ text:"", error:e, stderr:"" }));
        results.push({
          args: v.join(" "),
          ok: !!r.text,
          outLen: (r.text || "").length,
          outHead: (r.text || "").slice(0, 220),
          err: r.error ? String(r.error.message || r.error).slice(0, 120) : null,
          errHead: (r.stderr || "").slice(0, 160)
        });
      }
      json(res, 200, { bin: process.env.SURF_BIN || "surf", platform: process.platform, results });
    })();
    return;
  }

  if (req.method === "POST" && req.url === "/scan") {
    let body = "";
    req.on("data", (c) => { body += c; if (body.length > 1e5) req.destroy(); });
    req.on("end", async () => {
      let query = "", mode = "instant";
      try { const j = JSON.parse(body || "{}"); query = (j.query || "").toString().trim(); mode = j.mode === "research" ? "research" : "instant"; } catch { /* ignore */ }
      if (!query) return json(res, 400, { error: "missing query" });

      // smart cache (per query + mode)
      const key = mode + "::" + query.toLowerCase();
      const hit = cache.get(key);
      if (hit && Date.now() - hit.at < TTL_MS) {
        return json(res, 200, { ...hit.data, cached: true });
      }

      try {
        const data = await analyze(query, mode);
        cache.set(key, { at: Date.now(), data });
        return json(res, 200, data);
      } catch (e) {
        console.error("scan error:", (e && e.stack) || e);
        return json(res, 500, { error: String(e.message || e) });
      }
    });
    return;
  }

  if (req.method === "POST" && req.url === "/verify") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      let sym = "", address = "", chain = "";
      try {
        const j = JSON.parse(body || "{}");
        sym = (j.symbol || "").toString().trim();
        address = (j.address || "").toString().trim();
        chain = (j.chain || "").toString().trim();
      } catch { /* ignore */ }
      if (!sym && !address) return json(res, 400, { error: "missing symbol or address" });
      const key = "verify::" + (address ? address.toLowerCase() : sym.toLowerCase());
      const hit = cache.get(key);
      // Verification is stable — cache it for an hour to keep credits near zero.
      if (hit && Date.now() - hit.at < 60 * 60 * 1000) return json(res, 200, { ...hit.data, cached: true });
      try {
        const data = await verifyToken({ symbol: sym, address, chain });
        cache.set(key, { at: Date.now(), data });
        return json(res, 200, data);
      } catch (e) {
        return json(res, 500, { error: String(e.message || e) });
      }
    });
    return;
  }

  if (req.method === "GET" && req.url === "/pulse") {
    if (pulseCache && Date.now() - pulseCache.at < 10 * 60 * 1000) return json(res, 200, { ...pulseCache.data, cached: true });
    getPulse().then((data) => { pulseCache = { at: Date.now(), data }; json(res, 200, data); })
      .catch((e) => json(res, 500, { error: String(e.message || e) }));
    return;
  }

  if (req.method === "GET" && req.url === "/rankings") {
    if (rankingsCache && Date.now() - rankingsCache.at < 10 * 60 * 1000) return json(res, 200, { ...rankingsCache.data, cached: true });
    getRankings().then((data) => { rankingsCache = { at: Date.now(), data }; json(res, 200, data); })
      .catch((e) => json(res, 500, { error: String(e.message || e) }));
    return;
  }

  // ---- static web app ----
  if (req.method === "GET") {
    let urlPath = req.url.split("?")[0];
    if (urlPath === "/") urlPath = "/index.html";
    const filePath = path.join(WEB_DIR, path.normalize(urlPath).replace(/^(\.\.[/\\])+/, ""));
    if (filePath.startsWith(WEB_DIR) && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      cors(res);
      res.writeHead(200, { "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream" });
      return fs.createReadStream(filePath).pipe(res);
    }
  }

  json(res, 404, { error: "not found" });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`\n  Surf Alpha Radar — Local Connector`);
  console.log(`  Web app:  http://127.0.0.1:${PORT}`);
  console.log(`  health:   http://127.0.0.1:${PORT}/health\n`);
});
