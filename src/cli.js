#!/usr/bin/env node

/**
 * Contact Hunter CLI
 *
 * Usage:
 *   contact-hunter find <domain> <name>     Find someone's email
 *   contact-hunter search <domain>          Search domain for emails
 *   contact-hunter verify <email>           Verify email deliverability
 *   contact-hunter discover <domain>        Full multi-channel discovery
 *   contact-hunter dns <domain>             DNS intelligence analysis
 *   contact-hunter patterns <first> <last> <domain>  Generate email patterns
 *   contact-hunter serve [port]             Start HTTP server
 */

import { createContactHunter } from "./hunter.js"
import { analyzeDomain } from "./dns-intel.js"
import { generatePatterns } from "./pattern-generator.js"
import { extractEmailsFromDomain } from "./web-email-extractor.js"
import { searchForEmail } from "./search-email-miner.js"
import { mineGitHubEmails } from "./github-email-miner.js"
import { mineYouTubeEmail } from "./youtube-email-miner.js"
import { searchFrenchRegistry } from "./company-registry.js"

async function defaultScrape(url, opts = {}) {
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), opts.timeout || 10_000)
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "ContactHunter/1.0" },
    })
    clearTimeout(timeout)
    const text = await response.text()
    return { text, status: response.status }
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

function createFullHunter() {
  return createContactHunter({
    extractWebEmailsFn: (domain) => extractEmailsFromDomain(domain, { scrape: defaultScrape }),
    searchEmailsFn: (name, domain) => searchForEmail(name, domain, { searchFn: defaultSearch }),
    githubMinerFn: (name, domain) => mineGitHubEmails(name, domain),
    youtubeMinerFn: (url) => mineYouTubeEmail(url, { scrape: defaultScrape }),
    companyRegistryFn: (name) => searchFrenchRegistry(name, { searchFn: defaultSearch, scrape: defaultScrape }),
    enableRateLimit: true,
  })
}

function printResult(data) {
  console.log(JSON.stringify(data, null, 2))
}

const USAGE = `
Contact Hunter — Self-hosted multi-channel contact intelligence

Usage:
  contact-hunter find <domain> <name>                Find someone's email
  contact-hunter search <domain>                     Search domain for emails
  contact-hunter verify <email>                      Verify email deliverability
  contact-hunter discover <domain>                   Full multi-channel discovery
  contact-hunter dns <domain>                        DNS intelligence analysis
  contact-hunter patterns <first> <last> <domain>    Generate email patterns
  contact-hunter serve [port]                        Start HTTP server

Environment:
  CONTACT_HUNTER_EHLO_DOMAIN   EHLO domain for SMTP verification
  BRAVE_API_KEY                Brave Search API key (for search mining)
  GITHUB_TOKEN                 GitHub token (increases rate limit from 60 to 5000/hr)
  HUNTER_API_KEY               Hunter.io key (optional fallback)

Examples:
  contact-hunter find stripe.com "Patrick Collison"
  contact-hunter search openai.com
  contact-hunter verify alice@company.com
  contact-hunter discover tesla.com
  contact-hunter dns google.com
  contact-hunter patterns alice smith company.com
  contact-hunter serve 8080
`.trim()

async function main() {
  const args = process.argv.slice(2)
  const command = args[0]

  if (!command || command === "--help" || command === "-h") {
    console.log(USAGE)
    process.exit(0)
  }

  switch (command) {
    case "find": {
      const [, domain, ...nameParts] = args
      if (!domain || nameParts.length === 0) {
        console.error("Usage: contact-hunter find <domain> <name>")
        process.exit(1)
      }
      const hunter = createFullHunter()
      const result = await hunter.findEmail(domain, nameParts.join(" "))
      printResult(result)
      break
    }

    case "search": {
      const domain = args[1]
      if (!domain) {
        console.error("Usage: contact-hunter search <domain>")
        process.exit(1)
      }
      const hunter = createFullHunter()
      const result = await hunter.domainSearch(domain)
      printResult(result)
      break
    }

    case "verify": {
      const email = args[1]
      if (!email) {
        console.error("Usage: contact-hunter verify <email>")
        process.exit(1)
      }
      const hunter = createFullHunter()
      const result = await hunter.verifyEmail(email)
      printResult(result)
      break
    }

    case "discover": {
      const domain = args[1]
      if (!domain) {
        console.error("Usage: contact-hunter discover <domain>")
        process.exit(1)
      }
      const hunter = createFullHunter()
      const result = await hunter.discoverContacts(domain, {
        youtubeUrl: args[2] || undefined,
      })
      printResult(result)
      break
    }

    case "dns": {
      const domain = args[1]
      if (!domain) {
        console.error("Usage: contact-hunter dns <domain>")
        process.exit(1)
      }
      const result = await analyzeDomain(domain)
      printResult(result)
      break
    }

    case "patterns": {
      const [, first, last, domain] = args
      if (!first || !last || !domain) {
        console.error("Usage: contact-hunter patterns <first> <last> <domain>")
        process.exit(1)
      }
      const patterns = generatePatterns(first, last, domain)
      for (const p of patterns) console.log(p)
      break
    }

    case "serve": {
      const port = Number(args[1] || process.env.PORT || 3847)
      process.env.PORT = String(port)
      await import("./server.js")
      break
    }

    default:
      console.error(`Unknown command: ${command}`)
      console.log(USAGE)
      process.exit(1)
  }
}

main().catch((err) => {
  console.error(err.message)
  process.exit(1)
})
