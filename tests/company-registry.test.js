import { test } from "node:test"
import assert from "node:assert/strict"
import { searchFrenchRegistry, extractPhoneNumbers, extractSiren } from "../src/company-registry.js"

// Une page de registre qui ne parle PAS de la cible. Cas reel du 2026-09-08 :
// `discover similarweb.com` a rendu 9 fixes francais a confiance 78, mines sur des
// pages pappers.fr qui ne mentionnaient nulle part Similarweb.
const PAGE_ETRANGERE = `
  BOULANGERIE DUPONT SAS - SIREN : 812 345 678
  Telephone : 01 71 97 34 59
  Contact : contact@boulangerie-dupont.fr
`
const PAGE_CIBLE = `
  SIMILARWEB FRANCE SARL - SIREN : 799 123 456
  Telephone : 01 84 88 12 00
  Contact : france@similarweb.com
`

function deps(pageText) {
  return {
    searchFn: async () => ({ results: [{ url: "https://www.pappers.fr/entreprise/xyz" }] }),
    scrape: async () => ({ text: pageText, status: 200 }),
  }
}

test("une page de registre qui ne nomme pas la cible ne produit aucun contact", async () => {
  const r = await searchFrenchRegistry("similarweb.com", deps(PAGE_ETRANGERE))
  assert.deepEqual(r.phones, [], "aucun telephone ne doit sortir d'une page hors sujet")
  assert.deepEqual(r.emails, [], "aucun email ne doit sortir d'une page hors sujet")
  assert.equal(r.entityMatched, false)
})

test("une page de registre qui nomme la cible produit ses contacts", async () => {
  const r = await searchFrenchRegistry("similarweb.com", deps(PAGE_CIBLE))
  assert.equal(r.entityMatched, true)
  assert.ok(r.phones.includes("0184881200"), "le telephone de la page cible doit sortir")
  assert.ok(r.emails.includes("france@similarweb.com"))
})

test("le resultat declare sa juridiction", async () => {
  const r = await searchFrenchRegistry("similarweb.com", deps(PAGE_CIBLE))
  assert.equal(r.jurisdiction, "FR", "ce canal ne couvre que les registres francais")
})

test("un SIREN etiquete est extrait", () => {
  assert.equal(extractSiren("SIREN : 812 345 678"), "812345678")
})

test("les numeros sont dedupliques quel que soit le formatage", () => {
  assert.deepEqual(extractPhoneNumbers("01 71 97 34 59 et 01.71.97.34.59"), ["01 71 97 34 59"])
})
