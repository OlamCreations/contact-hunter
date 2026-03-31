/**
 * Contact Hunter — Self-hosted multi-channel contact intelligence.
 *
 * Find verified business emails via SMTP verification, DNS intelligence,
 * web scraping, search mining, GitHub commits, YouTube about pages,
 * and company registries. Zero API cost.
 *
 * @example
 * import { createContactHunter } from 'contact-hunter'
 *
 * const hunter = createContactHunter()
 * const result = await hunter.findEmail('company.com', 'Alice Smith')
 * console.log(result)
 * // { email: 'alice.smith@company.com', confidence: 95, ... }
 */

export { createContactHunter, domainSearch, findEmail, verifyEmail } from "./hunter.js"
export { analyzeDomain, identifyProvider, parseSpfRecord } from "./dns-intel.js"
export { generatePatterns, detectDomainPattern, applyPattern, PATTERN_TEMPLATES } from "./pattern-generator.js"
export { verifyEmailSmtp, smtpHandshake, extractDomain, isPrivateIp, validateMxHost } from "./smtp-verifier.js"
export { computeConfidence, selectBestCandidate, SCORE_MATRIX } from "./confidence-scorer.js"
export { extractEmailsFromDomain, extractEmailsFromText, findContactPageUrls } from "./web-email-extractor.js"
export { searchForEmail } from "./search-email-miner.js"
export { mineGitHubEmails, searchGitHubUsers } from "./github-email-miner.js"
export { mineYouTubeEmail, extractBusinessEmail } from "./youtube-email-miner.js"
export { searchFrenchRegistry, extractPhoneNumbers, extractSiren } from "./company-registry.js"
export { createContactCache, SOURCE_TTL_DAYS } from "./contact-cache.js"
