# FindWhatIsLost - NameMatching

Implement functions:

```ts
async function setup(datasetPath: string): Promise<void>;
async function search(query: string): Promise<string[]>;
async function cleanup(): Promise<void>;
```

**`setup(datasetPath)`** is called once before any `search()` calls. It receives the absolute path to the dataset CSV. Use it to load, parse, and index the data. Time spent in `setup` is reported separately and **does not** count toward QPS. Optional.

**`search(query)`** — given a `query`, return matching record IDs from the selected dataset.

**`cleanup()`** is called once after all `search()` calls complete. Use it to tear down resources (close DB connections, remove temp files, etc.). Optional.

You can use any type of library / helpers / infrastructure you want.
The provided datasets are small for local evaluation, but the real production problem operates at 100M+ rows.

## Files

- `submission/search.ts` - your implementation lives here.
- `data/datasets/small/names.csv` - small dataset (~1k rows).
- `data/datasets/large/names.csv` - large dataset (~10k rows).
- `tests/public_small.json` - public quality suite.
- `tests/public_large.json` - public scale/noise suite.
- `scripts/score.ts` - scorer.

## Run

```bash
bun install
bun run score
bun run score:small
bun run score:large
```

`bun run score` defaults to:

- dataset: `small`
- suite: `tests/public_small.json`

Or directly:

```bash
bun run score --dataset small --suite tests/public_small.json
bun run score --dataset large --suite tests/public_large.json
```

Use `--verbose` to print every case, not just failures.
Default mode prints summary and timing only.

## Scoring

```text
penalty_points =
  (listed_false_positives * 0.02) +
  (unexpected_extra_returns * 0.05)

score_raw = recall_pct - penalty_points
score = clamp(score_raw, 0, 100)

if invalid_ids > 0, final score = 0
```

The output includes:

- recall / precision / F1
- per-penalty counts and weighted penalty points
- raw score and final clamped score
- timing stats (`avg`, `p95`, `QPS`)
- per-failing-query details with both ID and name

## Submission Instructions

Submit your work as a Pull Request.

Your PR must include:

- your implementation (`submission/search.ts` and any supporting files)
- your final score summary from:
  - `bun run score:small`
  - `bun run score:large`
- notes on your approach, tradeoffs, and edge cases considered
- tools/models/libraries used while building your solution
- a short scale plan for 100M+ rows (indexing/storage strategy, expected latency, bottlenecks, and mitigations)

If your solution requires additional infrastructure, include reproducible setup steps in the PR:

- exact commands to start/stop dependencies (for example Redis, Postgres, vector DB, etc.)
- required environment variables and example values
- any migrations or precomputation/build steps
- the exact scoring commands we should run after setup

Recommended PR format:

- `Score (small)`: paste summary block
- `Score (large)`: paste summary block
- `Approach`: short description of matching strategy
- `Notes`: assumptions, known limitations, and next improvements
- `Infra setup`: only if non-default infrastructure is required
