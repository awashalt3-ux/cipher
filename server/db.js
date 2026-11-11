/**
 * Couche base de données.
 *
 * Deux moteurs, choisis automatiquement :
 *  - Postgres (pg) quand `DB_HOST` ou `DATABASE_URL` est fourni — c'est le cas
 *    sur Wasmer Edge, qui provisionne une base managée et injecte ces variables ;
 *  - SQLite (node:sqlite) en local, chargé par `import()` dynamique car le
 *    runtime WebAssembly de Wasmer Edge n'expose pas le binding `sqlite`
 *    (un import statique tuerait le processus au démarrage).
 *
 * L'API `q` est asynchrone dans les deux cas, pour un code appelant unique.
 * Les requêtes restent écrites avec des `?` : elles sont traduites en `$n`
 * pour Postgres.
 */

import { DB_FILE, DATA_DIR } from "./paths.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  email_verified INTEGER NOT NULL DEFAULT 0,
  verify_token TEXT,
  verify_sent_at BIGINT,
  totp_secret TEXT,
  totp_enabled INTEGER NOT NULL DEFAULT 0,
  totp_pending_secret TEXT,
  backup_codes TEXT,
  created_at BIGINT NOT NULL,
  last_login_at BIGINT,
  storage_quota BIGINT NOT NULL DEFAULT 209715200
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  csrf TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  last_seen_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL,
  ip TEXT,
  user_agent TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS mailboxes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  address TEXT NOT NULL,
  domain TEXT,
  label TEXT,
  notes TEXT,
  recovery_key TEXT,
  email_token TEXT,
  ez_session TEXT,
  ez_csrf TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at BIGINT NOT NULL,
  last_polled_at BIGINT,
  last_seen_at BIGINT,
  expires_at BIGINT,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_mailboxes_user_address ON mailboxes(user_id, address);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  mailbox_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  remote_id TEXT,
  from_name TEXT,
  from_email TEXT,
  to_email TEXT,
  subject TEXT,
  preview TEXT,
  body_html TEXT,
  body_text TEXT,
  code TEXT,
  received_at BIGINT NOT NULL,
  stored_at BIGINT NOT NULL,
  read_at BIGINT,
  starred INTEGER NOT NULL DEFAULT 0,
  has_attachments INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (mailbox_id) REFERENCES mailboxes(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_mailbox_remote ON messages(mailbox_id, remote_id);
CREATE INDEX IF NOT EXISTS idx_messages_user_received ON messages(user_id, received_at DESC);

CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  filename TEXT,
  content_type TEXT,
  size BIGINT,
  remote_url TEXT,
  stored_path TEXT,
  created_at BIGINT NOT NULL,
  FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_attachments_message ON attachments(message_id);

CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  action TEXT NOT NULL,
  detail TEXT,
  ip TEXT,
  created_at BIGINT NOT NULL
);
`;

/* ------------------------------------------------------------------ */
/* Postgres                                                            */
/* ------------------------------------------------------------------ */

function toPgPlaceholders(sql) {
  let index = 0;
  // Les requêtes du projet ne contiennent jamais de « ? » littéral.
  return sql.replace(/\?/g, () => `$${++index}`);
}

function databaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  if (!process.env.DB_HOST) return "";
  const user = encodeURIComponent(process.env.DB_USERNAME || "");
  const pass = encodeURIComponent(process.env.DB_PASSWORD || "");
  const host = process.env.DB_HOST;
  const port = process.env.DB_PORT || 5432;
  const name = encodeURIComponent(process.env.DB_NAME || "postgres");
  return `postgresql://${user}:${pass}@${host}:${port}/${name}`;
}

async function initPostgres() {
  const { default: pg } = await import("pg");
  const connectionString = databaseUrl();
  const pool = new pg.Pool({
    connectionString,
    max: Number(process.env.DB_POOL_SIZE || 4),
    idleTimeoutMillis: 15000,
    connectionTimeoutMillis: 10000,
    // Le certificat du serveur est émis par une autorité privée : on chiffre
    // sans vérifier la chaîne (recommandation Wasmer Edge).
    ssl: String(process.env.DB_SSL || "on") === "off" || /[?&]sslmode=disable/.test(connectionString)
      ? false
      : { rejectUnauthorized: false },
  });
  pool.on("error", (error) => console.error("[db:pg] erreur de pool:", error.message));

  await pool.query("SELECT 1");
  await pool.query(SCHEMA);

  const all = async (sql, params) => (await pool.query(toPgPlaceholders(sql), params)).rows;
  const run = async (sql, params) => {
    const result = await pool.query(toPgPlaceholders(sql), params);
    return { changes: result.rowCount };
  };

  return {
    kind: "postgres",
    all,
    run,
    async tx(fn) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const scoped = {
          all: async (sql, params = []) => (await client.query(toPgPlaceholders(sql), params)).rows,
          run: async (sql, params = []) => {
            const result = await client.query(toPgPlaceholders(sql), params);
            return { changes: result.rowCount };
          },
        };
        const result = await fn(scoped);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    },
    async close() {
      await pool.end();
    },
  };
}

/* ------------------------------------------------------------------ */
/* SQLite (développement local)                                        */
/* ------------------------------------------------------------------ */

async function initSqlite() {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import("node:sqlite"));
  } catch {
    throw new Error(
      "SQLite natif indisponible sur ce runtime. Définissez DB_HOST (Postgres) pour utiliser une base distante.",
    );
  }

  const db = new DatabaseSync(DB_FILE);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec(SCHEMA);

  const all = async (sql, params) => db.prepare(sql).all(...params);
  const run = async (sql, params) => {
    const result = db.prepare(sql).run(...params);
    return { changes: Number(result?.changes ?? 0) };
  };

  return {
    kind: "sqlite",
    all,
    run,
    async tx(fn) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const result = await fn({ all, run });
        db.exec("COMMIT");
        return result;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    async close() {
      db.close();
    },
  };
}

/* ------------------------------------------------------------------ */
/* Initialisation différée                                             */
/* ------------------------------------------------------------------ */

let driverPromise = null;

/** Initialise (une seule fois) le moteur de base de données. */
export function dbReady() {
  driverPromise ??= (async () => {
    return process.env.DB_HOST || process.env.DATABASE_URL ? await initPostgres() : await initSqlite();
  })().catch((error) => {
    driverPromise = null;
    throw error;
  });
  return driverPromise;
}

const driver = () => dbReady();

/** Accès aux données. Toutes les méthodes sont asynchrones. */
export const q = {
  async one(sql, ...params) {
    const rows = await (await driver()).all(sql, params);
    return rows[0] ?? null;
  },
  async all(sql, ...params) {
    return (await driver()).all(sql, params);
  },
  async run(sql, ...params) {
    return (await driver()).run(sql, params);
  },
  async tx(fn) {
    return (await driver()).tx(fn);
  },
};

export async function dbInfo() {
  const active = await driver();
  return { kind: active.kind, dataDir: DATA_DIR, sqliteFile: active.kind === "sqlite" ? DB_FILE : null };
}
