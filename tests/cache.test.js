import { describe, it, beforeEach } from "node:test"
import assert from "node:assert/strict"
import { createContactCache, SOURCE_TTL_DAYS } from "../src/contact-cache.js"

describe("contact-cache", () => {
  let cache
  let mockDb

  beforeEach(() => {
    const rows = new Map()
    mockDb = {
      prepare: (sql) => ({
        run: (...params) => {
          if (sql.includes("INSERT") || sql.includes("REPLACE")) {
            const id = params[0]
            rows.set(id, params)
            return { changes: 1 }
          }
          if (sql.includes("DELETE")) {
            const key = params[0]
            let deleted = 0
            for (const [id, row] of rows) {
              if (row[2] === key || id === key) { rows.delete(id); deleted++ }
            }
            return { changes: deleted }
          }
          if (sql.includes("UPDATE")) {
            return { changes: 1 }
          }
          return { changes: 0 }
        },
        get: (...params) => {
          const id = params[0]
          const row = rows.get(id)
          if (!row) return undefined
          return {
            id: row[0], domain: row[1], email: row[2], person_name: row[3],
            confidence: row[4], source: row[5], verified_at: row[6],
            bounced_at: row[7], expires_at: row[8], data_json: row[9],
          }
        },
        all: () => Array.from(rows.values()).map((r) => ({
          id: r[0], domain: r[1], email: r[2], person_name: r[3],
          confidence: r[4], source: r[5], verified_at: r[6],
          bounced_at: r[7], expires_at: r[8], data_json: r[9],
        })),
      }),
      exec: () => {},
      _rows: rows,
    }
    cache = createContactCache({ db: mockDb })
  })

  describe("createContactCache", () => {
    it("returns cache interface with required methods", () => {
      assert.equal(typeof cache.get, "function")
      assert.equal(typeof cache.set, "function")
      assert.equal(typeof cache.invalidateOnBounce, "function")
      assert.equal(typeof cache.stats, "function")
      assert.equal(typeof cache.gc, "function")
    })
  })

  describe("set + get", () => {
    it("stores and retrieves a contact", async () => {
      await cache.set({
        domain: "example.com",
        email: "alice@example.com",
        personName: "Alice Smith",
        confidence: 85,
        source: "smtp_verify",
      })
      const result = await cache.get("example.com", "alice@example.com")
      assert.ok(result)
      assert.equal(result.email, "alice@example.com")
      assert.equal(result.confidence, 85)
      assert.equal(result.source, "smtp_verify")
    })

    it("returns null for cache miss", async () => {
      const result = await cache.get("nothing.com", "nobody@nothing.com")
      assert.equal(result, null)
    })
  })

  describe("invalidateOnBounce", () => {
    it("marks email as bounced", async () => {
      await cache.set({
        domain: "example.com",
        email: "alice@example.com",
        confidence: 85,
        source: "smtp_verify",
      })
      const invalidated = await cache.invalidateOnBounce("alice@example.com")
      assert.ok(invalidated)
    })
  })

  describe("SOURCE_TTL_DAYS", () => {
    it("exports TTL configuration per source", () => {
      assert.equal(typeof SOURCE_TTL_DAYS, "object")
      assert.equal(SOURCE_TTL_DAYS.smtp_verify, 90)
      assert.equal(SOURCE_TTL_DAYS.web_scrape, 30)
      assert.equal(SOURCE_TTL_DAYS.search_engine, 14)
      assert.equal(SOURCE_TTL_DAYS.pattern, 7)
      assert.equal(SOURCE_TTL_DAYS.github, 60)
      assert.equal(SOURCE_TTL_DAYS.youtube, 45)
      assert.equal(SOURCE_TTL_DAYS.company_registry, 90)
      assert.equal(SOURCE_TTL_DAYS.bounce, 365)
    })
  })

  describe("no-db mode", () => {
    it("works without database", async () => {
      const noDbCache = createContactCache({})
      const result = await noDbCache.get("x.com", "x@x.com")
      assert.equal(result, null)
      const stats = await noDbCache.stats()
      assert.equal(stats.total, 0)
    })
  })
})
