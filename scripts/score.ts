import { resolve } from "node:path";
import { setup, search, cleanup } from "../submission/search";

interface RecordRow {
  id: string;
  name: string;
}

interface TestCase {
  id: string;
  dataset: "small" | "large";
  query: string;
  expectedIds: string[];
  falsePositiveIds: string[];
  tags: string[];
  notes: string;
}

interface TestSuite {
  name: string;
  dataset: "small" | "large";
  visibility: "public";
  seed: number;
  cases: TestCase[];
}

interface Args {
  dataset: "small" | "large";
  suitePath: string;
  verbose: boolean;
  timeoutMs: number;
}

type Painter = (value: string) => string;

const PENALTY_LISTED_FP = 0.02;
const PENALTY_UNEXPECTED_EXTRA = 0.05;

const COLORS_ENABLED = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
};

const identity: Painter = (value) => value;

function colorize(value: string, code: string): string {
  if (!COLORS_ENABLED) {
    return value;
  }
  return `${code}${value}${ANSI.reset}`;
}

const color = {
  bold: (value: string): string => colorize(value, ANSI.bold),
  dim: (value: string): string => colorize(value, ANSI.dim),
  red: (value: string): string => colorize(value, ANSI.red),
  green: (value: string): string => colorize(value, ANSI.green),
  yellow: (value: string): string => colorize(value, ANSI.yellow),
  blue: (value: string): string => colorize(value, ANSI.blue),
  magenta: (value: string): string => colorize(value, ANSI.magenta),
  cyan: (value: string): string => colorize(value, ANSI.cyan),
};

function parseArgs(): Args {
  const args = Bun.argv.slice(2);

  const get = (flag: string): string | undefined => {
    const idx = args.indexOf(flag);
    return idx === -1 ? undefined : args[idx + 1];
  };

  const has = (flag: string): boolean => args.includes(flag);

  const dataset = (get("--dataset") ?? "small") as "small" | "large";
  if (dataset !== "small" && dataset !== "large") {
    throw new Error(`Invalid --dataset: ${dataset}`);
  }

  const suitePath = get("--suite") ?? `tests/public_${dataset}.json`;
  const timeoutMs = Number.parseInt(get("--timeout-ms") ?? "2000", 10);

  return {
    dataset,
    suitePath,
    verbose: has("--verbose"),
    timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : 2000,
  };
}

function parseCsvLine(line: string): [string, string] {
  const firstComma = line.indexOf(",");
  if (firstComma === -1) {
    throw new Error(`Invalid CSV row: ${line}`);
  }

  const id = line.slice(0, firstComma).trim();
  let name = line.slice(firstComma + 1).trim();

  if (name.startsWith("\"") && name.endsWith("\"")) {
    name = name.slice(1, -1).replace(/\"\"/g, "\"");
  }

  return [id, name];
}

async function loadDataset(path: string): Promise<RecordRow[]> {
  const text = await Bun.file(path).text();
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  const rows: RecordRow[] = [];

  for (const [index, line] of lines.entries()) {
    if (index === 0) {
      continue;
    }
    const [id, name] = parseCsvLine(line);
    rows.push({ id, name });
  }

  return rows;
}

function toUniqueIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  const out: string[] = [];
  const seen = new Set<string>();

  for (const value of raw) {
    const id = String(value).trim();
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    out.push(id);
  }

  return out;
}

function percentile(values: number[], pct: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.floor((sorted.length - 1) * pct);
  return sorted[idx] ?? 0;
}

function formatPercent(value: number): string {
  return `${value.toFixed(2)}%`;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: Timer | undefined;
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`search timed out after ${timeoutMs}ms`)), timeoutMs);
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function printMetric(label: string, value: string, painter: Painter = identity): void {
  console.log(`  ${color.dim(`${label}:`.padEnd(24, " "))}${painter(value)}`);
}

function scorePainter(score: number): Painter {
  if (score >= 85) {
    return color.green;
  }
  if (score >= 65) {
    return color.yellow;
  }
  return color.red;
}

function percentPainter(percent: number): Painter {
  if (percent >= 90) {
    return color.green;
  }
  if (percent >= 70) {
    return color.yellow;
  }
  return color.red;
}

function formatIdName(id: string, byId: Map<string, RecordRow>): string {
  const name = byId.get(id)?.name ?? "<unknown-id>";
  return `[${id}] ${name}`;
}

function printIdList(label: string, ids: string[], byId: Map<string, RecordRow>, painter: Painter = identity): void {
  console.log(`  ${painter(`${label} (${ids.length})`)}`);
  if (ids.length === 0) {
    console.log(`    ${color.dim("- (none)")}`);
    return;
  }

  for (const id of ids) {
    console.log(`    - ${formatIdName(id, byId)}`);
  }
}

function printStringList(label: string, values: string[], painter: Painter = identity): void {
  console.log(`  ${painter(`${label} (${values.length})`)}`);
  if (values.length === 0) {
    console.log(`    ${color.dim("- (none)")}`);
    return;
  }

  for (const value of values) {
    console.log(`    - ${value}`);
  }
}

function printCaseResult(
  testCase: TestCase,
  pass: boolean,
  caseIndex: number,
  totalCases: number,
  elapsedMs: number,
  expectedIds: string[],
  returnedIds: string[],
  missingIds: string[],
  fpHits: string[],
  invalidIds: string[],
  extrasUnscored: string[],
  byId: Map<string, RecordRow>,
  runtimeError: string | null,
): void {
  const line = color.dim("-".repeat(88));
  const statusLabel = pass ? color.green("PASS") : color.red("FAIL");

  console.log(`\n${line}`);
  console.log(`${statusLabel} ${color.bold(`${caseIndex}/${totalCases}`)} ${color.bold(testCase.id)} ${color.dim(`(${elapsedMs.toFixed(1)}ms)`)}`);
  console.log(`  ${color.cyan("query")}: ${testCase.query}`);

  printIdList("expected", expectedIds, byId, color.cyan);
  printIdList("returned", returnedIds, byId, color.blue);
  printIdList("missing", missingIds, byId, color.red);
  printIdList("false positives", fpHits, byId, color.yellow);

  if (invalidIds.length > 0) {
    printStringList("invalid ids", invalidIds, color.yellow);
  }
  if (extrasUnscored.length > 0) {
    printIdList("extra unscored ids", extrasUnscored, byId, color.magenta);
  }
  if (runtimeError) {
    console.log(`  ${color.red("runtime error")}: ${runtimeError}`);
  }
}

async function main(): Promise<void> {
  const args = parseArgs();

  const datasetPath = resolve(`data/datasets/${args.dataset}/names.csv`);
  process.env.CHALLENGE_DATASET = datasetPath;

  const suite = (await Bun.file(args.suitePath).json()) as TestSuite;
  if (suite.dataset !== args.dataset) {
    throw new Error(`Suite dataset mismatch: suite=${suite.dataset}, arg=${args.dataset}`);
  }

  const rows = await loadDataset(datasetPath);
  const byId = new Map(rows.map((row) => [row.id, row] as const));

  const setupStart = performance.now();
  if (typeof setup === "function") {
    await setup(datasetPath);
  }
  const setupMs = performance.now() - setupStart;

  console.log(color.dim("=".repeat(88)));
  console.log(color.bold("Name Challenge Scorer"));
  printMetric("Dataset", args.dataset, color.cyan);
  printMetric("Suite", suite.name, color.cyan);
  printMetric("Cases", String(suite.cases.length), color.cyan);
  printMetric("Submission", "submission/search.ts", color.cyan);
  console.log(color.dim("=".repeat(88)));

  let expectedTotal = 0;
  let expectedHits = 0;
  let listedFalsePositiveCount = 0;
  let unexpectedExtraCount = 0;
  let invalidIdCount = 0;
  let returnedTotal = 0;
  let passCases = 0;
  const timesMs: number[] = [];

  for (const [index, testCase] of suite.cases.entries()) {
    const expectedSet = new Set(testCase.expectedIds);
    const fpSet = new Set(testCase.falsePositiveIds);

    const start = performance.now();
    let returnedIds: string[] = [];
    let runtimeError: string | null = null;

    try {
      returnedIds = toUniqueIds(await withTimeout(search(testCase.query), args.timeoutMs));
    } catch (error) {
      returnedIds = [];
      runtimeError = error instanceof Error ? error.message : String(error);
    }

    const elapsed = performance.now() - start;
    timesMs.push(elapsed);

    const hitIds = testCase.expectedIds.filter((id) => returnedIds.includes(id));
    const missingIds = testCase.expectedIds.filter((id) => !returnedIds.includes(id));
    const fpHits = returnedIds.filter((id) => fpSet.has(id));
    const invalidIds = returnedIds.filter((id) => !byId.has(id));
    const extrasUnscored = returnedIds.filter(
      (id) => byId.has(id) && !expectedSet.has(id) && !fpSet.has(id),
    );

    expectedTotal += testCase.expectedIds.length;
    expectedHits += hitIds.length;
    listedFalsePositiveCount += fpHits.length;
    unexpectedExtraCount += extrasUnscored.length;
    invalidIdCount += invalidIds.length;
    returnedTotal += returnedIds.length;

    const pass =
      missingIds.length === 0
      && fpHits.length === 0
      && extrasUnscored.length === 0
      && invalidIds.length === 0
      && runtimeError === null;

    if (pass) {
      passCases += 1;
    }

    if (args.verbose) {
      printCaseResult(
        testCase,
        pass,
        index + 1,
        suite.cases.length,
        elapsed,
        testCase.expectedIds,
        returnedIds,
        missingIds,
        fpHits,
        invalidIds,
        extrasUnscored,
        byId,
        runtimeError,
      );
    }
  }

  const cleanupStart = performance.now();
  if (typeof cleanup === "function") {
    await cleanup();
  }
  const cleanupMs = performance.now() - cleanupStart;

  const recall = expectedTotal === 0 ? 100 : (expectedHits / expectedTotal) * 100;
  const precision = returnedTotal === 0 ? 0 : (expectedHits / returnedTotal) * 100;
  const f1 = (recall + precision) === 0 ? 0 : (2 * recall * precision) / (recall + precision);
  const penaltyPoints =
    (listedFalsePositiveCount * PENALTY_LISTED_FP)
    + (unexpectedExtraCount * PENALTY_UNEXPECTED_EXTRA);
  const scoreRaw = recall - penaltyPoints;
  const scoreClamped = Math.max(0, Math.min(100, scoreRaw));
  const score = invalidIdCount > 0 ? 0 : scoreClamped;

  const totalMs = timesMs.reduce((sum, ms) => sum + ms, 0);
  const avgMs = totalMs / Math.max(1, timesMs.length);
  const p95Ms = percentile(timesMs, 0.95);
  const qps = totalMs === 0 ? 0 : (suite.cases.length / totalMs) * 1000;
  const passRate = suite.cases.length === 0 ? 100 : (passCases / suite.cases.length) * 100;

  console.log(`\n${color.dim("=".repeat(88))}`);
  console.log(color.bold("Score Summary"));
  printMetric("Cases passed", `${passCases}/${suite.cases.length} (${formatPercent(passRate)})`, percentPainter(passRate));
  printMetric("Recall", `${formatPercent(recall)} (${expectedHits}/${expectedTotal})`, percentPainter(recall));
  printMetric("Precision", `${formatPercent(precision)} (${expectedHits}/${returnedTotal})`, percentPainter(precision));
  printMetric("F1", formatPercent(f1), percentPainter(f1));
  printMetric(
    "Listed false positives",
    `${listedFalsePositiveCount} (x${PENALTY_LISTED_FP})`,
    listedFalsePositiveCount === 0 ? color.green : color.yellow,
  );
  printMetric(
    "Unexpected extras",
    `${unexpectedExtraCount} (x${PENALTY_UNEXPECTED_EXTRA})`,
    unexpectedExtraCount === 0 ? color.green : color.red,
  );
  printMetric(
    "Invalid IDs",
    `${invalidIdCount} (score=0 if >0)`,
    invalidIdCount === 0 ? color.green : color.red,
  );
  printMetric("Penalty points", penaltyPoints.toFixed(2), penaltyPoints === 0 ? color.green : color.red);
  printMetric("Score raw", scoreRaw.toFixed(2), scorePainter(Math.max(0, Math.min(100, scoreRaw))));
  printMetric("Score", score.toFixed(2), scorePainter(score));

  console.log(`\n${color.bold("Timing")}`);
  printMetric("Setup", `${setupMs.toFixed(1)}ms`);
  printMetric("Total", `${totalMs.toFixed(1)}ms`);
  printMetric("Average/query", `${avgMs.toFixed(1)}ms`);
  printMetric("P95/query", `${p95Ms.toFixed(1)}ms`);
  printMetric("Approx QPS", qps.toFixed(2));
  printMetric("Cleanup", `${cleanupMs.toFixed(1)}ms`);
  console.log(color.dim("=".repeat(88)));
}

void main();
