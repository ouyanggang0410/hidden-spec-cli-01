# hidden-spec-cli-01

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/ouyanggang0410/hidden-spec-cli-01/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/ouyanggang0410/hidden-spec-cli-01/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend is one command-line patch tool for every AI edit format: it reads a patch in any of the four formats AI models write (unified diff, SEARCH/REPLACE blocks, V4A, JSON edits), finds the lines each edit names at the first of three matching tiers, and writes every change or none, printing what it changed or why it failed. `main.ts` is the CLI (Node 22, standard library alone); `SPEC.md` is the whole specification. Local practice set: 100 of 100 checks passed, practice score 1000.

## Run it

```sh
node main.ts [options] [PATCH]
node check.ts practice.json
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=qhmde06g&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
