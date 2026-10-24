/**
 * Payee domain files written by the SpiffyVault app (lib/services/payee_domain.dart).
 */

/** shop.spiffyvault.net's file, made by the app's Link a website screen on a real desktop identity (2026-10-24). */
export const SHOP_FILE = `{
  "version": 1,
  "payees": [
    {
      "peerId": "12D3KooWEu2TyREHzqYo2QadsCwghvko8Wd6RX2Mjooqbznoex7U",
      "paymentKey": "030efb1541e8a0f3acede33fd84173f6654e3c957edb45a81ccb1391f4f040f795",
      "networks": [
        "testnet"
      ],
      "name": "Fina Tey",
      "sig": "a4ef1166974e252a9da2eed53e35982e213c76600e5506338667fb8b93df0b475a02b7b67114c76d682ebfd7be7deabadb573679c468bd5ef2a52e9fad9ecb05"
    }
  ]
}`
export const SHOP_DOMAIN = 'shop.spiffyvault.net'
export const SHOP_PEER = '12D3KooWEu2TyREHzqYo2QadsCwghvko8Wd6RX2Mjooqbznoex7U'
export const SHOP_KEY = '030efb1541e8a0f3acede33fd84173f6654e3c957edb45a81ccb1391f4f040f795'

/**
 * PayeeDomain.entryFor(domain: 'shop.example', seed 32 × 0x07, key in upper
 * case, networks ['main', 'testnet'], name '  Corner   Shop '), as
 * PayeeDomain.fileText writes it. Ed25519 is deterministic, so the
 * library's own entry for the same input is this text exactly.
 */
export const DART_SEED7_FILE = `{
  "version": 1,
  "payees": [
    {
      "peerId": "12D3KooWRawPbxPtP1eZaJpumGnyWX2DcUyd3RQnydr3eAto4Az7",
      "paymentKey": "02a1633cafcc01ebfb6d78e39f687a1f0995c62fc95f51ead10a02ee0be551b5dc",
      "networks": [
        "mainnet",
        "testnet"
      ],
      "name": "Corner Shop",
      "sig": "e234dd23b03e497dad8ad73efbed5f1e5d75036bb2592097a476ee1afa4c7a70d973ff2fbb8b6d17711aed4b0eeb2094eddcf5b582072ec5c79af9cf5def0305"
    }
  ]
}`
