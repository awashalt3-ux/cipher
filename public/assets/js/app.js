import {
  $, $$, ICONS, api, setCsrf, initTheme, toggleTheme, toast, copyText,
  timeAgo, fullDate, initials, avatarColor, escapeHtml, openModal, closeModal,
  confirmDialog, debounce, formatBytes,
} from "./common.js";

/* ================================================================== */
/* État                                                               */
/* ================================================================== */

const state = {
  user: null,
  mailboxes: [],
  activeId: null,
  messages: [],
  activeMessageId: null,
  filter: "all",
  search: "",
  sort: localStorage.getItem("cipher-sort") || "recent",
  csrf: "",
  polling: null,
  busy: false,
  domains: [],
  loadedAddress: "",
};

const teardown = [];

/* ================================================================== */
/* Démarrage                                                          */
/* ================================================================== */

initTheme();
paintThemeButton();

async function boot() {
  try {
    const data = await api("/api/auth/me");
    if (!data.user) return (location.href = "/login");
    state.user = data.user;
    state.csrf = data.csrf || "";
    setCsrf(state.csrf);
    paintUser();
  } catch {
    return (location.href = "/login");
  }

  const saved = localStorage.getItem("cipher-active-box");
  await loadMailboxes({ silent: true });

  const target = state.mailboxes.find((box) => box.id === saved) || state.mailboxes[0];
  if (target) await selectMailbox(target.id, { silent: true });
  else renderEmptyAll();

  startPolling();
  bindGlobal();
}

/** Raccourcis et comportements globaux, attachés une seule fois. */
function bindGlobal() {
  const isTyping = () => /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || "");

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      if (!$("#userMenu").hidden) {
        $("#userMenu").hidden = true;
        $("#userChip").setAttribute("aria-expanded", "false");
      }
      if (!$("#mainPanel").classList.contains("reading-collapsed")) {
        $("#mainPanel").classList.add("reading-collapsed");
        state.activeMessageId = null;
        renderMessages();
      }
      return;
    }
    if (isTyping() || event.metaKey || event.ctrlKey || event.altKey) return;

    if (event.key === "n" || event.key === "N") {
      event.preventDefault();
      openCreateModal();
    } else if (event.key === "r" || event.key === "R") {
      event.preventDefault();
      refreshActive();
    } else if (event.key === "/") {
      event.preventDefault();
      $("#searchInput").focus();
    }
  });

  // la relève reprend dès que l'onglet redevient visible
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) return;
    const box = activeMailbox();
    if (box) refreshActive({ silent: true });
  });
}

/* ================================================================== */
/* Compte                                                             */
/* ================================================================== */

function paintUser() {
  const { user } = state;
  if (!user) return;
  $("#userAvatar").textContent = initials(user.displayName);
  $("#userAvatar").style.background = avatarColor(user.email);
  $("#userName").textContent = user.displayName;
  $("#userMail").textContent = user.email;
  $("#menuName").textContent = user.displayName;
  $("#menuMail").textContent = user.email;
  $("#settingsName").textContent = user.displayName;
  $("#settingsEmail").textContent = user.email;
  $("#settingsAvatar").textContent = initials(user.displayName);
  $("#settingsAvatar").style.background = avatarColor(user.email);
  const badge = $("#settingsVerified");
  badge.textContent = user.verified ? "Vérifié" : "Non confirmé";
  badge.className = `chip ${user.verified ? "chip-success" : "chip-warn"}`;
}

/* ================================================================== */
/* Boîtes                                                             */
/* ================================================================== */

function sortMailboxes(list) {
  const sorted = [...list];
  if (state.sort === "alpha") {
    sorted.sort((a, b) => a.address.localeCompare(b.address));
  } else if (state.sort === "unread") {
    sorted.sort((a, b) => b.unread - a.unread || (b.lastReceivedAt || 0) - (a.lastReceivedAt || 0));
  } else {
    sorted.sort((a, b) => (b.lastReceivedAt || b.createdAt) - (a.lastReceivedAt || a.createdAt));
  }
  return sorted;
}

async function loadMailboxes({ silent = false } = {}) {
  try {
    const data = await api("/api/mailboxes");
    state.mailboxes = data.mailboxes;
    $("#collectionCount").textContent = String(data.totals.mailboxes);
    renderMailboxList();
    return true;
  } catch (error) {
    if (!silent) toast(error.message, "error");
    return false;
  }
}

function renderMailboxList() {
  const container = $("#mailboxList");
  const list = sortMailboxes(state.mailboxes);

  if (!list.length) {
    container.innerHTML = `
      <div style="padding:22px 12px;text-align:center;color:var(--text-faint);font-size:12.5px;line-height:1.6">
        <div style="width:44px;height:44px;border-radius:13px;background:var(--surface-3);display:grid;place-items:center;margin:0 auto 12px">
          ${ICONS.inbox}
        </div>
        Aucune boîte pour l'instant.<br>Créez-en une pour commencer.
      </div>`;
    container.querySelector("svg")?.style.setProperty("width", "20px");
    return;
  }

  container.innerHTML = list
    .map((box) => {
      const active = box.id === state.activeId;
      const label = box.label || box.address.split("@")[0];
      const sub = box.lastSubject
        ? `${box.lastFrom || "Message"} · ${timeAgo(box.lastReceivedAt)}`
        : box.status === "expired"
          ? "Session expirée"
          : box.status === "error"
            ? "Erreur de relève"
            : "En attente de messages";
      return `
        <button class="mailbox-item ${active ? "active" : ""}" data-id="${box.id}" role="listitem" title="${escapeHtml(box.address)}">
          <span class="mb-icon">${escapeHtml(initials(label))}</span>
          <span class="mb-main">
            <span class="mb-address">${escapeHtml(label)}</span>
            <span class="mb-sub">${box.status === "error" ? '<span class="mb-dot"></span>' : ""}${escapeHtml(sub)}</span>
          </span>
          ${box.unread ? `<span class="mb-badge">${box.unread > 99 ? "99+" : box.unread}</span>` : ""}
        </button>`;
    })
    .join("");

  for (const button of $$(".mailbox-item", container)) {
    button.addEventListener("click", () => {
      selectMailbox(button.dataset.id);
      $("#sidebar").classList.remove("open");
    });
  }
}

async function selectMailbox(id, { silent = false } = {}) {
  if (state.activeId === id && !silent) {
    $("#mainPanel").classList.remove("reading-collapsed");
    return;
  }
  state.activeId = id;
  state.activeMessageId = null;
  localStorage.setItem("cipher-active-box", id);
  state.search = "";
  $("#searchInput").value = "";
  $("#searchClear").classList.remove("visible");
  renderMailboxList();
  await loadMessages({ silent });
  $("#mainPanel").classList.add("reading-collapsed");
  renderReaderEmpty();
}

function activeMailbox() {
  return state.mailboxes.find((box) => box.id === state.activeId) || null;
}

function renderEmptyAll() {
  $("#listTitle").innerHTML = `Bienvenue dans Cipher Mail<small>Créez votre première boîte temporaire</small>`;
  $("#addressPill").hidden = true;
  $("#filters").hidden = true;
  $("#messageList").innerHTML = `
    <div class="empty-state">
      <div class="empty-art">${ICONS.inbox}</div>
      <h4>Votre collection est vide</h4>
      <p>Créez une boîte temporaire : elle sera archivée ici avec tous les messages qu'elle recevra, sans limite de durée.</p>
      <button class="btn btn-primary" id="emptyCreate">${ICONS.plus} Créer ma première boîte</button>
    </div>`;
  $("#emptyCreate")?.addEventListener("click", openCreateModal);
}

/* ================================================================== */
/* Messages                                                           */
/* ================================================================== */

async function loadMessages({ silent = false } = {}) {
  const box = activeMailbox();
  if (!box) return renderEmptyAll();

  const params = new URLSearchParams({ filter: state.filter, limit: "150" });
  if (state.search) params.set("search", state.search);

  try {
    const data = await api(`/api/mailboxes/${box.id}/messages?${params}`);
    state.messages = data.messages;
    state.loadedAddress = data.mailbox.address;

    $("#listTitle").innerHTML = `${escapeHtml(box.label || data.mailbox.address.split("@")[0])}
      <small>${escapeHtml(data.mailbox.address)}</small>`;
    $("#addressPill").hidden = false;
    $("#addressValue").textContent = data.mailbox.address;
    $("#filters").hidden = false;

    renderMessages();
  } catch (error) {
    if (!silent) toast(error.message, "error");
  }
}

const STAR_SVG = ICONS.star;
const STAR_FILL_SVG = ICONS.starFill;

function renderMessages() {
  const container = $("#messageList");
  const list = state.messages;

  if (!list.length) {
    const message = state.search
      ? `Aucun message ne correspond à « ${escapeHtml(state.search)} ».`
      : state.filter === "unread"
        ? "Aucun message non lu. Tout est à jour."
        : state.filter === "codes"
          ? "Aucun message contenant un code détecté."
          : state.filter === "starred"
            ? "Aucun message favori."
            : "En attente de messages. Cette boîte se met à jour automatiquement dès qu'un email arrive.";
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-art">${ICONS.mail}</div>
        <h4>${state.search ? "Aucun résultat" : "Boîte vide pour le moment"}</h4>
        <p>${message}</p>
      </div>`;
    return;
  }

  container.innerHTML = list
    .map((message) => {
      const from = message.from || message.fromEmail || "Inconnu";
      return `
      <button class="message-row ${message.read ? "" : "unread"} ${message.id === state.activeMessageId ? "selected" : ""}"
              data-id="${message.id}" role="listitem">
        <span class="row-avatar" style="background:${avatarColor(message.fromEmail || from)}">${escapeHtml(initials(from))}</span>
        <span class="row-main">
          <span class="row-line1">
            <span class="row-from">${escapeHtml(from)}</span>
            <span class="row-time">${timeAgo(message.receivedAt)}</span>
          </span>
          <span class="row-subject">${escapeHtml(message.subject)}</span>
          <span class="row-preview">${escapeHtml(message.preview || "")}</span>
        </span>
        <span class="row-flags">
          ${message.code ? `<span class="flag-code" data-copy-code="${escapeHtml(message.code)}" title="Copier le code">${escapeHtml(message.code)}</span>` : ""}
          ${message.starred ? `<span class="flag-star">${STAR_FILL_SVG}</span>` : ""}
          ${message.read ? "" : '<span class="flag-unread"></span>'}
        </span>
      </button>`;
    })
    .join("");

  for (const row of $$(".message-row", container)) {
    row.addEventListener("click", (event) => {
      const code = event.target.closest("[data-copy-code]");
      if (code) {
        event.stopPropagation();
        copyText(code.dataset.copyCode);
        return;
      }
      openMessage(row.dataset.id);
    });
  }
}

function renderReaderEmpty() {
  $("#readerSubject").textContent = "";
  $("#readerBody").innerHTML = `
    <div class="empty-state">
      <div class="empty-art">${ICONS.mail}</div>
      <h4>Sélectionnez un message</h4>
      <p>Le contenu s'affiche ici, avec le code de vérification détecté et copiable en un clic.</p>
    </div>`;
}

async function openMessage(id) {
  state.activeMessageId = id;
  renderMessages();
  $("#mainPanel").classList.remove("reading-collapsed");
  $("#readerBody").innerHTML = `
    <div style="padding:26px 22px;display:flex;flex-direction:column;gap:12px">
      <div class="skeleton" style="height:22px;width:60%"></div>
      <div class="skeleton" style="height:14px;width:38%"></div>
      <div class="skeleton" style="height:180px;margin-top:16px"></div>
    </div>`;

  try {
    const data = await api(`/api/messages/${id}`);
    renderReader(data.message);
    const message = state.messages.find((item) => item.id === id);
    if (message && !message.read) {
      message.read = true;
      renderMessages();
      loadMailboxes({ silent: true });
    }
  } catch (error) {
    toast(error.message, "error");
    renderReaderEmpty();
  }
}

function renderReader(message) {
  $("#readerSubject").textContent = message.subject;

  const starButton = $("#readerStar");
  starButton.innerHTML = message.starred ? STAR_FILL_SVG : STAR_SVG;
  starButton.style.color = message.starred ? "var(--warn)" : "";
  starButton.dataset.id = message.id;

  const safeHtml = sanitizeEmail(message.bodyHtml || `<pre>${escapeHtml(message.bodyText || message.preview || "Ce message ne contient pas de corps lisible.")}</pre>`);
  state.remoteImagesBlocked = true;

  $("#readerBody").innerHTML = `
    <div class="reader-meta">
      <span class="avatar" style="background:${avatarColor(message.fromEmail)}">${escapeHtml(initials(message.from))}</span>
      <div class="reader-sender-meta">
        <div class="reader-sender-name">${escapeHtml(message.from)}
          ${message.code ? '<span class="chip chip-success">Code détecté</span>' : ""}
        </div>
        <div class="reader-sender-mail">${escapeHtml(message.fromEmail)}</div>
        <div class="reader-sender-mail">à ${escapeHtml(message.mailboxAddress)}</div>
      </div>
      <div class="reader-date" title="${escapeHtml(fullDate(message.receivedAt))}">${timeAgo(message.receivedAt)}</div>
    </div>

    <div style="padding:14px 22px 0">
      <div class="reader-title">${escapeHtml(message.subject)}</div>
    </div>

    ${message.code ? `
      <div class="code-banner">
        <div>
          <div class="code-label">Code de vérification détecté</div>
          <div class="code-value">${escapeHtml(message.code)}</div>
        </div>
        <button class="btn btn-sm btn-outline" style="margin-left:auto" id="copyReaderCode">${ICONS.copy} Copier</button>
      </div>` : ""}

    ${message.attachments?.length ? `
      <div style="padding:14px 22px 0;display:flex;gap:8px;flex-wrap:wrap">
        ${message.attachments.map((file) => `
          <span class="chip" title="${escapeHtml(file.contentType)}">
            ${escapeHtml(file.filename)}${file.size ? ` · ${formatBytes(file.size)}` : ""}
          </span>`).join("")}
      </div>` : ""}

    <div class="mail-frame-wrap">
      <div class="images-notice" id="imagesNotice" hidden>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2.5"/><circle cx="8.5" cy="10" r="1.6"/><path d="m4 17 5-5 4 4 3-3 4 4"/></svg>
        <span>Les images distantes sont bloquées pour protéger votre vie privée.</span>
        <button class="btn btn-sm btn-soft" id="showImagesBtn">Afficher les images</button>
      </div>
      <div class="mail-body" id="mailBody"></div>
    </div>`;

  const host = document.getElementById("mailBody");
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = `<style>${EMAIL_CSS}</style>${safeHtml}`;
  bindEmailContent(root, safeHtml);

  $("#copyReaderCode")?.addEventListener("click", () => copyText(message.code));
}

const EMAIL_CSS = `
  :host { display: block; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body, :host {
    color: #1f2430;
    font: 14px/1.62 -apple-system, "Segoe UI", Roboto, system-ui, sans-serif;
    word-break: break-word;
    overflow-wrap: anywhere;
  }
  img { max-width: 100% !important; height: auto !important; }
  table { max-width: 100% !important; border-collapse: collapse; }
  td, th { max-width: 100%; }
  pre { white-space: pre-wrap; font-family: ui-monospace, Consolas, monospace; font-size: 13px; }
  a { color: #1a73e8; }
  blockquote { margin: 0 0 0 4px; padding-left: 14px; border-left: 2px solid #e2e8f2; color: #5f6b7d; }
  h1, h2, h3 { line-height: 1.28; }
  :host-context(html[data-theme="dark"]) body,
  :host-context(html[data-theme="dark"]) :host { color: #e7ebf3; }
  :host-context(html[data-theme="dark"]) a { color: #8ab4f8; }
  :host-context(html[data-theme="dark"]) blockquote { border-color: #3a4251; color: #a3adc0; }
  :host-context(html[data-theme="dark"]) img { filter: brightness(.92); }
`;

/** Neutralise les images distantes et sécurise les liens du message. */
function bindEmailContent(root, safeHtml) {
  const images = [...root.querySelectorAll("img")];
  const blocked = images
    .filter((img) => /^https?:/i.test(img.getAttribute("src") || ""))
    .map((img) => {
      img.dataset.realSrc = img.getAttribute("src");
      img.setAttribute("src", TRANSPARENT_PIXEL);
      img.style.minHeight = img.style.minHeight || "18px";
      return img;
    });

  const notice = $("#imagesNotice");
  if (notice && blocked.length) {
    notice.hidden = false;
    $("#showImagesBtn")?.addEventListener("click", () => {
      for (const img of blocked) img.setAttribute("src", img.dataset.realSrc || "");
      notice.hidden = true;
    });
  }

  for (const anchor of root.querySelectorAll("a[href]")) {
    const href = anchor.getAttribute("href") || "";
    if (!/^(https?:|mailto:)/i.test(href)) {
      anchor.removeAttribute("href");
      continue;
    }
    anchor.setAttribute("target", "_blank");
    anchor.setAttribute("rel", "noopener noreferrer nofollow");
  }
}

const TRANSPARENT_PIXEL =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='1' height='1'%3E%3C/svg%3E";

/**
 * Nettoyage défensif : les emails sont du HTML arbitraire.
 * On retire les scripts, cadres et gestionnaires d'événements avant insertion.
 */
function sanitizeEmail(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, "")
    .replace(/<frame[\s\S]*?>/gi, "")
    .replace(/<object[\s\S]*?<\/object>/gi, "")
    .replace(/<embed[\s\S]*?>/gi, "")
    .replace(/<link[^>]*>/gi, "")
    .replace(/<meta[^>]*>/gi, "")
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/(href|src)\s*=\s*(["'])\s*javascript:[^"']*\2/gi, '$1="#"');
}

/* ================================================================== */
/* Actions sur la boîte active                                        */
/* ================================================================== */

$("#copyAddressBtn").addEventListener("click", () => {
  const box = activeMailbox();
  if (box) copyText(state.loadedAddress || box.address);
});

for (const chip of $$(".filter-chip")) {
  chip.addEventListener("click", () => {
    $$(".filter-chip").forEach((item) => item.classList.toggle("active", item === chip));
    state.filter = chip.dataset.filter;
    loadMessages();
  });
}

const onSearch = debounce(() => {
  state.search = $("#searchInput").value.trim();
  loadMessages();
}, 300);

$("#searchInput").addEventListener("input", () => {
  $("#searchClear").classList.toggle("visible", $("#searchInput").value.length > 0);
  onSearch();
});

$("#searchClear").addEventListener("click", () => {
  $("#searchInput").value = "";
  state.search = "";
  $("#searchClear").classList.remove("visible");
  loadMessages();
});

$("#markAllReadBtn").addEventListener("click", async () => {
  const box = activeMailbox();
  if (!box) return;
  try {
    await api("/api/messages/bulk", { method: "POST", body: { action: "read-all", mailboxId: box.id } });
    await Promise.all([loadMessages({ silent: true }), loadMailboxes({ silent: true })]);
    toast("Tous les messages sont marqués comme lus", "success");
  } catch (error) {
    toast(error.message, "error");
  }
});

$("#readerBack").addEventListener("click", () => {
  $("#mainPanel").classList.add("reading-collapsed");
  state.activeMessageId = null;
  renderMessages();
});

$("#exportBtn").addEventListener("click", () => {
  const box = activeMailbox();
  if (!box) return toast("Sélectionnez d'abord une boîte", "warn");
  window.location.href = `/api/mailboxes/${box.id}/export`;
  toast("Export XML lancé", "info", 2200);
});

$("#readerStar").addEventListener("click", async (event) => {
  const id = event.currentTarget.dataset.id;
  if (!id) return;
  const message = state.messages.find((item) => item.id === id);
  try {
    await api(`/api/messages/${id}`, { method: "PATCH", body: { starred: !message?.starred } });
    if (message) message.starred = !message.starred;
    toast(message?.starred ? "Ajouté aux favoris" : "Retiré des favoris", "success", 1800);
    await Promise.all([loadMessages({ silent: true }), loadMailboxes({ silent: true })]);
    openMessage(id);
  } catch (error) {
    toast(error.message, "error");
  }
});

$("#readerDelete").addEventListener("click", async () => {
  if (!state.activeMessageId) return;
  const ok = await confirmDialog({
    title: "Supprimer ce message ?",
    message: "Le message sera retiré de votre archive Cipher Mail. L'original reste sur le serveur eztempmail.",
    confirmLabel: "Supprimer",
    danger: true,
  });
  if (!ok) return;
  try {
    await api(`/api/messages/${state.activeMessageId}`, { method: "DELETE" });
    state.activeMessageId = null;
    $("#mainPanel").classList.add("reading-collapsed");
    renderReaderEmpty();
    await Promise.all([loadMessages({ silent: true }), loadMailboxes({ silent: true })]);
    toast("Message supprimé", "success", 2000);
  } catch (error) {
    toast(error.message, "error");
  }
});

/* ================================================================== */
/* Actualisation                                                      */
/* ================================================================== */

async function refreshActive({ silent = false } = {}) {
  const box = activeMailbox();
  if (!box) return;
  setPolling(true);
  try {
    const data = await api(`/api/mailboxes/${box.id}/refresh`, { method: "POST" });
    await Promise.all([loadMailboxes({ silent: true }), loadMessages({ silent: true })]);
    if (!silent) {
      if (data.added) toast(`${data.added} nouveau${data.added > 1 ? "x" : ""} message${data.added > 1 ? "s" : ""}`, "success", 2600);
      else toast("Boîte à jour", "info", 1800);
    }
    if (data.added) ping();
    return data;
  } catch (error) {
    if (!silent) toast(error.message, "error");
    await loadMailboxes({ silent: true });
  } finally {
    setPolling(false);
  }
}

$("#refreshBtn").addEventListener("click", async () => {
  const box = activeMailbox();
  if (box) await refreshActive();
  else await refreshAll();
});

$("#refreshAllBtn").addEventListener("click", refreshAll);

async function refreshAll() {
  if (state.busy) return;
  state.busy = true;
  setPolling(true);
  try {
    const data = await api("/api/mailboxes/refresh", { method: "POST" });
    await Promise.all([loadMailboxes({ silent: true }), loadMessages({ silent: true })]);
    toast(`Relève terminée : ${data.refreshed} boîte${data.refreshed > 1 ? "s" : ""}${data.failed ? `, ${data.failed} en erreur` : ""}`, data.failed ? "warn" : "success");
  } catch (error) {
    toast(error.message, "error");
  } finally {
    state.busy = false;
    setPolling(false);
  }
}

function setPolling(busy) {
  const indicator = $("#pollIndicator");
  indicator.classList.toggle("busy", busy);
  $("#pollLabel").textContent = busy ? "Relève…" : "En direct";
}

function ping() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.16, ctx.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.28);
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.3);
    osc.onended = () => ctx.close();
  } catch {}
}

/* ---------------- relève périodique ---------------- */

function startPolling() {
  clearInterval(state.polling);
  state.polling = setInterval(async () => {
    if (document.hidden) return;
    const box = activeMailbox();
    if (!box) return;
    try {
      const before = state.messages.length;
      const data = await api(`/api/mailboxes/${box.id}/refresh`, { method: "POST" });
      if (data.added > 0) {
        await Promise.all([loadMailboxes({ silent: true }), loadMessages({ silent: true })]);
        ping();
      } else {
        await loadMailboxes({ silent: true });
      }
    } catch {}
  }, 15000);
}

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) {
    const box = activeMailbox();
    if (box) refreshActive({ silent: true });
  }
});

/* ================================================================== */
/* Création de boîte                                                  */
/* ================================================================== */

let domainsLoaded = false;

async function ensureDomains() {
  if (domainsLoaded && state.domains.length) return state.domains;
  try {
    const data = await api("/api/mailboxes/domains");
    state.domains = data.domains;
    domainsLoaded = true;
  } catch {
    state.domains = [{ domain: "goofyfox.com", label: "goofyfox.com" }];
  }
  return state.domains;
}

async function fillDomainSelect(select, selected = "") {
  const domains = await ensureDomains();
  select.innerHTML = domains.map((item) => `<option value="${escapeHtml(item.domain)}">${escapeHtml(item.label)}</option>`).join("");
  if (selected) select.value = selected;
}

function openCreateModal() {
  $("#createError").hidden = true;
  $("#newLocal").value = "";
  $("#newLabel").value = "";
  updateAddressPreview();
  fillDomainSelect($("#newDomain"));
  openModal("createModal");
  setTimeout(() => $("#newLocal").focus(), 120);
}

function updateAddressPreview() {
  const local = $("#newLocal").value.trim().toLowerCase() || "adresse-aleatoire";
  const domain = $("#newDomain").value || "…";
  $("#newAddressPreview").textContent = `${local}@${domain}`;
}

$("#newLocal").addEventListener("input", updateAddressPreview);
$("#newDomain").addEventListener("change", updateAddressPreview);

$("#createConfirm").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  const original = button.textContent;
  $("#createError").hidden = true;
  button.disabled = true;
  button.innerHTML = '<span class="spinner"></span> Création…';

  try {
    const body = {
      local: $("#newLocal").value.trim().toLowerCase(),
      domain: $("#newDomain").value,
      label: $("#newLabel").value.trim(),
    };
    const data = await api("/api/mailboxes", { method: "POST", body });
    closeModal("createModal");
    await loadMailboxes({ silent: true });
    await selectMailbox(data.mailbox.id, { silent: true });
    toast(`Boîte ${data.mailbox.address} créée`, "success");
    if (data.warning) toast(data.warning, "warn", 8000);
    copyText(data.mailbox.address, { silent: true });
  } catch (error) {
    $("#createErrorText").textContent = error.message;
    $("#createError").hidden = false;
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
});

$("#createBtn").addEventListener("click", openCreateModal);

/* ================================================================== */
/* Import d'adresse                                                   */
/* ================================================================== */

$("#importBtn").addEventListener("click", () => {
  $("#importError").hidden = true;
  $("#importAddress").value = "";
  $("#importLabel").value = "";
  openModal("importModal");
});

$("#importConfirm").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  const original = button.textContent;
  $("#importError").hidden = true;

  const address = $("#importAddress").value.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(address)) {
    $("#importErrorText").textContent = "Saisissez une adresse email complète.";
    $("#importError").hidden = false;
    return;
  }

  button.disabled = true;
  button.innerHTML = '<span class="spinner"></span> Import…';
  try {
    const data = await api("/api/mailboxes/import", { method: "POST", body: { address, label: $("#importLabel").value.trim() } });
    closeModal("importModal");
    await loadMailboxes({ silent: true });
    await selectMailbox(data.mailbox.id, { silent: true });
    toast(`Adresse ${data.mailbox.address} importée`, "success");
  } catch (error) {
    $("#importErrorText").textContent = error.message;
    $("#importError").hidden = false;
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
});

/* ================================================================== */
/* Options de la boîte                                                */
/* ================================================================== */

$("#mailboxMenuBtn").addEventListener("click", async () => {
  const box = activeMailbox();
  if (!box) return toast("Sélectionnez d'abord une boîte", "warn");

  $("#boxError").hidden = true;
  $("#boxAddress").textContent = box.address;
  $("#boxLabelEdit").value = box.label || "";
  $("#boxNotes").value = box.notes || "";
  $("#boxLocal").value = box.address.split("@")[0];
  await fillDomainSelect($("#boxDomain"), box.domain);
  openModal("boxModal");
});

$("#boxCopy").addEventListener("click", () => {
  const box = activeMailbox();
  if (box) copyText(box.address);
});

$("#boxSave").addEventListener("click", async (event) => {
  const box = activeMailbox();
  if (!box) return;
  const button = event.currentTarget;
  const original = button.textContent;
  $("#boxError").hidden = true;
  button.disabled = true;
  button.innerHTML = '<span class="spinner"></span>';

  try {
    await api(`/api/mailboxes/${box.id}`, {
      method: "PATCH",
      body: { label: $("#boxLabelEdit").value.trim(), notes: $("#boxNotes").value.trim() },
    });

    const newLocal = $("#boxLocal").value.trim().toLowerCase();
    const newDomain = $("#boxDomain").value;
    const currentLocal = box.address.split("@")[0];
    if (newLocal && (newLocal !== currentLocal || newDomain !== box.domain)) {
      await api(`/api/mailboxes/${box.id}/address`, { method: "POST", body: { local: newLocal, domain: newDomain } });
    }

    closeModal("boxModal");
    await loadMailboxes({ silent: true });
    await selectMailbox(box.id, { silent: true });
    toast("Boîte mise à jour", "success");
  } catch (error) {
    $("#boxErrorText").textContent = error.message;
    $("#boxError").hidden = false;
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
});

$("#boxDelete").addEventListener("click", async () => {
  const box = activeMailbox();
  if (!box) return;
  const ok = await confirmDialog({
    title: "Supprimer la boîte ?",
    message: `Tous les messages archivés de ${box.address} seront définitivement supprimés de Cipher Mail.`,
    confirmLabel: "Supprimer définitivement",
    danger: true,
  });
  if (!ok) return;
  try {
    await api(`/api/mailboxes/${box.id}`, { method: "DELETE" });
    closeModal("boxModal");
    state.activeId = null;
    await loadMailboxes({ silent: true });
    const next = state.mailboxes[0];
    if (next) await selectMailbox(next.id, { silent: true });
    else {
      renderEmptyAll();
      renderReaderEmpty();
    }
    toast("Boîte supprimée", "success");
  } catch (error) {
    toast(error.message, "error");
  }
});

/* ================================================================== */
/* Paramètres du compte                                               */
/* ================================================================== */

$("#menuSettings").addEventListener("click", () => {
  $("#userMenu").hidden = true;
  $("#settingsError").hidden = true;
  $("#curPassword").value = "";
  $("#newPassword").value = "";
  $("#newPassword2").value = "";
  openModal("settingsModal");
});

$("#changePasswordBtn").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  const original = button.textContent;
  $("#settingsError").hidden = true;

  const currentPassword = $("#curPassword").value;
  const newPassword = $("#newPassword").value;
  const newPassword2 = $("#newPassword2").value;

  if (!currentPassword) return showSettingsError("Saisissez votre mot de passe actuel.");
  if (newPassword.length < 10) return showSettingsError("Le nouveau mot de passe doit contenir au moins 10 caractères.");
  if (!/[A-Z]/.test(newPassword) || !/[a-z]/.test(newPassword) || !/[0-9]/.test(newPassword)) {
    return showSettingsError("Il faut au moins une majuscule, une minuscule et un chiffre.");
  }
  if (newPassword !== newPassword2) return showSettingsError("Les deux mots de passe ne correspondent pas.");

  button.disabled = true;
  button.innerHTML = '<span class="spinner"></span>';
  try {
    const data = await api("/api/auth/password", { method: "POST", body: { currentPassword, newPassword } });
    toast(data.message || "Mot de passe mis à jour", "success");
    $("#curPassword").value = "";
    $("#newPassword").value = "";
    $("#newPassword2").value = "";
    closeModal("settingsModal");
  } catch (error) {
    showSettingsError(error.message);
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
});

function showSettingsError(message) {
  $("#settingsErrorText").textContent = message;
  $("#settingsError").hidden = false;
}

/* ================================================================== */
/* Sécurité                                                           */
/* ================================================================== */

$("#menuSecurity").addEventListener("click", async () => {
  $("#userMenu").hidden = true;
  $("#securityError").hidden = true;
  openModal("securityModal");
  await Promise.all([renderTotpSection(), loadSessions()]);
});

async function renderTotpSection() {
  const container = $("#totpSection");
  const enabled = state.user?.totpEnabled;

  container.innerHTML = `
    <div style="display:flex;gap:14px;align-items:flex-start">
      <div style="width:40px;height:40px;border-radius:11px;display:grid;place-items:center;flex:0 0 auto;background:${enabled ? "var(--success-soft)" : "var(--surface-2)"};color:${enabled ? "var(--success)" : "var(--text-faint)"}">
        ${ICONS.shield}
      </div>
      <div style="flex:1;min-width:0">
        <h4 style="font-size:14px;margin-bottom:4px">Double authentification (TOTP)</h4>
        <p class="hint" style="margin-bottom:12px">${enabled
          ? "Active. Un code est demandé à chaque connexion."
          : "Protégez votre compte avec un code temporaire généré par une application d'authentification."}</p>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          ${enabled
            ? '<button class="btn btn-sm btn-outline" id="regenBackup">Nouveaux codes de secours</button><button class="btn btn-sm btn-danger-soft" id="disableTotp">Désactiver</button>'
            : '<button class="btn btn-sm btn-primary" id="enableTotp">Activer la double authentification</button>'}
        </div>
      </div>
    </div>`;

  $("#enableTotp")?.addEventListener("click", startTotpSetup);
  $("#disableTotp")?.addEventListener("click", disableTotp);
  $("#regenBackup")?.addEventListener("click", regenerateBackup);
}

async function startTotpSetup() {
  try {
    const data = await api("/api/auth/totp/setup", { method: "POST", body: {} });
    $("#totpSecret").textContent = data.secret;
    $("#totpCode").value = "";
    $("#totpError").hidden = true;
    $("#totpModal").dataset.secret = data.secret;
    openModal("totpModal");
  } catch (error) {
    toast(error.message, "error");
  }
}

$("#copyTotpSecret").addEventListener("click", () => copyText($("#totpSecret").textContent));

$("#totpConfirm").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  const original = button.textContent;
  const code = $("#totpCode").value.trim();
  $("#totpError").hidden = true;

  if (!/^\d{6}$/.test(code)) {
    $("#totpErrorText").textContent = "Saisissez le code à 6 chiffres de votre application.";
    $("#totpError").hidden = false;
    return;
  }

  button.disabled = true;
  button.innerHTML = '<span class="spinner"></span>';
  try {
    const data = await api("/api/auth/totp/enable", { method: "POST", body: { code } });
    closeModal("totpModal");
    closeModal("securityModal");
    state.user.totpEnabled = true;
    showBackupCodes(data.backupCodes);
    toast("Double authentification activée", "success");
  } catch (error) {
    $("#totpErrorText").textContent = error.message;
    $("#totpError").hidden = false;
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
});

function showBackupCodes(codes) {
  $("#backupCodes").innerHTML = codes.map((code) => `<span>${escapeHtml(code)}</span>`).join("");
  $("#backupCopy").onclick = () => copyText(codes.join("\n"));
  openModal("backupModal");
}

async function disableTotp() {
  const ok = await confirmDialog({
    title: "Désactiver la double authentification ?",
    message: "Votre compte ne sera plus protégé que par votre mot de passe.",
    confirmLabel: "Désactiver",
    danger: true,
  });
  if (!ok) return;

  const password = prompt("Confirmez avec votre mot de passe :");
  if (!password) return;
  try {
    await api("/api/auth/totp/disable", { method: "POST", body: { password } });
    state.user.totpEnabled = false;
    toast("Double authentification désactivée", "success");
    await renderTotpSection();
  } catch (error) {
    toast(error.message, "error");
  }
}

async function regenerateBackup() {
  const password = prompt("Confirmez avec votre mot de passe :");
  if (!password) return;
  try {
    const data = await api("/api/auth/totp/backup-codes", { method: "POST", body: { password } });
    showBackupCodes(data.backupCodes);
  } catch (error) {
    toast(error.message, "error");
  }
}

async function loadSessions() {
  try {
    const data = await api("/api/auth/sessions");
    const container = $("#sessionList");
    container.innerHTML = data.sessions
      .map((session) => {
        const agent = session.userAgent || "Client inconnu";
        const short = agent.length > 58 ? `${agent.slice(0, 58)}…` : agent;
        return `
        <div style="display:flex;align-items:center;gap:12px;padding:11px 13px;border-radius:10px;background:var(--surface-2);border:1px solid var(--border)">
          <div style="min-width:0;flex:1">
            <div style="font-size:12.5px;font-weight:600;display:flex;align-items:center;gap:8px">
              ${session.current ? '<span class="chip chip-success" style="padding:1px 8px">Session actuelle</span>' : ""}
              ${escapeHtml(session.ip || "IP inconnue")}
            </div>
            <div style="font-size:11.5px;color:var(--text-faint);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(short)}</div>
            <div style="font-size:11px;color:var(--text-faint);margin-top:2px">Dernière activité ${timeAgo(session.lastSeenAt)}</div>
          </div>
          ${session.current ? "" : `<button class="btn btn-sm btn-danger-soft" data-revoke="${session.id}">Révoquer</button>`}
        </div>`;
      })
      .join("");

    for (const button of $$("[data-revoke]", container)) {
      button.addEventListener("click", async () => {
        try {
          await api(`/api/auth/sessions/${button.dataset.revoke}`, { method: "DELETE" });
          toast("Session révoquée", "success");
          loadSessions();
        } catch (error) {
          toast(error.message, "error");
        }
      });
    }
  } catch (error) {
    toast(error.message, "error");
  }
}

/* ================================================================== */
/* Menu utilisateur / thème / déconnexion                             */
/* ================================================================== */

$("#userChip").addEventListener("click", (event) => {
  event.stopPropagation();
  const menu = $("#userMenu");
  const opening = menu.hidden;
  menu.hidden = !opening;
  $("#userChip").setAttribute("aria-expanded", String(opening));
  if (opening) {
    const rect = $("#userChip").getBoundingClientRect();
    menu.style.top = `${rect.bottom + 8}px`;
    menu.style.right = `${Math.max(12, window.innerWidth - rect.right)}px`;
  }
});

document.addEventListener("click", (event) => {
  if (!event.target.closest("#userMenu") && !event.target.closest("#userChip")) {
    $("#userMenu").hidden = true;
    $("#userChip").setAttribute("aria-expanded", "false");
  }
});

function paintThemeButton() {
  const dark = document.documentElement.dataset.theme === "dark";
  $("#themeBtn").innerHTML = dark
    ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><circle cx="12" cy="12" r="4.4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4"/></svg>'
    : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>';
}

$("#themeBtn").addEventListener("click", () => {
  toggleTheme();
  paintThemeButton();
});

$("#menuLogout").addEventListener("click", async () => {
  try {
    await api("/api/auth/logout", { method: "POST", body: {} });
  } catch {}
  localStorage.removeItem("cipher-active-box");
  location.href = "/login";
});

$("#sortBtn").addEventListener("click", () => {
  const order = ["recent", "unread", "alpha"];
  state.sort = order[(order.indexOf(state.sort) + 1) % order.length];
  localStorage.setItem("cipher-sort", state.sort);
  renderMailboxList();
  toast(`Tri : ${state.sort === "recent" ? "plus récents" : state.sort === "unread" ? "non lus d'abord" : "alphabétique"}`, "info", 1600);
});

/* ================================================================== */
/* Divers                                                             */
/* ================================================================== */

$("#sidebarToggle").addEventListener("click", () => $("#sidebar").classList.toggle("open"));

for (const button of $$("[data-close]")) {
  button.addEventListener("click", () => closeModal(button.dataset.close));
}

for (const backdrop of $$(".modal-backdrop")) {
  backdrop.addEventListener("click", (event) => {
    if (event.target === backdrop) closeModal(backdrop);
  });
}

document.addEventListener("keydown", (event) => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || "");
  if (event.key === "Escape") {
    if (!$("#userMenu").hidden) $("#userMenu").hidden = true;
    if (!$("#mainPanel").classList.contains("reading-collapsed")) {
      $("#mainPanel").classList.add("reading-collapsed");
      state.activeMessageId = null;
      renderMessages();
    }
  }
  if (typing) return;
  if (event.key === "n" || event.key === "N") {
    event.preventDefault();
    openCreateModal();
  }
  if (event.key === "r" || event.key === "R") {
    event.preventDefault();
    refreshActive();
  }
  if (event.key === "/") {
    event.preventDefault();
    $("#searchInput").focus();
  }
});

window.addEventListener("beforeunload", () => clearInterval(state.polling));

boot();
