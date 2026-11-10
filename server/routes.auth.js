import {
  hashPassword, verifyPassword, passwordProblems, id, now, randomToken, sha256,
  generateTotpSecret, verifyTotp, otpauthUrl, backupCodes, verifyTotp as checkTotp,
  encrypt, decrypt, safeEqual,
} from "./util.js";
import { q } from "./db.js";
import { config } from "./config.js";
import {
  createSession, destroySession, publicUser, audit, rateLimit, clientIp, COOKIE, cookie, clearCookie,
} from "./auth.js";
import { sendMail, verificationEmail, alertEmail } from "./mailer.js";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;

export function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function newVerificationToken(userId) {
  const token = randomToken(24);
  q.run("UPDATE users SET verify_token = ?, verify_sent_at = ? WHERE id = ?", sha256(token), now(), userId);
  return token;
}

async function dispatchVerification(user) {
  const token = newVerificationToken(user.id);
  const link = `${config.appUrl}/verify?token=${encodeURIComponent(token)}`;
  const mail = verificationEmail({ name: user.display_name, link });
  try {
    await sendMail({ to: user.email, ...mail });
  } catch (error) {
    console.error("[mail] échec d'envoi:", error.message);
  }
  return { link, mail };
}

function fail(status, message, extra = {}) {
  return { status, body: { ok: false, error: message, ...extra } };
}

export async function register({ body, req }) {
  const email = normalizeEmail(body.email);
  const displayName = String(body.displayName || "").trim().slice(0, 60);
  const password = String(body.password || "");

  const ip = clientIp(req);
  const limit = rateLimit(`register:${ip}`, 6, 60 * 60 * 1000);
  if (!limit.allowed) return fail(429, "Trop de tentatives. Réessayez plus tard.");

  if (!EMAIL_RE.test(email)) return fail(400, "Adresse email invalide.");
  if (displayName.length < 2) return fail(400, "Le nom doit contenir au moins 2 caractères.");
  const problems = passwordProblems(password);
  if (problems.length) return fail(400, `Mot de passe trop faible : il manque ${problems.join(", ")}.`);

  const existing = q.one("SELECT id FROM users WHERE email = ?", email);
  if (existing) return fail(409, "Un compte existe déjà avec cette adresse.");

  const userId = id("USR");
  const createdAt = now();
  q.run(
    `INSERT INTO users (id, email, display_name, password_hash, email_verified, created_at)
     VALUES (?, ?, ?, ?, 0, ?)`,
    userId, email, displayName, hashPassword(password), createdAt,
  );

  const user = q.one("SELECT * FROM users WHERE id = ?", userId);
  const { link, mail } = await dispatchVerification(user);
  audit(userId, "register", email, ip);

  return {
    status: 201,
    body: {
      ok: true,
      requiresVerification: config.requireEmailVerification,
      message: "Compte créé. Confirmez votre adresse pour l'activer.",
      previewLink: config.smtpConfigured ? undefined : link,
      previewBody: config.smtpConfigured ? undefined : mail.text,
    },
  };
}

export async function verifyEmail({ body, req }) {
  const token = String(body.token || "");
  if (!token) return fail(400, "Jeton manquant.");
  const user = q.one("SELECT * FROM users WHERE verify_token = ?", sha256(token));
  if (!user) return fail(400, "Lien de confirmation invalide ou déjà utilisé.");
  if (user.verify_sent_at && now() - Number(user.verify_sent_at) > 24 * 3600 * 1000) {
    return fail(400, "Ce lien a expiré. Demandez un nouvel email de confirmation.");
  }
  q.run("UPDATE users SET email_verified = 1, verify_token = NULL WHERE id = ?", user.id);
  audit(user.id, "email_verified", user.email, clientIp(req));
  return { status: 200, body: { ok: true, message: "Adresse confirmée. Vous pouvez vous connecter." } };
}

export async function resendVerification({ session }) {
  const user = q.one("SELECT * FROM users WHERE id = ?", session.user_id);
  if (!user) return fail(404, "Compte introuvable.");
  if (user.email_verified) return fail(400, "Cette adresse est déjà confirmée.");
  const limit = rateLimit(`verify:${user.id}`, 3, 15 * 60 * 1000);
  if (!limit.allowed) return fail(429, "Patientez avant de demander un nouvel email.");
  const { link } = await dispatchVerification(user);
  return {
    status: 200,
    body: { ok: true, message: "Email de confirmation renvoyé.", previewLink: config.smtpConfigured ? undefined : link },
  };
}

/** Renvoi public (depuis la page de connexion) : ne révèle jamais l'existence du compte. */
export async function resendPublic({ body, req }) {
  const email = normalizeEmail(body.email);
  const ip = clientIp(req);
  const limit = rateLimit(`resend:${ip}`, 5, 15 * 60 * 1000);
  if (!limit.allowed) return fail(429, "Trop de demandes. Réessayez dans quelques minutes.");

  const user = EMAIL_RE.test(email) ? q.one("SELECT * FROM users WHERE email = ?", email) : null;
  if (user && !user.email_verified) {
    const { link } = await dispatchVerification(user);
    audit(user.id, "verification_resent", email, ip);
    return { status: 200, body: { ok: true, previewLink: config.smtpConfigured ? undefined : link } };
  }
  return { status: 200, body: { ok: true } };
}

export async function login({ body, req, res }) {
  const email = normalizeEmail(body.email);
  const password = String(body.password || "");
  const ip = clientIp(req);
  const limit = rateLimit(`login:${ip}:${email}`, 8, 15 * 60 * 1000);
  if (!limit.allowed) return fail(429, `Trop de tentatives. Réessayez dans ${limit.retryAfter}s.`);

  const user = q.one("SELECT * FROM users WHERE email = ?", email);
  // toujours exécuter un hachage pour éviter les attaques temporelles
  const stored = user?.password_hash || "scrypt$16384$8$1$00$00";
  const valid = verifyPassword(password, stored);
  if (!user || !valid) {
    audit(user?.id || null, "login_failed", email, ip);
    return fail(401, "Email ou mot de passe incorrect.");
  }

  if (config.requireEmailVerification && !user.email_verified) {
    return fail(403, "Confirmez votre adresse email avant de vous connecter.", { code: "unverified" });
  }

  if (user.totp_enabled) {
    const code = String(body.totp || "").trim();
    if (!code) return fail(401, "Code d'authentification à deux facteurs requis.", { code: "totp_required" });
    const secret = decrypt(user.totp_secret, config.secret);
    const okTotp = secret && verifyTotp(secret, code);
    const okBackup = !okTotp && consumeBackupCode(user, code);
    if (!okTotp && !okBackup) {
      audit(user.id, "login_totp_failed", email, ip);
      return fail(401, "Code à deux facteurs invalide.", { code: "totp_invalid" });
    }
    if (okBackup) audit(user.id, "backup_code_used", email, ip);
  }

  const sessions = q.all("SELECT id FROM sessions WHERE user_id = ? ORDER BY created_at ASC", user.id);
  if (sessions.length >= 8) {
    for (const old of sessions.slice(0, sessions.length - 7)) destroySession(old.id);
  }

  const created = createSession(user.id, { ip, userAgent: req.headers["user-agent"] || "" });
  q.run("UPDATE users SET last_login_at = ? WHERE id = ?", now(), user.id);
  audit(user.id, "login", email, ip);

  return {
    status: 200,
    body: { ok: true, user: publicUser({ ...user, last_login_at: now() }), csrf: created.csrf },
    cookies: [cookie(COOKIE, created.token, { maxAge: config.sessionTtl })],
  };
}

function consumeBackupCode(user, code) {
  if (!user.backup_codes) return false;
  const hashes = JSON.parse(decrypt(user.backup_codes, config.secret) || "[]");
  const normalized = String(code).toUpperCase().replace(/[^A-Z0-9]/g, "");
  const target = sha256(normalized);
  const index = hashes.findIndex((entry) => safeEqual(entry, target));
  if (index < 0) return false;
  hashes.splice(index, 1);
  q.run("UPDATE users SET backup_codes = ? WHERE id = ?", encrypt(JSON.stringify(hashes), config.secret), user.id);
  return true;
}

export async function logout({ session, res }) {
  if (session) {
    destroySession(session.id);
    audit(session.user_id, "logout", "", "");
  }
  return { status: 200, body: { ok: true }, cookies: [clearCookie(COOKIE)] };
}

export async function me({ session }) {
  if (!session) return { status: 200, body: { ok: true, user: null } };
  const user = q.one("SELECT * FROM users WHERE id = ?", session.user_id);
  if (!user) return { status: 200, body: { ok: true, user: null } };
  return { status: 200, body: { ok: true, user: publicUser(user), csrf: session.csrf } };
}

export async function changePassword({ body, session, req }) {
  const user = q.one("SELECT * FROM users WHERE id = ?", session.user_id);
  if (!verifyPassword(String(body.currentPassword || ""), user.password_hash)) {
    return fail(403, "Mot de passe actuel incorrect.");
  }
  const problems = passwordProblems(String(body.newPassword || ""));
  if (problems.length) return fail(400, `Mot de passe trop faible : il manque ${problems.join(", ")}.`);

  q.run("UPDATE users SET password_hash = ? WHERE id = ?", hashPassword(body.newPassword), user.id);
  q.run("DELETE FROM sessions WHERE user_id = ? AND id <> ?", user.id, session.id);
  audit(user.id, "password_changed", "", clientIp(req));

  const mail = alertEmail({
    name: user.display_name,
    title: "Mot de passe modifié",
    detail: "Le mot de passe de votre compte Cipher Mail vient d'être modifié. Toutes les autres sessions ont été déconnectées.",
  });
  sendMail({ to: user.email, ...mail }).catch(() => {});

  return { status: 200, body: { ok: true, message: "Mot de passe mis à jour. Les autres sessions ont été fermées." } };
}

export async function setupTotp({ session }) {
  const secret = generateTotpSecret();
  q.run("UPDATE users SET totp_pending_secret = ? WHERE id = ?", encrypt(secret, config.secret), session.user_id);
  const user = q.one("SELECT * FROM users WHERE id = ?", session.user_id);
  return {
    status: 200,
    body: { ok: true, secret, otpauth: otpauthUrl(secret, user.email), account: user.email },
  };
}

export async function enableTotp({ body, session, req }) {
  const user = q.one("SELECT * FROM users WHERE id = ?", session.user_id);
  if (user.totp_enabled) return fail(400, "La double authentification est déjà active.");
  if (!user.totp_pending_secret) return fail(400, "Commencez par générer un secret.");
  const secret = decrypt(user.totp_pending_secret, config.secret);
  if (!secret || !checkTotp(secret, body.code)) return fail(400, "Code invalide. Vérifiez votre application d'authentification.");

  const codes = backupCodes(8);
  const hashes = codes.map((code) => sha256(code.replace(/[^A-Z0-9]/gi, "").toUpperCase()));
  q.run(
    "UPDATE users SET totp_secret = ?, totp_enabled = 1, totp_pending_secret = NULL, backup_codes = ? WHERE id = ?",
    encrypt(secret, config.secret), encrypt(JSON.stringify(hashes), config.secret), user.id,
  );
  audit(user.id, "totp_enabled", "", clientIp(req));

  const mail = alertEmail({
    name: user.display_name,
    title: "Double authentification activée",
    detail: "La double authentification vient d'être activée sur votre compte. Conservez vos codes de secours en lieu sûr.",
  });
  sendMail({ to: user.email, ...mail }).catch(() => {});

  return { status: 200, body: { ok: true, backupCodes: codes, message: "Double authentification activée." } };
}

export async function disableTotp({ body, session, req }) {
  const user = q.one("SELECT * FROM users WHERE id = ?", session.user_id);
  if (!user.totp_enabled) return fail(400, "La double authentification n'est pas active.");
  if (!verifyPassword(String(body.password || ""), user.password_hash)) return fail(403, "Mot de passe incorrect.");

  q.run("UPDATE users SET totp_secret = NULL, totp_enabled = 0, backup_codes = NULL WHERE id = ?", user.id);
  audit(user.id, "totp_disabled", "", clientIp(req));
  const mail = alertEmail({
    name: user.display_name,
    title: "Double authentification désactivée",
    detail: "La double authentification a été désactivée sur votre compte. Si ce n'était pas vous, sécurisez immédiatement votre compte.",
  });
  sendMail({ to: user.email, ...mail }).catch(() => {});
  return { status: 200, body: { ok: true, message: "Double authentification désactivée." } };
}

export async function regenerateBackupCodes({ body, session }) {
  const user = q.one("SELECT * FROM users WHERE id = ?", session.user_id);
  if (!user.totp_enabled) return fail(400, "Activez d'abord la double authentification.");
  if (!verifyPassword(String(body.password || ""), user.password_hash)) return fail(403, "Mot de passe incorrect.");
  const codes = backupCodes(8);
  const hashes = codes.map((code) => sha256(code.replace(/[^A-Z0-9]/gi, "").toUpperCase()));
  q.run("UPDATE users SET backup_codes = ? WHERE id = ?", encrypt(JSON.stringify(hashes), config.secret), user.id);
  return { status: 200, body: { ok: true, backupCodes: codes } };
}

export async function listSessions({ session }) {
  const rows = q.all("SELECT * FROM sessions WHERE user_id = ? ORDER BY last_seen_at DESC", session.user_id);
  return {
    status: 200,
    body: {
      ok: true,
      sessions: rows.map((row) => ({
        id: row.id,
        current: row.id === session.id,
        createdAt: Number(row.created_at),
        lastSeenAt: Number(row.last_seen_at),
        ip: row.ip,
        userAgent: row.user_agent,
      })),
    },
  };
}

export async function revokeSession({ params, session }) {
  const row = q.one("SELECT * FROM sessions WHERE id = ? AND user_id = ?", params.id, session.user_id);
  if (!row) return fail(404, "Session introuvable.");
  destroySession(row.id);
  return { status: 200, body: { ok: true } };
}
