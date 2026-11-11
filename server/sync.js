import { q } from "./db.js";
import { config } from "./config.js";
import { OUTBOX_DIR } from "./paths.js";
import { id, now, encrypt, decrypt, previewText, detectCode } from "./util.js";
import * as ez from "./eztempmail.js";

/* ---------------- sessions eztempmail stockées ---------------- */

function sessionFor(mailbox) {
  return {
    jar: mailbox.ez_session ? JSON.parse(decrypt(mailbox.ez_session, config.secret) || "{}") : {},
    csrf: mailbox.ez_csrf ? decrypt(mailbox.ez_csrf, config.secret) : "",
  };
}

/* ---------------- stockage des messages ---------------- */

function splitName(value) {
  const text = String(value || "").trim();
  const match = text.match(/^(.*?)\s*<([^>]+)>$/);
  if (match) return { name: match[1].replace(/^["']|["']$/g, "").trim(), email: match[2].trim() };
  return { name: "", email: text };
}

async function messageExists(mailboxId, remoteId) {
  const row = await q.one("SELECT id FROM messages WHERE mailbox_id = ? AND remote_id = ?", mailboxId, String(remoteId));
  return Boolean(row);
}

async function insertMessage(mailbox, raw) {
  const remoteId = String(raw.remoteId ?? raw.id ?? "");
  if (!remoteId || (await messageExists(mailbox.id, remoteId))) return null;

  const parsedFrom = splitName(raw.fromEmail || raw.from_email || raw.from || "");
  const fromName = String(raw.fromName || "").trim() || parsedFrom.name || parsedFrom.email.split("@")[0] || "Inconnu";
  const subject = String(raw.subject || "(sans objet)").trim() || "(sans objet)";
  const html = raw.bodyHtml || "";
  const attachments = Array.isArray(raw.attachments) ? raw.attachments : [];
  const messageId = id("MSG");
  const preview = previewText(html);

  await q.run(
    `INSERT INTO messages
       (id, mailbox_id, user_id, remote_id, from_name, from_email, to_email, subject, preview, body_html, body_text, code, received_at, stored_at, read_at, starred, has_attachments)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, NULL, 0, ?)`,
    messageId,
    mailbox.id,
    mailbox.user_id,
    remoteId,
    fromName,
    parsedFrom.email,
    raw.toEmail || mailbox.address,
    subject,
    preview,
    html || null,
    detectCode(`${subject} ${preview}`),
    Number(raw.receivedAt) || now(),
    now(),
    attachments.length ? 1 : 0,
  );

  for (const file of attachments) {
    await q.run(
      `INSERT INTO attachments (id, message_id, user_id, filename, content_type, size, remote_url, stored_path, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
      id("ATT"), messageId, mailbox.user_id, file.filename, file.contentType, file.size, file.remoteUrl, now(),
    );
  }

  return messageId;
}

/* ---------------- lecture du contenu d'un message ---------------- */

function extractFromView(html) {
  const bodyMatch =
    html.match(/<div[^>]*class="[^"]*mail-content[^"]*"[\s\S]*?<\/div>\s*<\/div>/i) ||
    html.match(/<iframe[^>]*id="myContent"[\s\S]*?<\/iframe>/i);

  // Le corps est affiché dans un iframe srcdoc ou chargé via /view/{id}/content
  const srcdoc = html.match(/<iframe[^>]*srcdoc="([\s\S]*?)"[^>]*>/i);
  if (srcdoc) {
    return srcdoc[1]
      .replaceAll("&quot;", '"')
      .replaceAll("&#039;", "'")
      .replaceAll("&lt;", "<")
      .replaceAll("&gt;", ">")
      .replaceAll("&amp;", "&");
  }
  const src = html.match(/<iframe[^>]*src="([^"]+)"[^>]*>/i);
  if (src) return { iframeSrc: src[1] };
  if (bodyMatch) return bodyMatch[0];
  return "";
}

export async function fetchMessageBody(mailbox, remoteId) {
  const session = sessionFor(mailbox);
  const opened = await ez.openSession(session.jar, session.csrf);
  const cookieHeader = Object.entries(opened.jar).map(([k, v]) => `${k}=${v}`).join("; ");
  const page = await fetch(`https://www.eztempmail.com/view/${encodeURIComponent(remoteId)}`, {
    headers: {
      Cookie: cookieHeader,
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      Referer: "https://www.eztempmail.com/",
    },
  });
  if (page.status !== 200) return null;
  const html = await page.text();
  const extracted = extractFromView(html);

  let bodyHtml = typeof extracted === "string" ? extracted : "";
  if (extracted && typeof extracted === "object" && extracted.iframeSrc) {
    const url = extracted.iframeSrc.startsWith("http") ? extracted.iframeSrc : `https://www.eztempmail.com${extracted.iframeSrc}`;
    const inner = await fetch(url, {
      headers: {
        Cookie: cookieHeader,
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      },
    });
    if (inner.status === 200) bodyHtml = await inner.text();
  }

  const subject = (html.match(/<title>([^<]*)<\/title>/) || [])[1] || "";
  return { bodyHtml, subject };
}

/* ---------------- relève d'une boîte ---------------- */

const bus = new Set();
export const subscribers = {
  add(fn) {
    bus.add(fn);
    return () => bus.delete(fn);
  },
  emit(userId, event) {
    for (const fn of bus) {
      try {
        fn(userId, event);
      } catch {}
    }
  },
};

export async function syncMailbox(mailbox, { deep = false } = {}) {
  if (!mailbox || mailbox.status === "deleted") return { ok: false, reason: "deleted" };
  const session = sessionFor(mailbox);

  let opened;
  try {
    opened = await ez.openSession(session.jar, session.csrf);
  } catch (error) {
    await markFailure(mailbox, error.message);
    return { ok: false, reason: error.message };
  }

  let inbox;
  try {
    inbox = await ez.fetchInbox(opened);
  } catch (error) {
    await markFailure(mailbox, error.message);
    return { ok: false, reason: error.message };
  }

  const mailboxId = mailbox.id;
  const addressChanged = inbox.mailbox && inbox.mailbox !== mailbox.address;

  await q.run(
    `UPDATE mailboxes
        SET ez_session = ?, ez_csrf = ?, last_polled_at = ?, status = 'active',
            address = COALESCE(?, address),
            domain = COALESCE(?, domain),
            recovery_key = COALESCE(?, recovery_key),
            email_token = COALESCE(?, email_token)
      WHERE id = ?`,
    encrypt(JSON.stringify(inbox.jar || {}), config.secret),
    encrypt(inbox.csrf || "", config.secret),
    now(),
    addressChanged ? inbox.mailbox : null,
    addressChanged && inbox.mailbox.includes("@") ? inbox.mailbox.split("@").pop() : null,
    inbox.recoveryKey || null,
    inbox.emailToken || null,
    mailboxId,
  );

  const effective = { ...mailbox, address: inbox.mailbox || mailbox.address };
  let added = 0;

  for (const raw of inbox.messages) {
    const normalized = ez.normalizeMessage(raw);
    if (!normalized.remoteId) continue;
    const created = await insertMessage(effective, normalized);
    if (created) added += 1;
  }

  if (added > 0) {
    subscribers.emit(mailbox.user_id, { type: "new-mail", mailboxId, count: added, address: effective.address });
  }

  await q.run("UPDATE mailboxes SET last_seen_at = ? WHERE id = ?", now(), mailboxId);
  return { ok: true, address: effective.address, added, total: inbox.messages.length };
}

async function markFailure(mailbox, reason) {
  const message = String(reason || "");
  const expired = /session|expir/i.test(message);
  await q.run(
    "UPDATE mailboxes SET status = ?, last_polled_at = ? WHERE id = ?",
    expired ? "expired" : mailbox.status === "expired" ? "expired" : "error",
    now(),
    mailbox.id,
  );
}

/* ---------------- création / changement d'adresse ---------------- */

export async function createRemoteMailbox({ name = "", domain = "" } = {}) {
  let session = await ez.openSession({}, "");
  let inbox = await ez.fetchInbox(session);
  session = { jar: inbox.jar, csrf: inbox.csrf };

  if (name || domain) {
    try {
      session = await ez.changeAddress(session, { name, domain: domain || inbox.mailbox.split("@").pop() });
      inbox = await ez.fetchInbox(session);
    } catch (error) {
      // Limite journalière de personnalisation : on garde l'adresse aléatoire attribuée.
      if (error.code === "daily_limit") {
        return { ...inbox, fallback: true, fallbackReason: error.message };
      }
      throw error;
    }
  }
  return inbox;
}

export async function changeRemoteMailbox(mailbox, { name, domain }) {
  const current = sessionFor(mailbox);
  const opened = await ez.openSession(current.jar, current.csrf);
  const updated = await ez.changeAddress(opened, { name, domain });
  const inbox = await ez.fetchInbox(updated);
  return inbox;
}

export async function deleteRemoteMailbox(mailbox) {
  const current = sessionFor(mailbox);
  return ez.deleteAddress(await ez.openSession(current.jar, current.csrf));
}

/* ---------------- boucle de fond ---------------- */

let timer = null;
let running = false;

export function startSyncLoop() {
  if (timer) return;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const rows = await q.all(
        `SELECT * FROM mailboxes
          WHERE status IN ('active', 'error')
          ORDER BY COALESCE(last_polled_at, 0) ASC
          LIMIT ?`,
        config.pollConcurrency,
      );
      await Promise.allSettled(rows.map((row) => syncMailbox(row)));
    } catch (error) {
      console.error("[sync]", error.message);
    } finally {
      running = false;
      timer = setTimeout(tick, config.pollInterval);
      timer.unref?.();
    }
  };
  timer = setTimeout(tick, 1500);
  timer.unref?.();
}

export function stopSyncLoop() {
  if (timer) clearTimeout(timer);
  timer = null;
}

export { OUTBOX_DIR };
