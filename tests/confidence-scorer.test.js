import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { computeConfidence, selectBestCandidate, SCORE_MATRIX } from "../src/confidence-scorer.js"

describe("confidence-scorer", () => {
  describe("computeConfidence", () => {
    it("returns 0 for empty signals", () => {
      const result = computeConfidence([])
      assert.equal(result.score, 0)
      assert.equal(result.sources, 0)
    })

    it("scores smtp_verify at 95", () => {
      const result = computeConfidence([{ source: "smtp_verify" }])
      assert.equal(result.score, 95)
    })

    it("scores pattern at 40", () => {
      const result = computeConfidence([{ source: "pattern" }])
      assert.equal(result.score, 40)
    })

    it("adds corroboration bonus for 2+ sources", () => {
      const result = computeConfidence([
        { source: "web_scrape" },
        { source: "search_engine" },
      ])
      assert.ok(result.score > 70) // 70 base + 3 corroboration
    })

    it("adds higher bonus for 3+ sources", () => {
      const result = computeConfidence([
        { source: "web_scrape" },
        { source: "search_engine" },
        { source: "github" },
      ])
      assert.ok(result.score > 70) // 70 base + 5 corroboration
    })

    it("returns 0 for bounced signal", () => {
      const result = computeConfidence([{ source: "smtp_verify", bounced: true }])
      assert.equal(result.score, 0)
    })

    it("caps at 100", () => {
      const result = computeConfidence([
        { source: "smtp_verify" },
        { source: "web_scrape" },
        { source: "github" },
        { source: "company_registry" },
      ])
      assert.ok(result.score <= 100)
    })
  })

  describe("selectBestCandidate", () => {
    it("returns null for empty array", () => {
      assert.equal(selectBestCandidate([]), null)
    })

    it("selects highest confidence candidate", () => {
      const best = selectBestCandidate([
        { email: "low@x.com", confidence: 30 },
        { email: "high@x.com", confidence: 90 },
        { email: "mid@x.com", confidence: 60 },
      ])
      assert.equal(best.email, "high@x.com")
    })

    it("skips candidates without email", () => {
      const best = selectBestCandidate([
        { email: null, confidence: 100 },
        { email: "real@x.com", confidence: 50 },
      ])
      assert.equal(best.email, "real@x.com")
    })
  })

  describe("SCORE_MATRIX", () => {
    it("has all expected sources", () => {
      const sources = ["smtp_verify", "company_registry", "web_scrape", "youtube", "github", "search_engine", "pattern", "linkedin"]
      for (const s of sources) {
        assert.ok(SCORE_MATRIX[s], `Missing source: ${s}`)
        assert.equal(typeof SCORE_MATRIX[s].base, "number")
        assert.equal(typeof SCORE_MATRIX[s].decayPerMonth, "number")
      }
    })
  })
})
