/**
 * TODO: implement your name matching logic.
 *
 * Contract:
 *
 * setup(datasetPath):
 * - Called once before any search() calls with the path to the dataset CSV.
 * - Use this to load, parse, and index the dataset.
 * - Time spent here is reported separately and does NOT count toward QPS.
 * - Optional: if not exported, the scorer skips it.
 *
 * search(query):
 * - Input: query name string
 * - Output: list of matching record IDs from the dataset
 *
 * cleanup():
 * - Called once after all search() calls complete.
 * - Use this to tear down resources (DB connections, temp files, etc.).
 * - Optional: if not exported, the scorer skips it.
 */

interface NameRecord {
  id: string;
  raw: string;
  tokens: string[];
  suffix: string | null;
  normalized: string;
  sortedKey: string;
}

// Indexes
let records: NameRecord[] = [];
let idToRecord: Map<string, NameRecord> = new Map();
let tokenToIds: Map<string, Set<string>> = new Map();
let sortedKeyToIds: Map<string, Set<string>> = new Map();
let normalizedToIds: Map<string, Set<string>> = new Map();
let allTokens: Set<string> = new Set();

const SUFFIXES = new Set(["jr", "sr", "ii", "iii", "iv", "v"]);

function ocrFix(s: string): string {
  let result = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    const prev = i > 0 ? s[i - 1] : "";
    const next = i < s.length - 1 ? s[i + 1] : "";
    const prevIsLetter = /[a-zA-Z]/.test(prev);
    const nextIsLetter = /[a-zA-Z]/.test(next);

    if (ch === "0" && (prevIsLetter || nextIsLetter)) {
      result += "o";
    } else if (ch === "1" && (prevIsLetter || nextIsLetter)) {
      result += "l";
    } else {
      result += ch;
    }
  }
  return result;
}

function normalizeRaw(rawName: string): { tokens: string[]; suffix: string | null } {
  let name = rawName;
  name = ocrFix(name);
  name = name.replace(/([a-z])x([A-Z])/g, "$1 $2");
  if (name.includes(",")) {
    const commaIdx = name.indexOf(",");
    const before = name.slice(0, commaIdx).trim();
    const after = name.slice(commaIdx + 1).trim();
    name = after + " " + before;
  }
  name = name.toLowerCase();
  name = name.replace(/[^a-z. ]/g, "").replace(/\s+/g, " ").trim();
  let tokens = name.split(" ").filter(t => t.length > 0);
  tokens = tokens.map(t => t.replace(/\./g, "")).filter(t => t.length > 0);

  let suffix: string | null = null;
  const nonSuffixTokens: string[] = [];
  for (const t of tokens) {
    if (SUFFIXES.has(t)) {
      suffix = t;
    } else {
      nonSuffixTokens.push(t);
    }
  }

  return { tokens: nonSuffixTokens, suffix };
}

// Step 6: Damerau-Levenshtein edit distance (with transpositions)
function damerauLevenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const la = a.length;
  const lb = b.length;
  if (la === 0) return lb;
  if (lb === 0) return la;

  // Early exit: if length gap is already >3, distance must exceed our max threshold
  if (Math.abs(la - lb) > 3) return Math.abs(la - lb);

  const d: number[][] = Array.from({ length: la + 1 }, () =>
    new Array(lb + 1).fill(0)
  );

  // Base cases: transform empty string to prefix
  for (let i = 0; i <= la; i++) d[i][0] = i;
  for (let j = 0; j <= lb; j++) d[0][j] = j;

  for (let i = 1; i <= la; i++) {
    for (let j = 1; j <= lb; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(
        d[i - 1][j] + 1,        // deletion
        d[i][j - 1] + 1,        // insertion
        d[i - 1][j - 1] + cost  // substitution
      );

      // Transposition: swap adjacent chars
      if (
        i > 1 &&
        j > 1 &&
        a[i - 1] === b[j - 2] &&
        a[i - 2] === b[j - 1]
      ) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + cost);
      }
    }
  }

  return d[la][lb];
}

// Step 6: length-based thresholds to prevent short tokens from matching everything
function maxDistForLen(len: number): number {
  if (len <= 2) return 0;  // "al" vs "el" should not match
  if (len <= 4) return 1;  // short words allow 1 edit
  if (len <= 7) return 2;  // medium words allow 2 edits
  return 3;                // long words allow up to 3 edits
}

// rn→m OCR fix: replace "rn" with "m" in a token
function rnToMFix(s: string): string {
  return s.replace(/rn/g, "m");
}

// Token-level fuzzy matching (layers 1-6)
function tokenFuzzyMatch(a: string, b: string): boolean {
  // Layer 1: exact match
  if (a === b) return true;

  // Layer 2: initial handling — single char matches first letter
  if (a.length === 1) return b.length > 0 && b[0] === a[0];
  if (b.length === 1) return a.length > 0 && a[0] === b[0];

  // Layer 3: standard edit distance
  const dist = damerauLevenshtein(a, b);
  const maxDist = maxDistForLen(Math.min(a.length, b.length));
  if (dist <= maxDist) return true;

  // Layer 3b: length-diff-1 relaxation — use max length threshold for deletion+substitution
  if (Math.abs(a.length - b.length) === 1) {
    const maxDistMax = maxDistForLen(Math.max(a.length, b.length));
    if (dist <= maxDistMax) return true;
  }

  // Layer 4: short-word special case (2-3 char words allow 1 insertion)
  if ((a.length <= 3 || b.length <= 3) && Math.abs(a.length - b.length) === 1 && dist <= 1) {
    return true;
  }

  // Layer 5: rn→m OCR fallback
  const aFixed = rnToMFix(a);
  const bFixed = rnToMFix(b);
  if (aFixed !== a || bFixed !== b) {
    const fixedDist = damerauLevenshtein(aFixed, bFixed);
    const fixedMaxDist = maxDistForLen(Math.min(aFixed.length, bFixed.length));
    if (fixedDist <= fixedMaxDist) return true;
  }

  // Layer 6: x-at-start wildcard (x replaces first letter)
  if (a[0] === "x" && a.length > 1) {
    const aNoX = a.slice(1);
    const bNoFirst = b.slice(1);
    if (aNoX.length > 0 && bNoFirst.length > 0) {
      const xDist = damerauLevenshtein(aNoX, bNoFirst);
      if (xDist <= maxDistForLen(Math.min(aNoX.length, bNoFirst.length))) return true;
    }
  }
  if (b[0] === "x" && b.length > 1) {
    const bNoX = b.slice(1);
    const aNoFirst = a.slice(1);
    if (bNoX.length > 0 && aNoFirst.length > 0) {
      const xDist = damerauLevenshtein(bNoX, aNoFirst);
      if (xDist <= maxDistForLen(Math.min(bNoX.length, aNoFirst.length))) return true;
    }
  }

  return false;
}

// Direct alignment: first-to-first, last-to-last + anti-contamination
function matchAligned(at: string[], bt: string[]): boolean {
  if (at.length !== bt.length) return false;
  if (at.length === 0) return false;

  const dists: number[] = [];
  for (let i = 0; i < at.length; i++) {
    if (!tokenFuzzyMatch(at[i], bt[i])) return false;
    // Track actual edit distance (0 for initials that match)
    if (at[i].length === 1 || bt[i].length === 1) {
      dists.push(0);
    } else {
      dists.push(damerauLevenshtein(at[i], bt[i]));
    }
  }

  // Anti-contamination (for 2+ token names)
  if (at.length >= 2) {
    // Rule 1a: total distance cap at 2
    const totalDist = dists.reduce((a, b) => a + b, 0);
    if (totalDist > 2) return false;

    // Rule 1b: both full words with dist≥1, both >3 chars → reject
    const fi = 0, li = at.length - 1;
    if (at[fi].length > 1 && bt[fi].length > 1 &&
        at[li].length > 1 && bt[li].length > 1 &&
        dists[fi] >= 1 && dists[li] >= 1 &&
        Math.min(at[fi].length, bt[fi].length) > 3 &&
        Math.min(at[li].length, bt[li].length) > 3) {
      return false;
    }

    // Rule 2: initial first + fuzzy last → initials must agree exactly
    if ((at[fi].length === 1 || bt[fi].length === 1) && dists[li] > 0) {
      const a0 = at[fi][0], b0 = bt[fi][0];
      if (a0 !== b0) return false;
    }

    // Rule 3: fuzzy first + initial last → initials must agree exactly
    if ((at[li].length === 1 || bt[li].length === 1) && dists[fi] > 0) {
      const aL = at[li][0], bL = bt[li][0];
      if (aL !== bL) return false;
    }
  }

  return true;
}

// Guard: reversed alignment requires at least one full-word exact overlap
function hasFullWordOverlap(a: string[], b: string[]): boolean {
  for (const t of a) {
    if (t.length > 1 && b.includes(t)) return true;
  }
  return false;
}

// Check middle tokens all fuzzy-match (for subset matching)
function checkMiddleTokens(shorter: string[], longer: string[], startIdx: number): boolean {
  // shorter's middle tokens must match some of longer's middle tokens
  for (let i = 1; i < shorter.length - 1; i++) {
    let found = false;
    for (let j = startIdx; j < longer.length - 1; j++) {
      if (tokenFuzzyMatch(shorter[i], longer[j])) {
        found = true;
        break;
      }
    }
    if (!found) return false;
  }
  return true;
}

// Compute edit distance for a token pair (0 for initials)
function tokenDist(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 1 || b.length === 1) return 0;
  return damerauLevenshtein(a, b);
}

// Anti-contamination check for subset-matched pairs
function subsetAntiContamination(pairs: [string, string][]): boolean {
  if (pairs.length < 2) return true;
  let totalDist = 0;
  const dists: number[] = [];
  for (const [a, b] of pairs) {
    const d = tokenDist(a, b);
    dists.push(d);
    totalDist += d;
  }
  // Rule 1a: total distance cap at 2
  if (totalDist > 2) return false;
  // Rule 1b: first and last both fuzzy + both >3 chars → reject
  const fi = 0, li = pairs.length - 1;
  if (pairs[fi][0].length > 1 && pairs[fi][1].length > 1 &&
      pairs[li][0].length > 1 && pairs[li][1].length > 1 &&
      dists[fi] >= 1 && dists[li] >= 1 &&
      Math.min(pairs[fi][0].length, pairs[fi][1].length) > 3 &&
      Math.min(pairs[li][0].length, pairs[li][1].length) > 3) {
    return false;
  }
  return true;
}

// Subset matching: shorter name against longer name (different token counts)
function matchSubset(shorter: string[], longer: string[]): boolean {
  if (shorter.length < 1 || longer.length < 1) return false;

  // Strategy 1: first-to-first, last-to-last (most common — middle name present)
  if (tokenFuzzyMatch(shorter[0], longer[0]) &&
      tokenFuzzyMatch(shorter[shorter.length - 1], longer[longer.length - 1])) {
    const pairs: [string, string][] = [[shorter[0], longer[0]], [shorter[shorter.length - 1], longer[longer.length - 1]]];
    if (subsetAntiContamination(pairs)) {
      if (shorter.length <= 2) return true;
      if (checkMiddleTokens(shorter, longer, 1)) return true;
    }
  }

  // Strategy 2: cross-anchored (full reversal in the longer name)
  if (tokenFuzzyMatch(shorter[0], longer[longer.length - 1]) &&
      tokenFuzzyMatch(shorter[shorter.length - 1], longer[0])) {
    const pairs: [string, string][] = [[shorter[0], longer[longer.length - 1]], [shorter[shorter.length - 1], longer[0]]];
    if (subsetAntiContamination(pairs)) {
      if (shorter.length <= 2) return true;
      if (checkMiddleTokens(shorter, longer, 1)) return true;
    }
  }

  // Strategy 3: shorter's last matches middle of longer
  if (shorter.length === 2 && longer.length >= 3) {
    if (tokenFuzzyMatch(shorter[0], longer[0])) {
      for (let j = 1; j < longer.length - 1; j++) {
        if (tokenFuzzyMatch(shorter[1], longer[j])) {
          const pairs: [string, string][] = [[shorter[0], longer[0]], [shorter[1], longer[j]]];
          if (subsetAntiContamination(pairs)) return true;
        }
      }
    }
  }

  // Strategy 4: shorter's first matches middle of longer
  if (shorter.length === 2 && longer.length >= 3) {
    if (tokenFuzzyMatch(shorter[1], longer[longer.length - 1])) {
      for (let j = 1; j < longer.length - 1; j++) {
        if (tokenFuzzyMatch(shorter[0], longer[j])) {
          const pairs: [string, string][] = [[shorter[0], longer[j]], [shorter[1], longer[longer.length - 1]]];
          if (subsetAntiContamination(pairs)) return true;
        }
      }
    }
  }

  // Strategy 5: shorter's last matches longer's first (reversed), shorter's first matches middle
  // Handles: query ["n", "allan"] vs record ["allan", "nina", "kai"]
  if (shorter.length === 2 && longer.length >= 3) {
    if (tokenFuzzyMatch(shorter[shorter.length - 1], longer[0])) {
      for (let j = 1; j < longer.length; j++) {
        if (tokenFuzzyMatch(shorter[0], longer[j])) {
          const pairs: [string, string][] = [[shorter[shorter.length - 1], longer[0]], [shorter[0], longer[j]]];
          if (subsetAntiContamination(pairs)) return true;
        }
      }
    }
  }

  return false;
}

// Record-level matching
function recordsMatch(aTokens: string[], bTokens: string[]): boolean {
  // Try 1: direct alignment
  if (matchAligned(aTokens, bTokens)) return true;

  // Try 2: reversed alignment (swap query tokens)
  if (aTokens.length >= 2 && bTokens.length >= 2 && hasFullWordOverlap(aTokens, bTokens)) {
    const reversed = [...aTokens].reverse();
    if (matchAligned(reversed, bTokens)) return true;
  }

  // Try 3: subset matching (different token counts)
  if (aTokens.length !== bTokens.length) {
    const shorter = aTokens.length < bTokens.length ? aTokens : bTokens;
    const longer = aTokens.length < bTokens.length ? bTokens : aTokens;
    if (matchSubset(shorter, longer)) return true;
  }

  return false;
}

export async function setup(_datasetPath: string): Promise<void> {
  // TODO: load and preprocess the dataset
  const text = await Bun.file(_datasetPath).text();
  const lines = text.split(/\r?\n/).filter(l => l.trim().length > 0);

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    const firstComma = line.indexOf(",");
    if (firstComma === -1) continue;

    const id = line.slice(0, firstComma).trim();
    let name = line.slice(firstComma + 1).trim();
    if (name.startsWith('"') && name.endsWith('"')) {
      name = name.slice(1, -1).replace(/""/g, '"');
    }

    const { tokens, suffix } = normalizeRaw(name);
    const normalized = tokens.join(" ");
    const sortedKey = [...tokens].sort().join(" ");

    const record: NameRecord = {
      id,
      raw: name,
      tokens,
      suffix,
      normalized,
      sortedKey,
    };

    records.push(record);
    idToRecord.set(id, record);

    for (const t of tokens) {
      if (!tokenToIds.has(t)) tokenToIds.set(t, new Set());
      tokenToIds.get(t)!.add(id);
      allTokens.add(t);
    }

    if (!sortedKeyToIds.has(sortedKey)) sortedKeyToIds.set(sortedKey, new Set());
    sortedKeyToIds.get(sortedKey)!.add(id);

    if (!normalizedToIds.has(normalized)) normalizedToIds.set(normalized, new Set());
    normalizedToIds.get(normalized)!.add(id);
  }
}

export async function search(_query: string): Promise<string[]> {
  const { tokens } = normalizeRaw(_query);
  if (tokens.length === 0) return [];

  const normalized = tokens.join(" ");
  const sortedKey = [...tokens].sort().join(" ");

  const resultIds = new Set<string>();
  const exactMatches = normalizedToIds.get(normalized);
  if (exactMatches) {
    for (const id of exactMatches) resultIds.add(id);
  }

  const sortedMatches = sortedKeyToIds.get(sortedKey);
  if (sortedMatches) {
    for (const id of sortedMatches) resultIds.add(id);
  }

  // Pass 3: fuzzy candidate scan + recordsMatch filter
  const candidateIds = new Set<string>();
  for (const qt of tokens) {
    if (qt.length <= 1) continue; // skip initials — too broad
    for (const dt of allTokens) {
      if (dt.length <= 1) continue;
      // Use edit distance + rn→m fallback for candidate gen
      const dist = damerauLevenshtein(qt, dt);
      const maxDist = maxDistForLen(Math.min(qt.length, dt.length));
      let match = dist <= maxDist;
      if (!match) {
        const qf = rnToMFix(qt);
        const df = rnToMFix(dt);
        if (qf !== qt || df !== dt) {
          match = damerauLevenshtein(qf, df) <= maxDistForLen(Math.min(qf.length, df.length));
        }
      }
      if (match) {
        const ids = tokenToIds.get(dt);
        if (ids) {
          for (const id of ids) candidateIds.add(id);
        }
      }
    }
  }
  for (const id of candidateIds) {
    if (resultIds.has(id)) continue;
    const rec = idToRecord.get(id)!;
    if (recordsMatch(tokens, rec.tokens)) {
      resultIds.add(id);
    }
  }

  return [...resultIds];
}

export async function cleanup(): Promise<void> {
  // TODO: tear down any resources (DB connections, temp files, etc.)
  records = [];
  idToRecord.clear();
  tokenToIds.clear();
  sortedKeyToIds.clear();
  normalizedToIds.clear();
  allTokens.clear();
}

export default search;