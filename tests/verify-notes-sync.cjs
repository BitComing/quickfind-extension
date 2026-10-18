// 验证 P5-1：用 updatedAt 短路「自己写出去的回声」，但**不能**挡住别的标签页的改动。
//
// 这是本次最容易改错的一处：短路条件写宽一点（比如按内容比对、或按时间接近判断），
// 就会把真实的跨标签页同步一起挡掉——而那种故障在单标签页里测不出来。
//
// 两个方向都要证：① 自己写 → 不重复处理；② 别人写 → 必须生效。

const path = require('path');
const fs = require('fs');
const os = require('os');
const { resolvePlaywright, resolveChrome } = require('./helpers.cjs');

const { chromium } = resolvePlaywright();
const CHROME = resolveChrome(chromium);
const ROOT = path.resolve(__dirname, '..');
const EXT = path.join(ROOT, '.output/chrome-mv3');

let failures = 0;
function check(label, ok, detail) {
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail === undefined ? '' : '  → ' + detail}`);
}

/** 读笔记页当前渲染出的条目文本，用来判断界面是否跟随了存储。 */
const readOutline = (page) => page.evaluate(() => {
  const inputs = Array.from(document.querySelectorAll('#notes-outline .note-input'));
  return inputs.map((i) => i.value);
});

(async () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qf-echo-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: !process.env.QF_HEADED,
    executablePath: CHROME,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-first-run'],
    viewport: { width: 1100, height: 800 },
  });
  const worker = context.serviceWorkers()[0] || (await context.waitForEvent('serviceworker'));
  const extId = new URL(worker.url()).host;

  // 两个选项页 = 两个「标签页」，用它们验证跨页同步。
  const pageA = await context.newPage();
  await pageA.goto(`chrome-extension://${extId}/options.html`);
  await pageA.waitForTimeout(1200);
  const pageB = await context.newPage();
  await pageB.goto(`chrome-extension://${extId}/options.html`);
  await pageB.waitForTimeout(1200);
  console.log(`已打开两个选项页（模拟两个标签页）\n`);

  // 切到笔记面板
  for (const p of [pageA, pageB]) {
    await p.click('.nav-item[data-panel="notes"]');
    await p.waitForTimeout(600);
  }

  // 种一份可识别的笔记
  await pageA.evaluate(() => new Promise((resolve) => chrome.storage.local.set({
    'quickfind-notes': {
      version: 2, rootId: 'root', updatedAt: 1000,
      nodes: {
        root: { id: 'root', parentId: null, children: ['seed1'], text: '', collapsed: false, completed: false, createdAt: 1, updatedAt: 1 },
        seed1: { id: 'seed1', parentId: 'root', children: [], text: '初始条目', collapsed: false, completed: false, createdAt: 1, updatedAt: 1 },
      },
    },
  }, resolve)));
  await pageA.waitForTimeout(900);
  await pageB.waitForTimeout(900);

  const seedA = await readOutline(pageA);
  const seedB = await readOutline(pageB);
  check('A 页面渲染出初始笔记', seedA.includes('初始条目'), JSON.stringify(seedA));
  check('B 页面渲染出初始笔记', seedB.includes('初始条目'), JSON.stringify(seedB));

  // ---------- 方向 ①：自己写 → 界面一致，不出现重复处理 ----------
  console.log('\n【1】自己写入后界面保持一致（回声被短路但不影响正确性）');
  await pageA.evaluate(() => {
    const input = document.querySelector('#notes-outline .note-input');
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    setter.call(input, 'A 改过的条目');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await pageA.waitForTimeout(1200); // 等 350ms 防抖落盘 + 回声处理
  const afterA = await readOutline(pageA);
  check('A 页面保留自己的编辑', afterA.includes('A 改过的条目'), JSON.stringify(afterA));
  check('A 页面没有出现重复条目', afterA.length === 1, `条目数 ${afterA.length}`);

  // ---------- 方向 ②：别人写 → 必须生效（这是短路会不会改坏的关键） ----------
  console.log('\n【2】另一个标签页写入后必须生效（短路不能挡住真实同步）');
  // B 页面直接改存储，模拟「侧栏或别的标签页」写入。updatedAt 必须与 A 的不同。
  const wrote = await pageB.evaluate(() => new Promise((resolve) => {
    chrome.storage.local.get('quickfind-notes', (v) => {
      const cur = v['quickfind-notes'];
      const next = JSON.parse(JSON.stringify(cur));
      next.updatedAt = Date.now() + 5000; // 明确晚于 A 的副本
      next.nodes.seed1.text = 'B 写入的新内容';
      chrome.storage.local.set({ 'quickfind-notes': next }, () => resolve({ updatedAt: next.updatedAt }));
    });
  }));
  await pageA.waitForTimeout(1200);
  const crossA = await readOutline(pageA);
  check('A 页面收到并渲染了 B 的改动', crossA.includes('B 写入的新内容'), JSON.stringify(crossA));
  console.log(`        B 写入的 updatedAt = ${wrote.updatedAt}`);

  // ---------- 方向 ③：内容相同但 updatedAt 不同 → 也不该出错 ----------
  console.log('\n【3】同内容不同 updatedAt：应被内容签名挡住，界面不变');
  await pageB.evaluate(() => new Promise((resolve) => {
    chrome.storage.local.get('quickfind-notes', (v) => {
      const next = JSON.parse(JSON.stringify(v['quickfind-notes']));
      next.updatedAt = Date.now() + 9000; // 内容不变，只动时间戳
      chrome.storage.local.set({ 'quickfind-notes': next }, resolve);
    });
  }));
  await pageA.waitForTimeout(1000);
  const sameContent = await readOutline(pageA);
  check('界面内容未变、未出现重复行', sameContent.length === 1 && sameContent.includes('B 写入的新内容'), JSON.stringify(sameContent));

  console.log('');
  console.log(`========== ${failures === 0 ? '全部通过' : failures + ' 项未通过'} ==========`);
  await context.close();
  process.exit(failures === 0 ? 0 : 1);
})();