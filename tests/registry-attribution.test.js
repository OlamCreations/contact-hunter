import { test } from "node:test"
import assert from "node:assert/strict"
import { searchFrenchRegistry, scrapeMentionsLegales, isLegalNoticeUrl } from "../src/company-registry.js"

// Mesures du 2026-09-09 sur le chemin `discover similarweb.com`.

test("une recherche en echec n'est pas une absence de registre", async () => {
  // Brave a rendu HTTP 429 sur les trois requetes du canal. Le code a conclu
  // "aucun enregistrement", alors qu'une passe plus lente trouvait le SIREN
  // 842296253. Un canal muet doit le dire, pas rendre un verdict.
  const r = await searchFrenchRegistry("similarweb.com", {
    searchFn: async () => ({ results: [], error: "http_429" }),
    scrape: async () => ({ text: "", status: 0 }),
  })
  assert.equal(r.searchError, "http_429")
  assert.equal(r.entityMatched, false)
  assert.equal(r.conclusive, false, "sans recherche, le canal ne conclut rien")
})

test("une recherche vide mais reussie conclut", async () => {
  const r = await searchFrenchRegistry("similarweb.com", {
    searchFn: async () => ({ results: [] }),
    scrape: async () => ({ text: "", status: 0 }),
  })
  assert.equal(r.searchError, null)
  assert.equal(r.conclusive, true)
})

test("une page de politique n'est pas une mention legale", () => {
  // /corp/legal/content-disclaimers/ contient "/legal" et passait le filtre.
  assert.equal(isLegalNoticeUrl("https://www.similarweb.com/corp/legal/content-disclaimers/"), false)
  assert.equal(isLegalNoticeUrl("https://exemple.fr/mentions-legales"), true)
  assert.equal(isLegalNoticeUrl("https://exemple.de/impressum/"), true)
})

test("les mentions legales n'extraient qu'un numero etiquete", async () => {
  // 0364084687 sortait d'une page de disclaimers, sans etiquette de contact.
  const brut = "Content disclaimers. Reference 0364084687 applies to all regions."
  const r = await scrapeMentionsLegales("https://x.fr/mentions-legales", {
    scrape: async () => ({ text: brut, status: 200 }),
  })
  assert.deepEqual(r.phones, [])

  const propre = "Mentions legales\nTelephone : 03 64 08 46 87\n"
  const r2 = await scrapeMentionsLegales("https://x.fr/mentions-legales", {
    scrape: async () => ({ text: propre, status: 200 }),
  })
  assert.deepEqual(r2.phones, ["03 64 08 46 87"])
})
