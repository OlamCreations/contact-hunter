import net from "node:net"
import dns from "node:dns/promises"

const SMTP_TIMEOUT_MS = 10_000

export function extractDomain(email) {
  if (!email || typeof email !== "string") return ""
  const parts = String(email).trim().toLowerCase().split("@")
  return parts.length === 2 ? parts[1] : ""
}

function parseResponseCode(line) {
  const match = String(line || "").match(/^(\d{3})/)
  return match ? parseInt(match[1], 10) : 0
}

export async function smtpHandshake(mxHost, senderDomain, recipientEmail, deps = {}) {
  const netModule = deps.net || net

  return new Promise((resolve) => {
    let step = 0
    let resolved = false

    function finish(result) {
      if (resolved) return
      resolved = true
      resolve(result)
    }

    try {
      const socket = netModule.createConnection(25, mxHost)
      socket.setTimeout(SMTP_TIMEOUT_MS)

      const commands = [
        null,
        `EHLO ${senderDomain}\r\n`,
        `MAIL FROM:<verify@${senderDomain}>\r\n`,
        `RCPT TO:<${recipientEmail}>\r\n`,
        `QUIT\r\n`,
      ]

      socket.on("data", (data) => {
        const line = data.toString().trim()
        const code = parseResponseCode(line)

        if (step === 3) {
          const greylisted = code === 421 || code === 452
          socket.write(commands[4] || "QUIT\r\n")
          finish({
            accepted: code === 250 || code === 251,
            responseCode: code,
            response: line,
            greylisted,
            error: null,
          })
          return
        }

        step++
        if (step < commands.length && commands[step]) {
          socket.write(commands[step])
        }
      })

      socket.on("error", (err) => {
        finish({
          accepted: false,
          responseCode: 0,
          response: "",
          greylisted: false,
          error: err.message,
        })
      })

      socket.on("timeout", () => {
        socket.destroy()
        finish({
          accepted: false,
          responseCode: 0,
          response: "",
          greylisted: false,
          error: "timeout",
        })
      })

      socket.on("close", () => {
        finish({
          accepted: false,
          responseCode: 0,
          response: "",
          greylisted: false,
          error: "connection_closed",
        })
      })

      if (typeof socket.on === "function" && !socket._connected) {
        socket.on("connect", () => {})
      }
    } catch (err) {
      finish({
        accepted: false,
        responseCode: 0,
        response: "",
        greylisted: false,
        error: err.message,
      })
    }
  })
}

export async function verifyEmailSmtp(email, deps = {}) {
  const normalized = String(email || "").trim().toLowerCase()
  const domain = extractDomain(normalized)
  const ehloDomain = deps.ehloDomain || process.env.CONTACT_HUNTER_EHLO_DOMAIN || "localhost"

  if (!domain || !normalized.includes("@")) {
    return Object.freeze({
      email: normalized,
      valid: false,
      catchAll: false,
      reason: "invalid_format",
      mxHost: null,
      responseCode: 0,
    })
  }

  const resolveMxFn = deps.resolveMx || ((d) => dns.resolveMx(d))
  const handshakeFn = deps.smtpHandshake || smtpHandshake
  const catchAllFn = deps.detectCatchAll || (async () => false)

  let mxRecords
  try {
    mxRecords = await resolveMxFn(domain)
  } catch {
    mxRecords = []
  }

  if (!Array.isArray(mxRecords) || mxRecords.length === 0) {
    return Object.freeze({
      email: normalized,
      valid: false,
      catchAll: false,
      reason: "no_mx",
      mxHost: null,
      responseCode: 0,
    })
  }

  const sorted = [...mxRecords].sort((a, b) => (a.priority || 0) - (b.priority || 0))
  const primaryMx = sorted[0].exchange

  const isCatchAll = await catchAllFn(domain, primaryMx, deps)

  const result = await handshakeFn(primaryMx, ehloDomain, normalized, deps)

  if (result.error && !result.accepted) {
    return Object.freeze({
      email: normalized,
      valid: false,
      catchAll: false,
      reason: result.greylisted ? "greylisted" : "smtp_error",
      mxHost: primaryMx,
      responseCode: result.responseCode,
    })
  }

  if (result.greylisted) {
    return Object.freeze({
      email: normalized,
      valid: false,
      catchAll: false,
      reason: "greylisted",
      mxHost: primaryMx,
      responseCode: result.responseCode,
    })
  }

  if (isCatchAll && result.accepted) {
    return Object.freeze({
      email: normalized,
      valid: true,
      catchAll: true,
      reason: "catch_all",
      mxHost: primaryMx,
      responseCode: result.responseCode,
    })
  }

  return Object.freeze({
    email: normalized,
    valid: result.accepted,
    catchAll: false,
    reason: result.accepted ? "smtp_accepted" : "smtp_rejected",
    mxHost: primaryMx,
    responseCode: result.responseCode,
  })
}
