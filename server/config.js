import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ROOT, DATA_DIR } from "./paths.js";

/** Secret de chiffrement : `CIPHER_SECRET`, sinon fichier local, sinon généré en mémoire. */
function loadSecret() {
  if (process.env.CIPHER_SECRET) return process.env.CIPHER_SECRET;
  const file = path.join(DATA_DIR, "secret.key");
  try {
    if (fs.existsSync(file)) return fs.readFileSync(file, "utf8").trim();
    const secret = crypto.randomBytes(48).toString("base64");
    fs.writeFileSync(file, secret, { mode: 0o600 });
    return secret;
  } catch {
    // Système de fichiers non persistant : le secret ne survit pas au redémarrage.
    console.warn("[config] CIPHER_SECRET absent et data/ non inscriptible : secret éphémère.");
    return crypto.randomBytes(48).toString("base64");
  }
}

const port = Number(process.env.PORT || 4317);
const host = process.env.HOST || "0.0.0.0";

/** URL publique, utilisée pour les liens de confirmation. */
function resolveAppUrl() {
  if (process.env.CIPHER_APP_URL) return process.env.CIPHER_APP_URL.replace(/\/$/, "");
  if (process.env.WASMER_APP_URL) return process.env.WASMER_APP_URL.replace(/\/$/, "");
  if (process.env.WASMER_APP_DOMAIN) return `https://${process.env.WASMER_APP_DOMAIN}`;
  return `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${port}`;
}

export const config = {
  root: ROOT,
  dataDir: DATA_DIR,
  secret: loadSecret(),
  port,
  host,
  appUrl: resolveAppUrl(),
  sessionTtl: 90 * 24 * 3600 * 1000,
  sessionTtlShort: 12 * 3600 * 1000,
  pollInterval: Number(process.env.POLL_INTERVAL_MS || 8000),
  pollConcurrency: Number(process.env.POLL_CONCURRENCY || 4),
  requireEmailVerification: process.env.CIPHER_SKIP_VERIFICATION !== "1",
  smtp: {
    host: process.env.SMTP_HOST || "",
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === "1",
    user: process.env.SMTP_USER || "",
    pass: process.env.SMTP_PASS || "",
    from: process.env.SMTP_FROM || "Cipher Mail <no-reply@cipher.local>",
  },
};

export const smtpConfigured = Boolean(config.smtp.host);
