// Shared helpers for mend (SPEC.md sections 3, 5, 10). Imported by main.ts and
// by the per-format parsers (unified.ts, searchreplace.ts, v4a.ts). Node 22
// standard library only.

import { readFileSync, statSync } from 'node:fs';

export class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}

export class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

export const blank = (s: string): boolean => s.trim() === '';

/** SPEC section 3: a patch's lines (split at \n, one trailing \r removed, no empty piece after a final \n). */
export function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

export function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
export class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Successful move edits, as [old, new] pairs, in patch order (for R output lines). */
  readonly moves: Array<[string, string]> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

export type Edit = (tree: Tree) => void;

/** A file's lines under SPEC section 3. */
export interface FileModel {
  lines: string[];
  br: string;
  final: boolean;
}

export function parseFile(text: string): FileModel {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

export function serializeFile(f: FileModel): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

const rtrimWs = (s: string): string => s.replace(/[ \t]+$/, '');
const trimWs = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
export const leadingWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
};

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return rtrimWs(a) === rtrimWs(b);
  return trimWs(a) === trimWs(b);
}

/** First tier (0, 1, 2; strict: only 0) at which single lines a and b are equal, else null. */
export function lineTier(a: string, b: string, strict: boolean): number | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) if (lineEq(a, b, t)) return t;
  return null;
}

/** All 0-based positions where O occurs in fileLines at the given tier (overlaps count). */
export function findOccurrences(fileLines: string[], O: string[], tier: number): number[] {
  const out: number[] = [];
  if (O.length === 0) return out;
  for (let i = 0; i + O.length <= fileLines.length; i++) {
    let ok = true;
    for (let j = 0; j < O.length; j++) {
      if (!lineEq(fileLines[i + j]!, O[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** First tier with at least one occurrence of O, with all its positions; null when none at any tier. */
export function matchTier(fileLines: string[], O: string[], strict: boolean): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = findOccurrences(fileLines, O, t);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** First occurrence of O at or after `from`, at the first tier with one; endAtLast restricts to occurrences ending at the file's last line. */
export function findFirstAtOrAfter(
  fileLines: string[],
  O: string[],
  strict: boolean,
  from: number,
  endAtLast = false,
): { tier: number; pos: number } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = findOccurrences(fileLines, O, t).filter((i) => i >= from && (!endAtLast || i + O.length === fileLines.length));
    if (occ.length > 0) return { tier: t, pos: occ[0]! };
  }
  return null;
}

/** One line of an old/new pair: ctx lines are context (written as the file's own matched line). */
export interface PLine {
  text: string;
  ctx: boolean;
}

/** SPEC section 5 tier-2 re-indent of a single non-context new line. */
export function reindentLine(line: string, F: string, P: string): string {
  if (line === '' || line.trim() === '') return line;
  if (!line.startsWith(P)) return line;
  return F + line.slice(P.length);
}

/**
 * Replace the O lines at position `at` with the N lines. Context lines of N are
 * written as the file's own matched lines (k-th context line of N takes the
 * k-th context line of O's file line); other lines are written as-is at tiers
 * 0/1 and re-indented at tier 2.
 */
export function spliceAt(fileLines: string[], at: number, O: PLine[], N: PLine[], tier: number): string[] {
  const ctxIdx: number[] = [];
  O.forEach((o, j) => {
    if (o.ctx) ctxIdx.push(j);
  });
  const F = O.length > 0 ? leadingWs(fileLines[at] ?? '') : '';
  const P = O.length > 0 ? leadingWs(O[0]!.text) : '';
  let ci = 0;
  const mapped: string[] = N.map((n) => {
    if (n.ctx) {
      const j = ctxIdx[ci++];
      return j === undefined ? n.text : (fileLines[at + j] ?? n.text);
    }
    return tier === 2 ? reindentLine(n.text, F, P) : n.text;
  });
  return [...fileLines.slice(0, at), ...mapped, ...fileLines.slice(at + O.length)];
}

/** Insert plain texts at position `at` (no re-indent: no O to take P from). */
export function insertAt(fileLines: string[], at: number, texts: string[]): string[] {
  return [...fileLines.slice(0, at), ...texts, ...fileLines.slice(at)];
}
