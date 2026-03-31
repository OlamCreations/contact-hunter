import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { createContactHunter, domainSearch, findEmail, verifyEmail } from "../src/hunter.js"

describe("contact-hunter", () => {
  describe("createContactHunter", () => {
    it("returns object with all methods", () => {
      const hunter = createContactHunter()
      assert.equal(typeof hunter.domainSearch, "function")
      assert.equal(typeof hunter.findEmail, "function")
      assert.equal(typeof hunter.verifyEmail, "function")
      assert.equal(typeof hunter.discoverContacts, "function")
      assert.equal(typeof hunter.findPhone, "function")
    })
  })

  describe("verifyEmail", () => {
    it("returns deliverable for valid SMTP", async () => {
      const hunter = createContactHunter({
        verifySmtpFn: async () => ({ valid: true, catchAll: false, reason: "smtp_accepted" }),
      })
      const result = await hunter.verifyEmail("alice@example.com")
      assert.equal(result.result, "deliverable")
      assert.equal(result.score, 95)
    })

    it("returns risky for catch-all", async () => {
      const hunter = createContactHunter({
        verifySmtpFn: async () => ({ valid: true, catchAll: true, reason: "catch_all" }),
      })
      const result = await hunter.verifyEmail("anyone@example.com")
      assert.equal(result.result, "risky")
    })

    it("returns undeliverable for rejected", async () => {
      const hunter = createContactHunter({
        verifySmtpFn: async () => ({ valid: false, catchAll: false, reason: "smtp_rejected" }),
      })
      const result = await hunter.verifyEmail("bad@example.com")
      assert.equal(result.result, "undeliverable")
    })

    it("returns undeliverable for invalid format", async () => {
      const hunter = createContactHunter()
      const result = await hunter.verifyEmail("notanemail")
      assert.equal(result.result, "undeliverable")
    })
  })

  describe("findEmail", () => {
    it("finds email via pattern + SMTP verification", async () => {
      const hunter = createContactHunter({
        verifySmtpFn: async (email) => {
          if (email === "alice.smith@company.com") {
            return { valid: true, catchAll: false, reason: "smtp_accepted" }
          }
          return { valid: false, catchAll: false, reason: "smtp_rejected" }
        },
      })
      const result = await hunter.findEmail("company.com", "Alice Smith")
      assert.equal(result.email, "alice.smith@company.com")
      assert.ok(result.confidence > 0)
      assert.equal(result.firstName, "alice")
      assert.equal(result.lastName, "smith")
    })

    it("returns best unverified candidate when SMTP fails", async () => {
      const hunter = createContactHunter({
        verifySmtpFn: async () => ({ valid: false, catchAll: false, reason: "smtp_error" }),
      })
      const result = await hunter.findEmail("company.com", "Alice Smith")
      assert.ok(result.email)
      assert.ok(result.confidence > 0)
    })

    it("includes web scrape results", async () => {
      const hunter = createContactHunter({
        extractWebEmailsFn: async () => ({
          emails: [{ email: "contact@target.com", sourceUrl: "https://target.com/contact" }],
          pagesScraped: 1,
          errors: [],
        }),
        verifySmtpFn: async (email) => {
          if (email === "contact@target.com") return { valid: true, catchAll: false }
          return { valid: false, catchAll: false }
        },
      })
      const result = await hunter.findEmail("target.com", "CEO")
      assert.equal(result.email, "contact@target.com")
    })

    it("falls back to custom fallback when configured", async () => {
      const hunter = createContactHunter({
        verifySmtpFn: async () => ({ valid: false, catchAll: false, reason: "smtp_rejected" }),
        generatePatternsFn: () => [],
        hunterFallbackFn: async (domain, role) => ({
          email: "fallback@company.com", confidence: 80,
          firstName: null, lastName: null, position: role, linkedinUrl: null,
        }),
      })
      const result = await hunter.findEmail("company.com", "CEO")
      assert.equal(result.email, "fallback@company.com")
    })

    it("returns empty result for missing domain", async () => {
      const hunter = createContactHunter()
      const result = await hunter.findEmail("", "CEO")
      assert.equal(result.email, null)
      assert.equal(result.confidence, 0)
    })
  })

  describe("domainSearch", () => {
    it("aggregates web + search results", async () => {
      const hunter = createContactHunter({
        extractWebEmailsFn: async () => ({
          emails: [{ email: "a@example.com" }, { email: "b@example.com" }],
        }),
        searchEmailsFn: async () => ({
          emails: [{ email: "c@example.com" }],
        }),
      })
      const result = await hunter.domainSearch("example.com")
      assert.equal(result.emails.length, 3)
      assert.equal(result.organization, null)
    })

    it("deduplicates across sources", async () => {
      const hunter = createContactHunter({
        extractWebEmailsFn: async () => ({
          emails: [{ email: "same@example.com" }],
        }),
        searchEmailsFn: async () => ({
          emails: [{ email: "same@example.com" }],
        }),
      })
      const result = await hunter.domainSearch("example.com")
      assert.equal(result.emails.length, 1)
    })

    it("returns empty for invalid domain", async () => {
      const hunter = createContactHunter()
      const result = await hunter.domainSearch("")
      assert.deepEqual(result.emails, [])
    })
  })

  describe("backward-compatible exports", () => {
    it("exports domainSearch as function", () => {
      assert.equal(typeof domainSearch, "function")
    })

    it("exports findEmail as function", () => {
      assert.equal(typeof findEmail, "function")
    })

    it("exports verifyEmail as function", () => {
      assert.equal(typeof verifyEmail, "function")
    })
  })
})
