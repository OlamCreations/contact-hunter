# Contact Hunter

Self-hosted multi-channel contact intelligence. Find verified business emails at zero API cost.

## Channels

| Channel | Source | Cost |
|---------|--------|------|
| SMTP Verification | Direct mailserver check | Free |
| DNS Intelligence | MX records, SPF, catch-all detection | Free |
| Pattern Generation | 17 email patterns + hyphenated name support | Free |
| Web Scraping | Homepage + contact pages email extraction | Free |
| Search Mining | Search engine result scraping | Free (needs Brave API key) |
| GitHub Mining | Public commit email extraction | Free (60/hr, 5000/hr with token) |
| YouTube Mining | Channel about page business email | Free |
| Company Registry | French Pappers/Societe.com SIREN extraction (FR only) | Free |
| Phone Discovery | Registry phone numbers, entity-attributed (FR only) | Free |

### Company registry: what it will and will not tell you

This channel reads French registers only, and every result says so:
`{ jurisdiction: "FR", entityMatched: boolean, siren, phones, emails }`.

`entityMatched` is the contract. A search engine returns records of companies that
merely resemble the query, and a page like `societe.com/societe/<company>.html` runs
to 170 000 characters carrying dozens of phone numbers that belong to the site, to
adverts and to "similar companies". Two gates therefore apply before anything is
attributed:

1. the page must name the target;
2. a phone must sit within 600 characters of that mention *and* be introduced as a
   contact number.

When both hold, results are scored through the shared confidence matrix. When they
do not, the channel returns nothing rather than a plausible wrong answer. Callers
must treat `entityMatched: false` as no data. An empty result on a real company is
the expected output when the register does not publish a number in the open.

## Install

```bash
npm install contact-hunter
```

## CLI

```bash
# Find someone's email
npx contact-hunter find stripe.com "Patrick Collison"

# Search a domain for all emails
npx contact-hunter search openai.com

# Verify an email
npx contact-hunter verify alice@company.com

# Full multi-channel discovery
npx contact-hunter discover tesla.com

# DNS intelligence
npx contact-hunter dns google.com

# Generate email patterns
npx contact-hunter patterns alice smith company.com

# Start HTTP server
npx contact-hunter serve 8080
```

## API

```javascript
import { createContactHunter } from 'contact-hunter'

const hunter = createContactHunter()

// Find email
const result = await hunter.findEmail('company.com', 'Alice Smith')
// { email: 'alice.smith@company.com', confidence: 95, firstName: 'alice', lastName: 'smith', ... }

// Search domain
const search = await hunter.domainSearch('company.com')
// { emails: [...], patterns: ['first.last'], organization: null }

// Verify email
const verify = await hunter.verifyEmail('alice@company.com')
// { result: 'deliverable', score: 95 }

// Four verdicts, and two of them mean "SMTP cannot decide here":
//   deliverable   95  the server rejects unknown recipients and accepted this one
//   undeliverable  0  the server rejected it
//   risky         50  the domain accepts every recipient, so acceptance proves nothing
//   unknown       40  the catch-all probe could not run, so acceptance proves nothing
//
// Measured 2026-09-09: aspmx.l.google.com answers 250 2.1.5 OK to
// RCPT TO:<zzq-nexistepas-8412@similarweb.com>. Any tool reporting that address
// as deliverable is reporting the absence of a rejection as a confirmation.

// Full discovery
const discover = await hunter.discoverContacts('company.com')
// { contacts: [...], phones: [...], meta: { provider: 'google_workspace', ... } }
```

## HTTP Server

```bash
npx contact-hunter serve
# Server listening on :3847
```

Endpoints:

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/find` | Find person's email (`{ domain, name/role }`) |
| POST | `/api/search` | Search domain for emails (`{ domain }`) |
| POST | `/api/verify` | Verify email (`{ email }`) |
| POST | `/api/discover` | Full multi-channel discovery (`{ domain }`) |
| GET | `/api/health` | Health check |
| GET | `/api/cache/stats` | Cache statistics |
| POST | `/api/cache/invalidate` | Invalidate bounced email (`{ email }`) |

## Wiring Channels

By default, only pattern generation and SMTP verification are active. To enable web scraping, search mining, GitHub, YouTube, and company registry channels, provide the dependency functions:

```javascript
import { createContactHunter } from 'contact-hunter'
import { extractEmailsFromDomain } from 'contact-hunter'
import { searchForEmail } from 'contact-hunter'
import { mineGitHubEmails } from 'contact-hunter'
import { mineYouTubeEmail } from 'contact-hunter'
import { searchFrenchRegistry } from 'contact-hunter'

const hunter = createContactHunter({
  extractWebEmailsFn: (domain) => extractEmailsFromDomain(domain, {
    scrape: async (url) => {
      const res = await fetch(url)
      return { text: await res.text(), status: res.status }
    }
  }),
  searchEmailsFn: (name, domain) => searchForEmail(name, domain, {
    searchFn: yourSearchFunction
  }),
  githubMinerFn: (name, domain) => mineGitHubEmails(name, domain),
  youtubeMinerFn: (url) => mineYouTubeEmail(url, { scrape: yourScrapeFunction }),
  companyRegistryFn: (name) => searchFrenchRegistry(name, {
    searchFn: yourSearchFunction,
    scrape: yourScrapeFunction
  }),
})
```

The HTTP server (`src/server.js`) wires all channels automatically using `fetch` for scraping and the Brave Search API for search mining.

## Confidence Scoring

Multi-signal confidence with temporal decay:

| Source | Base Score | Decay/Month |
|--------|-----------|-------------|
| SMTP Verify | 95 | 2 |
| Company Registry | 80 | 3 |
| Web Scrape | 70 | 5 |
| YouTube | 65 | 4 |
| GitHub | 60 | 5 |
| Search Engine | 50 | 8 |
| Pattern | 40 | 10 |

Multiple corroborating sources add +3 (2 sources) or +5 (3+ sources) bonus. Bounced emails are immediately scored 0.

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | HTTP server port | 3847 |
| `CONTACT_HUNTER_EHLO_DOMAIN` | EHLO domain for SMTP | localhost |
| `CONTACT_HUNTER_DB_PATH` | SQLite cache path | ./contact-hunter.db |
| `BRAVE_API_KEY` | Brave Search API key | optional, falls back to DuckDuckGo lite |
| `GITHUB_TOKEN` | GitHub API token | (60 req/hr) |

## Tests

```bash
npm test
```

## License

MIT
