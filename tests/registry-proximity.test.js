import { test } from "node:test"
import assert from "node:assert/strict"
import { extractPhoneNumbers } from "../src/company-registry.js"

// Mesure du 2026-09-09 sur societe.com/societe/similarweb-france-sas-842296253.html :
// 171 836 caracteres, la cible nommee a l'octet 99, 28 numeros francais dont le plus
// proche a 4 112 caracteres. Aucun n'est le telephone de l'entreprise : ce sont les
// numeros du site, des encarts et des « entreprises similaires ».
const PAGE = "SIMILARWEB FRANCE SAS - SIREN 842 296 253"
  + " ".repeat(4000)
  + "Nos conseillers au 01 71 97 34 59"
  + " ".repeat(2000)
  + "Entreprises similaires : 01 84 88 12 00"

const FICHE = "SIMILARWEB FRANCE SAS - SIREN 842 296 253\nTelephone : 01 88 55 12 34\n"

test("un numero eloigne de la mention de l'entite n'est pas son numero", () => {
  const r = extractPhoneNumbers(PAGE, { near: "similarweb", window: 600 })
  assert.deepEqual(r, [], "le mobilier de page ne doit pas devenir un contact")
})

test("un numero etiquete, proche de la mention, est retenu", () => {
  const r = extractPhoneNumbers(FICHE, { near: "similarweb", window: 600 })
  assert.deepEqual(r, ["01 88 55 12 34"])
})

test("sans option de proximite le comportement historique est conserve", () => {
  assert.deepEqual(extractPhoneNumbers("01 71 97 34 59 et 01.71.97.34.59"), ["01 71 97 34 59"])
})

test("un numero proche mais sans etiquette de contact est ecarte", () => {
  const brut = "SIMILARWEB FRANCE SAS 842 296 253 voisin 01 22 33 44 55"
  assert.deepEqual(extractPhoneNumbers(brut, { near: "similarweb", window: 600 }), [])
})
