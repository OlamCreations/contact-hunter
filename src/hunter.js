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
    source: null, verified: false, smtpInformative: null,
  })
}

function toHunterVerifyResult(smtpResult) {
  if (!smtpResult) return { result: "undeliverable", score: 0 }
  // A domain that accepts every recipient, or that was never shown to reject one,
  // cannot deliver a verdict. Reporting "deliverable" there is the lie the tool
  // told about zzq-nexistepas-8412@similarweb.com on 2026-09-09.
  if (smtpResult.valid && smtpResult.catchAll === true) return { result: "risky", score: 50 }
  if (smtpResult.valid && smtpResult.catchAll === null) return { result: "unknown", score: 40 }
  // The lookup never happened. Saying "undeliverable" here would retire a
  // live address on the strength of a resolver timeout.
  if (smtpResult.reason === "dns_error") return { result: "unknown", score: 0 }
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

      let registry = null
      if (typeof companyRegistryFn === "function") {
        try {
          registry = await companyRegistryFn(d, deps)
          if (registry.entityMatched === true) {
            const score = computeConfidence([{ source: "company_registry" }]).score
            for (const email of (registry.emails || [])) {
              if (!emails.some((e) => e.email === email)) {
                emails.push({ email, confidence: score, firstName: null, lastName: null, position: null, linkedinUrl: null })
              }
            }
          }
        } catch { /* non-critical */ }
      }

      const foundEmails = emails.map((e) => e.email)
      const detected = detectDomainPattern(foundEmails, d)
      const patterns = detected ? [detected.pattern] : []
      return Object.freeze({ emails, organization: null, patterns, registry })
    },

    async findEmail(domain, role) {
      const d = normalizeDomain(domain)
      if (!d) return buildEmptyFindResult(role)

      // Records whether each channel ran, so "found nothing" stays distinct
      // from "never looked". Channels fail quietly by design, and a silent
      // failure used to be indistinguishable from an honest empty result.
      const channels = {}
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
          channels.web_scrape = "ok"
          for (const item of (webResult.emails || [])) {
            if (!candidates.some((c) => c.email === item.email)) {
              candidates.push({ email: item.email, firstName: null, lastName: null, position: role, source: "web_scrape", signals: [{ source: "web_scrape" }] })
            }
          }
        } catch { channels.web_scrape = "error" }
      }

      // 3. Search mining
      if (typeof searchEmailsFn === "function") {
        try {
          const name = firstName ? (firstName + " " + lastName).trim() : role
          const searchResult = await searchEmailsFn(name, d, deps)
          channels.search_engine = "ok"
          for (const item of (searchResult.emails || [])) {
            const existing = candidates.find((c) => c.email === item.email)
            if (existing) { existing.signals.push({ source: "search_engine" }) }
            else { candidates.push({ email: item.email, firstName: null, lastName: null, position: role, source: "search_engine", signals: [{ source: "search_engine" }] }) }
          }
        } catch { channels.search_engine = "error" }
      }

      // 4. GitHub mining
      if (typeof githubMinerFn === "function" && firstName) {
        try {
          const ghResult = await githubMinerFn((firstName + " " + lastName).trim(), d, deps)
          channels.github = "ok"
          for (const item of (ghResult.emails || [])) {
            const existing = candidates.find((c) => c.email === item.email)
            if (existing) { existing.signals.push({ source: "github" }) }
            else { candidates.push({ email: item.email, firstName: item.name || null, lastName: null, position: role, source: "github", signals: [{ source: "github" }] }) }
          }
        } catch { channels.github = "error" }
      }

      // 5. Company registry
      if (typeof companyRegistryFn === "function") {
        try {
          const regResult = await companyRegistryFn(d, deps)
          channels.company_registry = regResult.conclusive === false ? "error" : "ok"
          for (const email of (regResult.emails || [])) {
            const existing = candidates.find((c) => c.email === email)
            if (existing) { existing.signals.push({ source: "company_registry" }) }
            else { candidates.push({ email, firstName: null, lastName: null, position: role, source: "company_registry", signals: [{ source: "company_registry" }] }) }
          }
        } catch { channels.company_registry = "error" }
      }

      // 6. SMTP verify, budget spent where it discriminates (rate-limited)
      // The first probe reveals which regime we are in, at no extra cost: on an
      // accept-all domain every further call is uninformative, on a domain that
      // rejects unknown recipients every call is decisive.
      const UNKNOWN_REGIME_LIMIT = 5
      let smtpInformative = null
      let limit = Math.min(candidates.length, UNKNOWN_REGIME_LIMIT)
      for (let i = 0; i < limit; i++) {
        const c = candidates[i]
        try {
          const smtp = await smtpVerify(c.email)
          // Only an explicit false proves the server rejects unknown recipients.
          // `!smtp.catchAll` also passed on null, the value that means the probe
          // never concluded, which promoted generated addresses to 95.
          if (smtp.valid && smtp.catchAll === false) {
            c.signals.push({ source: "smtp_verify" })
            c.smtpVerified = true
            c.confidence = scoreFn(c.signals).score
            return Object.freeze({
              email: c.email, confidence: c.confidence, firstName: c.firstName,
              lastName: c.lastName, position: c.position, linkedinUrl: null,
              source: c.source, verified: true, smtpInformative: true, channels,
            })
          }
          // The server said this recipient does not exist. Keeping the candidate
          // in the pool meant testing an address, learning it was wrong, and
          // returning it anyway at the score of an untested guess.
          if (smtp.valid === false && smtp.reason === "smtp_rejected") {
            c.rejected = true
          }

          if (smtpInformative === null && smtp.catchAll !== undefined) {
            smtpInformative = smtp.catchAll === false
            // Accept-all, or a probe that never concluded: stop spending calls
            // that cannot separate a real address from a generated one.
            limit = smtpInformative ? candidates.length : i + 1
          }
        } catch { /* continue */ }
      }

      // 7. Score and return best, among those not disproved
      const surviving = candidates.filter((c) => !c.rejected)
      for (const c of surviving) { c.confidence = scoreFn(c.signals).score }
      const best = selectBestCandidate(surviving)
      if (best && best.confidence > 0) {
        // `source` separates an address seen somewhere from one built out of a
        // firstname.lastname template. Both came back in the same shape before,
        // and a caller had no way to tell a finding from a guess.
        return Object.freeze({
          email: best.email, confidence: best.confidence, firstName: best.firstName,
          lastName: best.lastName, position: best.position || role, linkedinUrl: null,
          source: best.source, verified: false, smtpInformative, channels,
        })
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
      const found = []
      const phones = []

      const searchResult = await this.domainSearch(d)
      for (const email of searchResult.emails) {
        found.push({ type: "email", value: email.email, confidence: email.confidence, source: "domain_search" })
      }

      if (typeof youtubeMinerFn === "function" && opts.youtubeUrl) {
        try {
          const ytResult = await youtubeMinerFn(opts.youtubeUrl, deps)
          if (ytResult.email) {
            found.push({ type: "email", value: ytResult.email, confidence: 65, source: "youtube_about" })
          }
        } catch { /* non-critical */ }
      }

      // Reuses the pass domainSearch already made: calling the channel twice
      // burned the search quota that then returned HTTP 429 to both.
      let registry = null
      {
        try {
          const regResult = searchResult.registry
          if (!regResult) throw new Error("no_registry")
          // A registry hit that was never tied to the target is not a low-confidence
          // contact, it is another company's. Emitting it at any score is a bug:
          // `discover similarweb.com` used to return nine French landlines at 78.
          const attributed = regResult.entityMatched === true
          registry = {
            jurisdiction: regResult.jurisdiction || null,
            entityMatched: attributed,
            siren: attributed ? (regResult.siren || null) : null,
            searchError: regResult.searchError ?? null,
            conclusive: regResult.conclusive ?? true,
          }
          if (attributed) {
            const score = computeConfidence([{ source: "company_registry" }]).score
            for (const phone of (regResult.phones || [])) {
              phones.push({ type: "phone", value: phone, confidence: score, source: "company_registry" })
            }
            for (const email of (regResult.emails || [])) {
              if (!found.some((c) => c.value === email)) {
                found.push({ type: "email", value: email, confidence: score, source: "company_registry" })
              }
            }
          }
        } catch { /* non-critical */ }
      }

      return Object.freeze({
        contacts: found,
        phones,
        meta: {
          domain: d,
          provider: dnsInfo.provider,
          isCatchAll: dnsInfo.isCatchAll,
          patterns: searchResult.patterns,
          registry,
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
