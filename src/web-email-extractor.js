const EMAIL_REGEX = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g

const NOISE_LOCALS = new Set([
  "noreply", "no-reply", "do-not-reply", "donotreply",
  "example", "test", "admin", "webmaster", "postmaster",
  "mailer-daemon", "support", "abuse",
])

const CONTACT_PATHS = [
  "/contact", "/about", "/team", "/about-us", "/our-team",
  "/mentions-legales", "/impressum", "/imprint", "/legal",
  "/qui-sommes-nous", "/a-propos", "/kontakt", "/kontakt-uns",
  "/contact-us", "/reach-us", "/get-in-touch",
]

function normalizeDomain(raw) {
  return String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/.*$/, "")
}

export function extractEmailsFromText(text) {
  if (!text || typeof text !== "string") return []
  const matches = text.match(EMAIL_REGEX) || []
  const seen = new Set()
  return matches
    .map((e) => e.toLowerCase())
    .filter((email) => {
      if (seen.has(email)) return false
      seen.add(email)
      const local = email.split("@")[0]
      return !NOISE_LOCALS.has(local)
    })
}

export function findContactPageUrls(domain) {
  const d = normalizeDomain(domain)
  if (!d) return []
  return CONTACT_PATHS.map((path) => `https://${d}${path}`)
}

export async function extractEmailsFromDomain(domain, deps = {}) {
  const d = normalizeDomain(domain)
  if (!d) return Object.freeze({ emails: [], pagesScraped: 0, errors: [] })

  const scrapeFn = deps.scrape || (async () => ({ text: "", status: 0 }))
  const urls = findContactPageUrls(d)

  const allEmails = []
  const errors = []
  let pagesScraped = 0

  try {
    const homepage = await scrapeFn(`https://${d}`, { timeout: 10_000 })
    if (homepage.text && homepage.status >= 200 && homepage.status < 400) {
      pagesScraped++
      const found = extractEmailsFromText(homepage.text)
      for (const email of found) {
        allEmails.push({ email, sourceUrl: `https://${d}`, context: "homepage" })
      }
    }
  } catch (err) {
    errors.push({ url: `https://${d}`, error: err.message })
  }

  const chunks = []
  for (let i = 0; i < urls.length; i += 3) {
    chunks.push(urls.slice(i, i + 3))
  }

  for (const chunk of chunks) {
    const results = await Promise.allSettled(
      chunk.map(async (url) => {
        const page = await scrapeFn(url, { timeout: 10_000 })
        return { url, page }
      })
    )

    for (const r of results) {
      if (r.status === "fulfilled" && r.value.page.text && r.value.page.status >= 200 && r.value.page.status < 400) {
        pagesScraped++
        const found = extractEmailsFromText(r.value.page.text)
        for (const email of found) {
          if (!allEmails.some((e) => e.email === email)) {
            allEmails.push({ email, sourceUrl: r.value.url, context: "contact_page" })
          }
        }
      } else if (r.status === "rejected") {
        errors.push({ url: "unknown", error: r.reason?.message || "failed" })
      }
    }
  }

  const domainEmails = allEmails.filter((e) => {
    const emailDomain = e.email.split("@")[1]
    return emailDomain === d || emailDomain?.endsWith(`.${d}`)
  })

  const otherEmails = allEmails.filter((e) => {
    const emailDomain = e.email.split("@")[1]
    return emailDomain !== d && !emailDomain?.endsWith(`.${d}`)
  })

  return Object.freeze({
    emails: [...domainEmails, ...otherEmails],
    pagesScraped,
    errors,
  })
}

export { CONTACT_PATHS, NOISE_LOCALS }
