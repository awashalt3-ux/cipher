import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

/** Racine du projet (dossier contenant `server/` et `public/`). */
export const ROOT = path.resolve(here, "..");

/** Vérifie qu'un dossier existe et accepte l'écriture (les plateformes type Wasmer
 *  montent le code en lecture seule : il faut alors basculer ailleurs). */
function isWritable(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.cipher-write-${process.pid}-${Date.now()}`);
    fs.writeFileSync(probe, "ok");
    fs.unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}

function resolveDataDir() {
  const explicit = process.env.CIPHER_DATA_DIR;
  const candidates = explicit
    ? [explicit]
    : [
        path.join(ROOT, "data"),
        "/data", // volume persistant Wasmer Edge
        path.join("/data", "cipher"),
        path.join(os.tmpdir(), "cipher-mail"),
      ];

  for (const dir of candidates) {
    if (isWritable(dir)) return dir;
  }

  // Dernier recours : le dossier temporaire système, toujours inscriptible.
  const fallback = path.join(os.tmpdir(), "cipher-mail");
  fs.mkdirSync(fallback, { recursive: true });
  return fallback;
}

export const DATA_DIR = resolveDataDir();
export const UPLOAD_DIR = path.join(DATA_DIR, "uploads");
export const OUTBOX_DIR = path.join(DATA_DIR, "outbox");
export const DB_FILE = path.join(DATA_DIR, "cipher.db");

for (const dir of [DATA_DIR, UPLOAD_DIR, OUTBOX_DIR]) {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {}
}
