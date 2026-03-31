import crypto from "node:crypto"

export const SOURCE_TTL_DAYS = Object.freeze({
  smtp_verify: 90,
  web_scrape: 30,
  search_engine: 14,
  pattern: 7,
  github: 60,
  youtube: 45,
  company_registry: 90,
  bounce: 365,
})

const CREATE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS contact_cache (
    id TEXT PRIMARY KEY,
    domain TEXT NOT NULL,
    email TEXT,
    person_name TEXT,
    confidence INTEGER DEFAULT 0,
    source TEXT,
    verified_at TEXT,
    bounced_at TEXT,
    expires_at TEXT,
    data_json TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  )
`

const CREATE_INDEXES_SQL = `
  CREATE INDEX IF NOT EXISTS idx_cc_domain ON contact_cache(domain);
  CREATE INDEX IF NOT EXISTS idx_cc_email ON contact_cache(email);
  CREATE INDEX IF NOT EXISTS idx_cc_expires ON contact_cache(expires_at);
`

function buildId(domain, email) {
  const raw = `${(domain || "").toLowerCase()}:${(email || "").toLowerCase()}`
  return crypto.createHash("sha256").update(raw).digest("hex").slice(0, 16)
}

function addDays(date, days) {
  const d = new Date(date)
  d.setDate(d.getDate() + days)
  return d.toISOString()
}

function nowIso() {
  return new Date().toISOString()
}

export function createContactCache(deps = {}) {
  const db = deps.db

  if (db && typeof db.exec === "function") {
    db.exec(CREATE_TABLE_SQL)
    try { db.exec(CREATE_INDEXES_SQL) } catch { /* indexes may already exist */ }
  }

  return {
    async get(domain, email) {
      if (!db) return null
      const id = buildId(domain, email)
      const row = db.prepare(
        "SELECT * FROM contact_cache WHERE id = ? AND (expires_at IS NULL OR expires_at > datetime('now')) AND bounced_at IS NULL"
      ).get(id)
      return row || null
    },

    async set({ domain, email, personName, confidence, source, data }) {
      if (!db) return null
      const id = buildId(domain, email)
      const ttlDays = SOURCE_TTL_DAYS[source] || 30
      const expiresAt = addDays(nowIso(), ttlDays)
      const now = nowIso()

      db.prepare(`
        INSERT OR REPLACE INTO contact_cache
        (id, domain, email, person_name, confidence, source, verified_at, bounced_at, expires_at, data_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)
      `).run(
        id,
        (domain || "").toLowerCase(),
        (email || "").toLowerCase(),
        personName || null,
        confidence || 0,
        source || "unknown",
        source === "smtp_verify" ? now : null,
        expiresAt,
        data ? JSON.stringify(data) : null,
        now,
        now,
      )

      return Object.freeze({ id, domain, email, confidence, source, expires_at: expiresAt })
    },

    async invalidateOnBounce(email) {
      if (!db) return false
      const now = nowIso()
      const result = db.prepare(
        "UPDATE contact_cache SET bounced_at = ?, confidence = 0, updated_at = ? WHERE email = ?"
      ).run(now, now, (email || "").toLowerCase())
      return result.changes > 0
    },

    async gc() {
      if (!db) return 0
      const result = db.prepare(
        "DELETE FROM contact_cache WHERE expires_at IS NOT NULL AND expires_at < datetime('now')"
      ).run()
      return result.changes
    },

    async stats() {
      if (!db) return { total: 0, expired: 0, bounced: 0 }
      const total = db.prepare("SELECT COUNT(*) as count FROM contact_cache").get()
      const bounced = db.prepare("SELECT COUNT(*) as count FROM contact_cache WHERE bounced_at IS NOT NULL").get()
      const expired = db.prepare(
        "SELECT COUNT(*) as count FROM contact_cache WHERE expires_at IS NOT NULL AND expires_at < datetime('now')"
      ).get()
      return Object.freeze({
        total: total?.count || 0,
        bounced: bounced?.count || 0,
        expired: expired?.count || 0,
      })
    },
  }
}
