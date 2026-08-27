import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { extractEmailsFromText, findContactPageUrls, extractEmailsFromDomain } from "../src/web-email-extractor.js"

describe("web-email-extractor", () => {
  describe("extractEmailsFromText", () => {
    it("extracts emails from text", () => {
      const emails = extractEmailsFromText("Contact us at alice@company.com or bob@company.com")
      assert.deepEqual(emails, ["alice@company.com", "bob@company.com"])
    })

    it("filters noise emails", () => {
      const emails = extractEmailsFromText("noreply@x.com alice@x.com support@x.com")
      assert.deepEqual(emails, ["alice@x.com"])
    })

    it("deduplicates", () => {
      const emails = extractEmailsFromText("alice@x.com hello alice@x.com")
      assert.equal(emails.length, 1)
    })

    it("returns empty for no matches", () => {
      assert.deepEqual(extractEmailsFromText("no emails here"), [])
      assert.deepEqual(extractEmailsFromText(""), [])
      assert.deepEqual(extractEmailsFromText(null), [])
    })
  })

  describe("findContactPageUrls", () => {
    it("generates contact page URLs", () => {
      const urls = findContactPageUrls("company.com")
      assert.ok(urls.includes("https://company.com/contact"))
      assert.ok(urls.includes("https://company.com/about"))
      assert.ok(urls.includes("https://company.com/mentions-legales"))
    })

    it("returns empty for empty domain", () => {
      assert.deepEqual(findContactPageUrls(""), [])
    })
  })
})
