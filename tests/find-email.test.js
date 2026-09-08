import { test } from "node:test"
import assert from "node:assert/strict"
import { createContactHunter } from "../src/hunter.js"

// `find` melangeait deux choses tres differentes sous la meme forme de reponse :
// une adresse OBSERVEE quelque part, et une adresse FABRIQUEE a partir d'un
// gabarit prenom.nom@domaine. Rien dans la sortie ne disait laquelle.

function hunter(opts = {}) {
  return createContactHunter({
    analyzeDomainFn: async () => ({ provider: "google_workspace", isCatchAll: null, mxRecords: [] }),
    enableRateLimit: false,
    ...opts,
  })
}

test("un catch-all indetermine ne vaut pas une verification", async () => {
  // Regression introduite par le tri-etat : `!smtp.catchAll` est vrai quand
  // catchAll vaut null, donc une adresse inventee passait pour verifiee a 95.
  const r = await hunter({
    verifySmtpFn: async () => ({ valid: true, catchAll: null, reason: "accepted_catch_all_unknown" }),
  }).findEmail("exemple.com", "Personne Inexistante")

  assert.notEqual(r.confidence, 95, "une acceptation sans sonde concluante n'est pas une preuve")
  assert.equal(r.verified, false)
})

test("une adresse rejetee par SMTP n'est pas verifiee", async () => {
  const r = await hunter({
    verifySmtpFn: async () => ({ valid: false, catchAll: false, reason: "smtp_rejected" }),
  }).findEmail("exemple.com", "Personne Inexistante")

  assert.equal(r.verified, false)
})

test("une adresse acceptee sur un domaine non catch-all est verifiee", async () => {
  const r = await hunter({
    verifySmtpFn: async () => ({ valid: true, catchAll: false, reason: "smtp_accepted" }),
  }).findEmail("exemple.com", "Alice Martin")

  assert.equal(r.verified, true)
  assert.equal(r.confidence, 95)
})

test("la reponse dit d'ou vient l'adresse", async () => {
  // Sonde non concluante : le candidat survit, et doit s'annoncer comme fabrique.
  const r = await hunter({
    verifySmtpFn: async () => ({ valid: true, catchAll: null, reason: "accepted_catch_all_unknown" }),
  }).findEmail("exemple.com", "Alice Martin")

  assert.equal(r.source, "pattern", "une adresse fabriquee doit se declarer telle")
  assert.equal(r.verified, false)
})

test("une adresse observee sur le web se declare observee", async () => {
  // Une adresse CONSTATEE bat un gabarit : web_scrape 70 contre pattern 40.
  const r = await hunter({
    extractWebEmailsFn: async () => ({ emails: [{ email: "contact@exemple.com" }] }),
    verifySmtpFn: async () => ({ valid: true, catchAll: true, reason: "catch_all" }),
  }).findEmail("exemple.com", "Alice Martin")

  assert.equal(r.email, "contact@exemple.com")
  assert.equal(r.source, "web_scrape")
  assert.equal(r.smtpInformative, false)
})

test("un gabarit ne corrobore pas la source qui l'a verifie", async () => {
  // pattern + smtp_verify donnait 98 : le gabarit qui a fabrique l'adresse
  // comptait comme second temoin et poussait au-dessus du plafond SMTP.
  const { computeConfidence } = await import("../src/confidence-scorer.js")
  assert.equal(computeConfidence([{ source: "pattern" }, { source: "smtp_verify" }]).score, 95)
  assert.equal(computeConfidence([{ source: "web_scrape" }, { source: "smtp_verify" }]).score, 98)
})

test("une adresse explicitement rejetee par le serveur n'est pas proposee", async () => {
  // Controle reel du 2026-09-09 : gmail.com rejette zzqx.nexistepas@gmail.com
  // (undeliverable, 0), et `find` la rendait quand meme a 40.
  const teste = []
  const r = await hunter({
    verifySmtpFn: async (email) => {
      teste.push(email)
      return { valid: false, catchAll: false, reason: "smtp_rejected" }
    },
  }).findEmail("exemple.com", "Zzqx Nexistepas")

  assert.ok(teste.length > 0, "des candidats doivent avoir ete testes")
  assert.ok(!teste.includes(r.email), "l'adresse rendue ne doit pas etre une de celles rejetees")
})

test("tout rejete et rien d'autre : le resultat est vide, pas un pis-aller", async () => {
  const r = await hunter({
    generatePatternsFn: () => ["a@exemple.com", "b@exemple.com"],
    verifySmtpFn: async () => ({ valid: false, catchAll: false, reason: "smtp_rejected" }),
  }).findEmail("exemple.com", "Zzqx Nexistepas")

  assert.equal(r.email, null)
  assert.equal(r.confidence, 0)
})

test("sur un domaine accept-all, on ne gaspille pas les sondes SMTP", async () => {
  // Le serveur accepte tout : chaque appel supplementaire coute et n'apprend rien.
  // L'ancienne version en depensait cinq avant de rendre un gabarit non verifie.
  let appels = 0
  const r = await hunter({
    generatePatternsFn: () => ["a@x.com", "b@x.com", "c@x.com", "d@x.com", "e@x.com"],
    verifySmtpFn: async () => {
      appels++
      return { valid: true, catchAll: true, reason: "catch_all" }
    },
  }).findEmail("x.com", "Alice Martin")

  assert.equal(appels, 1, "une sonde suffit a etablir que le domaine n'est pas discriminant")
  assert.equal(r.verified, false)
  assert.equal(r.smtpInformative, false)
})

test("sur un domaine discriminant, on teste au-dela des cinq premiers", async () => {
  // Chaque appel y est decisif : s'arreter a cinq laissait la bonne adresse
  // non testee et rendait un gabarit au hasard.
  const motifs = ["a@x.com", "b@x.com", "c@x.com", "d@x.com", "e@x.com", "f@x.com", "bonne@x.com"]
  const r = await hunter({
    generatePatternsFn: () => motifs,
    verifySmtpFn: async (email) => ({
      valid: email === "bonne@x.com",
      catchAll: false,
      reason: email === "bonne@x.com" ? "smtp_accepted" : "smtp_rejected",
    }),
  }).findEmail("x.com", "Alice Martin")

  assert.equal(r.email, "bonne@x.com")
  assert.equal(r.verified, true)
})
