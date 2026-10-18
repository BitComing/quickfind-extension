// 一次性验证（用完即删）：top layer 的进出是否成对。
//
// 为什么必须专门测这个：把宿主提升到 top layer 之后，如果某条收起路径漏了「收回」，
// 一个透明全屏宿主会一直留在页面最上层，把页面自己的弹窗、下拉、按钮全挡住——
// 而这种缺陷在「看起来都正常」的截图里完全看不出来。
//
// 判据用 host.matches(':popover-open')，即浏览器对 top layer 状态的真实回答。

const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const { resolvePlaywright, EXT, resolveChrome } = require('./helpers.cjs');
const { chromium } = resolvePlaywright();
const CHROME = resolveChrome(chromium);

let failures = 0;
function check(label, ok, detail) {
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail === undefined ? '' : '  → ' + detail}`);
}

const PAGE = `<!doctype html><meta charset="utf-8"><title>toplayer</title>
<body style="font:16px sans-serif">
  <p id="text">这一段文字用来产生选区，验证 top layer 的进出是否成对。</p>
  <button id="page-btn" style="position:fixed;left:20px;bottom:20px">页面自己的按钮</button>
  <div id="tall" style="height:2000px"></div>
</body>`;

/** 读两个宿主的 top layer 状态，以及页面按钮是否还能被点中。 */
function layerState(page) {
  return page.evaluate(() => {
    const read = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      let open = null;
      try { open = el.matches(':popover-open'); } catch { open = 'unsupported'; }
      return { open, hidden: el.hidden };
    };
    // 页面按钮中心点上，最上层是谁 —— 宿主若挂在 top layer，这里会是宿主。
    const btn = document.getElementById('page-btn');
    const r = btn.getBoundingClientRect();
    const chain = document.elementsFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2));
    return {
      main: read('#quickfind-shadow-host'),
      pinned: read('#quickfind-pinned-search-host'),
      buttonTop: chain[0] ? (chain[0].id || chain[0].tagName) : null,
    };
  });
}

async function selectText(page) {
  await page.evaluate(() => {
    const node = document.getElementById('text').firstChild;
    const range = document.createRange();
    range.setStart(node, 0); range.setEnd(node, 8);
    const sel = window.getSelection();
    sel.removeAllRanges(); sel.addRange(range);
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: 220, clientY: 100 }));
  });
  await page.waitForTimeout(500);
}

(async () => {
  const server = http.createServer((request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(PAGE);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/`;

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qf-toplayer-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: !process.env.QF_HEADED, executablePath: CHROME,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-first-run'],
    viewport: { width: 1100, height: 800 },
  });
  const worker = context.serviceWorkers()[0] || (await context.waitForEvent('serviceworker'));
  const extId = new URL(worker.url()).host;
  const optionsPage = await context.newPage();
  await optionsPage.goto(`chrome-extension://${extId}/options.html`);
  await optionsPage.waitForTimeout(1500);

  const page = await context.newPage();
  page.on('pageerror', (e) => { failures += 1; console.log(`  FAIL  页面抛错：${e.message}`); });
  await page.goto(url);
  await page.waitForTimeout(1200);

  // ---------- 1. 初始：主宿主不该占用；常驻栏可见（allSites 默认开）则应当在 ----------
  console.log('【1】初始状态：主宿主不占用，可见的常驻栏应当占用');
  const initial = await layerState(page);
  check('主宿主未进入 top layer（触发点尚未出现）', initial.main.open === false, JSON.stringify(initial.main));
  check('常驻栏可见、已进入 top layer', initial.pinned.open === true, JSON.stringify(initial.pinned));
  check('页面按钮可点到（宿主 pointer-events:none 不拦页面交互）', initial.buttonTop === 'page-btn', String(initial.buttonTop));

  // ---------- 2. 选中文字 → 提升且触发点可被命中；点页面空白 → 必须收回 ----------
  console.log('\n【2】选中文字后提升（触发点可命中），点击页面空白后收回');
  await selectText(page);
  const selected = await layerState(page);
  check('选中文字后主宿主进入 top layer', selected.main.open === true, JSON.stringify(selected.main));

  // 关键：top layer 的意义是「交互元素能被命中」。宿主本身 pointer-events:none，
  // 所以要测触发点本身能不能被点到，而不是宿主有没有拦页面。
  const hitTrigger = await page.evaluate(() => {
    const hostEl = document.querySelector('#quickfind-shadow-host');
    const root = hostEl?.shadowRoot;
    const trigger = root?.querySelector('.quickfind-trigger');
    if (!trigger) return { found: false };
    const r = trigger.getBoundingClientRect();
    const cx = Math.round(r.left + r.width / 2), cy = Math.round(r.top + r.height / 2);
    // document 视角的 elementsFromPoint 只会返回影子宿主（拿不到内部节点），
    // 真正能判断「有没有被页面层压住」的是影子根自己的命中测试。
    const inner = root.elementFromPoint ? root.elementFromPoint(cx, cy) : null;
    const docChain = document.elementsFromPoint(cx, cy).map((el) => el.id || el.tagName);
    return {
      found: true,
      innerTag: inner ? inner.tagName : null,
      hitsTrigger: Boolean(inner && (inner === trigger || trigger.contains(inner))),
      docChain: docChain.slice(0, 3),
    };
  });
  check('触发点可被命中（在 top layer 且未被页面层压住）', hitTrigger.hitsTrigger === true, JSON.stringify(hitTrigger));

  await page.mouse.click(600, 400); // 点页面空白
  await page.waitForTimeout(500);
  const dismissed = await layerState(page);
  check('点空白后主宿主退出 top layer', dismissed.main.open === false, JSON.stringify(dismissed.main));
  check('页面按钮恢复可点', dismissed.buttonTop === 'page-btn', String(dismissed.buttonTop));

  // ---------- 3. Esc 关闭后面板也要收回 ----------
  console.log('\n【3】打开面板后按 Esc 必须收回');
  await selectText(page);
  await page.evaluate(() => {
    const root = document.querySelector('#quickfind-shadow-host')?.shadowRoot;
    const trigger = root?.querySelector('.quickfind-trigger');
    trigger?.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 240, clientY: 100 }));
  });
  await page.waitForTimeout(400);
  const opened = await layerState(page);
  check('面板打开时宿主在 top layer', opened.main.open === true, JSON.stringify(opened.main));

  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);
  const afterEsc = await layerState(page);
  check('Esc 后宿主退出 top layer', afterEsc.main.open === false, JSON.stringify(afterEsc.main));
  check('Esc 后页面按钮恢复可点', afterEsc.buttonTop === 'page-btn', String(afterEsc.buttonTop));

  // ---------- 4. 常驻栏显示/隐藏成对 ----------
  console.log('\n【4】常驻栏的 top layer 进出成对');
  const pinnedVisible = await layerState(page);
  check('常驻栏可见时宿主在 top layer', pinnedVisible.pinned.open === true, JSON.stringify(pinnedVisible.pinned));

  // 关掉 allSites 让常驻栏隐藏
  await optionsPage.evaluate(() => new Promise((resolve) => chrome.storage.sync.set({
    pinnedSearch: { sites: [], customSites: [], defaultGroupCount: 4, collapseDelay: 1000, openInNewTab: false, allSites: false, siteConfigVersion: 3 },
  }, resolve)));
  await page.waitForTimeout(800);
  const pinnedHidden = await layerState(page);
  check('常驻栏隐藏后宿主退出 top layer', pinnedHidden.pinned.open === false, JSON.stringify(pinnedHidden.pinned));
  check('常驻栏隐藏后页面按钮可点', pinnedHidden.buttonTop === 'page-btn', String(pinnedHidden.buttonTop));

  console.log('');
  console.log(`========== ${failures === 0 ? '全部通过' : failures + ' 项未通过'} ==========`);
  await context.close();
  await new Promise((resolve) => server.close(resolve));
  process.exit(failures === 0 ? 0 : 1);
})();