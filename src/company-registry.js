/**
 * Company Registry — French mentions legales + Pappers scraping.
 * Extracts SIREN, emails, phones from company websites and registries.
 */

const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g
const PHONE_REGEX = /(?:\+33\s?|0)[1-9](?:[\s.-]?\d{2}){4}/g
const SIREN_REGEX = /(?:SIREN|SIRET|RCS\s+\w+)\s*:?\s*(\d[\d\s]{7,15}\d)/gi
const BARE_SIREN = /\b(\d{3}\s?\d{3}\s?\d{3})\b/g

const NOISE_EMAILS = new Set(["noreply", "no-reply", "example", "test", "admin", "webmaster"])

const MENTIONS_PATHS = [
  "/mentions-legales", "/legal", "/mentions", "/cgu",
  "/impressum", "/legal-notice", "/politique-de-confidentialite",
]

function normalizeDomain(raw) {
  return String(raw || "").trim().toLowerCase()
    .replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "")
}

export function extractPhoneNumbers(text) {
  if (!text || typeof text !== "string") return []
  const matches = text.match(PHONE_REGEX) || []
  const seen = new Set()
  return matches.filter((p) => {
    const normalized = p.replace(/[\s.-]/g, "")
    if (seen.has(normalized)) return false
    seen.add(normalized)
    return true
  })
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
    const phones = extractPhoneNumbers(page.text)
    const siren = extractSiren(page.text)

    return Object.freeze({ emails, phones, siren, error: null })
  } catch (err) {
    return Object.freeze({ emails: [], phones: [], siren: null, error: err.message })
  }
}

export async function searchFrenchRegistry(companyName, deps = {}) {
  const searchFn = deps.searchBraveWeb || deps.searchFn || (async () => ({ results: [] }))
  const scrapeFn = deps.scrape || (async () => ({ text: "", status: 0 }))

  const name = String(companyName || "").trim()
  if (!name) return Object.freeze({ emails: [], phones: [], siren: null, mentionsUrl: null })

  let searchResults = []
  try {
    const response = await searchFn({ query: `${name} site:pappers.fr OR site:societe.com SIREN`, count: 5 })
    searchResults = response.results || []
  } catch { /* search failed */ }

  let allEmails = []
  let allPhones = []
  let siren = null
  let mentionsUrl = null

  for (const result of searchResults.slice(0, 2)) {
    if (!result.url) continue
    try {
      const page = await scrapeFn(result.url, { timeout: 15_000 })
      if (page.text && page.status < 400) {
        allEmails.push(...extractEmails(page.text))
        allPhones.push(...extractPhoneNumbers(page.text))
        if (!siren) siren = extractSiren(page.text)
      }
    } catch { /* skip */ }
  }

  try {
    const webSearch = await searchFn({ query: `${name} mentions legales`, count: 3 })
    for (const result of (webSearch.results || []).slice(0, 2)) {
      const url = result.url || ""
      if (MENTIONS_PATHS.some((p) => url.includes(p))) {
        mentionsUrl = url
        const mentions = await scrapeMentionsLegales(url, { scrape: scrapeFn })
        allEmails.push(...mentions.emails)
        allPhones.push(...mentions.phones)
        if (!siren && mentions.siren) siren = mentions.siren
        break
      }
    }
  } catch { /* non-critical */ }

  allEmails = [...new Set(allEmails)]
  allPhones = [...new Set(allPhones.map((p) => p.replace(/[\s.-]/g, "")))]

  return Object.freeze({ emails: allEmails, phones: allPhones, siren, mentionsUrl })
}
