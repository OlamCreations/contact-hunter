import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { verifyEmailSmtp, extractDomain } from "../src/smtp-verifier.js"

describe("smtp-verifier", () => {
  describe("extractDomain", () => {
    it("extracts domain from email", () => {
      assert.equal(extractDomain("alice@company.com"), "company.com")
    })

    it("returns empty for invalid input", () => {
      assert.equal(extractDomain("nope"), "")
      assert.equal(extractDomain(""), "")
      assert.equal(extractDomain(null), "")
    })
  })

  describe("verifyEmailSmtp", () => {
    it("returns invalid_format for bad email", async () => {
      const result = await verifyEmailSmtp("notanemail")
      assert.equal(result.valid, false)
      assert.equal(result.reason, "invalid_format")
    })

    it("returns no_mx when no MX records", async () => {
      const result = await verifyEmailSmtp("alice@nowhere.invalid", {
        resolveMx: async () => [],
      })
      assert.equal(result.valid, false)
      assert.equal(result.reason, "no_mx")
    })

    it("returns smtp_accepted for accepted email", async () => {
      const result = await verifyEmailSmtp("alice@company.com", {
        resolveMx: async () => [{ exchange: "mx.company.com", priority: 10 }],
        smtpHandshake: async () => ({
          accepted: true,
          responseCode: 250,
          response: "250 OK",
          greylisted: false,
          error: null,
        }),
        detectCatchAll: async () => false,
      })
      assert.equal(result.valid, true)
      assert.equal(result.reason, "smtp_accepted")
      assert.equal(result.mxHost, "mx.company.com")
    })

    it("returns smtp_rejected for rejected email", async () => {
      const result = await verifyEmailSmtp("bad@company.com", {
        resolveMx: async () => [{ exchange: "mx.company.com", priority: 10 }],
        smtpHandshake: async () => ({
          accepted: false,
          responseCode: 550,
          response: "550 User unknown",
          greylisted: false,
          error: null,
        }),
        detectCatchAll: async () => false,
      })
      assert.equal(result.valid, false)
      assert.equal(result.reason, "smtp_rejected")
    })

    it("detects catch-all domains", async () => {
      const result = await verifyEmailSmtp("anyone@catchall.com", {
        resolveMx: async () => [{ exchange: "mx.catchall.com", priority: 10 }],
        smtpHandshake: async () => ({
          accepted: true,
          responseCode: 250,
          greylisted: false,
          error: null,
        }),
        detectCatchAll: async () => true,
      })
      assert.equal(result.valid, true)
      assert.equal(result.catchAll, true)
      assert.equal(result.reason, "catch_all")
    })

    it("handles greylisting", async () => {
      const result = await verifyEmailSmtp("alice@grey.com", {
        resolveMx: async () => [{ exchange: "mx.grey.com", priority: 10 }],
        smtpHandshake: async () => ({
          accepted: false,
          responseCode: 421,
          greylisted: true,
          error: null,
        }),
        detectCatchAll: async () => false,
      })
      assert.equal(result.valid, false)
      assert.equal(result.reason, "greylisted")
    })
  })
})
