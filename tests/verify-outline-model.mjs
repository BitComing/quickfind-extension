#!/usr/bin/env node
/**
 * 大纲模型层的行为契约。
 *
 * 这里锁定的是「算得对不对」，不是「界面长什么样」——界面部分由 verify-note-bullet 覆盖。
 * 之所以单独测模型层：normalizeNotes 要处理环、孤儿、不可达节点、非法 children 这些
 * 界面上造不出来的坏数据，而它们一旦处理错，表现是「用户的笔记打开后少了几条」，
 * 不会报错，只会静默丢数据。
 *
 * 直接跑源码（Node 22 支持 type stripping），不需要构建产物，也不需要浏览器。
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outline = await import(pathToFileURL(path.join(ROOT, 'shared', 'outline.ts')).href);

let failures = 0;
let passes = 0;
function check(label, fn) {
  try {
    fn();
    passes += 1;
    console.log(`  PASS  ${label}`);
  } catch (error) {
    failures += 1;
    console.log(`  FAIL  ${label}\n        ${error.message}`);
  }
}

/**
 * 一棵形状明确的树：root → [n1, n2]，n1 → [n3]，n2 → [n4]，n4 → [n5]。
 *
 * parentId 与 children 必须显式写一致：模型层两种表示都读（notePath/noteDepth 走 parentId，
 * visibleNoteIds 走 children），夹具里一旦不一致，测出来的就不是模型的行为而是夹具的巧合。
 * 这里不用循环推导 parentId，就是为了不让两者有机会漂移。
 */
function tree() {
  const s = outline.createEmptyNotes();
  const now = Date.now();
  const spec = [
    { id: 'n1', parentId: 'root' },
    { id: 'n2', parentId: 'root' },
    { id: 'n3', parentId: 'n1' },
    { id: 'n4', parentId: 'n2' },
    { id: 'n5', parentId: 'n4' },
  ];
  spec.forEach(({ id, parentId }) => {
    s.nodes[id] = { id, parentId, children: [], text: 'item ' + id, collapsed: false, completed: false, createdAt: now, updatedAt: now };
  });
  s.nodes.root.children = ['n1', 'n2'];
  s.nodes.n1.children = ['n3'];
  s.nodes.n2.children = ['n4'];
  s.nodes.n4.children = ['n5'];
  return s;
}

/** 夹具自检：parentId 与 children 必须互相印证。放在每次使用前跑，避免夹具漂移后继续测。 */
function assertFixtureConsistent(s) {
  for (const node of Object.values(s.nodes)) {
    node.children.forEach((childId) => {
      assert.equal(s.nodes[childId]?.parentId, node.id, `夹具不一致：${childId} 的 parentId 不是 ${node.id}`);
    });
    if (node.id !== 'root') {
      const parent = s.nodes[node.parentId];
      assert.ok(parent?.children.includes(node.id), `夹具不一致：${node.id} 不在父节点 ${node.parentId} 的 children 里`);
    }
  }
}

const shape = (s) => JSON.stringify({
  root: s.nodes.root.children,
  n1: s.nodes.n1?.children,
  n2: s.nodes.n2?.children,
  n4: s.nodes.n4?.children,
});

console.log('【1】normalizeNotes 必须修好坏数据，不能丢节点');
check('全部节点都被保留（含孤儿/不可达/自指）', () => {
  const broken = {
    version: 2, rootId: 'root', updatedAt: 111,
    nodes: {
      root: { id: 'root', parentId: null, children: ['a'], text: '', collapsed: false, completed: false },
      a: { id: 'a', parentId: 'root', children: [], text: 'A', collapsed: false, completed: false },
      orphan: { id: 'orphan', parentId: 'missing', children: [], text: 'O', collapsed: false, completed: false },
      self: { id: 'self', parentId: 'self', children: ['self'], text: 'S', collapsed: false, completed: false },
      weird: { id: 'weird', parentId: 'root', children: 'not-an-array', text: 'W', collapsed: false, completed: false },
    },
  };
  const s = outline.normalizeNotes(broken);
  // 关键：一个都不能少。丢节点=用户笔记凭空消失。
  for (const id of ['a', 'orphan', 'self', 'weird']) {
    assert.ok(s.nodes[id], `节点 ${id} 被丢掉了`);
  }
});
check('孤儿与不可达节点被提到根下（可从根遍历到）', () => {
  const broken = {
    version: 2, rootId: 'root',
    nodes: {
      root: { id: 'root', parentId: null, children: [], text: '', collapsed: false, completed: false },
      orphan: { id: 'orphan', parentId: 'missing', children: [], text: 'O', collapsed: false, completed: false },
      self: { id: 'self', parentId: 'self', children: ['self'], text: 'S', collapsed: false, completed: false },
    },
  };
  const s = outline.normalizeNotes(broken);
  for (const id of ['orphan', 'self']) {
    assert.equal(s.nodes[id].parentId, 'root', `${id} 的父节点没被修正`);
    assert.ok(s.nodes.root.children.includes(id), `${id} 没被挂到根下`);
  }
});
check('环不会导致 children 自指或无限递归', () => {
  const cyclic = {
    version: 2, rootId: 'root',
    nodes: {
      root: { id: 'root', parentId: null, children: ['a'], text: '', collapsed: false, completed: false },
      a: { id: 'a', parentId: 'root', children: ['b'], text: 'A', collapsed: false, completed: false },
      b: { id: 'b', parentId: 'a', children: ['a'], text: 'B', collapsed: false, completed: false },
    },
  };
  const s = outline.normalizeNotes(cyclic);
  // a 不能既在 b 的子列表里、又是 b 的祖先，否则渲染时无限递归
  assert.ok(!s.nodes.b.children.includes('a'), 'a 被重复挂到 b 之下，形成环');
});
check('非对象输入回落到空笔记而不是抛错', () => {
  for (const input of [null, undefined, 42, 'x', {}, { nodes: null }]) {
    const s = outline.normalizeNotes(input);
    assert.ok(s.nodes.root, `输入 ${JSON.stringify(input)} 没有回落`);
  }
});
check('正常数据往返后形状不变', () => {
  const s = tree();
  const again = outline.normalizeNotes(JSON.parse(JSON.stringify(s)));
  assert.equal(shape(again), shape(s));
});

console.log('\n【2】查询');
check('noteDepth 数的是「base 之下有几层」', () => {
  const s = tree();
  assertFixtureConsistent(s);
  // root 的直接子节点为 0 层（树形缩进的基准），每下一层 +1。
  assert.equal(outline.noteDepth(s, 'n1'), 0);
  assert.equal(outline.noteDepth(s, 'n3'), 1);
  assert.equal(outline.noteDepth(s, 'n5'), 2);
  // 指定 base 后，从 base 往下重新计数。
  assert.equal(outline.noteDepth(s, 'n5', 'n2'), 1);
});
check('notePath 给出标题路径', () => {
  const s = tree();
  assertFixtureConsistent(s);
  assert.deepEqual(outline.notePath(s, 'n5'), ['item n2', 'item n4', 'item n5']);
});
check('isNoteDescendant 方向正确且不含自身', () => {
  const s = tree();
  assert.equal(outline.isNoteDescendant(s, 'n5', 'n2'), true);
  assert.equal(outline.isNoteDescendant(s, 'n2', 'n5'), false);
  assert.equal(outline.isNoteDescendant(s, 'n2', 'n2'), false);
});
check('visibleNoteIds：折叠时子节点不出现', () => {
  const s = tree();
  s.nodes.n2.collapsed = true;
  const visible = outline.visibleNoteIds(s, 'root', '');
  assert.deepEqual(visible.ids, ['n1', 'n3', 'n2'], '折叠后 n4/n5 不该出现');
});
check('visibleNoteIds：搜索时忽略折叠', () => {
  const s = tree();
  s.nodes.n2.collapsed = true;
  const visible = outline.visibleNoteIds(s, 'root', 'item n5');
  // 命中的项即使在折叠的子树里也必须显示，否则「搜到了却看不见」
  assert.ok(visible.ids.includes('n5'), '折叠子树里的命中项没显示');
});
check('countMatches 不含 scope 自身，但含其后代', () => {
  const s = tree();
  assertFixtureConsistent(s);
  // root 范围：5 个条目全部计入（不含 root 自己）
  assert.equal(outline.countMatches(s, 'root', 'item'), 5);
  // n2 范围：n2 自身被排除，只有后代 n4/n5 → 2。
  // 这个口径与「面包屑显示当前节点」一致：当前节点是范围本身，不该被当成命中结果。
  assert.equal(outline.countMatches(s, 'n2', 'item'), 2, 'n2 自身应被排除，只数 n4/n5');
});

console.log('\n【3】变更操作（含拒绝路径）');
check('moveNote 三种投放位置', () => {
  // 源节点统一取 n3（它是 n1 的子节点），三种落点都投到 n2 上。
  // 期望值按「n3 从 n1 移出后，按落点插到根级」推导：
  //   after  → 根级顺序 n1, n2, n3
  //   before → n3 插在 n2 之前 → n1, n3, n2
  //   inside → n3 成为 n2 的子节点，根级不变
  const cases = [
    ['after', ['n1', 'n2', 'n3'], ['n4']],
    ['before', ['n1', 'n3', 'n2'], ['n4']],
    // inside：n3 追加为 n2 的最后一个子节点。n5 仍在 n4 之下，不是 n2 的直接子节点。
    ['inside', ['n1', 'n2'], ['n4', 'n3']],
  ];
  for (const [placement, rootExpected, n2Expected] of cases) {
    const s = tree();
    const r = outline.moveNote(s, 'n3', 'n2', placement);
    assert.equal(r.changed, true, `placement=${placement} 应成功`);
    assert.deepEqual(s.nodes.root.children, rootExpected, `placement=${placement} 的根级顺序`);
    assert.deepEqual(s.nodes.n2.children, n2Expected, `placement=${placement} 的 n2 直接子节点`);
    assert.equal(s.nodes.n3.parentId, placement === 'inside' ? 'n2' : 'root', `placement=${placement} 的父节点`);
  }
});
check('moveNote 拒绝「移到自己后代」', () => {
  const s = tree();
  const before = shape(s);
  const r = outline.moveNote(s, 'n2', 'n5', 'after');
  assert.equal(r.changed, false);
  assert.equal(shape(s), before, '被拒绝的操作不该改动树');
});
check('insertNoteAfter 插在目标之后、同级', () => {
  const s = tree();
  const r = outline.insertNoteAfter(s, 'n1', 'new', 'newnode');
  assert.equal(r.changed, true);
  assert.deepEqual(s.nodes.root.children, ['n1', 'newnode', 'n2']);
});
check('insertNoteChild 追加到目标之下并展开它', () => {
  const s = tree();
  s.nodes.n2.collapsed = true;
  const r = outline.insertNoteChild(s, 'n2', 'new', 'newnode');
  assert.equal(r.changed, true);
  assert.deepEqual(s.nodes.n2.children, ['n4', 'newnode']);
  assert.equal(s.nodes.n2.collapsed, false, '插入子节点后应展开，否则新节点看不见');
});
check('removeNote 把子节点提升到父级，不连带删掉', () => {
  const s = tree();
  outline.removeNote(s, 'n2');
  assert.equal(s.nodes.n4.parentId, 'root');
  assert.ok(s.nodes.n5, 'n5 是 n4 的子节点，不该被删');
  assert.ok(s.nodes.root.children.includes('n4'));
});
check('removeNote 拒绝删除 root', () => {
  const s = tree();
  assert.equal(outline.removeNote(s, 'root').changed, false);
  assert.ok(s.nodes.root);
});
check('changeNoteIndent 缩进/反缩进/拒绝的首个兄弟', () => {
  const s = tree();
  outline.changeNoteIndent(s, 'n2', false);
  assert.equal(s.nodes.n2.parentId, 'n1', 'n2 应成为 n1 的子节点');
  const s2 = tree();
  outline.changeNoteIndent(s2, 'n3', true);
  assert.equal(s2.nodes.n3.parentId, 'root', 'n3 应提升到根级');
  const s3 = tree();
  assert.equal(outline.changeNoteIndent(s3, 'n1', false).changed, false, '第一个兄弟无法缩进');
});
check('mergeNoteWithPrevious 合并文本并接管子节点', () => {
  const s = tree();
  const r = outline.mergeNoteWithPrevious(s, 'n2');
  assert.equal(r.changed, true);
  assert.equal(s.nodes.n1.text, 'item n1item n2');
  assert.equal(s.nodes.n4.parentId, 'n1', 'n4 应转由 n1 接管');
  assert.equal(s.nodes.n2, undefined);
  assert.equal(typeof r.caret, 'number', '要返回合并点供光标定位');
});

console.log('\n【4】Markdown 导入导出（往返必须无损）');
const MD = ['- 第一项', '  - 子项 A', '  - 子项 B', '- 第二项', '  - [x] 已完成项', '    - 更深一层'].join('\n');
check('解析出正确的层级与完成态', () => {
  let n = 0;
  const s = outline.parseMarkdownNotes(MD, () => 'id' + (n += 1));
  const walk = (id, d = 0, out = []) => {
    (s.nodes[id]?.children || []).forEach((c) => { out.push(`${d}:${s.nodes[c].text}:${s.nodes[c].completed}`); walk(c, d + 1, out); });
    return out;
  };
  assert.deepEqual(walk('root'), ['0:第一项:false', '1:子项 A:false', '1:子项 B:false', '0:第二项:false', '1:已完成项:true', '2:更深一层:false']);
});
check('导出后与输入逐字一致（缩进与 [x]）', () => {
  let n = 0;
  const s = outline.parseMarkdownNotes(MD, () => 'id' + (n += 1));
  assert.equal(outline.notesToMarkdownLines(s).join('\n'), MD);
});
check('空输入不抛错', () => {
  assert.equal(outline.notesToMarkdownLines(outline.parseMarkdownNotes('', () => 'x')).length, 0);
});

console.log('');
console.log(`========== ${failures === 0 ? `全部通过（${passes} 项）` : `${failures} 项未通过（通过 ${passes} 项）`} ==========`);
process.exit(failures === 0 ? 0 : 1);