#!/usr/bin/env node

/**
 * Contact Hunter — Standalone HTTP server.
 *
 * Environment variables:
 *   PORT                        — HTTP port (default: 3847)
 *   CONTACT_HUNTER_HOST         — Bind address (default: 127.0.0.1)
 *   CONTACT_HUNTER_EHLO_DOMAIN  — EHLO domain for SMTP (default: localhost)
 *   CONTACT_HUNTER_DB_PATH      — SQLite cache path (default: ./contact-hunter.db)
 *   GITHUB_TOKEN                — GitHub API token (optional, increases rate limit)
 *   BRAVE_API_KEY               — Brave Search API key (optional, for search mining)
 */

import http from "node:http"
import dns from "node:dns/promises"
import { isIP } from "node:net"
import { createContactHunter } from "./hunter.js"
import { extractEmailsFromDomain } from "./web-email-extractor.js"
import { searchForEmail } from "./search-email-miner.js"
import { mineGitHubEmails } from "./github-email-miner.js"
import { mineYouTubeEmail } from "./youtube-email-miner.js"
import { searchFrenchRegistry } from "./company-registry.js"
import { createContactCache, SOURCE_TTL_DAYS } from "./contact-cache.js"
import { isPrivateIp } from "./smtp-verifier.js"

const PORT = Number(process.env.PORT || 3847)
const HOST = process.env.CONTACT_HUNTER_HOST || "127.0.0.1"
const MAX_BODY_SIZE = 64 * 1024 // 64 KB
const RATE_LIMIT_WINDOW_MS = 60_000
const RATE_LIMIT_MAX = 60

// ---- SSRF Protection ----

async function validateUrl(url) {
  const parsed = new URL(url)
  const hostname = parsed.hostname

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("ssrf_blocked")
  }

  if (isIP(hostname)) {
    if (isPrivateIp(hostname)) throw new Error("ssrf_blocked")
    return url
  }

  try {
    const addresses = await dns.resolve4(hostname)
    for (const addr of addresses) {
      if (isPrivateIp(addr)) throw new Error("ssrf_blocked")
    }
  } catch (err) {
    if (err.message === "ssrf_blocked") throw err
    // DNS resolution failed — allow (will fail at fetch level)
  }

  return url
}

// ---- Rate Limiter ----

const requestCounts = new Map()

function rateLimit(req, res) {
  const ip = req.socket.remoteAddress || "unknown"
  const now = Date.now()
  const entry = requestCounts.get(ip) || { count: 0, windowStart: now }
  if (now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    entry.count = 0
    entry.windowStart = now
  }
  entry.count++
  requestCounts.set(ip, entry)
  if (entry.count > RATE_LIMIT_MAX) {
    sendJson(res, { error: "rate limit exceeded" }, 429)
    return false
  }
  return true
}

// Cleanup stale entries every 5 minutes
setInterval(() => {
  const now = Date.now()
  for (const [ip, entry] of requestCounts) {
    if (now - entry.windowStart > RATE_LIMIT_WINDOW_MS * 2) requestCounts.delete(ip)
  }
}, 300_000).unref()

// ---- Helpers ----

function sendJson(res, data, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json" })
  res.end(JSON.stringify(data))
}

function parseBody(req) {
  return new Promise((resolve) => {
    const chunks = []
    let totalSize = 0
    req.on("data", (c) => {
      totalSize += c.length
      if (totalSize > MAX_BODY_SIZE) {
        req.destroy()
        resolve({})
        return
      }
      chunks.push(c)
    })
    req.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString())) }
      catch { resolve({}) }
    })
  })
}

function validateDomain(domain) {
  if (typeof domain !== "string") return null
  const cleaned = domain.trim().slice(0, 253)
  return cleaned || null
}

function validateString(value, maxLen = 200) {
  if (typeof value !== "string") return ""
  return value.trim().slice(0, maxLen)
}

// ---- SSRF-safe Scrape ----

async function safeScrape(url, opts = {}) {
  try {
    await validateUrl(url)
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), opts.timeout || 10_000)
    const response = await fetch(url, { signal: controller.signal, redirect: "manual" })
    clearTimeout(timeout)
    const text = await response.text()
    return { text: text.slice(0, 500_000), status: response.status }
  } catch {
    return { text: "", status: 0 }
  }
}

async function defaultSearch(params) {
  const apiKey = process.env.BRAVE_API_KEY
  if (!apiKey) return { results: [] }

  try {
    const url = new URL("https://api.search.brave.com/res/v1/web/search")
    url.searchParams.set("q", params.query)
    url.searchParams.set("count", String(params.count || 10))

    const response = await fetch(url, {
      headers: { "X-Subscription-Token": apiKey, Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    })
    const data = await response.json()
    return {
      results: (data.web?.results || []).map((r) => ({
        title: r.title,
        url: r.url,
        snippet: r.description,
      })),
    }
  } catch {
    return { results: [] }
  }
}

// ---- Server ----

async function createServer() {
  let db = null
  try {
    const Database = (await import("better-sqlite3")).default
    const dbPath = process.env.CONTACT_HUNTER_DB_PATH || "./contact-hunter.db"
    db = new Database(dbPath)
  } catch {
    console.log("[contact-hunter] SQLite not available, running without cache")
  }

  const cache = createContactCache({ db })

  const hunter = createContactHunter({
    extractWebEmailsFn: (domain) => extractEmailsFromDomain(domain, { scrape: safeScrape }),
    searchEmailsFn: (name, domain) => searchForEmail(name, domain, { searchFn: defaultSearch }),
    githubMinerFn: (name, domain) => mineGitHubEmails(name, domain),
    youtubeMinerFn: (url) => mineYouTubeEmail(url, { scrape: safeScrape }),
    companyRegistryFn: (name) => searchFrenchRegistry(name, { searchFn: defaultSearch, scrape: safeScrape }),
    enableRateLimit: true,
  })

  const routes = {
    "POST /api/search": async (req, res) => {
      const body = await parseBody(req)
      const domain = validateDomain(body.domain)
      if (!domain) return sendJson(res, { error: "domain required" }, 400)
      const result = await hunter.domainSearch(domain)
      sendJson(res, { ok: true, ...result })
    },

    "POST /api/find": async (req, res) => {
      const body = await parseBody(req)
      const domain = validateDomain(body.domain)
      if (!domain) return sendJson(res, { error: "domain required" }, 400)
      const role = validateString(body.role || body.name || "")
      const result = await hunter.findEmail(domain, role)
      if (result.email) {
        await cache.set({
          domain,
          email: result.email,
          personName: [result.firstName, result.lastName].filter(Boolean).join(" "),
          confidence: result.confidence,
          source: "contact_hunter",
        }).catch(() => {})
      }
      sendJson(res, { ok: true, ...result })
    },

    "POST /api/verify": async (req, res) => {
      const body = await parseBody(req)
      const email = validateString(body.email, 320)
      if (!email) return sendJson(res, { error: "email required" }, 400)
      const result = await hunter.verifyEmail(email)
      sendJson(res, { ok: true, ...result })
    },

    "POST /api/discover": async (req, res) => {
      const body = await parseBody(req)
      const domain = validateDomain(body.domain)
      if (!domain) return sendJson(res, { error: "domain required" }, 400)
      const opts = {}
      if (body.youtubeUrl) opts.youtubeUrl = validateString(body.youtubeUrl, 500)
      const result = await hunter.discoverContacts(domain, opts)
      sendJson(res, { ok: true, ...result })
    },

    "GET /api/cache/stats": async (_req, res) => {
      const stats = await cache.stats()
      sendJson(res, { ok: true, ...stats, ttl_config: SOURCE_TTL_DAYS })
    },

    "POST /api/cache/invalidate": async (req, res) => {
      const body = await parseBody(req)
      const email = validateString(body.email, 320)
      if (!email) return sendJson(res, { error: "email required" }, 400)
      const invalidated = await cache.invalidateOnBounce(email)
      sendJson(res, { ok: true, invalidated })
    },

    "GET /api/health": async (_req, res) => {
      const stats = await cache.stats()
      sendJson(res, {
        ok: true,
        status: "operational",
        channels: ["smtp_verify", "dns_intel", "web_scrape", "search_mine", "pattern_gen", "github", "youtube", "company_registry", "phone"],
        cache: stats,
      })
    },
  }

  const server = http.createServer(async (req, res) => {
    if (!rateLimit(req, res)) return

    const key = `${req.method} ${req.url?.split("?")[0]}`
    const handler = routes[key]

    if (!handler) {
      return sendJson(res, { error: "not found" }, 404)
    }

    try {
      await handler(req, res)
    } catch (err) {
      console.error("[contact-hunter] Internal error:", err)
      sendJson(res, { ok: false, error: "internal_error" }, 500)
    }
  })

  return server
}

// Auto-start when run directly
const server = await createServer()
server.listen(PORT, HOST, () => {
  console.log(`[contact-hunter] Server listening on ${HOST}:${PORT}`)
  console.log(`[contact-hunter] Endpoints:`)
  console.log(`  POST /api/search    — Domain email search`)
  console.log(`  POST /api/find      — Find specific person's email`)
  console.log(`  POST /api/verify    — Verify email deliverability`)
  console.log(`  POST /api/discover  — Full multi-channel discovery`)
  console.log(`  GET  /api/health    — Health check`)
})
