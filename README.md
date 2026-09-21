# Silver Auctions — site preview

A static, self-contained preview build of the rebuilt Silver Auctions platform. Single-page app, five routes (`#/block`, `#/catalog`, `#/lot/:n`, `#/assay`, `#/consign`, `#/archive`), one data layer, client-side only — no backend yet. See the Silver Auctions Claude Project doc `claude/silver-auctions-site-build.md` for the full design notes and known gaps.

## Deploy to Render (2 commands, once this repo exists on GitHub)

This repo has one file that matters: `index.html`. Render just needs to serve it as a static site.

1. Create an empty GitHub repo (e.g. `silver-auctions-preview`) under github.com/andrewjrider — no README/gitignore, just empty.
2. From this folder:
   ```
   git init
   git add index.html README.md
   git commit -m "Silver Auctions site preview"
   git branch -M main
   git remote add origin https://github.com/andrewjrider/silver-auctions-preview.git
   git push -u origin main
   ```
3. Tell Claude (or Claude will pick it up on its own device sync) once it's pushed — it has Render access to this workspace (`tea-d8s6me1o3t8c73eqj920`) and can create the static site, wire the subdomain, and confirm it's live.

## What this is not yet

Not the live silverauctions.com. No real bidding, no persistence, no backend. See the "Known gaps / next" section of the build doc for the honest list.
