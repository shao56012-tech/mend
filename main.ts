// main.ts is mend, the CLI SPEC.md specifies (MIT). It implements SPEC.md sections 1 to 10: the command line, the
// output and exit codes, safe paths, format detection, the three-tier line matching of section 5, unified diffs
// (section 6), SEARCH/REPLACE blocks (section 7), V4A patches (section 8), JSON edits (section 9) and the
// all-or-nothing write of section 10. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** A file as lines (section 3): its own line break, and whether it ends with one. */
interface FileState {
  lines: string[];
  br: string;
  final: boolean;
}

function splitFile(text: string): FileState {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  let final = false;
  if (text.endsWith(br)) {
    lines.pop();
    final = true;
  }
  return { lines, br, final };
}

function joinFile(st: FileState): string {
  if (st.lines.length === 0) return '';
  return st.lines.join(st.br) + (st.final ? st.br : '');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Move edits that succeeded, in order, for the `R` output lines of section 2. */
  readonly moves: [string, string][] = [];
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

type Edit = (tree: Tree) => void;

// ---------- Section 5: matching lines at three tiers ----------

const leadWs = (s: string): string => /^[ \t]*/.exec(s)![0];
const stripTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const stripBoth = (s: string): string => stripTrail(s.replace(/^[ \t]+/, ''));

function tierKey(line: string, tier: number): string {
  return tier === 0 ? line : tier === 1 ? stripTrail(line) : stripBoth(line);
}

/** Occurrences of O in fileLines at the first tier that has any, at or after `from`; with eofOnly, only
 *  occurrences that end at the file's last line. Null when O occurs at no tier. */
function findTiers(fileLines: string[], O: string[], strict: boolean, from = 0, eofOnly = false): { tier: number; positions: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const oKeys = O.map((l) => tierKey(l, tier));
    const positions: number[] = [];
    for (let i = from; i + O.length <= fileLines.length; i += 1) {
      if (eofOnly && i + O.length !== fileLines.length) continue;
      let ok = true;
      for (let j = 0; j < O.length; j += 1) {
        if (tierKey(fileLines[i + j]!, tier) !== oKeys[j]) {
          ok = false;
          break;
        }
      }
      if (ok) positions.push(i);
    }
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

/** The first line at or after `from` equal to the anchor, at the first tier that has one (a single line). */
function findAnchor(fileLines: string[], anchor: string, from: number, strict: boolean): number {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const key = tierKey(anchor, tier);
    for (let i = from; i < fileLines.length; i += 1) {
      if (tierKey(fileLines[i]!, tier) === key) return i;
    }
  }
  return -1;
}

/** One line of a hunk or chunk body: context (in O and N), old (O only), new (N only), or a `\` line. */
interface BodyLine {
  kind: 'ctx' | 'del' | 'add' | 'bs';
  text: string;
}

function bodyOld(body: BodyLine[]): string[] {
  return body.filter((b) => b.kind === 'ctx' || b.kind === 'del').map((b) => b.text);
}

/** Whether a `\` line follows the body's last context or new line (sections 5 and 6, the final-break rule). */
function bsAfterLast(body: BodyLine[]): boolean {
  let last = -1;
  body.forEach((b, idx) => {
    if (b.kind === 'ctx' || b.kind === 'add') last = idx;
  });
  return last >= 0 && body[last + 1]?.kind === 'bs';
}

/** The lines a matched body writes in place of the file's lines at `pos`: context lines are the file's own,
 *  new lines are the patch's, re-indented at tier 2 as section 5 says. */
function bodySeg(fileLines: string[], pos: number, body: BodyLine[], tier: number): string[] {
  const out: string[] = [];
  let j = pos;
  let f = '';
  let p = '';
  if (tier === 2) {
    f = leadWs(fileLines[pos]!);
    const first = body.find((b) => b.kind === 'ctx' || b.kind === 'del');
    p = first ? leadWs(first.text) : '';
  }
  for (const b of body) {
    if (b.kind === 'ctx') {
      out.push(fileLines[j]!);
      j += 1;
    } else if (b.kind === 'del') {
      j += 1;
    } else if (b.kind === 'add') {
      let t = b.text;
      if (tier === 2 && t.trim() !== '' && t.startsWith(p)) t = f + t.slice(p.length);
      out.push(t);
    }
  }
  return out;
}

/** Section 5's tier-2 re-indent of one new line that is not a context line. */
function reindent(line: string, f: string, p: string): string {
  if (line.trim() === '') return line;
  return line.startsWith(p) ? f + line.slice(p.length) : line;
}

// ---------- Section 4: detecting the format ----------

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ---------- Section 6: unified diffs ----------

interface UHunk {
  a: number;
  body: BodyLine[];
}

interface USection {
  gitOld: string | null;
  gitNew: string | null;
  hdrOld: string | null;
  hdrNew: string | null;
  hasPair: boolean;
  renOld: string | null;
  renNew: string | null;
  newFile: boolean;
  delFile: boolean;
  hunks: UHunk[];
}

function gitPaths(line: string, ln: number): [string, string] {
  const rest = line.slice(11);
  if (!rest.startsWith('a/')) throw new Exit2(`error: parse ${ln}`);
  const sep = rest.indexOf(' b/', 2);
  if (sep < 0) throw new Exit2(`error: parse ${ln}`);
  const x = rest.slice(2, sep);
  const y = rest.slice(sep + 3);
  if (x === '' || y === '') throw new Exit2(`error: parse ${ln}`);
  return [x, y];
}

/** A `--- `/`+++ ` header path: after the four characters, up to the first tab, spaces removed, prefix removed. */
function hdrPath(line: string): string {
  let p = line.slice(4);
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = p.trim();
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: USection[] = [];
  let cur: USection | null = null;
  let inHeader = false;
  const newSection = (): USection => {
    const s: USection = { gitOld: null, gitNew: null, hdrOld: null, hdrNew: null, hasPair: false, renOld: null, renNew: null, newFile: false, delFile: false, hunks: [] };
    sections.push(s);
    cur = s;
    inHeader = true;
    return s;
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const [x, y] = gitPaths(line, i + 1);
      const s = newSection();
      s.gitOld = x;
      s.gitNew = y;
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur === null || !inHeader) newSection();
      cur!.hdrOld = hdrPath(line);
      cur!.hdrNew = hdrPath(lines[i + 1]!);
      cur!.hasPair = true;
      i += 2;
      continue;
    }
    if (cur !== null && inHeader && line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:\s.*)?$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const raw: string[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const l = lines[j]!;
        if (l.startsWith('diff --git ')) break;
        if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
        if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+' || l[0] === '\\') {
          raw.push(l);
          j += 1;
        } else break;
      }
      while (raw.length > 0 && raw[raw.length - 1] === '') raw.pop();
      const body: BodyLine[] = raw.map((l) =>
        l === '' ? { kind: 'ctx' as const, text: '' }
        : l[0] === ' ' ? { kind: 'ctx' as const, text: l.slice(1) }
        : l[0] === '-' ? { kind: 'del' as const, text: l.slice(1) }
        : l[0] === '+' ? { kind: 'add' as const, text: l.slice(1) }
        : { kind: 'bs' as const, text: l.slice(1) },
      );
      cur.hunks.push({ a: Number(m[1]), body });
      inHeader = false;
      i = j;
      continue;
    }
    if (cur !== null && inHeader) {
      if (line.startsWith('rename from ')) cur.renOld = line.slice(12).trim();
      else if (line.startsWith('rename to ')) cur.renNew = line.slice(10).trim();
      else if (line.startsWith('new file mode')) cur.newFile = true;
      else if (line.startsWith('deleted file mode')) cur.delFile = true;
    }
    i += 1;
  }
  return sections.map((s) => unifiedEdit(s, strict));
}

function applyUHunk(st: FileState, h: UHunk, d: number, strict: boolean, path: string): FileState {
  const O = bodyOld(h.body);
  const bs = bsAfterLast(h.body);
  if (O.length === 0) {
    const pos = Math.max(0, Math.min(h.a + d, st.lines.length));
    const adds = h.body.filter((b) => b.kind === 'add').map((b) => b.text);
    const lines = [...st.lines.slice(0, pos), ...adds, ...st.lines.slice(pos)];
    return { lines, br: st.br, final: pos === st.lines.length ? !bs : st.final };
  }
  const found = findTiers(st.lines, O, strict);
  if (found === null) throw new Fail('no-match', path);
  const target = h.a - 1 + d;
  let pos = found.positions[0]!;
  for (const p of found.positions) {
    if (Math.abs(p - target) < Math.abs(pos - target)) pos = p;
  }
  const seg = bodySeg(st.lines, pos, h.body, found.tier);
  const lines = [...st.lines.slice(0, pos), ...seg, ...st.lines.slice(pos + O.length)];
  const reachesEnd = pos + O.length === st.lines.length;
  return { lines, br: st.br, final: reachesEnd ? !bs : st.final };
}

function unifiedEdit(s: USection, strict: boolean): Edit {
  let oldRaw: string | null;
  let newRaw: string | null;
  if (s.hasPair) {
    oldRaw = s.hdrOld;
    newRaw = s.hdrNew;
  } else if (s.renOld !== null || s.renNew !== null) {
    oldRaw = s.renOld ?? s.gitOld;
    newRaw = s.renNew ?? s.gitNew;
  } else {
    oldRaw = s.gitOld;
    newRaw = s.gitNew;
  }
  const oldPath = oldRaw === '/dev/null' ? null : oldRaw;
  const newPath = newRaw === '/dev/null' ? null : newRaw;
  const hunks = s.hunks;
  if (s.newFile || oldPath === null) {
    const target = newPath ?? oldPath ?? '';
    return (tree) => {
      if (!safe(target)) throw new Fail('unsafe', target);
      if (tree.get(target) !== null) throw new Fail('exists', target);
      const out: string[] = [];
      let lastBs = false;
      for (const h of hunks) {
        for (let k = 0; k < h.body.length; k += 1) {
          const b = h.body[k]!;
          if (b.kind === 'add') {
            out.push(b.text);
            lastBs = h.body[k + 1]?.kind === 'bs';
          }
        }
      }
      tree.now.set(target, out.length === 0 ? '' : out.join('\n') + (lastBs ? '' : '\n'));
    };
  }
  if (s.delFile || newPath === null) {
    const target = oldPath ?? newPath ?? '';
    return (tree) => {
      if (!safe(target)) throw new Fail('unsafe', target);
      if (tree.get(target) === null) throw new Fail('missing', target);
      tree.now.set(target, null);
    };
  }
  const from = oldPath!;
  const to = newPath!;
  const move = from !== to;
  return (tree) => {
    if (!safe(from)) throw new Fail('unsafe', from);
    if (move && !safe(to)) throw new Fail('unsafe', to);
    const before = tree.get(from);
    if (before === null) throw new Fail('missing', from);
    if (move && tree.get(to) !== null) throw new Fail('exists', to);
    let st = splitFile(before);
    let d = 0;
    for (const h of hunks) {
      st = applyUHunk(st, h, d, strict, from);
      let nLen = 0;
      let oLen = 0;
      for (const b of h.body) {
        if (b.kind === 'ctx') {
          nLen += 1;
          oLen += 1;
        } else if (b.kind === 'add') nLen += 1;
        else if (b.kind === 'del') oLen += 1;
      }
      d += nLen - oLen;
    }
    const text = joinFile(st);
    if (move) {
      tree.now.set(from, null);
      tree.now.set(to, text);
      tree.moves.push([from, to]);
    } else tree.now.set(from, text);
  };
}

// ---------- Section 7: SEARCH/REPLACE blocks ----------

function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const st = splitFile(before);
    const found = findTiers(st.lines, oldLines, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.positions.length > 1) throw new Fail('ambiguous', path);
    const pos = found.positions[0]!;
    let nLines = newLines;
    if (found.tier === 2) {
      const f = leadWs(st.lines[pos]!);
      const p = leadWs(oldLines[0]!);
      nLines = newLines.map((l) => reindent(l, f, p));
    }
    st.lines.splice(pos, oldLines.length, ...nLines);
    tree.now.set(path, joinFile(st));
  };
}

function srEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let from = 0;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    let path: string | null = null;
    for (let k = i - 1; k >= from; k -= 1) {
      const l = lines[k]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${i + 1}`);
      path = prevPath;
    }
    let eq = -1;
    for (let k = i + 1; k < lines.length; k += 1) {
      if (lines[k]!.trimEnd() === '=======') {
        eq = k;
        break;
      }
    }
    if (eq < 0) throw new Exit2(`error: parse ${i + 1}`);
    let rep = -1;
    for (let k = eq + 1; k < lines.length; k += 1) {
      if (lines[k]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = k;
        break;
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(srEdit(path, lines.slice(i + 1, eq), lines.slice(eq + 1, rep), strict));
    prevPath = path;
    from = rep + 1;
    i = rep + 1;
  }
  return edits;
}

// ---------- Section 8: V4A patches ----------

interface VChunk {
  anchor: string | null;
  body: BodyLine[];
  eof: boolean;
}

type RawLine = { text: string; idx: number };

function v4aAdd(path: string, raw: RawLine[]): Edit {
  const fileLines: string[] = [];
  for (const r of raw) {
    if (r.text.startsWith('+')) fileLines.push(r.text.slice(1));
    else if (r.text === '') fileLines.push('');
    else throw new Exit2(`error: parse ${r.idx + 1}`);
  }
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
  };
}

function v4aDelete(path: string, raw: RawLine[]): Edit {
  for (const r of raw) {
    if (!blank(r.text)) throw new Exit2(`error: parse ${r.idx + 1}`);
  }
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

function v4aUpdate(path: string, raw: RawLine[], headerIdx: number, strict: boolean): Edit {
  let moveTo: string | null = null;
  let start = 0;
  if (raw.length > 0 && raw[0]!.text.startsWith('*** Move to: ')) {
    moveTo = raw[0]!.text.slice(13).trim();
    start = 1;
  }
  const chunks: VChunk[] = [];
  let cur: VChunk | null = null;
  const pushCur = (): void => {
    if (cur !== null) {
      chunks.push(cur);
      cur = null;
    }
  };
  for (let k = start; k < raw.length; k += 1) {
    const { text: l, idx } = raw[k]!;
    if (l.startsWith('@@')) {
      pushCur();
      const anchor = l.slice(2).trim();
      cur = { anchor: anchor === '' ? null : anchor, body: [], eof: false };
    } else if (l[0] === '*' && l.trim() === '*** End of File') {
      if (cur === null) throw new Exit2(`error: parse ${idx + 1}`);
      cur.eof = true;
      pushCur();
    } else if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
      if (cur === null) {
        if (chunks.length > 0) throw new Exit2(`error: parse ${idx + 1}`);
        cur = { anchor: null, body: [], eof: false };
      }
      if (l === '') cur.body.push({ kind: 'ctx', text: '' });
      else if (l[0] === ' ') cur.body.push({ kind: 'ctx', text: l.slice(1) });
      else if (l[0] === '-') cur.body.push({ kind: 'del', text: l.slice(1) });
      else cur.body.push({ kind: 'add', text: l.slice(1) });
    } else throw new Exit2(`error: parse ${idx + 1}`);
  }
  pushCur();
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${headerIdx + 1}`);
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const st = splitFile(before);
    let fileLines = st.lines;
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        const at = findAnchor(fileLines, ch.anchor, cursor, strict);
        if (at < 0) throw new Fail('no-match', path);
        cursor = at + 1;
      }
      const O = bodyOld(ch.body);
      if (O.length === 0) {
        const adds = ch.body.filter((b) => b.kind === 'add').map((b) => b.text);
        const ins = ch.eof ? fileLines.length : Math.min(cursor, fileLines.length);
        fileLines = [...fileLines.slice(0, ins), ...adds, ...fileLines.slice(ins)];
        cursor = ins + adds.length;
      } else {
        const found = findTiers(fileLines, O, strict, cursor, ch.eof);
        if (found === null) throw new Fail('no-match', path);
        const pos = found.positions[0]!;
        const seg = bodySeg(fileLines, pos, ch.body, found.tier);
        fileLines = [...fileLines.slice(0, pos), ...seg, ...fileLines.slice(pos + O.length)];
        cursor = pos + seg.length;
      }
    }
    const text = joinFile({ lines: fileLines, br: st.br, final: st.final });
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, text);
      tree.moves.push([path, moveTo]);
    } else tree.now.set(path, text);
  };
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const firstIdx = lines.findIndex((l) => !blank(l));
  if (firstIdx < 0) throw new Exit2('error: parse 1');
  if (lines[firstIdx]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${firstIdx + 1}`);
  let lastIdx = -1;
  for (let k = lines.length - 1; k >= 0; k -= 1) {
    if (!blank(lines[k]!)) {
      lastIdx = k;
      break;
    }
  }
  if (lines[lastIdx]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const isHeader = (l: string): 'add' | 'del' | 'upd' | null =>
    l.startsWith('*** Add File: ') ? 'add' : l.startsWith('*** Delete File: ') ? 'del' : l.startsWith('*** Update File: ') ? 'upd' : null;
  const edits: Edit[] = [];
  let i = firstIdx + 1;
  while (i < lastIdx) {
    const line = lines[i]!;
    if (blank(line)) {
      i += 1;
      continue;
    }
    const kind = isHeader(line);
    if (kind === null) throw new Exit2(`error: parse ${i + 1}`);
    const path = line.slice(kind === 'add' ? 14 : 17).trim();
    const headerIdx = i;
    const raw: RawLine[] = [];
    let j = i + 1;
    while (j < lastIdx && isHeader(lines[j]!) === null) {
      raw.push({ text: lines[j]!, idx: j });
      j += 1;
    }
    while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();
    if (kind === 'add') edits.push(v4aAdd(path, raw));
    else if (kind === 'del') edits.push(v4aDelete(path, raw));
    else edits.push(v4aUpdate(path, raw, headerIdx, strict));
    i = j;
  }
  return edits;
}

// ---------- Section 9: JSON edits ----------

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------- Sections 1, 2 and 10: the command line, the output, the all-or-nothing write ----------

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits =
      kind === 'json' ? jsonEdits(text, lines)
      : kind === 'unified' ? unifiedEdits(lines, strict)
      : kind === 'search-replace' ? srEdits(lines, strict)
      : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const moveCount = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = moveCount;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const changed: string[] = [];
  for (const p of tree.now.keys()) {
    if (tree.original(p) !== tree.now.get(p)!) changed.push(p);
  }
  if (!check) {
    for (const p of changed) {
      const now = tree.now.get(p)!;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  const byPath = new Map<string, { key: string; line: string }>();
  for (const p of changed) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    byPath.set(p, { key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  for (const [o, n] of tree.moves) {
    const dRow = byPath.get(o);
    const aRow = byPath.get(n);
    if (dRow !== undefined && aRow !== undefined && dRow.line.startsWith('D ') && aRow.line.startsWith('A ')) {
      byPath.delete(o);
      byPath.set(n, { key: n, line: `R ${o} -> ${n}` });
    }
  }
  const rows = [...byPath.values()]
    .sort((x, y) => Buffer.compare(Buffer.from(x.key, 'utf8'), Buffer.from(y.key, 'utf8')))
    .map((r) => r.line);
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
