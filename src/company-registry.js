/**
 * Company Registry — French mentions legales + Pappers scraping.
 * Extracts SIREN, emails, phones from company websites and registries.
 *
 * FRENCH JURISDICTION ONLY. Every result carries `jurisdiction: "FR"` and
 * `entityMatched`. A registry page is mined only once it has been shown to name
 * the target: a search engine will happily return the record of a different
 * company, and a phone number scraped from it is not a weak signal, it is a
 * wrong one. Callers must drop results where `entityMatched` is false.
 */

export const REGISTRY_CONFIG = Object.freeze({
  jurisdiction: "FR",
  // Under 4 characters a token like "ai" or "web" matches half the register,
  // so no match is claimed at all rather than guessed.
  minTokenLength: 4,
  maxRegistryPages: 2,
  legalSuffixes: ["sas", "sarl", "sa", "eurl", "sasu", "sci", "snc", "gmbh", "ltd", "inc", "llc", "bv", "nv"],
})

const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g
const PHONE_REGEX = /(?:\+33\s?|0)[1-9](?:[\s.-]?\d{2}){4}/g
const SIREN_REGEX = /(?:SIREN|SIRET|RCS\s+\w+)\s*:?\s*(\d[\d\s]{7,15}\d)/gi
const BARE_SIREN = /\b(\d{3}\s?\d{3}\s?\d{3})\b/g

const NOISE_EMAILS = new Set(["noreply", "no-reply", "example", "test", "admin", "webmaster"])

const MENTIONS_SLUGS = [
  "mentions-legales", "mentions", "legal", "legal-notice", "cgu",
  "impressum", "politique-de-confidentialite",
]

/**
 * A legal notice, not merely a page filed under /legal. Matching anywhere in the
 * URL accepted similarweb.com/corp/legal/content-disclaimers/, a content policy
 * with no contact details, whose stray digits then became a phone number.
 */
export function isLegalNoticeUrl(url) {
  let path
  try {
    path = new URL(String(url)).pathname
  } catch {
    return false
  }
  const last = path.split("/").filter(Boolean).pop()
  return Boolean(last) && MENTIONS_SLUGS.includes(last.toLowerCase())
}

function normalizeDomain(raw) {
  return String(raw || "").trim().toLowerCase()
    .replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "")
}

// A phone only counts as the company's when the page says so twice over: it sits
// near a mention of the entity, and it is introduced as a contact number.
// Measured 2026-09-09 on societe.com/societe/similarweb-france-sas-842296253.html:
// 171 836 characters, the entity named at offset 99, 28 French numbers, the closest
// 4 112 characters away. None of them belonged to the company. Without both gates
// the channel returns the page's own furniture with a registry-grade score.
const CONTACT_LABEL = /(t[eé]l[eé]phone|t[eé]l\.?|phone|standard|appelez|contact)[^0-9]{0,20}$/i

function labelledAsContact(text, index) {
  return CONTACT_LABEL.test(text.slice(Math.max(0, index - 60), index))
}

function mentionOffsets(text, near) {
  const token = String(near || "").toLowerCase()
  if (!token) return null
  const haystack = text.toLowerCase()
  const offsets = []
  for (let i = haystack.indexOf(token); i !== -1; i = haystack.indexOf(token, i + 1)) {
    offsets.push(i)
  }
  return offsets
}

export function extractPhoneNumbers(text, opts = {}) {
  if (!text || typeof text !== "string") return []

  const near = opts.near || null
  const window = opts.window ?? 600
  // Proximity implies the label check; a page known to be the target's own
  // still needs the label, since any digit run can look like a phone number.
  const requireLabel = opts.requireLabel ?? Boolean(near)
  const offsets = near ? mentionOffsets(text, near) : null
  // The entity is not named at all: nothing on this page can be attributed to it.
  if (near && (!offsets || offsets.length === 0)) return []

  const seen = new Set()
  const kept = []
  PHONE_REGEX.lastIndex = 0
  for (const match of text.matchAll(PHONE_REGEX)) {
    if (near) {
      const close = offsets.some((o) => Math.abs(match.index - o) <= window)
      if (!close) continue
    }
    if (requireLabel && !labelledAsContact(text, match.index)) continue
    const normalized = match[0].replace(/[\s.-]/g, "")
    if (seen.has(normalized)) continue
    seen.add(normalized)
    kept.push(match[0])
  }
  return kept
}

export function extractSiren(text) {
  if (!text || typeof text !== "string") return null

  const labeled = SIREN_REGEX.exec(text)
  if (labeled) {
    const digits = labeled[1].replace(/\s/g, "")
    if (digits.length >= 9) return digits.slice(0, 9)
  }

  SIREN_REGEX.lastIndex = 0

  const lines = text.split("\n")
  for (const line of lines) {
    if (/siren|siret|rcs|immatricul|registre|commerce/i.test(line)) {
      const match = line.match(BARE_SIREN)
      if (match) return match[0].replace(/\s/g, "")
    }
  }

  return null
}

/**
 * Reduces a domain or a company name to the token that identifies it.
 * "similarweb.com" and "Similarweb France SAS" both reduce to "similarweb".
 */
export function entityToken(target, config = REGISTRY_CONFIG) {
  const raw = String(target || "").trim().toLowerCase()
  if (!raw) return null

  const host = raw
    .replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "")
    .split(".")[0]

  const token = host
    .split(/[\s_-]+/)
    .filter((w) => w && !config.legalSuffixes.includes(w))[0] || ""

  return token.length >= config.minTokenLength ? token : null
}

/**
 * True only when the page actually names the target. Absence of proof is
 * treated as absence of match, never as a weak match.
 */
export function pageNamesEntity(text, target, config = REGISTRY_CONFIG) {
  const token = entityToken(target, config)
  if (!token || !text) return false
  const safe = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return new RegExp(`\\b${safe}`, "i").test(text)
}

function extractEmails(text) {
  if (!text) return []
  const matches = text.match(EMAIL_REGEX) || []
  return [...new Set(matches.map((e) => e.toLowerCase()))]
    .filter((e) => !NOISE_EMAILS.has(e.split("@")[0]))
}

export async function scrapeMentionsLegales(url, deps = {}) {
  const scrapeFn = deps.scrape || (async () => ({ text: "", status: 0 }))

  try {
    const page = await scrapeFn(url, { timeout: 15_000 })
    if (!page.text || page.status >= 400) {
      return Object.freeze({ emails: [], phones: [], siren: null, error: "page_not_found" })
    }

    const emails = extractEmails(page.text)
    const phones = extractPhoneNumbers(page.text, { requireLabel: true })
    const siren = extractSiren(page.text)

    return Object.freeze({ emails, phones, siren, error: null })
  } catch (err) {
    return Object.freeze({ emails: [], phones: [], siren: null, error: err.message })
  }
}

export async function searchFrenchRegistry(companyName, deps = {}) {
  const searchFn = deps.searchBraveWeb || deps.searchFn || (async () => ({ results: [] }))
  const scrapeFn = deps.scrape || (async () => ({ text: "", status: 0 }))
  const config = deps.config || REGISTRY_CONFIG

  const name = String(companyName || "").trim()
  const empty = {
    emails: [], phones: [], siren: null, mentionsUrl: null,
    entityMatched: false, jurisdiction: config.jurisdiction,
    searchError: null, conclusive: true,
  }
  if (!name) return Object.freeze(empty)
  // Without a usable token nothing can be attributed to the target, so the
  // channel declines instead of returning whatever the search engine found.
  if (!entityToken(name, config)) return Object.freeze(empty)

  let searchResults = []
  let searchError = null
  try {
    const response = await searchFn({ query: `${name} site:pappers.fr OR site:societe.com SIREN`, count: 5 })
    searchResults = response.results || []
    searchError = response.error || null
  } catch (err) {
    searchError = err.name || "search_failed"
  }

  let allEmails = []
  let allPhones = []
  let siren = null
  let mentionsUrl = null
  let entityMatched = false

  for (const result of searchResults.slice(0, config.maxRegistryPages)) {
    if (!result.url) continue
    try {
      const page = await scrapeFn(result.url, { timeout: 15_000 })
      if (!page.text || page.status >= 400) continue
      // The record of another company is not partial evidence, it is noise.
      if (!pageNamesEntity(page.text, name, config)) continue
      entityMatched = true
      allEmails.push(...extractEmails(page.text))
      allPhones.push(...extractPhoneNumbers(page.text, { near: entityToken(name, config) }))
      if (!siren) siren = extractSiren(page.text)
    } catch { /* skip */ }
  }

  try {
    const webSearch = await searchFn({ query: `${name} mentions legales`, count: 3 })
    if (webSearch.error && !searchError) searchError = webSearch.error
    for (const result of (webSearch.results || []).slice(0, 2)) {
      const url = result.url || ""
      // The page must both look like a legal notice AND name the target: a
      // third party's mentions legales lists its own contacts, not ours.
      if (isLegalNoticeUrl(url) && pageNamesEntity(url, name, config)) {
        mentionsUrl = url
        const mentions = await scrapeMentionsLegales(url, { scrape: scrapeFn })
        entityMatched = true
        allEmails.push(...mentions.emails)
        allPhones.push(...mentions.phones)
        if (!siren && mentions.siren) siren = mentions.siren
        break
      }
    }
  } catch { /* non-critical */ }

  allEmails = [...new Set(allEmails)]
  allPhones = [...new Set(allPhones.map((p) => p.replace(/[\s.-]/g, "")))]

  return Object.freeze({
    emails: allEmails, phones: allPhones, siren, mentionsUrl,
    entityMatched, jurisdiction: config.jurisdiction,
    searchError,
    // The channel only claims a verdict when it actually got to look.
    conclusive: !searchError || entityMatched,
  })
}
