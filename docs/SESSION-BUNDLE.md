# Witnessmark session bundle v1

How one inspection leaves the phone and is checked by someone who does not trust the phone.
Producer: `Witnessmark/Persistence/SessionExporter.swift` (Review tab → Export inspection bundle).
Reference checker: `server/verify.js` in `andrewjrider/silver-auctions-preview`.

## Layout

A zip containing exactly one folder:

```
witnessmark-session-<session uuid, lowercase>/
    manifest.json    SessionBundleManifest (UTF-8 JSON, ISO-8601 dates)
    signature.json   SessionBundleSignature over the exact bytes of manifest.json
    media/<file>     every RGB JPEG and depth sidecar the session references
```

`manifest.json` carries `format: "witnessmark.session-bundle"`, `formatVersion: 1`, `exportedAt`,
`appVersion`, `organization`, `vehicle`, the full `session` (every capture, including retaken
ones, with its capture-time hashes and review history), and `files`: one entry per media file
with `path`, `role` (`rgb` | `depth`), `evidenceID`, `sha256`, `bytes`.

`signature.json`: `algorithm: "ecdsa-p256-sha256"`, `publicKeyX963` (65-byte uncompressed key,
base64), `signatureDER` (base64), `manifestSHA256` (hex), `keyStorage` (`secureEnclave` |
`software`).

## What the exporter guarantees

- Every media file is re-hashed and must equal the hash recorded at capture; otherwise nothing
  is exported.
- File names are plain names (no paths), each referenced once.
- The manifest is signed with a P-256 key generated on the phone. With a Secure Enclave the
  private key cannot leave the phone's hardware; the simulator uses a software key and says so.

## What a receiver must check (the reference checker does all of these)

1. One top folder, no `..`, absolute or empty path segments; size and entry-count limits applied
   before inflating.
2. Folder name matches `session.id`; `vehicle.id` matches `session.vehicleID`.
3. Signature verifies over the raw manifest bytes; `manifestSHA256` matches.
4. Every listed file exists, has the listed size, and its SHA-256 matches both the manifest entry
   and the hash inside the capture record it belongs to. No unlisted media files.
5. Depth sidecars parse as depth v1 (`docs/DEPTH-FORMAT.md`) and their buffers match their grids.
6. Coverage (which required views exist, which were accepted by a reviewer) is recomputed from
   the capture records against the known protocol, not taken from the app's own score.

## What it proves, and what it does not

Proves: the files are byte-for-byte what the phone holding that key recorded, and nothing was
added, removed or edited after signing — including the lot number and vehicle details.

Does not prove: who held the phone; that the car photographed is the vehicle named; the time on
the phone's clock; or measurement accuracy (depth coverage and confidence are not accuracy).
Anyone can generate a key and sign their own bundle, so a receiver should keep a list of
registered inspection devices (key fingerprints = first 16 hex of SHA-256 of the public key,
shown in the phone-side export and on the receiving site) and treat unregistered keys as
unverified sources. Apple App Attest is the natural next step for proving the key lives in a
genuine copy of this app.
