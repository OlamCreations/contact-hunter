import dns from "node:dns/promises"
import { isIP } from "node:net"
import { isPrivateIp } from "./smtp-verifier.js"

export const MAX_REDIRECTS = 5

export async function validateUrl(url, deps = {}) {
  const resolve4 = deps.resolve4 || dns.resolve4
  const parsed = new URL(url)
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error("blocked")
  const hostname = parsed.hostname
  if (isIP(hostname) && isPrivateIp(hostname)) throw new Error("blocked")
  try {
    const addresses = await resolve4(hostname)
    for (const addr of addresses) {
      if (isPrivateIp(addr)) throw new Error("blocked")
    }
  } catch (err) {
    if (err.message === "blocked") throw err
  }
  return url
}

/**
 * Fetch a page, following redirects, revalidating every hop.
 *
 * This used to pass `redirect: "manual"` and stop there. That protects against
 * SSRF through a redirect to a private address, but it also made the whole
 * web-scraping channel useless: `https://example.com` answers 301 to
 * `https://www.example.com` with an empty body, and 301 satisfies the caller's
 * `status >= 200 && status < 400` check. An empty page was therefore reported
 * as a successfully scraped one, and no error was ever raised.
 *
 * Measured on a live domain: manual -> 301, 0 bytes, no mailto in the body.
 * Following the redirect -> 200, 1,994,719 bytes, mailto present.
 *
 * The SSRF protection is kept: each hop goes through validateUrl again, so a
 * redirect to a private address is still blocked. Only the pointless stop at
 * the first hop is gone.
 *
 * `deps` exists so this can be tested without network access — the bug lived
 * in a function that nothing could reach from a test.
 */
export async function safeScrape(url, opts = {}, deps = {}) {
  const doFetch = deps.fetch || fetch
  const check = deps.validateUrl || validateUrl
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), opts.timeout || 10_000)
  try {
    let current = url
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      await check(current)
      const response = await doFetch(current, {
        signal: controller.signal,
        headers: { "User-Agent": "ContactHunter/1.0" },
        redirect: "manual",
      })
      const location = response.headers?.get?.("location")
      if (response.status >= 300 && response.status < 400 && location) {
        current = new URL(location, current).toString()
        continue
      }
      const text = await response.text()
      return { text: text.slice(0, 500_000), status: response.status, url: current }
    }
    return { text: "", status: 0 }
  } catch {
    return { text: "", status: 0 }
  } finally {
    clearTimeout(timeout)
  }
}
