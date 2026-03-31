#!/usr/bin/env node

/**
 * Contact Hunter — Standalone HTTP server.
 *
 * Environment variables:
 *   PORT                        — HTTP port (default: 3847)
 *   CONTACT_HUNTER_EHLO_DOMAIN  — EHLO domain for SMTP (default: localhost)
 *   CONTACT_HUNTER_DB_PATH      — SQLite cache path (default: ./contact-hunter.db)
 *   GITHUB_TOKEN                — GitHub API token (optional, increases rate limit)
 *   HUNTER_API_KEY              — Hunter.io API key (optional, for fallback)
 */

import http from "node:http"
import { createContactHunter } from "./hunter.js"
import { extractEmailsFromDomain } from "./web-email-extractor.js"
import { searchForEmail } from "./search-email-miner.js"
import { mineGitHubEmails } from "./github-email-miner.js"
import { mineYouTubeEmail } from "./youtube-email-miner.js"
import { searchFrenchRegistry } from "./company-registry.js"
import { createContactCache, SOURCE_TTL_DAYS } from "./contact-cache.js"

const PORT = Number(process.env.PORT || 3847)

function sendJson(res, data, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json" })
  res.end(JSON.stringify(data))
}

function parseBody(req) {
  return new Promise((resolve) => {
    const chunks = []
    req.on("data", (c) => chunks.push(c))
    req.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString())) }
      catch { resolve({}) }
    })
  })
}

async function defaultScrape(url, opts = {}) {
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), opts.timeout || 10_000)
    const response = await fetch(url, { signal: controller.signal })
    clearTimeout(timeout)
    const text = await response.text()
    return { text, status: response.status }
  } catch {
    return { text: "", status: 0 }
  }
}

async function defaultSearch(params) {
  // Brave Search API (requires BRAVE_API_KEY)
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

function createServer() {
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
    extractWebEmailsFn: (domain) => extractEmailsFromDomain(domain, { scrape: defaultScrape }),
    searchEmailsFn: (name, domain) => searchForEmail(name, domain, { searchFn: defaultSearch }),
    githubMinerFn: (name, domain) => mineGitHubEmails(name, domain),
    youtubeMinerFn: (url) => mineYouTubeEmail(url, { scrape: defaultScrape }),
    companyRegistryFn: (name) => searchFrenchRegistry(name, { searchFn: defaultSearch, scrape: defaultScrape }),
    enableRateLimit: true,
  })

  const routes = {
    "POST /api/search": async (req, res) => {
      const body = await parseBody(req)
      if (!body.domain) return sendJson(res, { error: "domain required" }, 400)
      const result = await hunter.domainSearch(body.domain)
      sendJson(res, { ok: true, ...result })
    },

    "POST /api/find": async (req, res) => {
      const body = await parseBody(req)
      if (!body.domain) return sendJson(res, { error: "domain required" }, 400)
      const result = await hunter.findEmail(body.domain, body.role || body.name || "")
      if (result.email) {
        await cache.set({
          domain: body.domain,
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
      if (!body.email) return sendJson(res, { error: "email required" }, 400)
      const result = await hunter.verifyEmail(body.email)
      sendJson(res, { ok: true, ...result })
    },

    "POST /api/discover": async (req, res) => {
      const body = await parseBody(req)
      if (!body.domain) return sendJson(res, { error: "domain required" }, 400)
      const result = await hunter.discoverContacts(body.domain, body)
      sendJson(res, { ok: true, ...result })
    },

    "GET /api/cache/stats": async (_req, res) => {
      const stats = await cache.stats()
      sendJson(res, { ok: true, ...stats, ttl_config: SOURCE_TTL_DAYS })
    },

    "POST /api/cache/invalidate": async (req, res) => {
      const body = await parseBody(req)
      if (!body.email) return sendJson(res, { error: "email required" }, 400)
      const invalidated = await cache.invalidateOnBounce(body.email)
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
    const key = `${req.method} ${req.url?.split("?")[0]}`
    const handler = routes[key]

    if (!handler) {
      return sendJson(res, { error: "not found" }, 404)
    }

    try {
      await handler(req, res)
    } catch (err) {
      sendJson(res, { ok: false, error: err.message }, 500)
    }
  })

  return server
}

// Auto-start when run directly
const server = createServer()
server.listen(PORT, () => {
  console.log(`[contact-hunter] Server listening on :${PORT}`)
  console.log(`[contact-hunter] Endpoints:`)
  console.log(`  POST /api/search    — Domain email search`)
  console.log(`  POST /api/find      — Find specific person's email`)
  console.log(`  POST /api/verify    — Verify email deliverability`)
  console.log(`  POST /api/discover  — Full multi-channel discovery`)
  console.log(`  GET  /api/health    — Health check`)
})
