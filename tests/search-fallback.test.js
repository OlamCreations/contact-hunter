import { test } from "node:test"
import assert from "node:assert/strict"
import { parseLiteResults, searchDuckDuckGo } from "../src/search-fallback.js"

// Forme reelle de lite.duckduckgo.com mesuree le 2026-09-09 : des ancres href
// absolues, melangees aux liens du moteur lui-meme.
const PAGE = `
<a href="https://duckduckgo.com/settings">Settings</a>
<a href="https://www.pappers.fr/entreprise/similarweb-france-sas-842296253">SIMILARWEB FRANCE SAS</a>
<a href="https://www.pappers.fr/entreprise/similarweb-france-sas-842296253">doublon</a>
<a href="https://www.societe.com/societe/similarweb-france-sas-842296253.html">Societe.com</a>
`

test("les liens du moteur ne sont pas des resultats", () => {
  const r = parseLiteResults(PAGE)
  assert.ok(!r.some((x) => x.url.includes("duckduckgo.com")))
})

test("les resultats sont dedupliques et titres", () => {
  const r = parseLiteResults(PAGE)
  assert.equal(r.length, 2)
  assert.equal(r[0].url, "https://www.pappers.fr/entreprise/similarweb-france-sas-842296253")
  assert.equal(r[0].title, "SIMILARWEB FRANCE SAS")
})

test("count borne le nombre de resultats", () => {
  assert.equal(parseLiteResults(PAGE, 1).length, 1)
})

test("un HTTP en echec remonte comme erreur, pas comme web vide", async () => {
  const r = await searchDuckDuckGo({ query: "x" }, {
    fetch: async () => ({ ok: false, status: 429, text: async () => "" }),
  })
  assert.deepEqual(r.results, [])
  assert.equal(r.error, "http_429")
})

test("une reponse valide rend des resultats sans erreur", async () => {
  const r = await searchDuckDuckGo({ query: "x" }, {
    fetch: async () => ({ ok: true, status: 200, text: async () => PAGE }),
  })
  assert.equal(r.error, null)
  assert.equal(r.results.length, 2)
})
