/**
 * GitHub Email Miner — Extract emails from public git commits.
 * Free: 60 req/hour without auth, 5000/hour with GITHUB_TOKEN.
 */

const GITHUB_API = "https://api.github.com"
const NOISE_EMAILS = new Set(["noreply@github.com", "users.noreply@github.com"])

async function defaultFetchJson(url) {
  const headers = { Accept: "application/vnd.github.v3+json", "User-Agent": "ContactHunter/1.0" }
  const token = process.env.GITHUB_TOKEN
  if (token) headers.Authorization = `Bearer ${token}`

  const response = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) })
  if (!response.ok) throw new Error(`GitHub API ${response.status}`)
  return response.json()
}

export async function searchGitHubUsers(personName, companyDomain, deps = {}) {
  const fetchJson = deps.fetchJson || defaultFetchJson
  const name = String(personName || "").trim()
  const domain = String(companyDomain || "").trim().toLowerCase()

  if (!name && !domain) return []

  const query = [name, domain].filter(Boolean).join("+")
  try {
    const data = await fetchJson(`${GITHUB_API}/search/users?q=${encodeURIComponent(query)}&per_page=5`)
    return Array.isArray(data.items) ? data.items : []
  } catch {
    return []
  }
}

export function extractEmailsFromEvents(events) {
  if (!Array.isArray(events)) return []

  const seen = new Set()
  const results = []

  for (const event of events) {
    if (event.type !== "PushEvent") continue
    const commits = event.payload?.commits || []

    for (const commit of commits) {
      const email = String(commit.author?.email || "").trim().toLowerCase()
      if (!email || seen.has(email)) continue
      if (NOISE_EMAILS.has(email)) continue
      if (email.includes("noreply")) continue

      seen.add(email)
      results.push({ email, name: commit.author?.name || null, source: "github_commit" })
    }
  }

  return results
}

export async function mineGitHubEmails(personName, companyDomain, deps = {}) {
  const fetchJson = deps.fetchJson || defaultFetchJson
  const domain = String(companyDomain || "").trim().toLowerCase()

  const users = await searchGitHubUsers(personName, companyDomain, deps)
  if (users.length === 0) return Object.freeze({ emails: [], users: [] })

  const allEmails = []

  for (const user of users.slice(0, 3)) {
    if (user.email && !user.email.includes("noreply")) {
      const profileEmail = user.email.toLowerCase()
      if (!allEmails.some((e) => e.email === profileEmail)) {
        allEmails.push({ email: profileEmail, name: user.name || user.login, source: "github_profile", repo: null })
      }
    }

    try {
      const events = await fetchJson(`${GITHUB_API}/users/${encodeURIComponent(user.login)}/events/public?per_page=30`)
      const extracted = extractEmailsFromEvents(Array.isArray(events) ? events : [])

      for (const item of extracted) {
        if (!allEmails.some((e) => e.email === item.email)) {
          allEmails.push({ ...item, repo: user.login })
        }
      }
    } catch { /* rate limited or private, skip */ }
  }

  const sorted = allEmails.sort((a, b) => {
    const aMatch = domain && a.email.endsWith(`@${domain}`) ? 1 : 0
    const bMatch = domain && b.email.endsWith(`@${domain}`) ? 1 : 0
    return bMatch - aMatch
  })

  return Object.freeze({ emails: sorted, users: users.map((u) => u.login) })
}
