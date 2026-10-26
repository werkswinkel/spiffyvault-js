/**
 * The vectors of doc/payment-protocol.md, Appendix C, made by the app's
 * own classes (PaymentAnchorRecord) on 2026-10-23. The Signal values of
 * that appendix went with the old format; the peer-session vectors are
 * peer_sessions_v1.json.
 */
export const C = {
  phrase: 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
  pbkdf2Seed: '2ab0d25f38c3760aee8f065ce4a14767767074ecf2e5f9e2b836fcf2b70f8437',
  ed25519Public: '13971d98bfd539b3bde392780a350233ccab545bdbd9251969ed57493d9358e4',
  peerId: '12D3KooWB8qZaSUhyN7xY9fEafpCfrpPsknzGzsLrKgHbcjrpCgT',
  frameAck: '4f4e01010000000e7b2274797065223a2261636b227d'
} as const
