/**
 * Envoi d'emails sans dépendance : SMTP direct (STARTTLS / TLS), AUTH LOGIN.
 * Si SMTP n'est pas configuré, les emails sont écrits dans data/outbox/ et
 * affichés dans la console — l'inscription reste utilisable en local.
 */
import net from "node:net";
import tls from "node:tls";
import fs from "node:fs";
import path from "node:path";
import { config, smtpConfigured } from "./config.js";
import { OUTBOX_DIR } from "./paths.js";

function encodeHeader(value) {
  const text = String(value || "");
  return /^[\x20-\x7e]*$/.test(text) ? text : `=?UTF-8?B?${Buffer.from(text, "utf8").toString("base64")}?=`;
}

function buildMessage({ to, subject, text, html }) {
  const boundary = "cipher_" + Date.now().toString(16);
  const lines = [
    `From: ${config.smtp.from}`,
    `To: ${to}`,
    `Subject: ${encodeHeader(subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${Date.now()}.${Math.random().toString(36).slice(2)}@cipher.local>`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(text || "", "utf8").toString("base64"),
    "",
    `--${boundary}`,
    "Content-Type: text/html; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(html || text || "", "utf8").toString("base64"),
    "",
    `--${boundary}--`,
    "",
  ];
  return lines.join("\r\n");
}

function smtpConversation(socket, { to, message }) {
  return new Promise((resolve, reject) => {
    let buffer = "";
    let stage = 0;
    let settled = false;
    const done = (error) => {
      if (settled) return;
      settled = true;
      socket.removeAllListeners();
      socket.end();
      error ? reject(error) : resolve(true);
    };
    socket.setEncoding("utf8");
    socket.setTimeout(20000, () => done(new Error("SMTP: délai dépassé")));

    const steps = [
      () => `EHLO cipher.local`,
      () => (config.smtp.user ? "AUTH LOGIN" : null),
      () => Buffer.from(config.smtp.user).toString("base64"),
      () => Buffer.from(config.smtp.pass).toString("base64"),
      () => `MAIL FROM:<${(config.smtp.from.match(/<([^>]+)>/) || [])[1] || config.smtp.user}>`,
      () => `RCPT TO:<${to}>`,
      () => "DATA",
      () => `${message.replace(/\r?\n\./g, "\r\n..")}\r\n.`,
      () => "QUIT",
    ];

    const advance = () => {
      while (stage < steps.length) {
        const command = steps[stage++];
        const value = command();
        if (value === null) continue;
        socket.write(value + "\r\n");
        return;
      }
    };

    socket.on("data", (chunk) => {
      buffer += chunk;
      const lines = buffer.split("\r\n");
      if (!buffer.endsWith("\r\n")) {
        buffer = lines.pop();
        return;
      }
      buffer = "";
      const last = lines.filter(Boolean).pop() || "";
      const code = Number(last.slice(0, 3));
      if (code >= 400) return done(new Error(`SMTP ${code}: ${last.slice(4)}`));
      if (stage >= steps.length && code === 221) return done();
      advance();
    });
    socket.on("error", (error) => done(error));
    socket.on("close", () => (settled ? null : done(new Error("SMTP: connexion fermée"))));
    socket.on("connect", advance);
  });
}

async function upgrade(socket) {
  return new Promise((resolve, reject) => {
    socket.write("STARTTLS\r\n");
    socket.once("data", (chunk) => {
      const code = Number(String(chunk).slice(0, 3));
      if (code !== 220) return reject(new Error(`STARTTLS refusé (${code})`));
      const secure = tls.connect({ socket, servername: config.smtp.host }, () => resolve(secure));
      secure.on("error", reject);
    });
  });
}

async function sendSmtp(mail) {
  const message = buildMessage(mail);
  const port = config.smtp.port;

  if (config.smtp.secure) {
    const socket = tls.connect({ host: config.smtp.host, port, servername: config.smtp.host });
    await new Promise((resolve, reject) => {
      socket.once("secureConnect", resolve);
      socket.once("error", reject);
    });
    return smtpConversation(socket, { to: mail.to, message });
  }

  let socket = net.createConnection({ host: config.smtp.host, port });
  await new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });

  // bannière
  await new Promise((resolve) => socket.once("data", resolve));
  socket = await upgrade(socket);
  return smtpConversation(socket, { to: mail.to, message });
}

export async function sendMail(mail) {
  if (smtpConfigured) {
    return sendSmtp(mail);
  }
  try {
    fs.mkdirSync(OUTBOX_DIR, { recursive: true });
    const file = path.join(OUTBOX_DIR, `${Date.now()}-${mail.to.replace(/[^a-z0-9]/gi, "_")}.eml`);
    fs.writeFileSync(file, buildMessage(mail));
  } catch {
    // Système de fichiers en lecture seule : la console suffit.
  }
  console.log(`\n[mail:dev] → ${mail.to} | ${mail.subject}\n${mail.text}\n`);
  return true;
}

export function verificationEmail({ name, link }) {
  return {
    subject: "Confirmez votre adresse — Cipher Mail",
    text: `Bonjour ${name},\n\nConfirmez votre adresse pour activer votre compte :\n${link}\n\nCe lien expire dans 24 heures.\n\nSi vous n'êtes pas à l'origine de cette demande, ignorez cet email.`,
    html: `<div style="font-family:system-ui,-apple-system,'Segoe UI',sans-serif;max-width:520px;margin:0 auto;padding:32px;color:#0f172a">
      <h2 style="margin:0 0 12px;font-size:22px">Bienvenue sur Cipher Mail</h2>
      <p style="color:#475569;line-height:1.6">Bonjour ${name}, confirmez votre adresse pour activer votre compte.</p>
      <p style="margin:28px 0"><a href="${link}" style="background:#1a73e8;color:#fff;padding:13px 22px;border-radius:8px;text-decoration:none;font-weight:600;display:inline-block">Confirmer mon adresse</a></p>
      <p style="color:#94a3b8;font-size:13px;line-height:1.6">Ce lien expire dans 24 heures. Si vous n'êtes pas à l'origine de cette demande, ignorez cet email.</p>
      <p style="color:#cbd5e1;font-size:12px;word-break:break-all">${link}</p>
    </div>`,
  };
}

export function alertEmail({ name, title, detail, link }) {
  return {
    subject: `${title} — Cipher Mail`,
    text: `${name},\n\n${title}\n${detail}\n${link ? `\n${link}\n` : ""}\nSi ce n'était pas vous, changez immédiatement votre mot de passe.`,
    html: `<div style="font-family:system-ui,-apple-system,'Segoe UI',sans-serif;max-width:520px;margin:0 auto;padding:32px;color:#0f172a">
      <h2 style="margin:0 0 12px;font-size:20px">${title}</h2>
      <p style="color:#475569;line-height:1.6">${detail}</p>
      ${link ? `<p style="margin:24px 0"><a href="${link}" style="background:#1a73e8;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:600;display:inline-block">Vérifier</a></p>` : ""}
      <p style="color:#94a3b8;font-size:13px">Si ce n'était pas vous, changez immédiatement votre mot de passe.</p>
    </div>`,
  };
}
