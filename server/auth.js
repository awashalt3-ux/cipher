import crypto from "node:crypto";
import { q } from "./db.js";
import { config } from "./config.js";
import { id, now, sha256, randomToken, clamp } from "./util.js";

export const COOKIE = "cipher_sid";

export function parseCookies(header = "") {
  const out = {};
  for (const part of String(header).split(";")) {
    const index = part.indexOf("=");
    if (index <= 0) continue;
    out[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return out;
}

/** Détecte HTTPS derrière un proxy (Wasmer Edge, Nginx, etc.). */
export function isHttps(req) {
  if (!req) return config.appUrl.startsWith("https://");
  const proto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim().toLowerCase();
  if (proto) return proto === "https";
  if (req.socket?.encrypted) return true;
  return config.appUrl.startsWith("https://");
}

/**
 * Construit un cookie.
 * `maxAge` à `null` => cookie de session (disparaît à la fermeture du navigateur).
 */
export function cookie(name, value, { maxAge = null, httpOnly = true, sameSite = "Lax", path = "/", secure = null } = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${path}`, `SameSite=${sameSite}`];
  if (httpOnly) parts.push("HttpOnly");
  if (maxAge != null) parts.push(`Max-Age=${Math.floor(maxAge / 1000)}`);
  if (secure ?? config.appUrl.startsWith("https://")) parts.push("Secure");
  return parts.join("; ");
}

export function clearCookie(name) {
  return `${name}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`;
}

export async function createSession(userId, { ip = "", userAgent = "", remember = true } = {}) {
  const token = randomToken(32);
  const sid = id("SES");
  const csrf = randomToken(24);
  const createdAt = now();
  const ttl = remember ? config.sessionTtl : config.sessionTtlShort;
  await q.run(
    `INSERT INTO sessions (id, user_id, token_hash, csrf, created_at, last_seen_at, expires_at, ip, user_agent)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    sid, userId, sha256(token), csrf, createdAt, createdAt, createdAt + ttl, ip.slice(0, 64), userAgent.slice(0, 250),
  );
  return { sid, token, csrf, expiresAt: createdAt + ttl, remember, ttl };
}

/** Renouvelle la session à mi-parcours : tant qu'on revient, on reste connecté. */
const RENEW_THRESHOLD = 2 * 24 * 3600 * 1000;

export async function sessionFromRequest(req) {
  const cookies = parseCookies(req.headers.cookie || "");
  const token = cookies[COOKIE];
  if (!token) return null;
  const row = await q.one("SELECT * FROM sessions WHERE token_hash = ?", sha256(token));
  if (!row) return null;

  const stamp = now();
  if (Number(row.expires_at) < stamp) {
    await q.run("DELETE FROM sessions WHERE id = ?", row.id);
    return null;
  }

  const user = await q.one("SELECT * FROM users WHERE id = ?", row.user_id);
  if (!user) return null;

  // Prolongation glissante : pas besoin de se reconnecter si on utilise le site.
  const remaining = Number(row.expires_at) - stamp;
  if (remaining < config.sessionTtl - RENEW_THRESHOLD) {
    const expiresAt = stamp + config.sessionTtl;
    await q.run("UPDATE sessions SET expires_at = ? WHERE id = ?", expiresAt, row.id);
    row.expires_at = expiresAt;
  }

  return { session: row, user };
}

export async function touchSession(session) {
  if (now() - Number(session.last_seen_at) < 60000) return;
  await q.run("UPDATE sessions SET last_seen_at = ? WHERE id = ?", now(), session.id);
}

export async function destroySession(sessionId) {
  await q.run("DELETE FROM sessions WHERE id = ?", sessionId);
}

export async function audit(userId, action, detail = "", ip = "") {
  await q.run(
    "INSERT INTO audit_log (id, user_id, action, detail, ip, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    id("LOG"), userId || null, action, String(detail).slice(0, 500), ip, now(),
  );
}

/* ---------------- limitation de débit ---------------- */

const buckets = new Map();

export function rateLimit(key, limit, windowMs) {
  const stamp = now();
  const bucket = buckets.get(key);
  if (!bucket || stamp > bucket.reset) {
    buckets.set(key, { count: 1, reset: stamp + windowMs });
    return { allowed: true, remaining: limit - 1, retryAfter: 0 };
  }
  bucket.count += 1;
  if (bucket.count > limit) {
    return { allowed: false, remaining: 0, retryAfter: Math.ceil((bucket.reset - stamp) / 1000) };
  }
  return { allowed: true, remaining: limit - bucket.count, retryAfter: 0 };
}

setInterval(() => {
  const stamp = now();
  for (const [key, bucket] of buckets) if (stamp > bucket.reset) buckets.delete(key);
}, 60000).unref?.();

export function clientIp(req) {
  const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return forwarded || req.socket?.remoteAddress || "";
}

export function publicUser(user) {
  return {
    id: user.id,
    email: user.email,
    displayName: user.display_name,
    verified: Boolean(Number(user.email_verified)),
    totpEnabled: Boolean(Number(user.totp_enabled)),
    createdAt: Number(user.created_at),
    lastLoginAt: user.last_login_at ? Number(user.last_login_at) : null,
    storageQuota: Number(user.storage_quota || 0),
  };
}

export const sessionCsrf = (session) => session?.csrf || "";
export const newId = id;
export const clampNumber = clamp;
export const hash = sha256;
export const token = randomToken;
export const cryptoRandom = crypto;
