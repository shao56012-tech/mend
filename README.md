# mend

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/shao56012-tech/mend/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/shao56012-tech/mend/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

One patch tool for every AI edit format. `mend` applies an edit that an AI model wrote to a tree of text
files, reading all four formats models write in — unified diffs, SEARCH/REPLACE blocks, V4A patches and
text-editor tool calls as JSON — to one written specification (`SPEC.md` in the competition kit), finding
the lines an edit names even when the model drifted their whitespace or indentation, and changing every
file or none.

## Run it

```sh
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

- `PATCH` is the patch file, relative to the working directory (the root of the tree); absent or `-`,
  the patch is read from standard input.
- `--format=NAME` reads the patch as `unified`, `search-replace`, `v4a` or `json`; the default, `auto`,
  detects the format.
- `--check` does everything but write: the same output and exit code, and no file is touched.
- `--strict` matches lines exactly (tier 0 only); otherwise lines also match with trailing, then leading,
  whitespace drifted, and new lines are re-indented to the file's own indentation.

Output is one line per changed path (`A`/`D`/`M`/`R`), then `ok: <n> files`; a failed patch prints one
`error: <code> <path>` line per failed edit and `failed: <k> of <n> edits`, and writes nothing.

Node 22, standard library only. `runner.ts` beside `main.ts` is the kit's trial runner (kept as-is).

## License

MIT — see `LICENSE`.

---

<sub>Entered on [make.fun](https://make.fun/?ref=jcw1tf6r&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
