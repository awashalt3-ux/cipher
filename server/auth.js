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

export function cookie(name, value, { maxAge = null, httpOnly = true, sameSite = "Lax", path = "/" } = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${path}`, `SameSite=${sameSite}`];
  if (httpOnly) parts.push("HttpOnly");
  if (maxAge != null) parts.push(`Max-Age=${Math.floor(maxAge / 1000)}`);
  if (config.appUrl.startsWith("https://")) parts.push("Secure");
  return parts.join("; ");
}

export function clearCookie(name) {
  return `${name}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`;
}

export function createSession(userId, { ip = "", userAgent = "" } = {}) {
  const token = randomToken(32);
  const sid = id("SES");
  const csrf = randomToken(24);
  const createdAt = now();
  q.run(
    `INSERT INTO sessions (id, user_id, token_hash, csrf, created_at, last_seen_at, expires_at, ip, user_agent)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    sid, userId, sha256(token), csrf, createdAt, createdAt, createdAt + config.sessionTtl, ip.slice(0, 64), userAgent.slice(0, 250),
  );
  return { sid, token, csrf, expiresAt: createdAt + config.sessionTtl };
}

export function sessionFromRequest(req) {
  const cookies = parseCookies(req.headers.cookie || "");
  const token = cookies[COOKIE];
  if (!token) return null;
  const row = q.one("SELECT * FROM sessions WHERE token_hash = ?", sha256(token));
  if (!row) return null;
  if (row.expires_at < now()) {
    q.run("DELETE FROM sessions WHERE id = ?", row.id);
    return null;
  }
  const user = q.one("SELECT * FROM users WHERE id = ?", row.user_id);
  if (!user) return null;
  return { session: row, user };
}

export function touchSession(session) {
  if (now() - Number(session.last_seen_at) < 60000) return;
  q.run("UPDATE sessions SET last_seen_at = ? WHERE id = ?", now(), session.id);
}

export function destroySession(sessionId) {
  q.run("DELETE FROM sessions WHERE id = ?", sessionId);
}

export function audit(userId, action, detail = "", ip = "") {
  q.run(
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
    verified: Boolean(user.email_verified),
    totpEnabled: Boolean(user.totp_enabled),
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
