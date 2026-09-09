import { test } from "node:test"
import assert from "node:assert/strict"
import { verifyEmailSmtp } from "../src/smtp-verifier.js"
import { createContactHunter } from "../src/hunter.js"

// Balayage du 2026-09-09 : 44 endroits ou une erreur est avalee en resultat vide.
// La plupart sont des sauts legitimes. Ceux-ci produisent une REPONSE FAUSSE.

test("une resolution DNS en echec n'est pas une absence de MX", async () => {
  // `catch { mxRecords = [] }` rendait reason "no_mx", donc valid false, donc
  // undeliverable : une panne DNS passagere declarait morte une adresse vivante.
  const r = await verifyEmailSmtp("qui@exemple.com", {
    resolveMx: async () => { throw new Error("ETIMEOUT") },
  })
  assert.equal(r.reason, "dns_error")
  assert.notEqual(r.reason, "no_mx")
})

test("un domaine reellement sans MX se distingue d'une panne", async () => {
  const r = await verifyEmailSmtp("qui@exemple.com", { resolveMx: async () => [] })
  assert.equal(r.reason, "no_mx")
})

test("une panne DNS ne se rend pas en undeliverable", async () => {
  const h = createContactHunter({
    verifySmtpFn: async () => ({ valid: false, catchAll: false, reason: "dns_error" }),
    enableRateLimit: false,
  })
  const r = await h.verifyEmail("qui@exemple.com")
  assert.equal(r.result, "unknown", "on ne sait pas, on ne dit pas mort")
})

test("find dit quels canaux n'ont pas pu tourner", async () => {
  // Si tous les canaux tombent, `find` rendait un gabarit sans que rien n'indique
  // qu'aucune source n'avait effectivement ete consultee.
  const h = createContactHunter({
    analyzeDomainFn: async () => ({ provider: "unknown", isCatchAll: null, mxRecords: [] }),
    extractWebEmailsFn: async () => { throw new Error("ECONNRESET") },
    searchEmailsFn: async () => { throw new Error("http_429") },
    githubMinerFn: async () => { throw new Error("rate_limited") },
    verifySmtpFn: async () => ({ valid: true, catchAll: null, reason: "accepted_catch_all_unknown" }),
    enableRateLimit: false,
  })
  const r = await h.findEmail("exemple.com", "Alice Martin")

  assert.ok(r.channels, "la reponse doit porter l'etat des canaux")
  assert.equal(r.channels.web_scrape, "error")
  assert.equal(r.channels.search_engine, "error")
  assert.equal(r.channels.github, "error")
})

test("un canal qui a tourne sans rien trouver se distingue d'un canal tombe", async () => {
  const h = createContactHunter({
    analyzeDomainFn: async () => ({ provider: "unknown", isCatchAll: null, mxRecords: [] }),
    extractWebEmailsFn: async () => ({ emails: [] }),
    verifySmtpFn: async () => ({ valid: true, catchAll: null, reason: "accepted_catch_all_unknown" }),
    enableRateLimit: false,
  })
  const r = await h.findEmail("exemple.com", "Alice Martin")
  assert.equal(r.channels.web_scrape, "ok")
})
