import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { q } from "./db.js";
import { sessionFromRequest, touchSession, parseCookies, COOKIE, clientIp } from "./auth.js";
import { sendJson, serveStatic, readJson, addCookies } from "./http.js";
import { startSyncLoop } from "./sync.js";
import * as auth from "./routes.auth.js";
import * as boxes from "./routes.mailboxes.js";
import { escapeHtml } from "./util.js";

const PUBLIC_DIR = path.join(config.root, "public");

/* ------------------------------------------------------------------ */
/* Table de routage                                                    */
/* ------------------------------------------------------------------ */

const routes = [];
const add = (method, pattern, handler, options = {}) => routes.push({ method, pattern, handler, options });

const AUTH = { auth: true };
const PUBLIC = { auth: false };
const CSRF = { csrf: true };

/* ---- pages ---- */
add("GET", /^\/$/, ({ res, user }) => renderPage(res, user ? "app" : "landing"), PUBLIC);
add("GET", /^\/login$/, ({ res, user, redirect }) => (user ? redirect("/") : renderPage(res, "login")), PUBLIC);
add("GET", /^\/register$/, ({ res, user, redirect }) => (user ? redirect("/") : renderPage(res, "register")), PUBLIC);
add("GET", /^\/verify$/, ({ res }) => renderPage(res, "verify"), PUBLIC);
add("GET", /^\/app$/, ({ res, user, redirect }) => (user ? renderPage(res, "app") : redirect("/login")), PUBLIC);

/* ---- auth ---- */
add("POST", /^\/api\/auth\/register$/, auth.register, PUBLIC);
add("POST", /^\/api\/auth\/verify$/, auth.verifyEmail, PUBLIC);
add("POST", /^\/api\/auth\/login$/, auth.login, PUBLIC);
add("POST", /^\/api\/auth\/logout$/, auth.logout, PUBLIC);
add("GET", /^\/api\/auth\/me$/, auth.me, PUBLIC);
add("POST", /^\/api\/auth\/resend$/, auth.resendPublic, PUBLIC);
add("POST", /^\/api\/auth\/verification$/, auth.resendVerification, AUTH);
add("POST", /^\/api\/auth\/password$/, auth.changePassword, { ...AUTH, ...CSRF });
add("POST", /^\/api\/auth\/totp\/setup$/, auth.setupTotp, { ...AUTH, ...CSRF });
add("POST", /^\/api\/auth\/totp\/enable$/, auth.enableTotp, { ...AUTH, ...CSRF });
add("POST", /^\/api\/auth\/totp\/disable$/, auth.disableTotp, { ...AUTH, ...CSRF });
add("POST", /^\/api\/auth\/totp\/backup-codes$/, auth.regenerateBackupCodes, { ...AUTH, ...CSRF });
add("GET", /^\/api\/auth\/sessions$/, auth.listSessions, AUTH);
add("DELETE", /^\/api\/auth\/sessions\/([^/]+)$/, auth.revokeSession, { ...AUTH, ...CSRF });

/* ---- boîtes ---- */
add("GET", /^\/api\/mailboxes$/, boxes.listMailboxes, AUTH);
add("POST", /^\/api\/mailboxes$/, boxes.createMailbox, { ...AUTH, ...CSRF });
add("POST", /^\/api\/mailboxes\/import$/, boxes.importMailbox, { ...AUTH, ...CSRF });
add("GET", /^\/api\/mailboxes\/domains$/, boxes.domains, AUTH);
add("POST", /^\/api\/mailboxes\/refresh$/, boxes.refreshAll, { ...AUTH, ...CSRF });
add("GET", /^\/api\/mailboxes\/stats$/, boxes.mailboxStats, AUTH);
add("GET", /^\/api\/mailboxes\/([^/]+)$/, boxes.mailboxDetails, AUTH);
add("PATCH", /^\/api\/mailboxes\/([^/]+)$/, boxes.updateMailbox, { ...AUTH, ...CSRF });
add("DELETE", /^\/api\/mailboxes\/([^/]+)$/, boxes.deleteMailbox, { ...AUTH, ...CSRF });
add("POST", /^\/api\/mailboxes\/([^/]+)\/refresh$/, boxes.refreshMailbox, { ...AUTH, ...CSRF });
add("POST", /^\/api\/mailboxes\/([^/]+)\/address$/, boxes.changeMailboxAddress, { ...AUTH, ...CSRF });
add("GET", /^\/api\/mailboxes\/([^/]+)\/messages$/, boxes.listMessages, AUTH);
add("GET", /^\/api\/mailboxes\/([^/]+)\/export$/, boxes.exportMailbox, AUTH);

/* ---- messages ---- */
add("GET", /^\/api\/messages\/([^/]+)$/, boxes.getMessage, AUTH);
add("PATCH", /^\/api\/messages\/([^/]+)$/, boxes.updateMessage, { ...AUTH, ...CSRF });
add("DELETE", /^\/api\/messages\/([^/]+)$/, boxes.deleteMessage, { ...AUTH, ...CSRF });
add("POST", /^\/api\/messages\/bulk$/, boxes.bulkMessages, { ...AUTH, ...CSRF });

/* ------------------------------------------------------------------ */
/* Rendu HTML                                                          */
/* ------------------------------------------------------------------ */

const pageCache = new Map();

/** Empreinte des assets : change dès qu'un fichier est modifié, pour invalider les caches. */
let assetStamp = "";
function computeAssetStamp() {
  const dir = path.join(PUBLIC_DIR, "assets");
  let latest = 0;
  const walk = (current) => {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else {
        try {
          latest = Math.max(latest, fs.statSync(full).mtimeMs);
        } catch {}
      }
    }
  };
  walk(dir);
  assetStamp = Math.floor(latest).toString(36);
}
computeAssetStamp();
setInterval(computeAssetStamp, 5000).unref?.();

function renderPage(res, name, status = 200) {
  const file = path.join(PUBLIC_DIR, `${name}.html`);
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return sendText(res, 404, "Page introuvable");
  }

  // le cache est invalidé dès que le fichier change : aucune redémarrage nécessaire
  let entry = pageCache.get(name);
  if (!entry || entry.mtime !== stat.mtimeMs) {
    entry = { mtime: stat.mtimeMs, html: fs.readFileSync(file, "utf8") };
    pageCache.set(name, entry);
  }

  const versioned = entry.html.replace(/(src|href)="\/assets\/([^"?]+)"/g, (_, attr, f) => `${attr}="/assets/${f}?v=${assetStamp}"`);

  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-cache",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
    "Permissions-Policy": "geolocation=(), microphone=(), camera=(), interest-cohort=()",
    "Content-Security-Policy":
      "default-src 'self'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; script-src 'self' 'unsafe-inline'; frame-src 'none'; connect-src 'self'; form-action 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'",
  });
  res.end(versioned);
}

/* ------------------------------------------------------------------ */
/* Serveur                                                             */
/* ------------------------------------------------------------------ */

function matchRoute(method, pathname) {
  for (const route of routes) {
    if (route.method !== method) continue;
    const match = route.pattern.exec(pathname);
    if (match) return { route, params: match.slice(1) };
  }
  return null;
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const pathname = url.pathname;

  // en-têtes de sécurité de base
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");

  // fichiers statiques
  if (pathname.startsWith("/assets/") || pathname === "/favicon.ico" || pathname === "/manifest.webmanifest") {
    const root = pathname === "/favicon.ico" ? path.join(PUBLIC_DIR, "assets") : PUBLIC_DIR;
    if (serveStatic(root, pathname === "/favicon.ico" ? "/favicon.ico" : pathname, res, { assetStamp })) return;
  }

  const found = matchRoute(req.method, pathname);
  if (!found) {
    if (pathname.startsWith("/api/")) return sendJson(res, 404, { ok: false, error: "Route introuvable." });
    return renderPage(res, "notfound", 404);
  }

  const { route, params } = found;
  const ctx = {
    req,
    res,
    url,
    query: url.searchParams,
    params: Object.fromEntries(params.map((value, index) => [index, value])),
    get param() { return params[0]; },
    user: null,
    session: null,
    redirect(location) {
      res.writeHead(302, { Location: location });
      res.end();
    },
  };
  // accès par nom pour lisibilité
  ctx.params = { id: params[0], ...Object.fromEntries(params.map((v, i) => [i, v])) };

  // session
  let sessionCtx = null;
  try {
    sessionCtx = sessionFromRequest(req);
  } catch (error) {
    console.error("[session]", error.message);
  }
  if (sessionCtx) {
    ctx.session = sessionCtx.session;
    ctx.user = sessionCtx.user;
    touchSession(sessionCtx.session);
  }

  if (route.options.auth && !ctx.user) {
    if (pathname.startsWith("/api/")) return sendJson(res, 401, { ok: false, error: "Authentification requise." });
    return ctx.redirect("/login");
  }

  // CSRF pour les mutations
  if (route.options.csrf) {
    const header = String(req.headers["x-csrf-token"] || "");
    if (!ctx.session || !header || header !== ctx.session.csrf) {
      return sendJson(res, 403, { ok: false, error: "Jeton CSRF invalide. Rechargez la page." });
    }
  }

  try {
    let body = {};
    if (req.method === "POST" || req.method === "PATCH" || req.method === "PUT") {
      body = await readJson(req, 2 * 1024 * 1024);
    }

    const result = await route.handler({ ...ctx, body });
    if (!result || res.writableEnded) return;

    if (result.cookies) addCookies(res, result.cookies);
    if (result.download) {
      res.writeHead(200, {
        "Content-Type": result.download.contentType,
        "Content-Disposition": `attachment; filename="${result.download.filename}"`,
        "Content-Length": Buffer.byteLength(result.download.body),
      });
      return res.end(result.download.body);
    }
    return sendJson(res, result.status || 200, result.body || { ok: true });
  } catch (error) {
    const status = error.status || 500;
    if (status >= 500) console.error(`[${req.method} ${pathname}]`, error);
    if (!res.writableEnded) {
      sendJson(res, status, { ok: false, error: status >= 500 ? "Erreur interne du serveur." : error.message });
    }
  }
}

export function createServer() {
  return http.createServer((req, res) => {
    handle(req, res).catch((error) => {
      console.error("[fatal]", error);
      if (!res.writableEnded) sendJson(res, 500, { ok: false, error: "Erreur interne." });
    });
  });
}

if (process.argv[1] && process.argv[1].endsWith("index.js")) {
  const server = createServer();
  server.listen(config.port, config.host, () => {
    console.log(`\n  Cipher Mail — ${config.appUrl}`);
    console.log(`  données : ${config.dataDir}`);
    console.log(`  SMTP    : ${config.smtp.host ? config.smtp.host : "non configuré (emails dans data/outbox)"}`);
    console.log(`  vérification email : ${config.requireEmailVerification ? "activée" : "désactivée"}\n`);
    startSyncLoop();
  });
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      console.log("\nArrêt…");
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 2000).unref();
    });
  }
}
