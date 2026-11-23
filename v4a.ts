// V4A parser (SPEC.md section 8).
import {
  blank,
  Exit2,
  Fail,
  findFirstAtOrAfter,
  findOccurrences,
  insertAt,
  parseFile,
  safe,
  serializeFile,
  spliceAt,
  type Edit,
  type PLine,
  type Tree,
} from './lib.ts';

const ADD_PREFIX = '*** Add File: ';
const DEL_PREFIX = '*** Delete File: ';
const UPD_PREFIX = '*** Update File: ';
const MOVE_PREFIX = '*** Move to:';

function isHeader(l: string): boolean {
  return l.startsWith(ADD_PREFIX) || l.startsWith(DEL_PREFIX) || l.startsWith(UPD_PREFIX);
}

type BodyLine = { kind: 'ctx' | 'old' | 'new'; text: string; raw: string };
interface Chunk {
  anchor: string | null;
  body: BodyLine[];
  eof: boolean;
}

export function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!blank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);

  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    if (blank(lines[i]!)) {
      i++;
      continue;
    }
    let kind: 'add' | 'delete' | 'update';
    let path: string;
    if (lines[i]!.startsWith(ADD_PREFIX)) {
      kind = 'add';
      path = lines[i]!.slice(ADD_PREFIX.length).trim();
    } else if (lines[i]!.startsWith(DEL_PREFIX)) {
      kind = 'delete';
      path = lines[i]!.slice(DEL_PREFIX.length).trim();
    } else if (lines[i]!.startsWith(UPD_PREFIX)) {
      kind = 'update';
      path = lines[i]!.slice(UPD_PREFIX.length).trim();
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
    const headerNo = i + 1;
    i++;
    // Collect this section's lines, up to the next section header or End Patch.
    const raw: { text: string; no: number }[] = [];
    while (i < last && !isHeader(lines[i]!)) {
      raw.push({ text: lines[i]!, no: i + 1 });
      i++;
    }
    // Blank lines at the end of a section are not part of it.
    while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();

    if (kind === 'add') {
      const fileLines: string[] = [];
      for (const { text, no } of raw) {
        if (text.startsWith('+')) fileLines.push(text.slice(1));
        else if (text === '') fileLines.push('');
        else throw new Exit2(`error: parse ${no}`);
      }
      const p = path;
      const content = fileLines;
      edits.push((tree: Tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, content.length === 0 ? '' : content.join('\n') + '\n');
      });
      continue;
    }

    if (kind === 'delete') {
      if (raw.length > 0) throw new Exit2(`error: parse ${raw[0]!.no}`);
      const p = path;
      edits.push((tree: Tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
      });
      continue;
    }

    // Update File section.
    let moveTo: string | null = null;
    let pos = 0;
    if (raw.length > 0 && raw[0]!.text.startsWith(MOVE_PREFIX)) {
      moveTo = raw[0]!.text.slice(MOVE_PREFIX.length).trim();
      pos = 1;
    }
    const chunks: Chunk[] = [];
    let cur: Chunk | null = null;
    let startedAny = false;
    let between = false; // after a *** End of File, awaiting the next @@ line
    const finishChunk = (): void => {
      if (cur) {
        while (cur.body.length > 0 && blank(cur.body[cur.body.length - 1]!.raw)) cur.body.pop();
        chunks.push(cur);
        cur = null;
      }
    };
    for (; pos < raw.length; pos++) {
      const { text, no } = raw[pos]!;
      if (text.startsWith('@@')) {
        finishChunk();
        between = false;
        const a = text.slice(2).trim();
        cur = { anchor: a === '' ? null : a, body: [], eof: false };
        startedAny = true;
        continue;
      }
      if (text === '*** End of File') {
        if (!cur) throw new Exit2(`error: parse ${no}`);
        cur.eof = true;
        finishChunk();
        between = true;
        continue;
      }
      if (text.startsWith(MOVE_PREFIX)) throw new Exit2(`error: parse ${no}`);
      const isBody = text === '' || text.startsWith(' ') || text.startsWith('-') || text.startsWith('+');
      if (!isBody) throw new Exit2(`error: parse ${no}`);
      if (between) {
        if (blank(text)) continue;
        throw new Exit2(`error: parse ${no}`);
      }
      if (!cur) {
        cur = { anchor: null, body: [], eof: false };
        startedAny = true;
      }
      if (text === '') cur.body.push({ kind: 'ctx', text: '', raw: text });
      else if (text.startsWith(' ')) cur.body.push({ kind: 'ctx', text: text.slice(1), raw: text });
      else if (text.startsWith('-')) cur.body.push({ kind: 'old', text: text.slice(1), raw: text });
      else cur.body.push({ kind: 'new', text: text.slice(1), raw: text });
    }
    finishChunk();
    if (!startedAny && moveTo === null) throw new Exit2(`error: parse ${headerNo}`);

    const p = path;
    const dest = moveTo;
    const chunkList = chunks;
    edits.push((tree: Tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (dest !== null && !safe(dest)) throw new Fail('unsafe', dest);
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      if (dest !== null && tree.get(dest) !== null) throw new Fail('exists', dest);
      const model = parseFile(before);
      let fileLines = model.lines;
      let cursor = 0;
      const tiers = strict ? [0] : [0, 1, 2];
      for (const chunk of chunkList) {
        if (chunk.anchor !== null) {
          let found: number | null = null;
          for (const t of tiers) {
            const occ = findOccurrences(fileLines, [chunk.anchor], t).filter((idx) => idx >= cursor);
            if (occ.length > 0) {
              found = occ[0]!;
              break;
            }
          }
          if (found === null) throw new Fail('no-match', p);
          cursor = found + 1;
        }
        const O: PLine[] = [];
        const N: PLine[] = [];
        for (const b of chunk.body) {
          if (b.kind === 'ctx') {
            O.push({ text: b.text, ctx: true });
            N.push({ text: b.text, ctx: true });
          } else if (b.kind === 'old') {
            O.push({ text: b.text, ctx: false });
          } else {
            N.push({ text: b.text, ctx: false });
          }
        }
        if (O.length === 0) {
          const at = chunk.eof ? fileLines.length : cursor;
          const texts = N.map((n) => n.text);
          fileLines = insertAt(fileLines, at, texts);
          cursor = at + N.length;
        } else {
          const found = findFirstAtOrAfter(fileLines, O.map((o) => o.text), strict, cursor, chunk.eof);
          if (found === null) throw new Fail('no-match', p);
          fileLines = spliceAt(fileLines, found.pos, O, N, found.tier);
          cursor = found.pos + N.length;
        }
      }
      const out = serializeFile({ lines: fileLines, br: model.br, final: model.final });
      if (dest !== null) {
        tree.now.set(dest, out);
        tree.now.set(p, null);
        tree.moves.push([p, dest]);
      } else {
        tree.now.set(p, out);
      }
    });
  }
  return edits;
}
