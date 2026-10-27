# Security

## Reporting a vulnerability

Email **security@spiffyvault.net**. Please do not open a public issue for a
security problem.

We reply within **48 hours** to say we have your report, and then keep you
told as we work on it. Tell us:

- what you found and where (package, file, version or commit);
- how to reproduce it, and what an attacker gains;
- whether you want to be credited, and under what name.

We fix what affects funds or keys first, and publish an advisory once a
fixed version is out. Please give us a reasonable time to fix a problem
before you disclose it.

## Scope

- `@spiffyvault/payments` and `@spiffyvault/sign-in` (this repository).
  `@spiffyvault/payments/internal` is in scope too, though it is not a
  stable API.
- The protocols they share with the SpiffyVault app: payment links and
  domain files, live payments over libp2p, offline payments sealed to a
  Ricochet mailbox, PeerPay, and SpiffyVault sign-in.

The SpiffyVault apps themselves are reported the same way.

Testnet only for now. The cryptography had an outside review in October
2026, and the fixes from it are not yet re-checked by the reviewer, so do
not use the SDK for mainnet funds yet.
