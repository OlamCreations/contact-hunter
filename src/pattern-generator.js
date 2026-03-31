function normalizePart(value) {
  return String(value || "").trim().toLowerCase()
}

function normalizeDomain(raw) {
  return normalizePart(raw)
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/.*$/, "")
    .replace(/^@+/, "")
}

function firstInitials(name) {
  const parts = name.split(/[-\s]+/)
  return parts.map((p) => p[0] || "").join("")
}

export const PATTERN_TEMPLATES = Object.freeze([
  { id: "first.last",     fn: (f, l) => `${f}.${l}` },
  { id: "first",           fn: (f) => f },
  { id: "flast",           fn: (f, l) => `${f[0]}${l}` },
  { id: "firstl",          fn: (f, l) => `${f}${l[0]}` },
  { id: "first_last",      fn: (f, l) => `${f}_${l}` },
  { id: "first-last",      fn: (f, l) => `${f}-${l}` },
  { id: "last.first",      fn: (f, l) => `${l}.${f}` },
  { id: "firstlast",       fn: (f, l) => `${f}${l}` },
  { id: "f.last",          fn: (f, l) => `${f[0]}.${l}` },
  { id: "last",            fn: (_, l) => l },
  { id: "first.l",         fn: (f, l) => `${f}.${l[0]}` },
  { id: "fl",              fn: (f, l) => `${f[0]}${l[0]}` },
  { id: "last.f",          fn: (f, l) => `${l}.${f[0]}` },
  { id: "lastfirst",       fn: (f, l) => `${l}${f}` },
  { id: "last_first",      fn: (f, l) => `${l}_${f}` },
  { id: "f_last",          fn: (f, l) => `${f[0]}_${l}` },
  { id: "last-first",      fn: (f, l) => `${l}-${f}` },
])

const GENERIC_LOCALS = ["contact", "info", "partnerships", "marketing", "hello", "team"]

export function generatePatterns(firstName, lastName, domain) {
  const f = normalizePart(firstName)
  const l = normalizePart(lastName)
  const d = normalizeDomain(domain)

  if (!f || !l || !d) return []

  const seen = new Set()
  const results = []

  for (const tmpl of PATTERN_TEMPLATES) {
    const local = tmpl.fn(f, l)
    const email = `${local}@${d}`
    if (!seen.has(email)) {
      seen.add(email)
      results.push(email)
    }
  }

  if (f.includes("-")) {
    const initials = firstInitials(f)
    const variants = [
      `${initials}${l}@${d}`,
      `${initials}.${l}@${d}`,
      `${f.replace(/-/g, "")}@${d}`,
      `${f.replace(/-/g, "")}.${l}@${d}`,
    ]
    for (const email of variants) {
      if (!seen.has(email)) {
        seen.add(email)
        results.push(email)
      }
    }
  }

  for (const local of GENERIC_LOCALS) {
    const email = `${local}@${d}`
    if (!seen.has(email)) {
      seen.add(email)
      results.push(email)
    }
  }

  return results
}

const PATTERN_DETECTORS = [
  { id: "first.last",  test: (local, f, l) => local === `${f}.${l}` },
  { id: "first",        test: (local, f) => local === f },
  { id: "flast",        test: (local, f, l) => local === `${f[0]}${l}` },
  { id: "firstl",       test: (local, f, l) => local === `${f}${l[0]}` },
  { id: "first_last",   test: (local, f, l) => local === `${f}_${l}` },
  { id: "last.first",   test: (local, f, l) => local === `${l}.${f}` },
  { id: "firstlast",    test: (local, f, l) => local === `${f}${l}` },
  { id: "f.last",       test: (local, f, l) => local === `${f[0]}.${l}` },
]

export function detectDomainPattern(knownEmails, domain, contacts) {
  if (!Array.isArray(knownEmails) || knownEmails.length < 2) return null

  const d = normalizeDomain(domain)
  const domainEmails = knownEmails
    .map((e) => normalizePart(e))
    .filter((e) => e.endsWith(`@${d}`))

  if (domainEmails.length < 2) return null

  if (Array.isArray(contacts) && contacts.length >= 2) {
    const votes = new Map()

    for (const contact of contacts) {
      const email = normalizePart(contact.email)
      const f = normalizePart(contact.firstName)
      const l = normalizePart(contact.lastName)
      if (!email || !f) continue

      const local = email.split("@")[0]

      for (const det of PATTERN_DETECTORS) {
        if (det.test(local, f, l || "")) {
          votes.set(det.id, (votes.get(det.id) || 0) + 1)
          break
        }
      }
    }

    if (votes.size === 0) return null

    const sorted = [...votes.entries()].sort((a, b) => b[1] - a[1])
    const [bestPattern, bestCount] = sorted[0]
    const total = contacts.length
    const confidence = Math.round((bestCount / total) * 100)

    if (confidence < 50) return sorted.length > 1 ? null : { pattern: bestPattern, confidence }
    return Object.freeze({ pattern: bestPattern, confidence })
  }

  const locals = domainEmails.map((e) => e.split("@")[0])

  const hasDot = locals.every((l) => l.includes("."))
  const hasUnderscore = locals.every((l) => l.includes("_"))
  const hasDash = locals.every((l) => l.includes("-"))
  const avgParts = locals.reduce((sum, l) => sum + l.split(/[._-]/).length, 0) / locals.length

  if (hasDot && avgParts >= 1.8) return Object.freeze({ pattern: "first.last", confidence: 85 })
  if (hasUnderscore && avgParts >= 1.8) return Object.freeze({ pattern: "first.last", confidence: 85 })
  if (hasDash && avgParts >= 1.8) return Object.freeze({ pattern: "first-last", confidence: 60 })

  return null
}

export function applyPattern(pattern, firstName, lastName, domain) {
  const f = normalizePart(firstName)
  const l = normalizePart(lastName)
  const d = normalizeDomain(domain)

  if (!f || !d) return null

  const tmpl = PATTERN_TEMPLATES.find((t) => t.id === pattern)
  if (!tmpl) return null

  return `${tmpl.fn(f, l || "")}@${d}`
}
