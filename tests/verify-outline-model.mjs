// 一次性验证（用完即删）：把 shared/outline.ts 的模型层与「提取前」的两份实现做逐操作比对。
//
// 为什么需要它：五套 Playwright 回归只能覆盖到用户路径上会走到的分支。normalizeNotes 要处理
// 环、孤儿、不可达节点这些造不出来的坏数据，变更函数也有组合路径。这里用同一批操作序列
// 跑两套实现，逐条比对结果字符串——比「看起来一致」可靠。
//
// 旧实现直接从 git HEAD 的源码里取（用 eval 还原成可调用函数），新实现从 built 产物里取。

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(ROOT);

// ---------- 新实现：直接跑源码（Node 22 支持 type stripping）----------
// Windows 上动态 import 必须给 file:// URL，直接传绝对路径会被当成 c: 协议。
const outline = await import(pathToFileURL(path.join(ROOT, 'shared/outline.ts')).href);

// ---------- 旧实现：从 git HEAD 抽出函数体，eval 成同签名函数 ----------
const head = execFileSync('git', ['show', 'HEAD:entrypoints/content/index.ts'], { maxBuffer: 64e6 }).toString('utf8');
const lines = head.split(/\r?\n/);
function grabBody(name) {
  const i = lines.findIndex((l) => new RegExp('^  function ' + name + '\\b').test(l));
  if (i < 0) throw new Error('HEAD 里找不到 ' + name);
  let depth = 0, started = false, body = [];
  for (let j = i; j < lines.length; j += 1) {
    body.push(lines[j]);
    for (const ch of lines[j]) { if (ch === '{') { depth += 1; started = true; } else if (ch === '}') depth -= 1; }
    if (started && depth <= 0) break;
  }
  return body.join('\n');
}

/**
 * 旧实现的函数依赖 notesState / noteById 这类模块级名字，这里用闭包把它们做成可注入的。
 * 用 new Function 构造，形参即「外部依赖」，避免污染全局。
 */
function buildLegacy(stateHolder) {
  const bodies = {
    createEmptyNotes: grabBody('createEmptyNotes'),
    normalizeNotes: grabBody('normalizeNotes'),
    noteById: grabBody('noteById'),
    noteDepth: grabBody('noteDepth'),
    notePath: grabBody('notePath'),
    normal: grabBody('noteSubtreeHasMatch'),
    visibleNoteIds: grabBody('visibleNoteIds'),
    isNoteDescendant: grabBody('isNoteDescendant'),
    moveNote: grabBody('moveNote'),
    insertNoteAfter: grabBody('insertNoteAfter'),
    insertNoteChild: grabBody('insertNoteChild'),
    removeNote: grabBody('removeNote'),
    changeNoteIndent: grabBody('changeNoteIndent'),
    mergeNoteWithPrevious: grabBody('mergeNoteWithPrevious'),
  };
  // 这些函数原先是「直接改 notesState 并返回 id/boolean」。为了让两套实现可比，
  // 这里注入 no-op 的历史/落盘/渲染，把结果统一成「变更后的 state」。
  const src = `
    return function make(deps) {
      const { pushNotesHistory, scheduleNotesSave, renderNotes, noteSelection, notesZoomRootIdRef, notesActiveIdRef } = deps;
      let notesState = deps.initialState;
      let noteIdCounter = 0;
      // 旧实现里 cloneNotesState 有默认参数 state = notesState，必须在本作用域内定义才能读到它。
      function cloneNotesState(state = notesState) { return JSON.parse(JSON.stringify(state)); }
      const get = () => notesState;
      const setState = (s) => { notesState = s; };
      let notesZoomRootId = notesZoomRootIdRef.value;
      let notesActiveId = notesActiveIdRef.value;
      function noteId() { noteIdCounter += 1; return 'note-' + Date.now() + '-' + noteIdCounter; }
      ${bodies.noteById}
      ${bodies.noteDepth}
      ${bodies.notePath}
      ${bodies.normal}
      ${bodies.visibleNoteIds}
      ${bodies.isNoteDescendant}
      ${bodies.createEmptyNotes}
      ${bodies.normalizeNotes}
      ${bodies.moveNote}
      ${bodies.insertNoteAfter}
      ${bodies.insertNoteChild}
      ${bodies.removeNote}
      ${bodies.changeNoteIndent}
      ${bodies.mergeNoteWithPrevious}
      return {
        get, setState,
        normalizeNotes: (raw) => { notesState = normalizeNotes(raw); return notesState; },
        createEmptyNotes,
        visibleNoteIds: (q) => visibleNoteIds(q),
        noteDepth: (id, base) => noteDepth(id, base),
        notePath: (id) => notePath(id),
        isNoteDescendant: (a, b) => isNoteDescendant(a, b),
        moveNote: (s, t, p) => { moveNote(s, t, p); return notesState; },
        insertNoteAfter: (id, text) => { insertNoteAfter(id, text || ''); return notesState; },
        insertNoteChild: (id, text) => { insertNoteChild(id, text || ''); return notesState; },
        removeNote: (id) => { removeNote(id); return notesState; },
        changeNoteIndent: (id, out) => { changeNoteIndent(id, out, null); return notesState; },
        mergeNoteWithPrevious: (id) => { mergeNoteWithPrevious(id, { selectionStart: 0, selectionEnd: 0, value: '' }); return notesState; },
      };
    };
  `;
  return new Function(src)()(stateHolder);
}

// ---------- 构造测试数据（含坏数据） ----------
function makeState() {
  const s = outline.createEmptyNotes();
  const ids = ['n1', 'n2', 'n3', 'n4', 'n5'];
  ids.forEach((id, i) => {
    const now = Date.now();
    s.nodes[id] = { id, parentId: i < 2 ? 'root' : ids[i - 1], children: [], text: 'item ' + id, collapsed: false, completed: false, createdAt: now, updatedAt: now };
  });
  s.nodes.root.children = ['n1', 'n2'];
  s.nodes.n1.children = ['n3'];
  s.nodes.n2.children = ['n4'];
  s.nodes.n4.children = ['n5'];
  return s;
}

// 坏数据：环 / 孤儿 / 不可达 / 自指 / 非法 children
function makeBroken() {
  return {
    version: 2, rootId: 'root', updatedAt: 111,
    nodes: {
      root: { id: 'root', parentId: null, children: ['a', 'ghost'], text: '', collapsed: false, completed: false },
      a: { id: 'a', parentId: 'root', children: ['b'], text: 'A', collapsed: false, completed: false },
      b: { id: 'b', parentId: 'a', children: ['a'], text: 'B', collapsed: false, completed: false }, // 环 a↔?
      orphan: { id: 'orphan', parentId: 'missing', children: [], text: 'O', collapsed: false, completed: false },
      self: { id: 'self', parentId: 'self', children: ['self'], text: 'S', collapsed: false, completed: false },
      weird: { id: 'weird', parentId: 'root', children: 'not-an-array', text: 'W', collapsed: false, completed: false }, // children 非法
      ghost: { id: 'ghost', parentId: 'nobody', children: [], text: '', collapsed: false, completed: false },
    },
  };
}

const HOLDER = () => {
  const ref = { value: 'root' };
  return {
    initialState: makeState(),
    pushNotesHistory: () => {},
    scheduleNotesSave: () => {},
    renderNotes: () => {},
    noteSelection: () => ({ start: 0, end: 0, direction: 'none' }),
    notesZoomRootIdRef: ref,
    notesActiveIdRef: { value: null },
  };
};

const norm = (s) => JSON.stringify(s, Object.keys(s).sort());
const stateStr = (s) => JSON.stringify({ rootId: s.rootId, nodes: s.nodes }, Object.keys(s.nodes).sort().length ? undefined : undefined);
const ORIGINAL_IDS = new Set(['root', 'n1', 'n2', 'n3', 'n4', 'n5']);
/** 新生成的 id 两套实现必然不同（时间戳 vs 固定值），比对时统一折成 <new>，只比结构。 */
const foldId = (id) => (ORIGINAL_IDS.has(String(id)) ? String(id) : '<new>');
const pick = (s) => JSON.stringify({
  rootChildren: s.nodes.root.children.map(foldId),
  n1: (s.nodes.n1?.children || []).map(foldId),
  n2: (s.nodes.n2?.children || []).map(foldId),
  n4: (s.nodes.n4?.children || []).map(foldId),
  ids: Object.keys(s.nodes).map(foldId).sort(),
});

let checks = 0, bad = 0;
function compare(label, legacyFn, newFn) {
  checks += 1;
  const legacy = legacyFn();
  const next = newFn();
  const a = typeof legacy === 'string' ? legacy : pick(legacy);
  const b = typeof next === 'string' ? next : pick(next);
  if (a !== b) { bad += 1; console.log(`  ❌ ${label}\n      旧: ${a}\n      新: ${b}`); }
  else console.log(`  ✅ ${label}`);
}

console.log('【1】normalizeNotes 处理坏数据（环 / 孤儿 / 不可达 / 非法 children）');
{
  const L = buildLegacy(HOLDER());
  const legacyResult = L.normalizeNotes(JSON.parse(JSON.stringify(makeBroken())));
  const newResult = outline.normalizeNotes(JSON.parse(JSON.stringify(makeBroken())));
  compare('坏数据归一化结果一致（含 children 排序）', () => legacyResult, () => newResult);
}

console.log('\n【2】normalizeNotes 处理正常数据');
{
  const L = buildLegacy(HOLDER());
  const legacyResult = L.normalizeNotes(JSON.parse(JSON.stringify(makeState())));
  const newResult = outline.normalizeNotes(JSON.parse(JSON.stringify(makeState())));
  compare('正常数据归一化一致', () => legacyResult, () => newResult);
}

console.log('\n【3】查询函数');
{
  const L = buildLegacy(HOLDER());
  const s = makeState();
  const ls = L.normalizeNotes(JSON.parse(JSON.stringify(s)));
  const ns = outline.normalizeNotes(JSON.parse(JSON.stringify(s)));
  for (const [id, base] of [['n3', 'root'], ['n5', 'root'], ['n5', 'n2'], ['n1', 'root']]) {
    compare(`noteDepth(${id}, ${base})`, () => String(L.noteDepth(id, base)), () => String(outline.noteDepth(ns, id, base)));
  }
  compare('notePath(n5)', () => JSON.stringify(L.notePath('n5')), () => JSON.stringify(outline.notePath(ns, 'n5')));
  compare('isNoteDescendant(n5,n2)', () => String(L.isNoteDescendant('n5', 'n2')), () => String(outline.isNoteDescendant(ns, 'n5', 'n2')));
  compare('isNoteDescendant(n2,n5)', () => String(L.isNoteDescendant('n2', 'n5')), () => String(outline.isNoteDescendant(ns, 'n2', 'n5')));
  compare('visibleNoteIds(空查询)', () => JSON.stringify(L.visibleNoteIds('')), () => JSON.stringify(outline.visibleNoteIds(ns, 'root', '')));
  compare('visibleNoteIds(搜 item)', () => JSON.stringify(L.visibleNoteIds('item')), () => JSON.stringify(outline.visibleNoteIds(ns, 'root', 'item')));
  compare('visibleNoteIds(无匹配)', () => JSON.stringify(L.visibleNoteIds('zzz')), () => JSON.stringify(outline.visibleNoteIds(ns, 'root', 'zzz')));
}

console.log('\n【4】变更操作（每条各跑一遍，比对最终树）');
const ops = [
  ['moveNote n3 到 n2 之后', (E) => () => E.moveNote('n3', 'n2', 'after')],
  ['moveNote n3 到 n2 之内', (E) => () => E.moveNote('n3', 'n2', 'inside')],
  ['moveNote n3 到 n2 之前', (E) => () => E.moveNote('n3', 'n2', 'before')],
  ['moveNote 把自己移到自己的后代（应拒绝）', (E) => () => E.moveNote('n2', 'n5', 'after')],
  ['insertNoteAfter n1', (E) => () => E.insertNoteAfter('n1', 'new')],
  ['insertNoteChild n2', (E) => () => E.insertNoteChild('n2', 'child')],
  ['removeNote n1（子节点提升）', (E) => () => E.removeNote('n1')],
  ['removeNote root（应拒绝）', (E) => () => E.removeNote('root')],
  ['changeNoteIndent n2 缩进', (E) => () => E.changeNoteIndent('n2', false)],
  ['changeNoteIndent n3 反缩进', (E) => () => E.changeNoteIndent('n3', true)],
  ['changeNoteIndent n1 缩进（无前兄弟，应拒绝）', (E) => () => E.changeNoteIndent('n1', false)],
  ['mergeNoteWithPrevious n2', (E) => () => E.mergeNoteWithPrevious('n2')],
  ['mergeNoteWithPrevious n1（无前兄弟，应拒绝）', (E) => () => E.mergeNoteWithPrevious('n1')],
];
for (const [label, make] of ops) {
  const L = buildLegacy(HOLDER());
  const ls = L.normalizeNotes(JSON.parse(JSON.stringify(makeState())));
  L.setState(ls);
  const whateverLegacy = make(L)();
  const ns = outline.normalizeNotes(JSON.parse(JSON.stringify(makeState())));
  make({ ...outline, moveNote: (s, t, p) => outline.moveNote(ns, s, t, p), insertNoteAfter: (i, t) => outline.insertNoteAfter(ns, i, t, 'note-new'), insertNoteChild: (i, t) => outline.insertNoteChild(ns, i, t, 'note-new'), removeNote: (i) => outline.removeNote(ns, i), changeNoteIndent: (i, o) => outline.changeNoteIndent(ns, i, o), mergeNoteWithPrevious: (i) => outline.mergeNoteWithPrevious(ns, i) })();
  compare(label, () => pick(L.get()), () => pick(ns));
}

console.log('\n【5】Markdown 导入导出');
{
  const md = ['- 第一项', '  - 子项 A', '  - 子项 B', '- 第二项', '  - [x] 已完成项', '    - 更深一层'].join('\n');
  let counter = 0;
  const parsed = outline.parseMarkdownNotes(md, () => 'id' + (counter += 1));
  const shape = (s) => {
    const walk = (id, d = 0, out = []) => {
      (s.nodes[id]?.children || []).forEach((c) => { out.push(`${d}:${s.nodes[c].text}:${s.nodes[c].completed}`); walk(c, d + 1, out); });
      return out;
    };
    return walk('root');
  };
  compare('parseMarkdownNotes 结构', () => JSON.stringify(['0:第一项:false', '1:子项 A:false', '1:子项 B:false', '0:第二项:false', '1:已完成项:true', '2:更深一层:false']), () => JSON.stringify(shape(parsed)));
  const roundTrip = outline.notesToMarkdownLines(parsed).join('\n');
  console.log('  往返文本：\n' + roundTrip.split('\n').map((l) => '      ' + l).join('\n'));
  compare('导出后与输入一致（缩进与完成态）', () => md, () => roundTrip);
}

console.log(`\n========== ${bad === 0 ? `全部通过（${checks} 项）` : `${bad}/${checks} 项不一致`} ==========`);
process.exit(bad === 0 ? 0 : 1);