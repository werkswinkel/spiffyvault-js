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
  anchorContextHex: '6f7665726e6f64652f6f66666c696e652d7061796d656e74730013971d98bfd539b3bde392780a350233ccab545bdbd9251969ed57493d9358e400000000',
  anchorPayloadSha256: '002938787b20f003a3bc3f5047ea461caf153545e2e31ce45d7de8e7cb589601',
  anchorRecordJson: '{"peerId":"12D3KooWB8qZaSUhyN7xY9fEafpCfrpPsknzGzsLrKgHbcjrpCgT","identityPublicKey":"13971d98bfd539b3bde392780a350233ccab545bdbd9251969ed57493d9358e4","anchorPublicKey":"0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798","anchorContextHex":"6f7665726e6f64652f6f66666c696e652d7061796d656e74730013971d98bfd539b3bde392780a350233ccab545bdbd9251969ed57493d9358e400000000","epoch":0,"networkType":"test","timestamp":1760000000000,"version":2,"signature":"e82e083355455859a8c2761f0d35d900be7d75a3400ec98d714e9038c42d096277953b346e21e0c91db0a9766fc7b8ae35800660f8ef661777c1a7c0dfd9380f"}',
  frameAck: '4f4e01010000000e7b2274797065223a2261636b227d'
} as const
