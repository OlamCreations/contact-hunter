const EMAIL_REGEX = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g

function normalizeDomain(raw) {
  return String(raw || "").trim().toLowerCase()
    .replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "")
}

function buildQueries(personName, domain) {
  const queries = []
  const d = normalizeDomain(domain)
  const name = String(personName || "").trim()

  if (name && d) {
    queries.push(`"${name}" email ${d}`)
    queries.push(`"${name}" "@${d}"`)
    queries.push(`"${name}" ${d} contact`)
  }

  if (d) {
    queries.push(`site:${d} email OR contact`)
    queries.push(`"@${d}" partnerships OR marketing`)
  }

  return queries
}

function extractEmailsFromSnippets(results) {
  const seen = new Set()
  const emails = []

  for (const r of results) {
    const text = `${r.title || ""} ${r.snippet || ""} ${r.url || ""}`
    const matches = text.match(EMAIL_REGEX) || []
    for (const email of matches) {
      const lower = email.toLowerCase()
      if (!seen.has(lower)) {
        seen.add(lower)
        emails.push({ email: lower, sourceUrl: r.url || "", snippet: r.snippet || "" })
      }
    }
  }

  return emails
}

export async function searchForEmail(personName, companyDomain, deps = {}) {
  const searchFn = deps.searchBraveWeb || deps.searchFn || (async () => ({ results: [] }))
  const d = normalizeDomain(companyDomain)

  if (!d) return Object.freeze({ emails: [], queriesUsed: [] })

  const queries = buildQueries(personName, d)
  const allEmails = []
  const queriesUsed = []

  for (const query of queries) {
    try {
      const response = await searchFn({ query, count: 10 })
      queriesUsed.push(query)

      const found = extractEmailsFromSnippets(response.results || [])
      for (const item of found) {
        if (!allEmails.some((e) => e.email === item.email)) {
          allEmails.push(item)
        }
      }

      if (allEmails.some((e) => e.email.endsWith(`@${d}`))) break
    } catch {
      // Search failed, try next query
    }
  }

  const sorted = allEmails.sort((a, b) => {
    const aMatch = a.email.endsWith(`@${d}`) ? 1 : 0
    const bMatch = b.email.endsWith(`@${d}`) ? 1 : 0
    return bMatch - aMatch
  })

  return Object.freeze({
    emails: sorted,
    queriesUsed,
  })
}

export { buildQueries, extractEmailsFromSnippets }
