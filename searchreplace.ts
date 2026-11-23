// SEARCH/REPLACE parser (SPEC.md section 7).
import { blank, Exit2, Fail, matchTier, parseFile, safe, serializeFile, spliceAt, type Edit, type PLine, type Tree } from './lib.ts';

const SEARCH = '<<<<<<< SEARCH';
const SEP = '=======';
const END = '>>>>>>> REPLACE';

export function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let prevEnd = -1; // 0-based index of the previous block's >>>>>>> REPLACE line (-1: start of patch)
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== SEARCH) {
      i += 1;
      continue;
    }
    const searchIdx = i; // 0-based; its 1-based line number is searchIdx + 1

    // Path: nearest line before the SEARCH line and after the previous
    // block's >>>>>>> REPLACE line that is not blank and does not start
    // with three backticks (surrounding whitespace removed).
    let path: string | null = null;
    for (let j = searchIdx - 1; j > prevEnd; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      const t = l.trim();
      if (t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchIdx + 1}`);
      path = prevPath;
    }

    // The block needs a ======= line and then a >>>>>>> REPLACE line after it.
    let sepIdx = -1;
    let endIdx = -1;
    for (let j = searchIdx + 1; j < lines.length; j++) {
      const t = lines[j]!.trimEnd();
      if (t === END) {
        endIdx = j;
        break;
      }
      if (t === SEP && sepIdx === -1) sepIdx = j;
    }
    if (endIdx === -1 || sepIdx === -1) throw new Exit2(`error: parse ${searchIdx + 1}`);

    const oldLines = lines.slice(searchIdx + 1, sepIdx);
    const newLines = lines.slice(sepIdx + 1, endIdx);
    const p = path;
    edits.push((tree: Tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (oldLines.length === 0) {
        // Create: new lines are the file's content, LF, ending with a line
        // break unless there are no new lines (empty file).
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, newLines.length === 0 ? '' : `${newLines.join('\n')}\n`);
        return;
      }
      const cur = tree.get(p);
      if (cur === null) throw new Fail('missing', p);
      const file = parseFile(cur);
      const m = matchTier(file.lines, oldLines, strict);
      if (m === null) throw new Fail('no-match', p);
      if (m.occ.length > 1) throw new Fail('ambiguous', p);
      // New lines are all non-context lines; tier-2 re-indent is handled
      // by spliceAt.
      const O: PLine[] = oldLines.map((text) => ({ text, ctx: false }));
      const N: PLine[] = newLines.map((text) => ({ text, ctx: false }));
      const out = spliceAt(file.lines, m.occ[0]!, O, N, m.tier);
      tree.now.set(p, serializeFile({ lines: out, br: file.br, final: file.final }));
    });

    prevPath = p;
    prevEnd = endIdx;
    i = endIdx + 1;
  }
  return edits;
}
