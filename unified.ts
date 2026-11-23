// Unified diff parser (SPEC.md section 6).
import {
  Exit2,
  Fail,
  insertAt,
  matchTier,
  parseFile,
  safe,
  serializeFile,
  spliceAt,
  type Edit,
  type PLine,
} from './lib.ts';

interface BodyLine {
  kind: ' ' | '-' | '+' | '\\';
  text: string;
  /** The raw patch line was zero-length (an empty line, not a line holding one space). */
  rawEmpty: boolean;
}

interface Hunk {
  /** Old start line A (1-based) from the @@ header; B and D are not used. */
  a: number;
  body: BodyLine[];
}

interface Section {
  /** Old path from a --- line: undefined = absent, null = /dev/null. */
  oldDash: string | null | undefined;
  /** New path from a +++ line: undefined = absent, null = /dev/null. */
  newDash: string | null | undefined;
  renameFrom: string | undefined;
  renameTo: string | undefined;
  diffOld: string | undefined;
  diffNew: string | undefined;
  newFile: boolean;
  deletedFile: boolean;
  hunks: Hunk[];
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const DIFF_GIT_RE = /^diff --git a\/(\S+) b\/(\S+)$/;

/** SPEC section 6: the path after the four characters, up to the first tab, trimmed; /dev/null is null; one leading a/ or b/ removed. */
function dashPath(line: string): string | null {
  let rest = line.slice(4);
  const tab = rest.indexOf('\t');
  if (tab >= 0) rest = rest.slice(0, tab);
  rest = rest.trim();
  if (rest === '/dev/null') return null;
  if (rest.startsWith('a/') || rest.startsWith('b/')) rest = rest.slice(2);
  return rest;
}

/** Does a `\` line follow the hunk's last context or `+` line? */
function backslashAfterLastCtxOrPlus(body: BodyLine[]): boolean {
  let last = -1;
  for (let k = 0; k < body.length; k++) {
    if (body[k]!.kind === ' ' || body[k]!.kind === '+') last = k;
  }
  if (last < 0) return false;
  const next = body[last + 1];
  return next !== undefined && next.kind === '\\';
}

/** Apply a section's hunks in order to a parsed file; throws Fail('no-match', path). */
function applyHunks(
  model: { lines: string[]; br: string; final: boolean },
  hunks: Hunk[],
  strict: boolean,
  path: string,
): { lines: string[]; br: string; final: boolean } {
  let lines = model.lines;
  let final = model.final;
  let d = 0;
  for (const h of hunks) {
    const O: PLine[] = [];
    const N: PLine[] = [];
    for (const b of h.body) {
      if (b.kind === ' ') {
        O.push({ text: b.text, ctx: true });
        N.push({ text: b.text, ctx: true });
      } else if (b.kind === '-') O.push({ text: b.text, ctx: false });
      else if (b.kind === '+') N.push({ text: b.text, ctx: false });
    }
    const noEol = backslashAfterLastCtxOrPlus(h.body);
    if (O.length > 0) {
      const m = matchTier(lines, O.map((o) => o.text), strict);
      if (m === null) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let best = m.occ[0]!;
      for (const p of m.occ) {
        if (Math.abs(p - target) < Math.abs(best - target)) best = p;
      }
      if (best + O.length === lines.length) final = !noEol;
      lines = spliceAt(lines, best, O, N, m.tier);
    } else {
      const at = Math.max(0, Math.min(h.a + d, lines.length));
      if (at === lines.length) final = !noEol;
      lines = insertAt(lines, at, N.map((n) => n.text));
    }
    d += N.length - O.length;
  }
  return { lines, br: model.br, final };
}

/** A created file ends with a line break unless a `\` line follows its last `+` line. */
function creationFinal(hunks: Hunk[]): boolean {
  let last: boolean | null = null;
  for (const h of hunks) {
    let lastPlus = -1;
    for (let k = 0; k < h.body.length; k++) {
      if (h.body[k]!.kind === '+') lastPlus = k;
    }
    if (lastPlus >= 0) {
      const next = h.body[lastPlus + 1];
      last = next !== undefined && next.kind === '\\';
    }
  }
  return last === null ? true : !last;
}

export function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let seenHunk = false;

  const startSection = (): Section => {
    const s: Section = {
      oldDash: undefined,
      newDash: undefined,
      renameFrom: undefined,
      renameTo: undefined,
      diffOld: undefined,
      diffNew: undefined,
      newFile: false,
      deletedFile: false,
      hunks: [],
    };
    sections.push(s);
    cur = s;
    seenHunk = false;
    return s;
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const ln = i + 1;
    if (line.startsWith('@@')) {
      const m = HUNK_RE.exec(line);
      if (m === null) throw new Exit2(`error: parse ${ln}`);
      if (cur === null) throw new Exit2(`error: parse ${ln}`);
      const a = Number(m[1]);
      const body: BodyLine[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const bl = lines[j]!;
        // A `--- ` line followed by a `+++ ` line ends the body even though it starts with `-`.
        if (bl.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
        if (bl === '') {
          body.push({ kind: ' ', text: '', rawEmpty: true });
          j++;
          continue;
        }
        const c = bl[0]!;
        if (c === ' ' || c === '-' || c === '+' || c === '\\') {
          body.push({ kind: c as BodyLine['kind'], text: bl.slice(1), rawEmpty: false });
          j++;
          continue;
        }
        break;
      }
      // Empty lines at the end of a body are not part of it (zero-length lines only;
      // a line holding one space is a context line with empty text and stays).
      while (body.length > 0 && body[body.length - 1]!.rawEmpty) body.pop();
      cur.hunks.push({ a, body });
      seenHunk = true;
      i = j;
      continue;
    }
    if (line === 'diff --git' || line.startsWith('diff --git ')) {
      const m = DIFF_GIT_RE.exec(line);
      if (m === null) throw new Exit2(`error: parse ${ln}`);
      const s = startSection();
      s.diffOld = m[1];
      s.diffNew = m[2];
      i++;
      continue;
    }
    if (line.startsWith('--- ')) {
      if (cur !== null && !seenHunk) {
        // Inside a section's header: the next line must be a +++ line.
        const next = lines[i + 1];
        if (next === undefined || !next.startsWith('+++ ')) throw new Exit2(`error: parse ${i + 2}`);
        cur.oldDash = dashPath(line);
        cur.newDash = dashPath(next);
        i += 2;
        continue;
      }
      // Outside a header: a section starts only at a --- line followed by a +++ line.
      const next = lines[i + 1];
      if (next !== undefined && next.startsWith('+++ ')) {
        const s = startSection();
        s.oldDash = dashPath(line);
        s.newDash = dashPath(next);
        i += 2;
        continue;
      }
      i++;
      continue;
    }
    if (line.startsWith('+++ ')) {
      if (cur !== null && !seenHunk) cur.newDash = dashPath(line);
      i++;
      continue;
    }
    if (cur !== null && !seenHunk) {
      // Other header lines: rename from/to, new/deleted file mode; index/mode/similarity/Index: and the rest are ignored.
      if (line.startsWith('rename from ')) {
        cur.renameFrom = line.slice('rename from '.length).trim();
      } else if (line.startsWith('rename to ')) {
        cur.renameTo = line.slice('rename to '.length).trim();
      } else if (line === 'new file mode' || line.startsWith('new file mode ')) {
        cur.newFile = true;
      } else if (line === 'deleted file mode' || line.startsWith('deleted file mode ')) {
        cur.deletedFile = true;
      }
      i++;
      continue;
    }
    // Prose, code fences and anything else outside a body or a header: ignored.
    i++;
  }

  const edits: Edit[] = [];
  for (const s of sections) {
    const oldP: string | null =
      s.oldDash !== undefined ? s.oldDash : s.renameFrom !== undefined ? s.renameFrom : (s.diffOld ?? null);
    const newP: string | null =
      s.newDash !== undefined ? s.newDash : s.renameTo !== undefined ? s.renameTo : (s.diffNew ?? null);
    const isCreate = oldP === null || s.newFile;
    const isDelete = !isCreate && (newP === null || s.deletedFile);
    const isMove = !isCreate && !isDelete && oldP !== null && newP !== null && oldP !== newP;

    if (isCreate) {
      const plusLines: string[] = [];
      for (const h of s.hunks) for (const b of h.body) if (b.kind === '+') plusLines.push(b.text);
      const fin = creationFinal(s.hunks);
      edits.push((tree) => {
        if (newP === null) throw new Fail('unsafe', '/dev/null');
        if (!safe(newP)) throw new Fail('unsafe', newP);
        if (tree.get(newP) !== null) throw new Fail('exists', newP);
        tree.now.set(newP, serializeFile({ lines: plusLines, br: '\n', final: fin }));
      });
      continue;
    }
    if (isDelete) {
      const p = oldP as string;
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
      });
      continue;
    }
    if (isMove) {
      const oldS = oldP as string;
      const newS = newP as string;
      edits.push((tree) => {
        if (!safe(oldS)) throw new Fail('unsafe', oldS);
        if (!safe(newS)) throw new Fail('unsafe', newS);
        const before = tree.get(oldS);
        if (before === null) throw new Fail('missing', oldS);
        if (tree.get(newS) !== null) throw new Fail('exists', newS);
        const out = applyHunks(parseFile(before), s.hunks, strict, oldS);
        const text = serializeFile(out);
        tree.now.set(newS, text);
        tree.now.set(oldS, null);
        tree.moves.push([oldS, newS]);
      });
      continue;
    }
    const p = oldP as string;
    edits.push((tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      const out = applyHunks(parseFile(before), s.hunks, strict, p);
      tree.now.set(p, serializeFile(out));
    });
  }
  return edits;
}
