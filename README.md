# VeriDegree

Instant, forgery-proof credential verification.

Accredited institutions can issue academic credentials on-chain. Each
credential stores a hash of the certificate and links it to the student's
wallet address. Anyone can verify a credential's authenticity and validity
without contacting the issuing institution, and the contract never handles
Ether.

## Folder structure

```
veridegree/
├── contracts/
│   └── VeriDegree.sol       Smart contract
├── test/
│   └── VeriDegree.test.js   Hardhat + Chai test suite
├── scripts/
│   └── deploy.js            Deployment script
├── hardhat.config.js
├── package.json
└── README.md
```

## Setup

```bash
npm install
```

## Run tests

```bash
npx hardhat test
```

## Deploy to Sepolia

Create a local `.env` file if needed for deployment; do not commit it.

```env
SEPOLIA_RPC_URL=your_rpc_url
PRIVATE_KEY=your_private_key
ADMIN_A=0x...
ADMIN_B=0x...
ADMIN_C=0x...
```

`ADMIN_A`, `ADMIN_B`, and `ADMIN_C` must be three distinct, non-zero
addresses. They become the 2-of-3 admin multisig at deployment and cannot be
changed afterward. If you omit them, the deploy script falls back to the
first three local Hardhat signers. That works for a local demo, but it is not
appropriate for a real production deployment.

Then run:

```bash
npm run deploy:sepolia
```

## Admin model: 2-of-3 multisig

There is no single owner key. Three admin addresses are set when the contract
is deployed, and any 2 of the 3 must confirm a critical administrative action
before it takes effect. The following actions require this guardrail:

- `addInstitution`
- `removeInstitution`
- `setInstitutionName`
- emergency/global `revokeCredential` (see below)

The flow is simple: propose → confirm → auto-execute.

1. An admin calls `proposeAdminAction(data)`, where `data` is the ABI-encoded
   calldata for one of the functions above (for example,
   `veriDegree.interface.encodeFunctionData("addInstitution", [addr])`).
   This also counts as that admin's own confirmation.
2. A second, different admin calls `confirmAdminAction(proposalId)`.
3. Once 2 confirmations are reached, the contract executes the action itself.
   There is no separate "execute" step.

This rule applies only to **admin** actions. It does not interfere with an
approved institution's normal work: issuing a credential, revoking a
credential it issued, or recovering a student's wallet all happen in a single
transaction with no multisig involved. If one admin key is lost, the system
still keeps working because the other two admins can act together.

## Contract summary

**State**
- `admins` / `isAdmin` — the 3 fixed admin addresses and the lookup for them
- `nextProposalId`, `proposals`, `hasConfirmed` — the admin proposal queue
- `approvedInstitutions` — addresses allowed to issue credentials
- `institutionNames` — optional display names for institution addresses; this is metadata only and not a trust signal
- `credentials` — all issued credentials, keyed by ID
- `studentCredentials` — credential IDs associated with each student

**Functions**

| Function | Who can call it |
| --- | --- |
| `proposeAdminAction(bytes)` | any admin |
| `confirmAdminAction(uint256)` | any admin |
| `addInstitution(address)` | 2-of-3 admins via the multisig only |
| `removeInstitution(address)` | 2-of-3 admins via the multisig only |
| `setInstitutionName(address, string)` | 2-of-3 admins via the multisig only |
| `issueCredential(bytes32, address)` | approved institutions directly |
| `revokeCredential(uint256)` | the issuing institution directly, or 2-of-3 admins via the multisig |
| `updateCredentialStudent(uint256, address)` | the issuing institution only, directly |
| `verifyCredential(uint256)` | anyone (view) |
| `getStudentCredentials(address)` | anyone (view) |

**Invariants**
- Only an approved institution can issue a credential.
- A credential's hash and institution never change after issuance; its student address can only be changed via `updateCredentialStudent` by that credential's own issuer.
- No admin action (`addInstitution`, `removeInstitution`, `setInstitutionName`, or an admin-triggered `revokeCredential`) takes effect without 2 confirmations from 3 distinct, fixed admin addresses.
- No single admin can call an admin-only function directly.
- Revocation is one-way — a revoked credential cannot become valid again.
- A revoked credential's student wallet can no longer be updated.
- No institution can revoke or modify another institution's credential.
- The contract cannot hold or move Ether — no `payable`, no `receive`, and no `fallback`.

## Limitations and mitigations

This section explains the real-world limits of the design and how the system
responds to them. None of these are fully "solved"; instead, each risk is
acknowledged and managed transparently.

**1. Trust in institution-submitted data.** The blockchain can prove that a
credential record has not been altered since issuance, but it cannot prove that
the institution's original information was truthful. *Mitigation:* only
addresses approved by the 2-of-3 admin multisig can issue credentials at all.
Institutional legitimacy is an off-chain trust decision the admins make when
approving an address.

**2. Student wallet loss.** A student may lose access to the wallet tied to
a credential. *Mitigation:* `updateCredentialStudent` lets the *original issuing
institution only* move a credential to a new wallet directly, with no multisig
delay. The old wallet cannot move the credential itself, and no admin or other
institution can do it on the issuer's behalf.

**3. No true on-chain privacy.** A public blockchain cannot hide data from
observers — even a `private` Solidity variable is still readable by anyone
willing to inspect the state trie. *Mitigation:* the contract never stores
personal data in the first place. On-chain, it stores only `certHash`,
`institution`, `student`, `issuedAt`, and `revoked`. Off-chain, in an
encrypted store behind an authorized backend, it stores the student's name,
email, phone number, date of birth, address, and the certificate file itself.
The blockchain answers, "Is this credential genuine and currently valid?" The
backend separately answers, "Is this caller allowed to see the student's
private record?" These are two different systems and should never be
conflated.

**4. Administrative power.** A single owner key would create a single point of
failure for the institution whitelist. *Mitigation:* administrative power is
split among three addresses, and any 2 of 3 must agree before an admin action
takes effect, including `addInstitution`, `removeInstitution`,
`setInstitutionName`, and emergency global revocation. No single admin can act
alone. Day-to-day credential operations — issuing, revoking one's own
credentials, and wallet recovery — remain entirely with the issuing
institution and are never routed through the multisig, so the 2-of-3
requirement does not slow down legitimate students or institutions. There is
intentionally no admin-replacement function: if two of the three admin keys are
lost or compromised at once, there is no on-chain recovery path. That tradeoff
is accepted here to keep the design simple enough to explain clearly; a
production system would likely add admin rotation behind the same 2-of-3
quorum.

## Static analysis (Slither)

Run it against the contract with all 102 default detectors enabled:

```bash
slither contracts/VeriDegree.sol
```

Run this again after any contract change. The finding count in this README only
reflects the version it was last generated against.
