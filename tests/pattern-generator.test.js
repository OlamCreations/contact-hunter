import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { generatePatterns, detectDomainPattern, applyPattern, PATTERN_TEMPLATES } from "../src/pattern-generator.js"

describe("pattern-generator", () => {
  describe("generatePatterns", () => {
    it("generates expected patterns for simple name", () => {
      const patterns = generatePatterns("alice", "smith", "company.com")
      assert.ok(patterns.length > 10)
      assert.ok(patterns.includes("alice.smith@company.com"))
      assert.ok(patterns.includes("alice@company.com"))
      assert.ok(patterns.includes("asmith@company.com"))
      assert.ok(patterns.includes("alice_smith@company.com"))
      assert.ok(patterns.includes("smith.alice@company.com"))
    })

    it("includes generic emails", () => {
      const patterns = generatePatterns("alice", "smith", "company.com")
      assert.ok(patterns.includes("contact@company.com"))
      assert.ok(patterns.includes("info@company.com"))
    })

    it("handles hyphenated first names", () => {
      const patterns = generatePatterns("jean-pierre", "dupont", "company.fr")
      assert.ok(patterns.includes("jean-pierre.dupont@company.fr"))
      assert.ok(patterns.some((p) => p.startsWith("jp")))
    })

    it("returns empty for missing parts", () => {
      assert.deepEqual(generatePatterns("", "smith", "x.com"), [])
      assert.deepEqual(generatePatterns("alice", "", "x.com"), [])
      assert.deepEqual(generatePatterns("alice", "smith", ""), [])
    })

    it("normalizes domain (strips protocol, www)", () => {
      const patterns = generatePatterns("alice", "smith", "https://www.company.com/about")
      assert.ok(patterns[0].endsWith("@company.com"))
    })

    it("deduplicates results", () => {
      const patterns = generatePatterns("alice", "smith", "company.com")
      const unique = new Set(patterns)
      assert.equal(patterns.length, unique.size)
    })
  })

  describe("detectDomainPattern", () => {
    it("detects first.last from dot-separated emails", () => {
      const result = detectDomainPattern(
        ["alice.smith@x.com", "bob.jones@x.com"],
        "x.com"
      )
      assert.ok(result)
      assert.equal(result.pattern, "first.last")
      assert.ok(result.confidence > 50)
    })

    it("returns null for insufficient data", () => {
      assert.equal(detectDomainPattern(["only@x.com"], "x.com"), null)
      assert.equal(detectDomainPattern([], "x.com"), null)
    })

    it("detects from contacts with names", () => {
      const result = detectDomainPattern(
        ["alice.smith@x.com", "bob.jones@x.com"],
        "x.com",
        [
          { email: "alice.smith@x.com", firstName: "alice", lastName: "smith" },
          { email: "bob.jones@x.com", firstName: "bob", lastName: "jones" },
        ]
      )
      assert.ok(result)
      assert.equal(result.pattern, "first.last")
    })
  })

  describe("applyPattern", () => {
    it("applies first.last pattern", () => {
      assert.equal(applyPattern("first.last", "Alice", "Smith", "x.com"), "alice.smith@x.com")
    })

    it("returns null for unknown pattern", () => {
      assert.equal(applyPattern("unknown_pattern", "Alice", "Smith", "x.com"), null)
    })

    it("returns null for missing name", () => {
      assert.equal(applyPattern("first.last", "", "Smith", "x.com"), null)
    })
  })

  describe("PATTERN_TEMPLATES", () => {
    it("has 17 templates", () => {
      assert.equal(PATTERN_TEMPLATES.length, 17)
    })

    it("each template has id and fn", () => {
      for (const t of PATTERN_TEMPLATES) {
        assert.equal(typeof t.id, "string")
        assert.equal(typeof t.fn, "function")
      }
    })
  })
})
