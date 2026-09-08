import { test } from "node:test"
import assert from "node:assert/strict"
import { detectCatchAll } from "../src/dns-intel.js"
import { verifyEmailSmtp } from "../src/smtp-verifier.js"

// Mesure du 2026-09-09, dialogue SMTP reel avec aspmx.l.google.com :
//   RCPT TO:<zzq-nexistepas-8412@similarweb.com>  ->  250 2.1.5 OK
// Le domaine accepte n'importe quel destinataire. `verify` rendait pourtant
// "deliverable, 95" sur cette adresse inventee, parce que la detection catch-all
// n'etait jamais branchee : son `smtpCheck` par defaut rendait un 550 ecrit en dur.

const ACCEPTE_TOUT = async () => ({ accepted: true, responseCode: 250, greylisted: false, error: null })
const REJETTE = async (_mx, _ehlo, email) => ({
  accepted: email === "vrai@exemple.com",
  responseCode: email === "vrai@exemple.com" ? 250 : 550,
  greylisted: false, error: null,
})

test("une sonde impossible ne vaut pas un non", async () => {
  // Sans moyen de sonder, la reponse honnete est « je ne sais pas ».
  const r = await detectCatchAll("exemple.com", "mx.exemple.com", {})
  assert.equal(r, null, "l'absence de sonde ne doit pas se lire comme absence de catch-all")
})

test("un domaine qui accepte une adresse aleatoire est detecte accept-all", async () => {
  const r = await detectCatchAll("exemple.com", "mx.exemple.com", {
    smtpCheck: async () => ({ accepted: true, responseCode: 250 }),
  })
  assert.equal(r, true)
})

test("verify sonde le catch-all de lui-meme, sans qu'on le lui demande", async () => {
  const r = await verifyEmailSmtp("nexistepas@exemple.com", {
    resolveMx: async () => [{ exchange: "mx.exemple.com", priority: 10 }],
    validateMxHost: async () => true,
    smtpHandshake: ACCEPTE_TOUT,
  })
  assert.equal(r.catchAll, true, "le domaine accepte tout : aucune adresse n'y est verifiable")
  assert.equal(r.reason, "catch_all")
})

test("un domaine qui rejette les inconnus reste verifiable", async () => {
  const r = await verifyEmailSmtp("vrai@exemple.com", {
    resolveMx: async () => [{ exchange: "mx.exemple.com", priority: 10 }],
    validateMxHost: async () => true,
    smtpHandshake: REJETTE,
  })
  assert.equal(r.catchAll, false)
  assert.equal(r.valid, true)
  assert.equal(r.reason, "smtp_accepted")
})

test("catch-all indetermine : le resultat ne se donne pas pour certain", async () => {
  const r = await verifyEmailSmtp("qui@exemple.com", {
    resolveMx: async () => [{ exchange: "mx.exemple.com", priority: 10 }],
    validateMxHost: async () => true,
    smtpHandshake: async () => ({ accepted: true, responseCode: 250, greylisted: false, error: null }),
    detectCatchAll: async () => null,
  })
  assert.equal(r.catchAll, null)
  assert.equal(r.reason, "accepted_catch_all_unknown")
})
