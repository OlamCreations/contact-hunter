/**
 * Contact Hunter — Multi-channel contact intelligence orchestrator.
 *
 * Channels: SMTP verify, web scrape, search mine, GitHub, YouTube, company registry, phone.
 * Rate-limited SMTP to avoid blocks. Confidence scoring with temporal decay.
 */

import { analyzeDomain } from "./dns-intel.js"
import { generatePatterns, detectDomainPattern } from "./pattern-generator.js"
import { verifyEmailSmtp } from "./smtp-verifier.js"
import { computeConfidence, selectBestCandidate } from "./confidence-scorer.js"

function normalizeDomain(raw) {
  return String(raw || "").trim().toLowerCase()
    .replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "").replace(/^@+/, "")
}

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase()
}

function buildEmptySearchResult() {
  return Object.freeze({ emails: [], organization: null, patterns: [] })
}

function buildEmptyFindResult(role) {
  return Object.freeze({
    email: null, confidence: 0, firstName: null, lastName: null,
    position: role || null, linkedinUrl: null,
  })
}

function toHunterVerifyResult(smtpResult) {
  if (!smtpResult) return { result: "undeliverable", score: 0 }
  if (smtpResult.valid && smtpResult.catchAll) return { result: "risky", score: 50 }
  if (smtpResult.valid) return { result: "deliverable", score: 95 }
  if (smtpResult.reason === "greylisted") return { result: "risky", score: 30 }
  return { result: "undeliverable", score: 0 }
}

// ---- SMTP Rate Limiter (per-domain, 2s interval, LRU cleanup) ----

const smtpTimestamps = new Map()
const SMTP_MIN_INTERVAL_MS = 2000
const SMTP_MAP_MAX_SIZE = 500
const SMTP_TTL_MS = 300_000

function cleanupSmtpTimestamps() {
  if (smtpTimestamps.size <= SMTP_MAP_MAX_SIZE) return
  const now = Date.now()
  for (const [domain, ts] of smtpTimestamps) {
    if (now - ts > SMTP_TTL_MS) smtpTimestamps.delete(domain)
  }
  if (smtpTimestamps.size > SMTP_MAP_MAX_SIZE) {
    const entries = [...smtpTimestamps.entries()].sort((a, b) => a[1] - b[1])
    const toRemove = entries.slice(0, smtpTimestamps.size - SMTP_MAP_MAX_SIZE)
    for (const [key] of toRemove) smtpTimestamps.delete(key)
  }
}

async function rateLimitedSmtpVerify(email, verifyFn, deps) {
  const domain = email.split("@")[1] || ""
  const lastCheck = smtpTimestamps.get(domain) || 0
  const elapsed = Date.now() - lastCheck
  if (elapsed < SMTP_MIN_INTERVAL_MS) {
    await new Promise((r) => setTimeout(r, SMTP_MIN_INTERVAL_MS - elapsed))
  }
  smtpTimestamps.set(domain, Date.now())
  cleanupSmtpTimestamps()
  return verifyFn(email, deps)
}

// ---- Factory ----

export function createContactHunter(deps = {}) {
  const {
    analyzeDomainFn = analyzeDomain,
    generatePatternsFn = generatePatterns,
    verifySmtpFn = verifyEmailSmtp,
    extractWebEmailsFn,
    searchEmailsFn,
    githubMinerFn,
    youtubeMinerFn,
    companyRegistryFn,
    hunterFallbackFn,
    scoreFn = computeConfidence,
    enableRateLimit = true,
  } = deps

  const smtpVerify = enableRateLimit
    ? (email) => rateLimitedSmtpVerify(email, verifySmtpFn, deps)
    : (email) => verifySmtpFn(email, deps)

  return {
    async domainSearch(domain) {
      const d = normalizeDomain(domain)
      if (!d) return buildEmptySearchResult()
      const emails = []

      if (typeof extractWebEmailsFn === "function") {
        try {
          const webResult = await extractWebEmailsFn(d, deps)
          for (const item of (webResult.emails || [])) {
            emails.push({ email: item.email, confidence: 70, firstName: null, lastName: null, position: null, linkedinUrl: null })
          }
        } catch { /* non-critical */ }
      }

      if (typeof searchEmailsFn === "function") {
        try {
          const searchResult = await searchEmailsFn("", d, deps)
          for (const item of (searchResult.emails || [])) {
            if (!emails.some((e) => e.email === item.email)) {
              emails.push({ email: item.email, confidence: 50, firstName: null, lastName: null, position: null, linkedinUrl: null })
            }
          }
        } catch { /* non-critical */ }
      }

      if (typeof companyRegistryFn === "function") {
        try {
          const regResult = await companyRegistryFn(d, deps)
          for (const email of (regResult.emails || [])) {
            if (!emails.some((e) => e.email === email)) {
              emails.push({ email, confidence: 80, firstName: null, lastName: null, position: null, linkedinUrl: null })
            }
          }
        } catch { /* non-critical */ }
      }

      const foundEmails = emails.map((e) => e.email)
      const detected = detectDomainPattern(foundEmails, d)
      const patterns = detected ? [detected.pattern] : []
      return Object.freeze({ emails, organization: null, patterns })
    },

    async findEmail(domain, role) {
      const d = normalizeDomain(domain)
      if (!d) return buildEmptyFindResult(role)

      const roleParts = String(role || "").trim().split(/\s+/)
      const firstName = (roleParts[0] || "").toLowerCase()
      const lastName = (roleParts.slice(1).join(" ") || "").toLowerCase()
      const candidates = []

      // 1. Pattern generation
      if (firstName) {
        const patterns = generatePatternsFn(firstName, lastName, d)
        for (const email of patterns.slice(0, 10)) {
          candidates.push({ email, firstName: firstName || null, lastName: lastName || null, position: role, source: "pattern", signals: [{ source: "pattern" }] })
        }
      }

      // 2. Web extraction
      if (typeof extractWebEmailsFn === "function") {
        try {
          const webResult = await extractWebEmailsFn(d, deps)
          for (const item of (webResult.emails || [])) {
            if (!candidates.some((c) => c.email === item.email)) {
              candidates.push({ email: item.email, firstName: null, lastName: null, position: role, source: "web_scrape", signals: [{ source: "web_scrape" }] })
            }
          }
        } catch { /* non-critical */ }
      }

      // 3. Search mining
      if (typeof searchEmailsFn === "function") {
        try {
          const name = firstName ? (firstName + " " + lastName).trim() : role
          const searchResult = await searchEmailsFn(name, d, deps)
          for (const item of (searchResult.emails || [])) {
            const existing = candidates.find((c) => c.email === item.email)
            if (existing) { existing.signals.push({ source: "search_engine" }) }
            else { candidates.push({ email: item.email, firstName: null, lastName: null, position: role, source: "search_engine", signals: [{ source: "search_engine" }] }) }
          }
        } catch { /* non-critical */ }
      }

      // 4. GitHub mining
      if (typeof githubMinerFn === "function" && firstName) {
        try {
          const ghResult = await githubMinerFn((firstName + " " + lastName).trim(), d, deps)
          for (const item of (ghResult.emails || [])) {
            const existing = candidates.find((c) => c.email === item.email)
            if (existing) { existing.signals.push({ source: "github" }) }
            else { candidates.push({ email: item.email, firstName: item.name || null, lastName: null, position: role, source: "github", signals: [{ source: "github" }] }) }
          }
        } catch { /* non-critical */ }
      }

      // 5. Company registry
      if (typeof companyRegistryFn === "function") {
        try {
          const regResult = await companyRegistryFn(d, deps)
          for (const email of (regResult.emails || [])) {
            const existing = candidates.find((c) => c.email === email)
            if (existing) { existing.signals.push({ source: "company_registry" }) }
            else { candidates.push({ email, firstName: null, lastName: null, position: role, source: "company_registry", signals: [{ source: "company_registry" }] }) }
          }
        } catch { /* non-critical */ }
      }

      // 6. SMTP verify top candidates (rate-limited)
      const limit = Math.min(candidates.length, 5)
      for (let i = 0; i < limit; i++) {
        const c = candidates[i]
        try {
          const smtp = await smtpVerify(c.email)
          if (smtp.valid && !smtp.catchAll) {
            c.signals.push({ source: "smtp_verify" })
            c.smtpVerified = true
            c.confidence = scoreFn(c.signals).score
            return Object.freeze({ email: c.email, confidence: c.confidence, firstName: c.firstName, lastName: c.lastName, position: c.position, linkedinUrl: null })
          }
        } catch { /* continue */ }
      }

      // 7. Score and return best
      for (const c of candidates) { c.confidence = scoreFn(c.signals).score }
      const best = selectBestCandidate(candidates)
      if (best && best.confidence > 0) {
        return Object.freeze({ email: best.email, confidence: best.confidence, firstName: best.firstName, lastName: best.lastName, position: best.position || role, linkedinUrl: null })
      }

      // 8. Fallback
      if (typeof hunterFallbackFn === "function") {
        try { return await hunterFallbackFn(d, role) } catch { /* fallback failed */ }
      }
      return buildEmptyFindResult(role)
    },

    async verifyEmail(email) {
      const normalized = normalizeEmail(email)
      if (!normalized || !normalized.includes("@")) {
        return Object.freeze({ result: "undeliverable", score: 0 })
      }
      try {
        const smtpResult = await smtpVerify(normalized)
        return Object.freeze(toHunterVerifyResult(smtpResult))
      } catch {
        return Object.freeze({ result: "undeliverable", score: 0 })
      }
    },

    async discoverContacts(domain, opts = {}) {
      const d = normalizeDomain(domain)
      if (!d) return Object.freeze({ contacts: [], phones: [], meta: {} })

      const dnsInfo = await analyzeDomainFn(d, deps)
      const channels = []
      const phones = []

      const searchResult = await this.domainSearch(d)
      for (const email of searchResult.emails) {
        channels.push({ type: "email", value: email.email, confidence: email.confidence, source: "domain_search" })
      }

      if (typeof youtubeMinerFn === "function" && opts.youtubeUrl) {
        try {
          const ytResult = await youtubeMinerFn(opts.youtubeUrl, deps)
          if (ytResult.email) {
            channels.push({ type: "email", value: ytResult.email, confidence: 65, source: "youtube_about" })
          }
        } catch { /* non-critical */ }
      }

      if (typeof companyRegistryFn === "function") {
        try {
          const regResult = await companyRegistryFn(d, deps)
          for (const phone of (regResult.phones || [])) {
            phones.push({ type: "phone", value: phone, confidence: 78, source: "company_registry" })
          }
          for (const email of (regResult.emails || [])) {
            if (!channels.some((c) => c.value === email)) {
              channels.push({ type: "email", value: email, confidence: 80, source: "company_registry" })
            }
          }
        } catch { /* non-critical */ }
      }

      return Object.freeze({
        contacts: channels,
        phones,
        meta: {
          domain: d,
          provider: dnsInfo.provider,
          isCatchAll: dnsInfo.isCatchAll,
          patterns: searchResult.patterns,
        },
      })
    },

    async findPhone(domain, companyName) {
      if (typeof companyRegistryFn !== "function") return Object.freeze({ phone: null, source: null })
      try {
        const result = await companyRegistryFn(companyName || domain, deps)
        const phone = (result.phones || [])[0] || null
        return Object.freeze({ phone, source: phone ? "company_registry" : null })
      } catch {
        return Object.freeze({ phone: null, source: null })
      }
    },
  }
}

// Default instance
const defaultHunter = createContactHunter()
export async function domainSearch(domain) { return defaultHunter.domainSearch(domain) }
export async function findEmail(domain, role) { return defaultHunter.findEmail(domain, role) }
export async function verifyEmail(email) { return defaultHunter.verifyEmail(email) }
