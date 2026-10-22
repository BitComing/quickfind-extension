/**
 * 视频页面搜索体验的回归用例：按键分区、常驻栏命中、空查询回落、新标签激活。
 *
 * 三个缺陷本体（都在真实视频站上复现过）：
 *
 * 1. 在扩展输入框里按空格会暂停视频。
 *    视频站的通用判法是「document 捕获阶段监听 keydown，target 是 INPUT/TEXTAREA 就放行」。
 *    扩展的输入框在 shadow DOM 里，页面侧看到的 event.target 被重定向成宿主 <div>，
 *    那条判定失效，空格被当成全站播放/暂停快捷键。
 *    原先的隔断只认选区浮层那一个输入框，常驻搜索栏与 LLM 侧栏各是独立 shadow root，
 *    按键全部漏给页面。
 *
 * 2. 常驻搜索栏收起态的热区必须严格贴边。
 *    栏收起时宿主曾保持整条栏的宽度，且坐标判定允许「栏下沿 98px 以内」都算命中，
 *    于是鼠标划过页面顶部一大片区域都会把栏勾出来，即用户反馈的「响应的范围过大」。
 *    现在宿主宽度恒定、收起只收栏高，热区严格等于 .reveal-handle 自己的 52x24 矩形：
 *    划过图标位置不展开，划过贴边把手才展开，展开后点图标能搜索。
 *    另外框内为空时点图标不能只聚焦输入框、要搜索——页面上明明有可搜的内容。
 *
 * 3. 搜索结果在新标签里后台打开，用户看不到。
 *
 * 全部断言落在真实产物上：加载构建目录 → 打开页面 → 真实鼠标/键盘操作 → 读运行时 DOM。
 * 不依赖 git HEAD，也不依赖任何历史版本。
 */

const { createChecker, launchWithExtension } = require('./helpers.cjs');

const PANEL_HOST = '#quickfind-shadow-host';
const PINNED_HOST = '#quickfind-pinned-search-host';
const { check, summary } = createChecker();

/**
 * 被测页面：模仿视频站的按键处理。
 *
 * 判定「可编辑」用 target.tagName —— 这正是 B 站/YouTube 的写法，
 * 也是本缺陷能复现的前提：扩展输入框在 shadow DOM 里，页面拿到的是宿主 div。
 */
const PAGE = `<!doctype html><meta charset="utf-8"><title>qf video-like</title>
<style>body{font:16px sans-serif;margin:0;padding:24px;height:2400px}#stage{width:400px;height:220px;background:#222;color:#fff}</style>
<body>
  <input id="site-q" name="q" placeholder="搜索" style="width:360px;height:32px">
  <div id="stage">假视频区</div>
  <p id="para">页面上的一段文字，用来在扩展浮层里产生查询内容。</p>
  <script>
    window.__pageKeys = [];
    window.__pauses = 0;
    document.addEventListener('keydown', (e) => {
      const t = e.target;
      const tag = t && t.tagName ? t.tagName : '';
      const editable = tag === 'INPUT' || tag === 'TEXTAREA' || (t && t.isContentEditable);
      window.__pageKeys.push(e.code);
      if (!editable && e.code === 'Space') window.__pauses += 1;
    }, true);
  </script>
</body>`;

const rectOf = (page, host, inner) => page.evaluate(({ h, i }) => {
  const el = document.querySelector(h)?.shadowRoot?.querySelector(i);
  return el ? el.getBoundingClientRect().toJSON() : null;
}, { h: host, i: inner });

/**
 * 把 URL 彻底解码后再比对查询词。
 *
 * 不能直接拿 encodeURIComponent(词) 去匹配落地 URL：搜索引擎遇到速率限制会跳到
 * /sorry/index 这类重定向页，把原始查询串整段塞进 continue 参数再编码一层，
 * 于是词在地址里出现两次、编码层数也不同。解码到底再子串匹配才稳。
 */
const decodeDeep = (value) => {
  let out = String(value || '');
  for (let i = 0; i < 3; i += 1) {
    try {
      const next = decodeURIComponent(out);
      if (next === out) break;
      out = next;
    } catch { break; }
  }
  return out;
};

/** 命中点是否落在扩展宿主的 shadow 内。可点性必须这样验，不能只看"点击后状态变了"。 */
const hitInHost = (page, host, x, y) => page.evaluate(({ h, px, py }) => {
  const el = document.elementFromPoint(px, py);
  const hostEl = document.querySelector(h);
  return !!(hostEl && el && (el === hostEl || hostEl.contains(el)));
}, { h: host, px: x, py: y });

const state = (page) => page.evaluate(({ ph, nh }) => {
  const panelRoot = document.querySelector(ph)?.shadowRoot;
  const pinnedRoot = document.querySelector(nh)?.shadowRoot;
  const pinnedHost = document.querySelector(nh);
  const bar = pinnedRoot?.querySelector('.bar');
  return {
    panelVisible: panelRoot?.querySelector('.quickfind-panel')?.classList.contains('visible') ?? null,
    panelEngines: panelRoot?.querySelectorAll('.engine-list .engine').length ?? null,
    panelQuery: panelRoot?.querySelector('.query-input')?.value ?? null,
    pinnedCollapsed: pinnedHost?.classList.contains('is-collapsed') ?? null,
    pinnedHidden: pinnedHost?.hidden ?? null,
    pinnedValue: pinnedRoot?.querySelector('.pinned-query')?.value ?? null,
    barHeight: bar ? Math.round(bar.getBoundingClientRect().height) : null,
    pinnedFocused: pinnedRoot?.activeElement?.className || null,
  };
}, { ph: PANEL_HOST, nh: PINNED_HOST });

/** 记录页面导航（整页跳转或新开标签）。 */
async function navWatch(env, page, action, waitMs = 2400) {
  const beforePages = env.context.pages().length;
  const beforeUrl = await page.evaluate(() => location.href);
  await action();
  await page.waitForTimeout(waitMs);
  let url = beforeUrl;
  try { url = await page.evaluate(() => location.href); } catch { /* 导航中 */ }
  return { beforePages, afterPages: env.context.pages().length, beforeUrl, url,
    navigated: env.context.pages().length > beforePages || url !== beforeUrl };
}

(async () => {
  const env = await launchWithExtension();
  try {
    const optionsPage = await env.openOptionsPage();
    const setConfig = (pinned) => optionsPage.evaluate((value) => new Promise((resolve) => chrome.storage.sync.set(value, resolve)), pinned);

    const url = await env.serve(PAGE);

    // ================= 1. 扩展输入框的按键不泄漏给页面 =================
    console.log('【1】扩展输入框里的空格与方向键不泄漏给页面');
    await setConfig({
      searchHistory: [],
      pinnedSearch: { sites: [], customSites: [], defaultGroupCount: 4, collapseDelay: 60000,
        openInNewTab: false, allSites: true, siteConfigVersion: 3 },
      triggerMode: 'click', editableTriggerMode: 'click', selectionTriggerDelay: 0, llmDockVisible: false,
    });
    const page = await env.context.newPage();
    await page.goto(url);
    await page.waitForTimeout(1400);

    // -- 常驻搜索栏 --
    await page.evaluate((h) => document.querySelector(h)?.shadowRoot?.querySelector('.reveal-handle')?.click(), PINNED_HOST);
    await page.waitForTimeout(400);
    const boxRect = await rectOf(page, PINNED_HOST, '.pinned-query');
    await page.mouse.click(boxRect.x + boxRect.width / 2, boxRect.y + boxRect.height / 2);
    await page.waitForTimeout(150);
    const focusedPre = await page.evaluate((h) => document.querySelector(h)?.shadowRoot?.activeElement?.className || null, PINNED_HOST);
    check('常驻输入框拿到焦点（前置条件）', focusedPre === 'pinned-query', JSON.stringify(focusedPre));

    await page.keyboard.type('hello world');
    await page.keyboard.press('ArrowLeft');
    await page.waitForTimeout(250);
    const pinnedKeys = await page.evaluate(() => ({ keys: window.__pageKeys, pauses: window.__pauses }));
    const pinnedValue = (await state(page)).pinnedValue;
    check('常驻输入框收到了完整文字（输入本身没被吞）', pinnedValue === 'hello world', JSON.stringify(pinnedValue));
    check('页面未收到空格（修复点）', !pinnedKeys.keys.includes('Space'), JSON.stringify(pinnedKeys.keys));
    check('页面未因空格暂停（修复点）', pinnedKeys.pauses === 0, 'pauses=' + pinnedKeys.pauses);
    check('页面未收到方向键（修复点）', !pinnedKeys.keys.includes('ArrowLeft'), JSON.stringify(pinnedKeys.keys));
    // 普通字母仍然外传：证明不是把所有按键都吞掉，页面自身的键盘操作不受影响。
    check('普通字母键仍照常传给页面', pinnedKeys.keys.filter((k) => k.startsWith('Key')).length >= 8, JSON.stringify(pinnedKeys.keys));

    // -- 选区浮层（对照，原先就只有它被隔断）--
    await page.evaluate(() => { window.__pageKeys = []; window.__pauses = 0; });
    await page.evaluate(() => {
      const node = document.getElementById('para');
      const range = document.createRange();
      range.selectNodeContents(node);
      const s = window.getSelection();
      s.removeAllRanges();
      s.addRange(range);
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: 30, clientY: 120 }));
    });
    await page.waitForTimeout(700);
    const trigRect = await rectOf(page, PANEL_HOST, '.quickfind-trigger');
    await page.mouse.click(trigRect.x + trigRect.width / 2, trigRect.y + trigRect.height / 2);
    await page.waitForTimeout(500);
    const qRect = await rectOf(page, PANEL_HOST, '.query-input');
    await page.mouse.click(qRect.x + qRect.width / 2, qRect.y + qRect.height / 2);
    await page.waitForTimeout(150);
    await page.keyboard.press('Space');
    await page.waitForTimeout(200);
    const panelKeys = await page.evaluate(() => window.__pageKeys);
    check('浮层输入框里的空格同样不泄漏（既有行为，防回归）', !panelKeys.includes('Space'), JSON.stringify(panelKeys));
    console.log('');

    // ================= 2. 收起态热区严格贴边 =================
    console.log('【2】常驻栏收起态的热区严格贴边：划过图标位置不展开，划过贴边把手才展开');
    // 收起栏（收起按钮已移除，走真实用户路径：指针移出栏 → 自动收起）。
    // 本用例的 collapseDelay 是 60000，等不了自动收起，改为直接把指针移出栏后
    // 用展开态/收起态之外的等价真实动作 —— 这里为了只测热区几何，仍以类的切换为准，
    // 但必须先断言「自动收起链路本身可用」由 verify-pinned-click-and-collapse 覆盖。
    await page.evaluate((h) => {
      const host = document.querySelector(h);
      host.classList.add('is-collapsed');
      host.shadowRoot.querySelector('.reveal-handle')?.setAttribute('aria-expanded', 'false');
    }, PINNED_HOST);
    await page.waitForTimeout(520);
    const collapsed = await state(page);
    check('常驻栏已收起（前置条件）', collapsed.pinnedCollapsed === true, JSON.stringify(collapsed));

    // 量出「展开后图标应在的位置」——这是上一版热区允许直达的位置，现在必须不再响应。
    const iconSpot = await page.evaluate((h) => {
      const hostEl = document.querySelector(h);
      hostEl.classList.remove('is-collapsed');
      const el = hostEl.shadowRoot.querySelector('.entries .entry');
      const r = el.getBoundingClientRect().toJSON();
      hostEl.classList.add('is-collapsed');
      return r;
    }, PINNED_HOST);
    const tx = iconSpot.x + iconSpot.width / 2;
    const ty = iconSpot.y + iconSpot.height / 2;

    // 收起态的几何：宿主**不再收窄**（收窄会让收起动画横向跳变，见 content/index.ts），
    // 热区由把手自己的 52×24 矩形承担，所以断言量把手而不是宿主。
    const collapsedGeom = await page.evaluate((h) => {
      const hostEl = document.querySelector(h);
      const round = (n) => Math.round(n);
      const hr = hostEl.getBoundingClientRect();
      const handle = hostEl.shadowRoot.querySelector('.reveal-handle');
      const rr = handle.getBoundingClientRect();
      return { host: [round(hr.x), round(hr.y), round(hr.width), round(hr.height)],
        handle: [round(rr.x), round(rr.y), round(rr.width), round(rr.height)] };
    }, PINNED_HOST);
    check('收起态把手本身就是热区（52×24，响应范围不放大）',
      collapsedGeom.handle[2] <= 60 && collapsedGeom.handle[3] <= 30,
      JSON.stringify(collapsedGeom));
    check('收起态宿主宽度保持整条栏（保证收起动画无横向位移）',
      collapsedGeom.host[2] > 100, JSON.stringify(collapsedGeom.host));
    check('收起态把手贴在屏幕顶边（贴边，修复点）',
      collapsedGeom.handle[1] === 0, JSON.stringify(collapsedGeom.handle));

    // 反例：横向划过「展开后图标所在位置」不得把栏勾出来。
    await page.mouse.move(700, 500);
    await page.mouse.move(700, ty - 6);
    await page.mouse.move(tx - 2, ty - 2);
    await page.mouse.move(tx + 2, ty + 2);
    await page.mouse.move(tx, ty);
    await page.waitForTimeout(400);
    const afterIconSweep = await state(page);
    check('划过图标位置不展开（响应范围过大已修正）', afterIconSweep.pinnedCollapsed === true,
      'collapsed=' + afterIconSweep.pinnedCollapsed);

    // 正例：划过贴边把手（真实用户路径），必须展开；再点图标发起搜索。
    const hx = collapsedGeom.handle[0] + collapsedGeom.handle[2] / 2;
    const hy = collapsedGeom.handle[1] + collapsedGeom.handle[3] / 2;
    await page.mouse.move(700, 500);
    await page.mouse.move(700, 2);
    await page.mouse.move(hx - 2, 2);
    await page.mouse.move(hx + 2, 3);
    await page.mouse.move(hx, hy);
    await page.waitForTimeout(400);
    const afterHandleSweep = await state(page);
    check('划过贴边把手即展开（修复点）', afterHandleSweep.pinnedCollapsed === false,
      'collapsed=' + afterHandleSweep.pinnedCollapsed);

    const nav = await navWatch(env, page, async () => {
      const icon = await rectOf(page, PINNED_HOST, '.entries .entry');
      const cx = icon.x + icon.width / 2;
      const cy = icon.y + icon.height / 2;
      await page.mouse.move(cx - 2, cy - 2);
      await page.mouse.move(cx + 2, cy + 2);
      await page.mouse.move(cx, cy);
      await page.waitForTimeout(120);
      const hit = await hitInHost(page, PINNED_HOST, cx, cy);
      check('点击瞬间命中点落在常驻栏内（热区生效，修复点）', hit === true, 'inHost=' + hit);
      await page.mouse.down();
      await page.mouse.up();
    });
    check('展开后点图标即可发起搜索（修复点）', nav.navigated === true, JSON.stringify(nav));
    console.log('');

    // ================= 3. 框为空时回落到页面查询 =================
    console.log('【3】常驻框为空时，回落到页面搜索框与 URL 查询');
    // 场景 A：页面搜索框里有词
    const page2 = await env.context.newPage();
    await page2.goto(url);
    await page2.waitForTimeout(1400);
    await page2.evaluate(() => {
      const input = document.getElementById('site-q');
      input.value = '页面搜索框里的词';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page2.waitForTimeout(400);
    await page2.evaluate((h) => document.querySelector(h)?.shadowRoot?.querySelector('.reveal-handle')?.click(), PINNED_HOST);
    await page2.waitForTimeout(450);
    // 主动清空常驻框，并确认它确实是空的
    const cleared = await page2.evaluate((h) => {
      const input = document.querySelector(h).shadowRoot.querySelector('.pinned-query');
      input.focus();
      input.value = '';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.blur();
      return input.value;
    }, PINNED_HOST);
    await page2.waitForTimeout(300);
    const emptyNow = (await state(page2)).pinnedValue;
    check('常驻框已清空（前置条件）', emptyNow === '', JSON.stringify({ cleared, emptyNow }));
    const icon2 = await rectOf(page2, PINNED_HOST, '.entries .entry');
    const nav2 = await navWatch(env, page2, async () => {
      await page2.mouse.move(icon2.x + icon2.width / 2, icon2.y + icon2.height / 2);
      await page2.waitForTimeout(120);
      await page2.mouse.down();
      await page2.mouse.up();
    });
    check('空框时点图标仍发起搜索（回落页面查询，修复点）', nav2.navigated === true, JSON.stringify(nav2));
    check('搜索地址里带的是页面搜索框的词', decodeDeep(nav2.url).includes('页面搜索框里的词'), decodeDeep(nav2.url).slice(0, 120));

    // 场景 B：URL 里有查询参数
    const page3 = await env.context.newPage();
    await page3.goto(`${url}?q=地址里的词`);
    await page3.waitForTimeout(1400);
    await page3.evaluate((h) => document.querySelector(h)?.shadowRoot?.querySelector('.reveal-handle')?.click(), PINNED_HOST);
    await page3.waitForTimeout(450);
    const box3 = await page3.evaluate((h) => {
      const input = document.querySelector(h).shadowRoot.querySelector('.pinned-query');
      input.focus();
      input.value = '';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.blur();
      return input.value;
    }, PINNED_HOST);
    await page3.waitForTimeout(300);
    check('框已清空（前置条件）', box3 === '', JSON.stringify(box3));
    const icon3 = await rectOf(page3, PINNED_HOST, '.entries .entry');
    const nav3 = await navWatch(env, page3, async () => {
      await page3.mouse.move(icon3.x + icon3.width / 2, icon3.y + icon3.height / 2);
      await page3.waitForTimeout(120);
      await page3.mouse.down();
      await page3.mouse.up();
    });
    check('空框时用 URL 查询参数搜索（回落，修复点）', nav3.navigated === true, JSON.stringify(nav3));
    check('搜索地址里带的是 URL 查询参数', decodeDeep(nav3.url).includes('地址里的词'), decodeDeep(nav3.url).slice(0, 120));

    // 场景 C：三处都没有内容时才把焦点交给输入框
    const page4 = await env.context.newPage();
    await page4.goto(url);
    await page4.waitForTimeout(1400);
    await page4.evaluate((h) => document.querySelector(h)?.shadowRoot?.querySelector('.reveal-handle')?.click(), PINNED_HOST);
    await page4.waitForTimeout(450);
    await page4.evaluate((h) => {
      const input = document.querySelector(h).shadowRoot.querySelector('.pinned-query');
      input.focus();
      input.value = '';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.blur();
    }, PINNED_HOST);
    await page4.waitForTimeout(300);
    const icon4 = await rectOf(page4, PINNED_HOST, '.entries .entry');
    const before4 = await page4.evaluate(() => location.href);
    await page4.mouse.move(icon4.x + icon4.width / 2, icon4.y + icon4.height / 2);
    await page4.waitForTimeout(120);
    await page4.mouse.down();
    await page4.mouse.up();
    // 焦点要在点击后的一小段时间内轮询：栏可能因自动收起而把焦点丢掉，
    // 单看某一个时刻会误判成「从未聚焦过」。
    let focusedAtAnyPoint = false;
    for (let i = 0; i < 8; i += 1) {
      await page4.waitForTimeout(120);
      const probe = await page4.evaluate((h) => document.querySelector(h)?.shadowRoot?.activeElement?.className || null, PINNED_HOST);
      if (probe === 'pinned-query') { focusedAtAnyPoint = true; break; }
    }
    const url4 = await page4.evaluate(() => location.href);
    check('三处都无词时不跳转（既有行为）', url4 === before4, url4.slice(0, 60));
    check('三处都无词时把焦点交给常驻输入框（修复点）', focusedAtAnyPoint === true, 'focused=' + focusedAtAnyPoint);
    console.log('');

    // ================= 4. 新标签打开并自动切过去 =================
    console.log('【4】搜索结果在新标签打开，且自动切换过去');
    await setConfig({
      searchHistory: [{ query: '新标签场景词', timestamp: Date.now() }],
      pinnedSearch: { sites: [], customSites: [], defaultGroupCount: 4, collapseDelay: 60000,
        openInNewTab: true, allSites: true, siteConfigVersion: 3 },
    });
    const page5 = await env.context.newPage();
    await page5.goto(url);
    await page5.waitForTimeout(1400);
    await page5.evaluate((h) => document.querySelector(h)?.shadowRoot?.querySelector('.reveal-handle')?.click(), PINNED_HOST);
    await page5.waitForTimeout(450);
    const icon5 = await rectOf(page5, PINNED_HOST, '.entries .entry');
    const nav5 = await navWatch(env, page5, async () => {
      await page5.mouse.move(icon5.x + icon5.width / 2, icon5.y + icon5.height / 2);
      await page5.waitForTimeout(120);
      await page5.mouse.down();
      await page5.mouse.up();
    }, 2600);
    check('常驻栏确实新开了标签页', nav5.afterPages > nav5.beforePages, `${nav5.beforePages} -> ${nav5.afterPages}`);
    const activeAfterPinned = await optionsPage.evaluate(() => new Promise((resolve) => {
      chrome.tabs.query({ active: true, currentWindow: true }, (t) => resolve(t.map((x) => x.url || '')));
    }));
    check('新标签被激活（用户能直接看到结果）', activeAfterPinned.some((u) => u.includes('google') || u.includes('baidu') || u.includes('bing')), JSON.stringify(activeAfterPinned));

    // 弹窗入口：此前是 active:false，在后台打开，用户以为点了没反应
    const popup = await env.context.newPage();
    await popup.goto(`chrome-extension://${env.extId}/popup.html`);
    await popup.waitForTimeout(1500);
    await popup.evaluate(() => {
      const input = document.querySelector('#query-input');
      input.value = '弹窗新标签词';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const beforePopup = env.context.pages().length;
    await popup.evaluate(() => document.querySelector('#engine-settings .engine-row')?.click());
    await popup.waitForTimeout(2400);
    check('弹窗确实新开了标签页', env.context.pages().length > beforePopup, `${beforePopup} -> ${env.context.pages().length}`);
    const activeAfterPopup = await optionsPage.evaluate(() => new Promise((resolve) => {
      chrome.tabs.query({ active: true, currentWindow: true }, (t) => resolve(t.map((x) => x.url || '')));
    }));
    check('弹窗的新标签也被激活（修复点）', activeAfterPopup.some((u) => u.includes('google') || u.includes('baidu') || u.includes('bing')), JSON.stringify(activeAfterPopup));
    const popupUrls = env.context.pages().map((p) => p.url());
    check('弹窗的搜索地址带着输入内容', popupUrls.some((u) => decodeDeep(u).includes('弹窗新标签词')), JSON.stringify(popupUrls.slice(-2).map((u) => decodeDeep(u).slice(0, 90))));
    console.log('');

    return summary();
  } finally {
    await env.close();
  }
})().then((code) => process.exit(code));