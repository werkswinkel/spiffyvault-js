/**
 * Sign in with SpiffyVault, OIAP-v2 (SpiffyVault doc/sign-in.md). The site
 * side (SignInSite) and the challenge format; the page side is in
 * `@spiffyvault/sign-in/browser`.
 */

export {
  ChallengeError, MAX_AGE_SECONDS, VERSION, challengeJson, challengeLink, checkChallenge, checkSiteUrl, isLocalHost,
  parseChallengeLink, readChallenge, signedText
} from './challenge.ts'
export type { Challenge, Mode } from './challenge.ts'
export { siteKey, siteSeed, signChallenge, verifyResponse } from './keys.ts'
export type { SignInResponse } from './keys.ts'
export { MemoryStore, SignInSite } from './site.ts'
export type { CallbackReply, PendingSignIn, PollResult, SignInSiteOptions, SignInStore, Started } from './site.ts'
