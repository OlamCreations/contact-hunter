/**
 * Keyless search fallback.
 *
 * The README promises zero API cost, but every search-driven channel (search
 * mining, company registry, legal notices) went silent without a BRAVE_API_KEY,
 * and silent in a way no caller could see: the search function returned an empty
 * result list, indistinguishable from "the web has nothing".
 *
 * This module answers the same shape from DuckDuckGo's lite endpoint, which needs
 * no key. It is a fallback, not a replacement: no ranking metadata, no snippets
 * worth trusting, and it can be rate-limited or reshaped without notice. Errors
 * are reported, never swallowed into an empty list.
 */

const LITE_ENDPOINT = "https://lite.duckduckgo.com/lite/"
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36"
const ANCHOR = /<a[^>]+href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/g

function stripTags(html) {
  return String(html || "").replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim()
}

function isSearchEngineChrome(url) {
  try {
    return new URL(url).hostname.endsWith("duckduckgo.com")
  } catch {
    return true
  }
}

export function parseLiteResults(html, count = 10) {
  const seen = new Set()
  const results = []

  for (const match of String(html || "").matchAll(ANCHOR)) {
    const url = match[1]
    if (isSearchEngineChrome(url) || seen.has(url)) continue
    seen.add(url)
    results.push({ title: stripTags(match[2]) || null, url, snippet: null })
    if (results.length >= count) break
  }

  return results
}

export async function searchDuckDuckGo(params = {}, deps = {}) {
  const fetchFn = deps.fetch || globalThis.fetch
  const query = String(params.query || "").trim()
  const count = params.count || 10

  if (!query) return { results: [], error: "empty_query" }
  if (typeof fetchFn !== "function") return { results: [], error: "no_fetch" }

  try {
    const response = await fetchFn(LITE_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": UA },
      body: "q=" + encodeURIComponent(query),
      signal: AbortSignal.timeout(12_000),
    })

    if (!response.ok) return { results: [], error: `http_${response.status}` }

    const html = await response.text()
    return { results: parseLiteResults(html, count), error: null }
  } catch (err) {
    return { results: [], error: err.name || "search_failed" }
  }
}
