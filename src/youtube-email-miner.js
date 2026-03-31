/**
 * YouTube Email Miner — Extract business inquiry email from channel About page.
 */

const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g
const BUSINESS_KEYWORDS = /business|inquir|collab|partner|contact|booking|press|media|sponsor/i
const NOISE_LOCALS = new Set(["noreply", "no-reply", "support", "admin", "webmaster", "example"])

function normalizeChannelUrl(url) {
  const raw = String(url || "").trim()
  if (!raw) return null

  if (raw.startsWith("@")) return `https://www.youtube.com/${raw}/about`

  const clean = raw.replace(/\/+$/, "")
  if (clean.includes("/about")) return clean
  return `${clean}/about`
}

export function extractBusinessEmail(text) {
  if (!text || typeof text !== "string") return null

  const matches = text.match(EMAIL_REGEX)
  if (!matches || matches.length === 0) return null

  const cleaned = matches
    .map((e) => e.toLowerCase())
    .filter((e) => {
      const local = e.split("@")[0]
      return !NOISE_LOCALS.has(local) && !e.includes("youtube.com") && !e.includes("google.com")
    })

  if (cleaned.length === 0) return null

  const lines = text.split("\n")
  for (const line of lines) {
    if (BUSINESS_KEYWORDS.test(line)) {
      const lineEmails = line.match(EMAIL_REGEX)
      if (lineEmails) {
        const candidate = lineEmails[0].toLowerCase()
        if (cleaned.includes(candidate)) return candidate
      }
    }
  }

  for (const email of cleaned) {
    const emailIndex = lines.findIndex((l) => l.toLowerCase().includes(email))
    if (emailIndex >= 0) {
      const context = lines.slice(Math.max(0, emailIndex - 2), emailIndex + 3).join(" ")
      if (BUSINESS_KEYWORDS.test(context)) return email
    }
  }

  return cleaned[0]
}

export async function mineYouTubeEmail(channelUrl, deps = {}) {
  const scrapeFn = deps.scrape || (async () => ({ text: "", status: 0 }))
  const aboutUrl = normalizeChannelUrl(channelUrl)

  if (!aboutUrl) {
    return Object.freeze({ email: null, source: "youtube_about", error: "invalid_url" })
  }

  try {
    const page = await scrapeFn(aboutUrl, { timeout: 15_000 })

    if (!page.text || page.status >= 400) {
      return Object.freeze({ email: null, source: "youtube_about", error: "page_not_found" })
    }

    const email = extractBusinessEmail(page.text)
    return Object.freeze({ email, source: "youtube_about", error: null })
  } catch (err) {
    return Object.freeze({ email: null, source: "youtube_about", error: err.message })
  }
}
