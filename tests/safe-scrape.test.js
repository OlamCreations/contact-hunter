import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { safeScrape } from "../src/safe-scrape.js"

// A fake server: one URL redirects, the next one holds the body. Nothing here
// touches the network, so the test measures the redirect logic and only that.
function serveur(routes) {
  const vus = []
  const fetchFn = async (url) => {
    vus.push(url)
    // `new URL(location, current)` normalise et ajoute une barre finale sur une
    // racine : « https://www.shop.example » devient « .../ ». Sans cette
    // tolerance, le faux serveur rendait 404 et le test accusait le code d'un
    // defaut qui etait le sien.
    const r = routes[url] || routes[url.replace(/\/$/, "")] || routes[url + "/"]
    if (!r) return reponse(404, "")
    return reponse(r.status, r.body || "", r.location)
  }
  return { fetchFn, vus }
}

function memeUrl(a, b) {
  return a.replace(/\/$/, "") === b.replace(/\/$/, "")
}

function reponse(status, body, location) {
  return {
    status,
    headers: { get: (k) => (k.toLowerCase() === "location" ? location || null : null) },
    text: async () => body,
  }
}

const passe = async () => "ok" // validateUrl sans DNS

describe("safeScrape", () => {
  // Le defaut d'origine : `redirect: "manual"` sans suivre le saut. Un 301 rend
  // un corps VIDE, et 301 satisfait le test `status >= 200 && status < 400` de
  // l'appelant — une page vide passait donc pour une page lue, sans qu'aucune
  // erreur ne soit levee. Mesure sur un domaine reel : manual -> 301, 0 octet ;
  // en suivant -> 200, 1 994 719 octets.
  it("lit le corps derriere une redirection 301", async () => {
    const { fetchFn, vus } = serveur({
      "https://shop.example": { status: 301, location: "https://www.shop.example" },
      "https://www.shop.example": { status: 200, body: "hello@shop.example" },
    })
    const out = await safeScrape("https://shop.example", {}, { fetch: fetchFn, validateUrl: passe })
    assert.equal(out.status, 200)
    assert.match(out.text, /hello@shop\.example/)
    assert.equal(vus.length, 2, "deux pages doivent etre demandees, pas une")
    assert.ok(memeUrl(vus[0], "https://shop.example"))
    assert.ok(memeUrl(vus[1], "https://www.shop.example"),
              "la deuxieme page demandee doit etre la cible de la redirection : " + vus[1])
  })

  it("suit une redirection relative", async () => {
    const { fetchFn } = serveur({
      "https://shop.example/a": { status: 302, location: "/b" },
      "https://shop.example/b": { status: 200, body: "sur b" },
    })
    const out = await safeScrape("https://shop.example/a", {}, { fetch: fetchFn, validateUrl: passe })
    assert.equal(out.text, "sur b")
  })

  // La protection SSRF etait la RAISON du « manual ». Elle doit survivre au
  // correctif : chaque saut repasse par validateUrl, donc une redirection vers
  // une adresse privee reste bloquee.
  it("revalide chaque saut et bloque une redirection vers une adresse privee", async () => {
    const { fetchFn, vus } = serveur({
      "https://shop.example": { status: 301, location: "http://169.254.169.254/latest" },
      "http://169.254.169.254/latest": { status: 200, body: "SECRET" },
    })
    const check = async (u) => {
      if (u.includes("169.254.169.254")) throw new Error("blocked")
      return u
    }
    const out = await safeScrape("https://shop.example", {}, { fetch: fetchFn, validateUrl: check })
    assert.equal(out.text, "", "le corps derriere une redirection bloquee ne doit pas sortir")
    assert.ok(!vus.includes("http://169.254.169.254/latest"),
              "l'adresse privee a ete appelee malgre le blocage")
  })

  it("s'arrete apres un nombre borne de sauts plutot que de boucler", async () => {
    const { fetchFn, vus } = serveur({
      "https://boucle.example": { status: 301, location: "https://boucle.example" },
    })
    const out = await safeScrape("https://boucle.example", {}, { fetch: fetchFn, validateUrl: passe })
    assert.equal(out.status, 0)
    assert.ok(vus.length <= 7, "trop de sauts suivis : " + vus.length)
  })

  // Controle de cassure : on rejoue le comportement d'ORIGINE (s'arreter au
  // premier saut) et on exige que le premier test tombe. Sans ce controle, on
  // ne saurait pas si les assertions ci-dessus mesurent la correction ou si
  // elles passeraient de toute facon.
  it("le test peut echouer : l'ancien comportement ne passe pas", async () => {
    const { fetchFn } = serveur({
      "https://shop.example": { status: 301, location: "https://www.shop.example" },
      "https://www.shop.example": { status: 200, body: "hello@shop.example" },
    })
    const ancien = async (url) => {
      const r = await fetchFn(url)
      return { text: await r.text(), status: r.status }
    }
    const out = await ancien("https://shop.example")
    assert.equal(out.text, "", "l'ancien comportement rendait bien un corps vide")
    assert.equal(out.status, 301, "et un 301, que l'appelant prenait pour un succes")
  })
})
