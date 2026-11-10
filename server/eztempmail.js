/**
 * Client eztempmail.com
 * ---------------------
 * Le site n'expose pas d'API documentée. On reproduit exactement le flux du navigateur :
 *   GET  /                 -> csrf-token + cookies (session Laravel)
 *   POST /get_messages     -> crée/récupère la boîte de la session + messages
 *   POST /change           -> change l'adresse (nom personnalisé + domaine)
 *   POST /delete           -> supprime l'adresse courante
 *   GET  /change           -> liste des domaines disponibles
 *
 * Point clef : la boîte appartient à la SESSION (cookie `ez_temp_mail_session`).
 * En conservant ces cookies, on retrouve la boîte et ses messages à l'infini.
 */

const BASE = "https://www.eztempmail.com/";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const COOKIE_TTL = 10 * 24 * 3600 * 1000;

export class EzError extends Error {
  constructor(message, { status = 502, code = "ez_error" } = {}) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function cookieHeader(jar) {
  return Object.entries(jar || {})
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

function absorb(jar, response) {
  const list = response.headers.getSetCookie?.() || [];
  const next = { ...(jar || {}) };
  for (const raw of list) {
    const [pair, ...attrs] = raw.split(";");
    const index = pair.indexOf("=");
    if (index <= 0) continue;
    const name = pair.slice(0, index).trim();
    const value = pair.slice(index + 1).trim();
    const expired = attrs.some((a) => /max-age=0\b/i.test(a.trim()));
    if (expired) delete next[name];
    else next[name] = value;
  }
  return next;
}

function readCsrf(html) {
  return (html.match(/name="csrf-token" content="([^"]+)"/) || [])[1] || "";
}

async function request(path, { jar = {}, csrf = "", method = "GET", form = null, timeout = 25000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  const headers = {
    "User-Agent": UA,
    "Accept-Language": "en-US,en;q=0.9",
    Cookie: cookieHeader(jar),
    Origin: "https://www.eztempmail.com",
    Referer: BASE,
  };
  if (method === "POST") {
    headers["Content-Type"] = "application/x-www-form-urlencoded; charset=UTF-8";
    headers.Accept = "application/json, text/plain, */*";
    headers["X-Requested-With"] = "XMLHttpRequest";
    if (csrf) headers["X-CSRF-TOKEN"] = csrf;
  }
  try {
    const response = await fetch(BASE + path, {
      method,
      headers,
      body: form ? new URLSearchParams({ _token: csrf, ...form }).toString() : undefined,
      redirect: "manual",
      signal: controller.signal,
    });
    const text = await response.text();
    return {
      status: response.status,
      location: response.headers.get("location"),
      text,
      jar: absorb(jar, response),
    };
  } catch (error) {
    if (error.name === "AbortError") throw new EzError("Délai dépassé en contactant eztempmail.com", { status: 504, code: "timeout" });
    throw new EzError(`Connexion impossible à eztempmail.com (${error.message})`, { status: 502, code: "network" });
  } finally {
    clearTimeout(timer);
  }
}

/** Ouvre une session : cookies + jeton CSRF. */
export async function openSession(jar = {}, csrf = "") {
  const res = await request("", { jar });
  if (res.status >= 400) throw new EzError(`eztempmail.com a répondu ${res.status}`, { status: 502 });
  const token = readCsrf(res.text) || csrf;
  if (!token) throw new EzError("Jeton CSRF introuvable sur eztempmail.com", { status: 502, code: "no_csrf" });
  return { jar: res.jar, csrf: token };
}

function parseJson(res, what) {
  try {
    return JSON.parse(res.text);
  } catch {
    throw new EzError(`Réponse inattendue de eztempmail (${what})`, { status: 502, code: "bad_json" });
  }
}

/** Traduit les messages d'erreur d'eztempmail en erreurs exploitables. */
export function translateError(message) {
  const raw = String(message || "");
  // eztempmail renvoie parfois un JSON complet dans le champ message
  let text = raw;
  if (raw.trim().startsWith("{")) {
    try {
      const parsed = JSON.parse(raw);
      text = Object.values(parsed.errors || {}).flat().join(" · ") || parsed.message || raw;
    } catch {}
  }
  if (/daily limit|reached your daily|too many/i.test(text)) {
    return new EzError(
      "eztempmail a atteint sa limite journalière de création pour cette adresse IP. Réessayez plus tard, ou importez une adresse déjà existante.",
      { status: 429, code: "daily_limit" },
    );
  }
  if (/not available|no longer|already/i.test(text)) {
    return new EzError("Cette adresse n'est plus disponible. Essayez un autre nom ou un autre domaine.", {
      status: 409,
      code: "unavailable",
    });
  }
  if (/invalid|characters/i.test(text)) {
    return new EzError("Nom d'adresse refusé par eztempmail. Utilisez des lettres et des chiffres.", {
      status: 400,
      code: "invalid_name",
    });
  }
  return new EzError(text || "Opération refusée par eztempmail", { status: 502 });
}

/** Récupère (ou crée) la boîte associée à la session, avec ses messages. */
export async function fetchInbox(session) {
  const res = await request("get_messages", { jar: session.jar, csrf: session.csrf, method: "POST", form: { captcha: "", turnstile: "" } });
  if (res.status === 419 || res.status === 401) throw new EzError("Session expirée", { status: 409, code: "session_expired" });
  if (res.status !== 200) throw new EzError(`eztempmail a répondu ${res.status}`, { status: 502 });
  const data = parseJson(res, "get_messages");
  if (!data || data.status !== true || !data.mailbox) {
    throw translateError(data?.message || data?.error || "Boîte indisponible");
  }
  return {
    jar: res.jar,
    csrf: session.csrf,
    mailbox: data.mailbox,
    recoveryKey: data.recovery_key || null,
    emailToken: data.email_token || null,
    messages: Array.isArray(data.messages) ? data.messages : [],
    histories: Array.isArray(data.histories) ? data.histories : [],
  };
}

/** Change l'adresse de la boîte courante. `name` vide = adresse aléatoire. */
export async function changeAddress(session, { name = "", domain = "" } = {}) {
  // la page /change initialise son propre couple session+csrf
  const page = await request("change", { jar: session.jar });
  const csrf = readCsrf(page.text) || session.csrf;
  const working = { jar: page.jar, csrf };
  const res = await request("change", {
    ...working,
    method: "POST",
    form: { name: String(name || "").trim(), domain: String(domain || "").trim() },
  });
  if (res.status === 422) {
    let detail = "Adresse refusée";
    try {
      const parsed = JSON.parse(res.text);
      detail = Object.values(parsed.errors || {}).flat().join(" · ") || parsed.message || detail;
    } catch {}
    const translated = translateError(detail);
    // On conserve le détail lisible d'eztempmail pour les erreurs non catégorisées
    if (translated.code === undefined) translated.message = detail;
    throw translated;
  }
  if (res.status >= 400) throw new EzError(`eztempmail a répondu ${res.status}`, { status: 502 });
  return { jar: res.jar, csrf };
}

/** Supprime l'adresse courante (elle ne sera plus relevée). */
export async function deleteAddress(session) {
  const res = await request("delete", { jar: session.jar, csrf: session.csrf, method: "POST", form: {} });
  if (res.status === 419) throw new EzError("Session expirée", { status: 409, code: "session_expired" });
  if (res.status >= 400) throw new EzError(`eztempmail a répondu ${res.status}`, { status: 502 });
  return res.jar;
}

/** Liste des domaines proposés. */
export async function listDomains() {
  const res = await request("change", { jar: {} });
  if (res.status !== 200) throw new EzError("Impossible de charger les domaines", { status: 502 });
  const domains = [];
  for (const match of res.text.matchAll(/<option value="([^"]+)">\s*([^<]*?)\s*<\/option>/g)) {
    const value = match[1].trim();
    if (/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(value)) domains.push({ domain: value, label: (match[2] || value).trim() });
  }
  return [...new Map(domains.map((d) => [d.domain, d])).values()];
}

/**
 * Les horodatages d'eztempmail sont exprimés en heure du Pacifique (UTC-8),
 * sans indication de fuseau. On les convertit en epoch UTC de façon déterministe.
 */
export function parsePacificStamp(value) {
  if (value == null) return Date.now();
  if (typeof value === "number") return value;
  const text = String(value).trim();
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!match) {
    const parsed = Date.parse(text);
    return Number.isFinite(parsed) ? parsed : Date.now();
  }
  const [, y, mo, d, h, mi, s] = match;
  return Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h) + 8, Number(mi), Number(s || 0));
}

/** Normalise un message brut d'eztempmail (le corps HTML est fourni dans `content`). */
export function normalizeMessage(raw) {
  const fromEmail = String(raw.from_email || raw.from || "").trim();
  const fromName = String(raw.from_name || "").trim() || fromEmail.split("@")[0] || "Inconnu";
  const content = typeof raw.content === "string" ? raw.content : "";
  const attachments = Array.isArray(raw.attachments)
    ? raw.attachments.map((item) => ({
        filename: String(item.filename || item.name || "piece-jointe"),
        contentType: String(item.content_type || item.mimetype || "application/octet-stream"),
        size: Number(item.size || 0) || null,
        remoteUrl: item.url || item.download_url || null,
      }))
    : [];
  return {
    remoteId: String(raw.id ?? raw.message_id ?? ""),
    fromName,
    fromEmail,
    toEmail: String(raw.to || raw.mailbox || "").trim(),
    subject: String(raw.subject || "(sans objet)").trim(),
    receivedAt: parsePacificStamp(raw.receivedAt || raw.created_at),
    isSeen: Boolean(raw.is_seen),
    bodyHtml: content || null,
    attachments,
  };
}

export const sessionCookieExpiry = () => Date.now() + COOKIE_TTL;
