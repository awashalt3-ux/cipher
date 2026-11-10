import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";

export function sendJson(res, status, data, extraHeaders = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...extraHeaders,
  });
  res.end(body);
}

export function sendText(res, status, body, type = "text/plain; charset=utf-8") {
  res.writeHead(status, { "Content-Type": type, "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}

export function redirect(res, location, cookies = []) {
  const headers = { Location: location, "Cache-Control": "no-store" };
  if (cookies.length) headers["Set-Cookie"] = cookies;
  res.writeHead(302, headers);
  res.end();
}

export function addCookies(res, list) {
  if (!list.length) return;
  const existing = res.getHeader("Set-Cookie");
  const all = existing ? [].concat(existing, list) : list;
  res.setHeader("Set-Cookie", all);
}

export async function readJson(req, limit = 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error("Payload trop volumineux"), { status: 413 });
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  const text = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(text);
  } catch {
    throw Object.assign(new Error("JSON invalide"), { status: 400 });
  }
}

export async function readForm(req, limit = 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error("Payload trop volumineux"), { status: 413 });
    chunks.push(chunk);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".json": "application/json; charset=utf-8",
};

export function serveStatic(rootDir, urlPath, res, { assetStamp = "" } = {}) {
  const clean = decodeURIComponent(urlPath.split("?")[0]);
  const target = path.normalize(path.join(rootDir, clean));
  if (!target.startsWith(path.normalize(rootDir))) return false;
  let stat;
  try {
    stat = fs.statSync(target);
  } catch {
    return false;
  }
  if (stat.isDirectory()) return false;
  const ext = path.extname(target).toLowerCase();

  // Les modules ES importent des chemins relatifs : on propage la version pour
  // garantir que le navigateur récupère la dernière version de chaque fichier.
  if (ext === ".js" && assetStamp) {
    let source = fs.readFileSync(target, "utf8");
    source = source.replace(/(from\s*["'])(\.{1,2}\/[^"']+\.js)(["'])/g, (_, before, spec, after) => {
      const [pathPart, hash = ""] = spec.split("#");
      return `${before}${pathPart}?v=${assetStamp}${hash ? `#${hash}` : ""}${after}`;
    });
    const body = Buffer.from(source, "utf8");
    res.writeHead(200, {
      "Content-Type": "text/javascript; charset=utf-8",
      "Content-Length": body.length,
      "Cache-Control": "no-cache",
      "X-Content-Type-Options": "nosniff",
    });
    res.end(body);
    return true;
  }

  res.writeHead(200, {
    "Content-Type": MIME[ext] || "application/octet-stream",
    "Content-Length": stat.size,
    "Cache-Control": "no-cache",
    "ETag": `"${stat.size.toString(16)}-${stat.mtimeMs.toString(16)}"`,
    "X-Content-Type-Options": "nosniff",
  });
  fs.createReadStream(target).pipe(res);
  return true;
}

export function streamFile(res, filePath, { contentType = "application/octet-stream", filename = "file", inline = false } = {}) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return false;
  }
  res.writeHead(200, {
    "Content-Type": contentType,
    "Content-Length": stat.size,
    "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${String(filename).replace(/["\\]/g, "_")}"`,
    "X-Content-Type-Options": "nosniff",
  });
  fs.createReadStream(filePath).pipe(res);
  return true;
}

export const toWeb = (nodeReq) => Readable.toWeb(nodeReq);
