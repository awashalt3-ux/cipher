import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { ROOT } from "./db.js";

const DATA_DIR = process.env.CIPHER_DATA_DIR || path.join(ROOT, "data");
fs.mkdirSync(DATA_DIR, { recursive: true });

function loadSecret() {
  if (process.env.CIPHER_SECRET) return process.env.CIPHER_SECRET;
  const file = path.join(DATA_DIR, "secret.key");
  if (fs.existsSync(file)) return fs.readFileSync(file, "utf8").trim();
  const secret = crypto.randomBytes(48).toString("base64");
  fs.writeFileSync(file, secret, { mode: 0o600 });
  return secret;
}

export const config = {
  root: ROOT,
  dataDir: DATA_DIR,
  secret: loadSecret(),
  port: Number(process.env.PORT || 4317),
  host: process.env.HOST || "127.0.0.1",
  appUrl: process.env.CIPHER_APP_URL || `http://${process.env.HOST || "127.0.0.1"}:${Number(process.env.PORT || 4317)}`,
  sessionTtl: 14 * 24 * 3600 * 1000,
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
