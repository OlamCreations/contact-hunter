import dns from "node:dns/promises"
import crypto from "node:crypto"

const PROVIDER_PATTERNS = Object.freeze([
  { match: /google\.com|googlemail\.com/i, id: "google_workspace" },
  { match: /outlook\.com|microsoft\.com|office365/i, id: "microsoft_365" },
  { match: /zoho\.(com|eu|in)/i, id: "zoho" },
  { match: /protonmail\.(ch|com)|proton\.me/i, id: "protonmail" },
  { match: /ovh\.(net|com)/i, id: "ovh" },
  { match: /gandi\.net/i, id: "gandi" },
  { match: /mimecast/i, id: "mimecast" },
  { match: /barracuda/i, id: "barracuda" },
  { match: /mailgun/i, id: "mailgun" },
  { match: /sendgrid/i, id: "sendgrid" },
  { match: /amazonaws\.com|ses/i, id: "aws_ses" },
  { match: /yandex/i, id: "yandex" },
  { match: /ionos|1and1/i, id: "ionos" },
])

const DISPOSABLE_DOMAINS = new Set([
  "mailinator.com", "guerrillamail.com", "tempmail.com", "throwaway.email",
  "yopmail.com", "sharklasers.com", "trashmail.com", "10minutemail.com",
  "dispostable.com", "fakeinbox.com", "maildrop.cc", "temp-mail.org",
])

function normalizeDomain(raw) {
  return String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/.*$/, "")
    .replace(/^@+/, "")
}

export function identifyProvider(mxRecords) {
  if (!Array.isArray(mxRecords) || mxRecords.length === 0) return "unknown"

  const exchanges = mxRecords.map((r) => String(r.exchange || "").toLowerCase())

  for (const { match, id } of PROVIDER_PATTERNS) {
    if (exchanges.some((ex) => match.test(ex))) return id
  }

  return "self_hosted"
}

export function parseSpfRecord(txtRecords) {
  if (!Array.isArray(txtRecords) || txtRecords.length === 0) return null

  const flat = txtRecords.map((r) => (Array.isArray(r) ? r.join("") : String(r)))
  const spfLine = flat.find((line) => line.toLowerCase().startsWith("v=spf1"))

  if (!spfLine) return null

  const tokens = spfLine.split(/\s+/).slice(1)

  const includes = tokens
    .filter((t) => t.startsWith("include:"))
    .map((t) => t.replace("include:", ""))

  const mechanisms = tokens.filter(
    (t) => !t.startsWith("include:") && !t.startsWith("v=") && !/^[~+?-]?all$/i.test(t)
  )

  const allToken = tokens.find((t) => /^[~+?-]?all$/i.test(t)) || ""
  const allMap = { "-all": "fail", "~all": "softfail", "+all": "pass", "?all": "neutral", all: "neutral" }
  const all = allMap[allToken.toLowerCase()] || "neutral"

  return Object.freeze({ includes, mechanisms, all })
}

export async function detectCatchAll(domain, mxHost, deps = {}) {
  try {
    const randomLocal = crypto.randomUUID().replace(/-/g, "").slice(0, 16)
    const randomEmail = `${randomLocal}@${normalizeDomain(domain)}`

    const check = typeof deps.smtpCheck === "function"
      ? deps.smtpCheck
      : async () => ({ accepted: false, responseCode: 550 })

    const result = await check(randomEmail, mxHost)
    return result.accepted === true && result.responseCode === 250
  } catch {
    return false
  }
}

export async function analyzeDomain(rawDomain, deps = {}) {
  const domain = normalizeDomain(rawDomain)

  if (!domain) {
    return Object.freeze({
      domain: "",
      mxRecords: [],
      provider: "unknown",
      spfRecord: null,
      isCatchAll: false,
      isDisposable: false,
    })
  }

  const resolverMx = deps.resolveMx || ((d) => dns.resolveMx(d))
  const resolverTxt = deps.resolveTxt || ((d) => dns.resolveTxt(d))
  const catchAllFn = deps.detectCatchAll || detectCatchAll

  let mxRecords = []
  let txtRecords = []

  try {
    mxRecords = await resolverMx(domain)
    mxRecords = Array.isArray(mxRecords)
      ? [...mxRecords].sort((a, b) => (a.priority || 0) - (b.priority || 0))
      : []
  } catch {
    mxRecords = []
  }

  try {
    txtRecords = await resolverTxt(domain)
  } catch {
    txtRecords = []
  }

  const provider = identifyProvider(mxRecords)
  const spfRecord = parseSpfRecord(txtRecords)
  const isDisposable = DISPOSABLE_DOMAINS.has(domain)

  let isCatchAll = false
  if (mxRecords.length > 0) {
    const primaryMx = mxRecords[0].exchange
    isCatchAll = await catchAllFn(domain, primaryMx, deps)
  }

  return Object.freeze({
    domain,
    mxRecords,
    provider,
    spfRecord,
    isCatchAll,
    isDisposable,
  })
}
