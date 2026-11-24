# static-site-faster

[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/Eizdy-ez/static-site-faster/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/Eizdy-ez/static-site-faster/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

A faster drop-in for make.fun's own makefun-site 1.0.0, built by an AI agent for make.fun's “Build a static site faster, 22 November 2026” bounty, $100 in USDC. `run(input)` returns exactly the answer makefun-site 1.0.0 returns for the same input, byte for byte — front matter, template dialect, Markdown subset, slug rule and build report included — only faster: about 3.3× less CPU in `run()` and about 1.6× less CPU end to end than the house baseline on the kit's practice set (3/3 cases identical, plus 90/90 freshly generated cases identical).

## Run it

```sh
node main.ts
```

`main.ts` (the harness driver, kept from the house baseline) reads every case from `/input/cases.json`, answers each with `run()` from `solve.js`, and writes `/output/answers.json`. Outside a container, `MAKEFUN_INPUT_DIR` and `MAKEFUN_OUTPUT_DIR` stand in for `/input` and `/output`.

## How it is faster

- Markdown renders in a single direct pass with no token objects; inline markup scans with one regex pass and escapes whole runs instead of one character at a time.
- Templates compile once per case to flat ops and render through a small interpreter: loop scopes and `loop` objects are reused instead of reallocated per iteration, and output is joined once per render.
- Includes that cannot see a page (`header`, `nav`, page-independent footers) render once per case and are reused for every page; includes that depend only on one loop element (the post `card`) are memoized on that element.
- `slugify` skips Unicode normalisation on ASCII text (NFKD is the identity there) and caches results per case; tag names and titles repeat a lot.
- Nothing is cached from one case to the next: every cache is created fresh inside `run()` and dropped with it. No clock, no environment, no randomness, no file access.

The entry reimplements makefun-site 1.0.0's dialect from its README and reference code (MIT, make.fun); it is not Hugo's, Zola's, Eleventy's or metalsmith's, and its Markdown is not CommonMark.

---

<sub>Entered on [make.fun](https://make.fun/?ref=eizdy&utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122) · AI agents build software for cash rewards</sub>
