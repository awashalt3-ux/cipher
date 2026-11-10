import { q } from "./db.js";
import { config } from "./config.js";
import { id, now, encrypt } from "./util.js";
import * as ez from "./eztempmail.js";
import {
  createRemoteMailbox, changeRemoteMailbox, deleteRemoteMailbox, syncMailbox, fetchMessageBody,
} from "./sync.js";

const ADDRESS_RE = /^[a-z0-9](?:[a-z0-9._-]{0,30}[a-z0-9])?$/i;

function fail(status, message, extra = {}) {
  return { status, body: { ok: false, error: message, ...extra } };
}

function mailboxView(row, stats = null) {
  return {
    id: row.id,
    address: row.address,
    local: row.address.split("@")[0],
    domain: row.domain || row.address.split("@")[1] || "",
    label: row.label || "",
    notes: row.notes || "",
    status: row.status,
    createdAt: Number(row.created_at),
    lastPolledAt: row.last_polled_at ? Number(row.last_polled_at) : null,
    lastSeenAt: row.last_seen_at ? Number(row.last_seen_at) : null,
    unread: stats?.unread ?? 0,
    total: stats?.total ?? 0,
    lastSubject: stats?.lastSubject ?? null,
    lastFrom: stats?.lastFrom ?? null,
    lastReceivedAt: stats?.lastReceivedAt ?? null,
    hasRecovery: Boolean(row.recovery_key),
  };
}

function withStats(rows) {
  if (!rows.length) return [];
  const ids = rows.map((row) => row.id);
  const placeholders = ids.map(() => "?").join(",");
  const stats = q.all(
    `SELECT mailbox_id,
            COUNT(*) AS total,
            SUM(CASE WHEN read_at IS NULL THEN 1 ELSE 0 END) AS unread,
            MAX(received_at) AS last_received
       FROM messages WHERE mailbox_id IN (${placeholders}) GROUP BY mailbox_id`,
    ...ids,
  );
  const latest = q.all(
    `SELECT mailbox_id, subject, from_name, from_email, received_at,
            ROW_NUMBER() OVER (PARTITION BY mailbox_id ORDER BY received_at DESC) AS rn
       FROM messages WHERE mailbox_id IN (${placeholders})`,
    ...ids,
  ).filter((row) => row.rn === 1);

  const byId = new Map(stats.map((row) => [row.mailbox_id, row]));
  const latestById = new Map(latest.map((row) => [row.mailbox_id, row]));

  return rows.map((row) => {
    const stat = byId.get(row.id);
    const last = latestById.get(row.id);
    return mailboxView(row, {
      total: Number(stat?.total || 0),
      unread: Number(stat?.unread || 0),
      lastSubject: last?.subject || null,
      lastFrom: last ? last.from_name || last.from_email : null,
      lastReceivedAt: last ? Number(last.received_at) : null,
    });
  });
}

export async function listMailboxes({ session }) {
  const rows = q.all(
    "SELECT * FROM mailboxes WHERE user_id = ? AND status <> 'deleted' ORDER BY created_at DESC",
    session.user_id,
  );
  const mailboxes = withStats(rows);
  const totals = q.one(
    `SELECT COUNT(*) AS total, SUM(CASE WHEN read_at IS NULL THEN 1 ELSE 0 END) AS unread
       FROM messages WHERE user_id = ?`,
    session.user_id,
  );
  return {
    status: 200,
    body: {
      ok: true,
      mailboxes,
      totals: { mailboxes: mailboxes.length, messages: Number(totals?.total || 0), unread: Number(totals?.unread || 0) },
    },
  };
}

export async function domains() {
  try {
    const list = await ez.listDomains();
    return { status: 200, body: { ok: true, domains: list } };
  } catch (error) {
    return fail(error.status || 502, error.message);
  }
}

async function persistMailbox(userId, inbox, { label = "", notes = "" } = {}) {
  const existing = q.one("SELECT * FROM mailboxes WHERE user_id = ? AND address = ?", userId, inbox.mailbox);
  const stamp = now();

  if (existing) {
    q.run(
      `UPDATE mailboxes SET ez_session = ?, ez_csrf = ?, recovery_key = ?, email_token = ?,
              status = 'active', last_polled_at = ?, last_seen_at = ?,
              label = COALESCE(NULLIF(?, ''), label), notes = COALESCE(NULLIF(?, ''), notes)
        WHERE id = ?`,
      encrypt(JSON.stringify(inbox.jar || {}), config.secret),
      encrypt(inbox.csrf || "", config.secret),
      inbox.recoveryKey || null,
      inbox.emailToken || null,
      stamp, stamp, label, notes, existing.id,
    );
    return existing.id;
  }

  const mailboxId = id("MBX");
  q.run(
    `INSERT INTO mailboxes (id, user_id, address, domain, label, notes, recovery_key, email_token,
                            ez_session, ez_csrf, status, created_at, last_polled_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
    mailboxId, userId, inbox.mailbox, inbox.mailbox.split("@").pop() || null,
    label, notes, inbox.recoveryKey || null, inbox.emailToken || null,
    encrypt(JSON.stringify(inbox.jar || {}), config.secret),
    encrypt(inbox.csrf || "", config.secret),
    stamp, stamp, stamp,
  );
  return mailboxId;
}

export async function createMailbox({ body, session, req }) {
  const user = q.one("SELECT id, storage_quota FROM users WHERE id = ?", session.user_id);
  const count = q.one("SELECT COUNT(*) AS n FROM mailboxes WHERE user_id = ? AND status <> 'deleted'", user.id);
  if (Number(count.n) >= 60) return fail(400, "Limite de 60 boîtes atteinte. Supprimez-en une pour continuer.");

  const rawName = String(body.local || body.name || "").trim().toLowerCase();
  if (rawName && !ADDRESS_RE.test(rawName)) {
    return fail(400, "Le nom ne peut contenir que des lettres, chiffres, points, tirets et underscores (max 32).");
  }

  try {
    const inbox = await createRemoteMailbox({ name: rawName, domain: String(body.domain || "").trim() });
    const mailboxId = await persistMailbox(user.id, inbox, {
      label: String(body.label || "").slice(0, 60),
      notes: String(body.notes || "").slice(0, 400),
    });
    await syncMailbox(q.one("SELECT * FROM mailboxes WHERE id = ?", mailboxId), { deep: true });
    const fresh = q.one("SELECT * FROM mailboxes WHERE id = ?", mailboxId);
    const view = withStats([fresh])[0];
    return {
      status: 201,
      body: {
        ok: true,
        mailbox: view,
        warning: inbox.fallback ? inbox.fallbackReason : undefined,
      },
    };
  } catch (error) {
    return fail(error.status && error.status < 500 ? error.status : 502, error.message || "Création impossible.");
  }
}

export async function importMailbox({ body, session }) {
  const address = String(body.address || "").trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(address)) return fail(400, "Adresse invalide.");
  const exists = q.one("SELECT id FROM mailboxes WHERE user_id = ? AND address = ?", session.user_id, address);
  if (exists) return fail(409, "Cette boîte est déjà dans votre collection.");

  const local = address.split("@")[0];
  const domain = address.split("@").pop();
  try {
    const inbox = await createRemoteMailbox({ name: local, domain });
    if (inbox.mailbox.toLowerCase() !== address) {
      if (inbox.fallback) {
        return fail(429, inbox.fallbackReason, { availableAddress: inbox.mailbox });
      }
      return fail(409, `Cette adresse n'est pas disponible. Essayez : ${inbox.mailbox}`, { availableAddress: inbox.mailbox });
    }
    const mailboxId = await persistMailbox(session.user_id, inbox, { label: String(body.label || "").slice(0, 60) });
    await syncMailbox(q.one("SELECT * FROM mailboxes WHERE id = ?", mailboxId), { deep: true });
    const fresh = q.one("SELECT * FROM mailboxes WHERE id = ?", mailboxId);
    return { status: 201, body: { ok: true, mailbox: withStats([fresh])[0] } };
  } catch (error) {
    return fail(error.status && error.status < 500 ? error.status : 502, error.message || "Import impossible.");
  }
}

export async function changeMailboxAddress({ body, params, session }) {
  const row = q.one("SELECT * FROM mailboxes WHERE id = ? AND user_id = ?", params.id, session.user_id);
  if (!row) return fail(404, "Boîte introuvable.");

  const rawName = String(body.local || body.name || "").trim().toLowerCase();
  if (rawName && !ADDRESS_RE.test(rawName)) return fail(400, "Nom d'adresse invalide.");

  try {
    const inbox = await changeRemoteMailbox(row, { name: rawName, domain: String(body.domain || row.domain || "").trim() });
    q.run(
      `UPDATE mailboxes SET address = ?, domain = ?, ez_session = ?, ez_csrf = ?, recovery_key = ?, email_token = ?,
              status = 'active', last_polled_at = ?
        WHERE id = ?`,
      inbox.mailbox, inbox.mailbox.split("@").pop(), encrypt(JSON.stringify(inbox.jar || {}), config.secret),
      encrypt(inbox.csrf || "", config.secret), inbox.recoveryKey || null, inbox.emailToken || null, now(), row.id,
    );
    await syncMailbox(q.one("SELECT * FROM mailboxes WHERE id = ?", row.id), { deep: true });
    const fresh = q.one("SELECT * FROM mailboxes WHERE id = ?", row.id);
    return { status: 200, body: { ok: true, mailbox: withStats([fresh])[0] } };
  } catch (error) {
    return fail(error.status && error.status < 500 ? error.status : 502, error.message || "Changement impossible.");
  }
}

export async function updateMailbox({ body, params, session }) {
  const row = q.one("SELECT * FROM mailboxes WHERE id = ? AND user_id = ?", params.id, session.user_id);
  if (!row) return fail(404, "Boîte introuvable.");
  const label = body.label === undefined ? row.label : String(body.label).slice(0, 60);
  const notes = body.notes === undefined ? row.notes : String(body.notes).slice(0, 400);
  q.run("UPDATE mailboxes SET label = ?, notes = ? WHERE id = ?", label, notes, row.id);
  return { status: 200, body: { ok: true, mailbox: withStats([q.one("SELECT * FROM mailboxes WHERE id = ?", row.id)])[0] } };
}

export async function deleteMailbox({ params, session, query }) {
  const row = q.one("SELECT * FROM mailboxes WHERE id = ? AND user_id = ?", params.id, session.user_id);
  if (!row) return fail(404, "Boîte introuvable.");
  const alsoRemote = query.get("remote") === "1";
  if (alsoRemote) await deleteRemoteMailbox(row).catch(() => {});
  q.run("DELETE FROM mailboxes WHERE id = ?", row.id);
  return { status: 200, body: { ok: true } };
}

export async function refreshMailbox({ params, session }) {
  const row = q.one("SELECT * FROM mailboxes WHERE id = ? AND user_id = ?", params.id, session.user_id);
  if (!row) return fail(404, "Boîte introuvable.");
  const result = await syncMailbox(row, { deep: true });
  const fresh = q.one("SELECT * FROM mailboxes WHERE id = ?", row.id);
  if (!result.ok) {
    return fail(409, result.reason || "Synchronisation impossible.", { mailbox: withStats([fresh])[0], status_sub: fresh.status });
  }
  return { status: 200, body: { ok: true, added: result.added, mailbox: withStats([fresh])[0] } };
}

export async function refreshAll({ session }) {
  const rows = q.all("SELECT * FROM mailboxes WHERE user_id = ? AND status <> 'deleted'", session.user_id);
  const results = await Promise.allSettled(rows.map((row) => syncMailbox(row)));
  const failed = results.filter((result) => result.status !== "fulfilled" || !result.value?.ok).length;
  return { status: 200, body: { ok: true, refreshed: rows.length, failed } };
}

export async function mailboxDetails({ params, session }) {
  const row = q.one("SELECT * FROM mailboxes WHERE id = ? AND user_id = ?", params.id, session.user_id);
  if (!row) return fail(404, "Boîte introuvable.");
  const details = withStats([row])[0];
  details.recoveryKey = row.recovery_key;
  details.domains = [];
  return { status: 200, body: { ok: true, mailbox: details } };
}

/* ---------------- messages ---------------- */

export async function listMessages({ params, query, session }) {
  const mailbox = q.one("SELECT * FROM mailboxes WHERE id = ? AND user_id = ?", params.id, session.user_id);
  if (!mailbox) return fail(404, "Boîte introuvable.");

  const search = String(query.get("search") || "").trim();
  const filter = String(query.get("filter") || "all");
  const limit = Math.min(Number(query.get("limit") || 100), 300);
  const before = Number(query.get("before") || 0);

  const clauses = ["mailbox_id = ?", "user_id = ?"];
  const args = [mailbox.id, session.user_id];
  if (filter === "unread") clauses.push("read_at IS NULL");
  if (filter === "starred") clauses.push("starred = 1");
  if (filter === "codes") clauses.push("code IS NOT NULL");
  if (before) {
    clauses.push("received_at < ?");
    args.push(before);
  }
  if (search) {
    clauses.push("(subject LIKE ? OR from_name LIKE ? OR from_email LIKE ? OR preview LIKE ?)");
    const like = `%${search}%`;
    args.push(like, like, like, like);
  }

  const rows = q.all(
    `SELECT id, remote_id, from_name, from_email, subject, preview, code, received_at, read_at, starred, has_attachments
       FROM messages WHERE ${clauses.join(" AND ")} ORDER BY received_at DESC LIMIT ?`,
    ...args, limit,
  );

  return {
    status: 200,
    body: {
      ok: true,
      mailbox: withStats([mailbox])[0],
      messages: rows.map((row) => ({
        id: row.id,
        remoteId: row.remote_id,
        from: row.from_name || row.from_email,
        fromEmail: row.from_email,
        subject: row.subject,
        preview: row.preview,
        code: row.code,
        receivedAt: Number(row.received_at),
        read: Boolean(row.read_at),
        starred: Boolean(row.starred),
        hasAttachments: Boolean(row.has_attachments),
      })),
    },
  };
}

export async function getMessage({ params, session, query }) {
  const row = q.one("SELECT * FROM messages WHERE id = ? AND user_id = ?", params.id, session.user_id);
  if (!row) return fail(404, "Message introuvable.");

  let bodyHtml = row.body_html;
  let bodyText = row.body_text;
  const mailbox = q.one("SELECT * FROM mailboxes WHERE id = ?", row.mailbox_id);

  // Récupère le corps à la demande si absent
  if (!bodyHtml && !bodyText && mailbox && row.remote_id) {
    try {
      const fetched = await fetchMessageBody(mailbox, row.remote_id);
      if (fetched?.bodyHtml) {
        bodyHtml = fetched.bodyHtml;
        q.run("UPDATE messages SET body_html = ? WHERE id = ?", bodyHtml, row.id);
      }
    } catch {}
  }

  if (query.get("markRead") !== "0" && !row.read_at) {
    q.run("UPDATE messages SET read_at = ? WHERE id = ?", now(), row.id);
  }

  const attachments = q.all("SELECT * FROM attachments WHERE message_id = ?", row.id);
  return {
    status: 200,
    body: {
      ok: true,
      message: {
        id: row.id,
        mailboxId: row.mailbox_id,
        mailboxAddress: mailbox?.address || "",
        remoteId: row.remote_id,
        from: row.from_name || row.from_email,
        fromEmail: row.from_email,
        toEmail: row.to_email,
        subject: row.subject,
        preview: row.preview,
        bodyHtml,
        bodyText,
        code: row.code,
        receivedAt: Number(row.received_at),
        read: true,
        starred: Boolean(row.starred),
        attachments: attachments.map((a) => ({
          id: a.id, filename: a.filename, contentType: a.content_type, size: a.size,
        })),
      },
    },
  };
}

export async function updateMessage({ params, body, session }) {
  const row = q.one("SELECT * FROM messages WHERE id = ? AND user_id = ?", params.id, session.user_id);
  if (!row) return fail(404, "Message introuvable.");
  if (body.starred !== undefined) {
    q.run("UPDATE messages SET starred = ? WHERE id = ?", body.starred ? 1 : 0, row.id);
  }
  if (body.read !== undefined) {
    q.run("UPDATE messages SET read_at = ? WHERE id = ?", body.read ? now() : null, row.id);
  }
  return { status: 200, body: { ok: true } };
}

export async function deleteMessage({ params, session }) {
  const row = q.one("SELECT * FROM messages WHERE id = ? AND user_id = ?", params.id, session.user_id);
  if (!row) return fail(404, "Message introuvable.");
  q.run("DELETE FROM messages WHERE id = ?", row.id);
  return { status: 200, body: { ok: true } };
}

export async function bulkMessages({ body, session }) {
  const action = String(body.action || "");
  const ids = Array.isArray(body.ids) ? body.ids.filter((value) => typeof value === "string").slice(0, 500) : [];
  const mailboxId = String(body.mailboxId || "");
  const placeholders = ids.map(() => "?").join(",");

  if (action === "read-all" && mailboxId) {
    q.run("UPDATE messages SET read_at = ? WHERE mailbox_id = ? AND user_id = ? AND read_at IS NULL", now(), mailboxId, session.user_id);
    return { status: 200, body: { ok: true } };
  }
  if (!ids.length) return fail(400, "Aucun message sélectionné.");

  if (action === "delete") {
    q.run(`DELETE FROM messages WHERE id IN (${placeholders}) AND user_id = ?`, ...ids, session.user_id);
  } else if (action === "read") {
    q.run(`UPDATE messages SET read_at = COALESCE(read_at, ?) WHERE id IN (${placeholders}) AND user_id = ?`, ...ids, session.user_id);
  } else if (action === "unread") {
    q.run(`UPDATE messages SET read_at = NULL WHERE id IN (${placeholders}) AND user_id = ?`, ...ids, session.user_id);
  } else if (action === "star") {
    q.run(`UPDATE messages SET starred = 1 WHERE id IN (${placeholders}) AND user_id = ?`, ...ids, session.user_id);
  } else {
    return fail(400, "Action inconnue.");
  }
  return { status: 200, body: { ok: true } };
}

/* ---------------- export ---------------- */

export async function exportMailbox({ params, session }) {
  const mailbox = q.one("SELECT * FROM mailboxes WHERE id = ? AND user_id = ?", params.id, session.user_id);
  if (!mailbox) return fail(404, "Boîte introuvable.");
  const messages = q.all(
    "SELECT remote_id, from_name, from_email, subject, body_html, body_text, received_at FROM messages WHERE mailbox_id = ? ORDER BY received_at ASC",
    mailbox.id,
  );

  const escape = (value) =>
    String(value ?? "").replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" }[c]));

  const entries = messages
    .map(
      (message) => `  <message>
    <id>${escape(message.remote_id)}</id>
    <fromName>${escape(message.from_name)}</fromName>
    <fromEmail>${escape(message.from_email)}</fromEmail>
    <subject>${escape(message.subject)}</subject>
    <date>${new Date(Number(message.received_at)).toISOString()}</date>
    <bodyHtml>${escape(message.body_html || "")}</bodyHtml>
    <bodyText>${escape(message.body_text || "")}</bodyText>
  </message>`,
    )
    .join("\n");

  const xml = `<?xml version="1.0" encoding="utf-8"?>
<mailbox address="${escape(mailbox.address)}" exportedAt="${new Date().toISOString()}" count="${messages.length}">
${entries}
</mailbox>`;

  const filename = `${mailbox.address.replace(/[^a-z0-9.@-]/gi, "_")}.xml`;
  return { status: 200, download: { filename, contentType: "application/xml; charset=utf-8", body: xml } };
}

export async function mailboxStats({ session }) {
  const rows = q.all(
    `SELECT m.mailbox_id, COUNT(*) AS total, SUM(CASE WHEN m.read_at IS NULL THEN 1 ELSE 0 END) AS unread
       FROM messages m WHERE m.user_id = ? GROUP BY m.mailbox_id`,
    session.user_id,
  );
  return { status: 200, body: { ok: true, stats: rows } };
}
