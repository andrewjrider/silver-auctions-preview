# Silver Auctions — parallel site (preview)

A working preview of a rebuilt Silver Auctions platform. **Not** the live silverauctions.com;
no bid placed here reaches an auction.

## What's in it

- **Catalog, lot pages, archive, consign** — the Sun Valley 2026 catalog (page one), with sale
  timing that follows the calendar (the sale now shows as closed; next sale "to be announced").
- **Scan a car** — one photograph in, a conservative condition reading out. Runs on this site's
  server (`/api/assay`) with the prompt held server-side and per-visitor and daily limits.
  Shows the example reading until `ANTHROPIC_API_KEY` is set.
- **Evidence** (new) — the receiving end of the Witnessmark iPhone app. An inspector uploads the
  app's signed session bundle; the site checks the phone's signature, re-hashes every photo and
  LiDAR depth file against the capture records, recomputes which required views are present and
  accepted, and only then publishes it on the matching lot page with a "Witnessmark verified"
  badge. Anything altered is refused with the reason. Format and guarantees:
  [docs/SESSION-BUNDLE.md](docs/SESSION-BUNDLE.md).

- **Consign** (new) — a real consignment request form with the Witnessmark scan-kit option
  (planned $249 refundable deposit; no payment is taken on the site).
- **Staff console** (`#/staff`, new) — one password-protected view of consignment requests with
  status and lot assignment, verified Witnessmark scans, and every refused upload with its reason.

## Run and test

```
npm install
npm test                 # 25 tests: verification, tampering, intake auth, assay proxy, serving
npm run demo-bundle      # writes demo-bundle.zip (placeholder photos) for trying the upload page
INTAKE_TOKEN=pick-one npm start   # http://localhost:8080
```

## Deploy

`render.yaml` defines one Node web service with a persistent disk for published records. In the
Render dashboard set `INTAKE_TOKEN` (inspector password), optionally `ANTHROPIC_API_KEY` and
`TRUSTED_DEVICE_KEYS` (fingerprints shown in the app after an export).

## Layout

```
public/index.html   the site (single page, no build step)
server/server.js    HTTP server: page, /api/records, /api/bundles, /api/assay, /records/<id>/<file>
server/verify.js    independent Witnessmark bundle checker
server/store.js     published records on disk (atomic), rejected-upload audit log
server/assay.js     server-side assay prompt, Anthropic call, rate limiter
test/               node:test suites and a reference bundle producer
```

## Known gaps

No accounts or real bidding; one inspector token rather than per-inspector logins; records are
public once published (VIN photos included, as auction catalogs normally show VINs); App Attest
not yet used, so device trust rests on the registered-key list.
