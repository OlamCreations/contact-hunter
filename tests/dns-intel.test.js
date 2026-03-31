import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { identifyProvider, parseSpfRecord, analyzeDomain } from "../src/dns-intel.js"

describe("dns-intel", () => {
  describe("identifyProvider", () => {
    it("detects Google Workspace", () => {
      assert.equal(
        identifyProvider([{ exchange: "alt1.aspmx.l.google.com" }]),
        "google_workspace"
      )
    })

    it("detects Microsoft 365", () => {
      assert.equal(
        identifyProvider([{ exchange: "company-com.mail.protection.outlook.com" }]),
        "microsoft_365"
      )
    })

    it("detects Protonmail", () => {
      assert.equal(
        identifyProvider([{ exchange: "mail.protonmail.ch" }]),
        "protonmail"
      )
    })

    it("returns self_hosted for unknown MX", () => {
      assert.equal(
        identifyProvider([{ exchange: "mail.custom-company.com" }]),
        "self_hosted"
      )
    })

    it("returns unknown for empty records", () => {
      assert.equal(identifyProvider([]), "unknown")
      assert.equal(identifyProvider(null), "unknown")
    })
  })

  describe("parseSpfRecord", () => {
    it("parses SPF with includes", () => {
      const result = parseSpfRecord([["v=spf1 include:_spf.google.com ~all"]])
      assert.ok(result)
      assert.deepEqual(result.includes, ["_spf.google.com"])
      assert.equal(result.all, "softfail")
    })

    it("returns null for no SPF", () => {
      assert.equal(parseSpfRecord([["not-spf"]]), null)
    })

    it("returns null for empty records", () => {
      assert.equal(parseSpfRecord([]), null)
    })
  })

  describe("analyzeDomain", () => {
    it("returns empty result for empty domain", async () => {
      const result = await analyzeDomain("")
      assert.equal(result.domain, "")
      assert.equal(result.provider, "unknown")
    })

    it("works with injected resolvers", async () => {
      const result = await analyzeDomain("example.com", {
        resolveMx: async () => [{ exchange: "mx.example.com", priority: 10 }],
        resolveTxt: async () => [["v=spf1 -all"]],
        detectCatchAll: async () => false,
      })
      assert.equal(result.domain, "example.com")
      assert.equal(result.provider, "self_hosted")
      assert.ok(result.spfRecord)
      assert.equal(result.isCatchAll, false)
    })

    it("handles DNS resolution errors gracefully", async () => {
      const result = await analyzeDomain("nonexistent.invalid", {
        resolveMx: async () => { throw new Error("ENOTFOUND") },
        resolveTxt: async () => { throw new Error("ENOTFOUND") },
      })
      assert.equal(result.provider, "unknown")
      assert.deepEqual(result.mxRecords, [])
    })

    it("normalizes domain input", async () => {
      const result = await analyzeDomain("https://www.example.com/page", {
        resolveMx: async () => [],
        resolveTxt: async () => [],
      })
      assert.equal(result.domain, "example.com")
    })
  })
})
