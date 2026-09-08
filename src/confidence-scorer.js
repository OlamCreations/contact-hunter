const SCORE_MATRIX = Object.freeze({
  smtp_verify:       { base: 95, smtpBonus: 0,  decayPerMonth: 2 },
  company_registry:  { base: 80, smtpBonus: 10, decayPerMonth: 3 },
  web_scrape:        { base: 70, smtpBonus: 20, decayPerMonth: 5 },
  youtube:           { base: 65, smtpBonus: 20, decayPerMonth: 4 },
  github:            { base: 60, smtpBonus: 20, decayPerMonth: 5 },
  search_engine:     { base: 50, smtpBonus: 30, decayPerMonth: 8 },
  pattern:           { base: 40, smtpBonus: 40, decayPerMonth: 10 },
  linkedin:          { base: 35, smtpBonus: 45, decayPerMonth: 6 },
})

// Sources that generate a candidate rather than observe one. They can carry a
// score of their own, but they never corroborate another source.
const NON_OBSERVING_SOURCES = new Set(["pattern"])

const BOUNCE_PENALTY = -100

export function applyTemporalDecay(score, foundAt, now) {
  if (!foundAt) return score
  const foundDate = new Date(foundAt)
  const nowDate = now ? new Date(now) : new Date()
  const monthsElapsed = Math.max(0, (nowDate - foundDate) / (1000 * 60 * 60 * 24 * 30))
  return score - monthsElapsed
}

export function computeConfidence(signals, opts = {}) {
  if (!Array.isArray(signals) || signals.length === 0) {
    return Object.freeze({ score: 0, breakdown: {}, sources: 0 })
  }

  const now = opts.now || new Date().toISOString()
  const breakdown = {}
  let maxScore = 0

  for (const signal of signals) {
    if (!signal || !signal.source) continue

    if (signal.bounced) {
      return Object.freeze({ score: 0, breakdown: { bounce: BOUNCE_PENALTY }, sources: 1 })
    }

    const matrix = SCORE_MATRIX[signal.source]
    if (!matrix) continue

    let signalScore = matrix.base

    if (signal.smtpVerified && matrix.smtpBonus > 0) {
      signalScore += matrix.smtpBonus
    }

    const decayMonths = signal.foundAt
      ? Math.max(0, (new Date(now) - new Date(signal.foundAt)) / (1000 * 60 * 60 * 24 * 30))
      : 0
    const decay = decayMonths * matrix.decayPerMonth
    signalScore = Math.max(0, Math.round(signalScore - decay))

    breakdown[signal.source] = signalScore

    if (signalScore > maxScore) maxScore = signalScore
  }

  const sourceCount = Object.keys(breakdown).length
  // A generated pattern is not a witness: it is the hypothesis that produced the
  // candidate. Counting it as corroboration pushed an SMTP verification from 95
  // to 98, above the ceiling of the only source that proves anything.
  const observedCount = Object.keys(breakdown).filter((k) => !NON_OBSERVING_SOURCES.has(k)).length
  const corroborationBonus = observedCount >= 3 ? 5 : observedCount >= 2 ? 3 : 0
  const finalScore = Math.min(100, maxScore + corroborationBonus)

  return Object.freeze({
    score: finalScore,
    breakdown,
    sources: sourceCount,
    observedSources: observedCount,
  })
}

export function selectBestCandidate(candidates) {
  if (!Array.isArray(candidates) || candidates.length === 0) return null

  const scored = candidates
    .filter((c) => c && c.email)
    .map((c) => ({
      ...c,
      confidence: c.confidence ?? computeConfidence(c.signals || []).score,
    }))
    .sort((a, b) => b.confidence - a.confidence)

  return scored[0] || null
}

export { SCORE_MATRIX, NON_OBSERVING_SOURCES }
