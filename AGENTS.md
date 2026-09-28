# Agent instructions (Claude, Codex and any other assistant)

- **Owner:** Andrew Rider decides, merges, sends, deploys to paid plans and holds every
  credential.
- **Roles:** Claude owns this site and its verifier. Codex owns the Witnessmark iPhone app
  (andrewjrider/witnessmark-ios) and reviews Claude's PRs here. The team rules are in
  that repo's `docs/COLLABORATION.md` and `AGENTS.md`.
- **Branches:** `claude/…` and `codex/…`; integration branch `main`. Never commit to
  another assistant's branch or merge your own PR.
- **Every PR says:** what changed, tests actually run (`npm test`), what is unverified.
  The `Tests` workflow must be green.
- **Contract:** `server/verify.js` must accept exactly what the app's
  `docs/SESSION-BUNDLE.md` describes. Any change to field names or hash rules is a paired
  PR in both repos.
- **Never in Git:** tokens (`INTAKE_TOKEN`, `STAFF_TOKEN`), API keys, real customers'
  bundles or consignor data.
- **This is a preview of Silver Auctions' site.** Keep the "Preview build" label, and don't
  present it publicly as Silver's own site without Matt Backs' written OK.
- **End each session with a handoff note:** Done / In progress / Blocked on /
  Next 3 actions / Unsure about.
