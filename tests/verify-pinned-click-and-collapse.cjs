/**
 * 常驻搜索栏的「点击有效性」与「展开保持」回归用例。
 *
 * 覆盖两个在真实页面上复现过的缺陷：
 *
 * 1. 部分图标点了没反应。
 *    根因不是命中区太小（那是更早的缺陷，已修），而是按钮节点被高频重建：
 *    `MutationObserver(document.documentElement, {childList,subtree})` → schedulePinnedMount(120ms)
 *    → mountPinnedBar → renderPinnedBar → `entries.replaceChildren()`。页面 DOM 只要在变动
 *    （结果流、埋点、广告位持续增删节点），`.entries` 就被整体替换，实测每秒 6 次以上。
 *    用户在「按下」与「抬起」之间跨过一次替换时，两个事件落在不同元素上，`click` 不派发——
 *    表现为点了没反应，且是否中招取决于按压时长，所以只有「部分」图标有问题。
 *
 * 2. 点分组展开后，过一会儿栏被自动收回。
 *    重建把「正持有焦点」的按钮移出文档，浏览器随即在 `.bar` 上派发 focusout；收起排定挂在
 *    focusout 上，于是刚点开就被排定收起。实测事件序列就是 focusin → focusout。
 *
 * 3. 连带缺陷：飞层在触发按钮**侧边**展开，会覆盖同一行右侧的分组按钮（实测重叠 96%~100%），
 *    点「视频」实际点到飞层里的「360 搜索」。
 *
 * **位置口径已于 2026-10-20 按用户要求变更为「紧贴分组图标侧边、与图标同行」。**
 * 这条变更**重新引入了上述遮挡**：飞层宽 170px，而分组图标仅 54px 宽、间距 58px，
 * 「贴图标」与「不盖邻居」在几何上不能同时成立（实测中段分组的飞层会盖住右侧 1~3 个图标）。
 * 用户已明确选择接受该代价，因此【3】不再断言零重叠，改为：
 *  - 飞层紧贴触发图标侧边、与图标同行（位置契约）；
 *  - 触发图标自身不被自己的飞层盖住（代价上限）；
 *  - 遮挡只发生在同一行的邻居图标上、且「更多」按钮不被盖住（代价边界）；
 *  - 被盖住的邻居命中落到飞层里 —— 记录为**已知代价**，不是缺陷；未被盖住的邻居仍能正常切换。
 *
 * 三个断言组都落在真实产物上，且必须以行为契约表达（不依赖 git HEAD）：
 *  - 动态页面下连续点击多个图标，全部要产生跳转；
 *  - 同一节点在连续多次页面变动后必须仍然存活（未被替换）；
 *  - 点分组展开后，超过 collapseDelay 仍保持展开；
 *  - 飞层紧贴触发图标、与图标同行；点每个分组都展开各自的内容。
 *
 * 4. 收起按钮的位置：**位于搜索输入框上方**，不是整条栏的最下方（2026-10-20 按用户要求调整）。
 *    按钮从 `.bar-content` 末尾移到首位，外边距由 `margin-top` 改为 `margin-bottom`。
 *    这是产品口径，不是可自由调整的样式细节 —— 改回去会让下游几何一起漂移，故钉死。
 *
 * 4'. **同日又按用户要求把该按钮删除**，并修掉「收起动画一闪一闪地偏移方向」。
 *    抖动根因：为做热区用过 `:host(.is-collapsed){width:52px}`，宿主宽度在同一帧内
 *    377.6px → 52px 硬跳变、锚点被拽走 162px（实测），而 `.bar` 的高度还在走 0.22s 过渡。
 *    现在宿主宽度恒定、`.bar` 原地收高度，热区改由把手自身的 52×24 矩形承担。
 *    所以【4】改为两条契约：栏内无 `.collapse-button`；收起全程横向零位移、纵向无回弹。
 */

const { createChecker, launchWithExtension } = require('./helpers.cjs');

const PINNED_HOST = '#quickfind-pinned-search-host';
const { check, summary } = createChecker();
/** 当前飞层对应的分组 id。收起飞层时要精确点回触发它的那个图标（见【3】）。 */
let pinnedOpenGroup = null;

/**
 * 被测页面有两种模式。
 * mutating=true 时用 setInterval 持续增删节点 —— 这是真实结果页/门户页的常态（埋点、推荐位），
 * 正是缺陷 1、2 的触发条件；静止模式作为对照，证明断言不是恒真。
 */
const pageHtml = (mutating) => `<!doctype html><meta charset="utf-8"><title>qf pinned click</title>
<style>body{font:16px sans-serif;margin:0;padding:24px;height:3000px}#site-q{width:360px;height:32px}
#ticker div{height:18px}</style>
<body>
  <input id="site-q" name="q" placeholder="搜索" style="width:360px;height:32px">
  <div id="ticker"></div>
  <script>
    if (${mutating}) {
      setInterval(() => {
        const box = document.getElementById('ticker');
        const d = document.createElement('div');
        d.textContent = String(Math.random()).slice(0, 8);
        box.append(d);
        if (box.childElementCount > 6) box.firstElementChild.remove();
      }, 40);
    }
  </script>
</body>`;

const config = (overrides = {}) => ({
  searchHistory: [{ query: '回归词', timestamp: Date.now() }],
  pinnedSearch: Object.assign({
    sites: [], customSites: [], defaultGroupCount: 4, collapseDelay: 1000,
    openInNewTab: true, allSites: true, siteConfigVersion: 3,
  }, overrides),
  triggerMode: 'click', editableTriggerMode: 'none', selectionTriggerDelay: 0, llmDockVisible: false,
});

/** 常驻栏快照：结构、展开态、飞层内容与矩形。 */
const barState = (page) => page.evaluate((host) => {
  const el = document.querySelector(host);
  if (!el) return null;
  const root = el.shadowRoot;
  const groupList = root.querySelector('.pinned-group-list');
  const rect = groupList && !groupList.hidden ? groupList.getBoundingClientRect() : null;
  const describe = (b) => {
    const r = b.getBoundingClientRect();
    return {
      name: (b.querySelector('.name')?.textContent || '').trim(),
      cls: String(b.className).replace('entry ', ''),
      groupId: b.dataset.groupId || null,
      // 「更多」按钮的文案在展开/收起之间切换（更多 ↔ 收起），不能靠文字判定它。
      isMore: b.dataset.pinnedMore === 'true',
      rect: [r.x, r.y, r.width, r.height],
    };
  };
  return {
    collapsed: el.classList.contains('is-collapsed'),
    hidden: el.hidden,
    hostRect: (() => { const r = el.getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; })(),
    flyout: rect ? [rect.x, rect.y, rect.width, rect.height] : null,
    direct: Array.from(root.querySelectorAll('.entries .entry')).map(describe),
    flyItems: groupList && !groupList.hidden ? Array.from(groupList.querySelectorAll('.entry')).map(describe) : [],
  };
}, PINNED_HOST);

async function expandBar(page) {
  const s = await barState(page);
  if (s.hidden) return false;
  if (s.collapsed) {
    await page.evaluate((host) => document.querySelector(host)?.shadowRoot?.querySelector('.reveal-handle')?.click(), PINNED_HOST);
    await page.waitForTimeout(400);
  }
  return true;
}

/**
 * 真实鼠标点击：先移到附近，带 1~2px 抖动再落到目标。
 * 零抖动的 mouse.click 会绕过「按下与抬起之间节点被替换」这条路径，得到假阴性。
 */
async function realClick(page, scope, index) {
  const spot = await page.evaluate(({ host, sel, i }) => {
    const el = document.querySelector(host).shadowRoot;
    const target = Array.from(el.querySelectorAll(sel)).at(i);
    if (!target) return null;
    const r = target.getBoundingClientRect();
    return { cx: r.x + r.width / 2, cy: r.y + r.height / 2, name: (target.querySelector('.name')?.textContent || '').trim() };
  }, { host: PINNED_HOST, sel: scope, i: index });
  if (!spot) return null;
  await page.mouse.move(spot.cx - 2, spot.cy - 2);
  await page.waitForTimeout(30);
  await page.mouse.move(spot.cx + 2, spot.cy + 2);
  await page.waitForTimeout(30);
  await page.mouse.move(spot.cx, spot.cy);
  await page.waitForTimeout(60);
  await page.mouse.down();
  await page.waitForTimeout(90);
  await page.mouse.up();
  await page.waitForTimeout(420);
  return spot;
}

/** 两个矩形是否相交；返回重叠面积占比。 */
function overlapRatio(a, b) {
  if (!a || !b) return 0;
  const w = Math.max(0, Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0]));
  const h = Math.max(0, Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]));
  return Math.round((w * h) / Math.max(1, a[2] * a[3]) * 100) / 100;
}

(async () => {
  const env = await launchWithExtension();
  try {
    const optionsPage = await env.openOptionsPage();
    const setConfig = (value) => optionsPage.evaluate((v) => new Promise((r) => chrome.storage.sync.set(v, r)), value);
    await optionsPage.evaluate(() => {
      window.__opened = [];
      chrome.tabs.onCreated.addListener((t) => window.__opened.push(t.pendingUrl || t.url || ''));
    });
    const drainOpened = () => optionsPage.evaluate(() => { const o = window.__opened.slice(); window.__opened = []; return o; });

    // ================= 1. 动态页面下点击必须全部生效 =================
    console.log('【1】页面持续变动时，常驻栏每个图标点击都生效');
    await setConfig(config());
    const mutatingUrl = await env.serve(pageHtml(true));
    const page = await env.context.newPage();
    await page.goto(mutatingUrl);
    await page.waitForTimeout(1600);
    await expandBar(page);

    // 按钮节点是否被替换：打标后观察标记是否还在。
    await page.evaluate((host) => {
      const root = document.querySelector(host).shadowRoot;
      Array.from(root.querySelectorAll('.entries .entry')).forEach((b, i) => { b.dataset.qfProbe = String(i) + '@' + Date.now(); });
    }, PINNED_HOST);
    await page.waitForTimeout(1200);
    const survived = await page.evaluate((host) => {
      const root = document.querySelector(host).shadowRoot;
      const all = Array.from(root.querySelectorAll('.entries .entry'));
      return { kept: all.filter((b) => b.dataset.qfProbe).length, total: all.length };
    }, PINNED_HOST);
    check('页面变动期间按钮节点未被整体替换（修复点）', survived.kept === survived.total && survived.total > 0,
      `保有原标记 ${survived.kept}/${survived.total}`);

    const s1 = await barState(page);
    const searchableIdx = s1.direct.map((d, i) => ({ d, i })).filter(({ d }) => !d.cls.includes('group')).map(({ i }) => i);
    const hitResults = [];
    for (const i of searchableIdx) {
      await expandBar(page);
      const before = await barState(page);
      const target = before.direct[i];
      if (!target) { hitResults.push({ name: '?', ok: false, reason: '元素消失' }); continue; }
      await drainOpened();
      const spot = await realClick(page, '.entries .entry', i);
      const opened = await drainOpened();
      hitResults.push({ name: spot?.name || target.name, ok: opened.length > 0, url: opened[0] || '' });
    }
    hitResults.forEach((r) => check(`动态页点「${r.name}」生效（修复点）`, r.ok, r.url ? r.url.slice(0, 70) : '无跳转'));
    check('动态页上所有可搜索图标都点了就生效', hitResults.every((r) => r.ok), JSON.stringify(hitResults.map((r) => r.name + ':' + r.ok)));

    // 按住跨越一次页面变动：修复前节点被替换 → click 丢失。这条断言是缺陷 1 的最小复现。
    await expandBar(page);
    const holdSpot = await page.evaluate((host) => {
      const root = document.querySelector(host).shadowRoot;
      const b = root.querySelector('.entries .entry');
      const r = b.getBoundingClientRect();
      b.dataset.qfHold = 'keep';
      return { cx: r.x + r.width / 2, cy: r.y + r.height / 2 };
    }, PINNED_HOST);
    await drainOpened();
    await page.mouse.move(holdSpot.cx, holdSpot.cy);
    await page.mouse.down();
    await page.waitForTimeout(300); // 跨过至少两个页面变动周期
    const heldIntact = await page.evaluate((host) => {
      const root = document.querySelector(host).shadowRoot;
      return Array.from(root.querySelectorAll('.entries .entry')).some((b) => b.dataset.qfHold === 'keep');
    }, PINNED_HOST);
    await page.mouse.up();
    await page.waitForTimeout(500);
    const holdOpened = await drainOpened();
    check('按住期间按钮未被替换（修复点）', heldIntact === true, 'intact=' + heldIntact);
    check('按住跨越页面变动后松开仍触发搜索（修复点）', holdOpened.length > 0, JSON.stringify(holdOpened.map((u) => u.slice(0, 60))));
    await page.close();
    console.log('');

    // ================= 2. 点分组展开后不被自动收回 =================
    console.log('【2】点分组展开后，超过 collapseDelay 仍保持展开');
    const url = await env.serve(pageHtml(true));
    for (const cfg of [
      { label: '动态页面', count: 20, patch: {} },
      { label: '默认配置（经「更多」进入）', count: 4, patch: {} },
    ]) {
      await setConfig(config(Object.assign({ defaultGroupCount: cfg.count }, cfg.patch)));
      const p = await env.context.newPage();
      await p.goto(url);
      await p.waitForTimeout(1600);
      await expandBar(p);
      // 要展开的分组可能在直排区，也可能在「更多」拉出的飞层里（默认配置就是后者）。
      // 两种情况都是用户真实路径，都要覆盖：先找直排，找不到就点「更多」再到飞层里找。
      let state = await barState(p);
      let scope = '.entries .entry';
      let groupIdx = state.direct.findIndex((d) => d.groupId);
      if (groupIdx < 0) {
        const moreIdx = state.direct.findIndex((d) => d.isMore);
        if (moreIdx >= 0) { await realClick(p, '.entries .entry', moreIdx); await p.waitForTimeout(250); }
        state = await barState(p);
        groupIdx = state.flyItems.findIndex((d) => d.groupId);
        scope = '.pinned-group-list .entry';
      }
      const visible = scope === '.entries .entry' ? state.direct : state.flyItems;
      if (groupIdx < 0) {
        check(`[${cfg.label}] 找到可展开的分组（前置条件）`, false,
          JSON.stringify({ direct: state.direct.map((d) => d.name), fly: state.flyItems.map((d) => d.name) }));
        await p.close();
        continue;
      }
      const groupName = visible[groupIdx].name;
      await realClick(p, scope, groupIdx);
      const openedNow = await barState(p);
      check(`[${cfg.label}] 点「${groupName}」后飞层已展开（前置条件）`, openedNow.flyout !== null && openedNow.flyItems.length > 0,
        JSON.stringify(openedNow.flyItems.map((f) => f.name)));
      // collapseDelay=1000，等 2.2 秒（原先 1 秒即收起）
      await p.waitForTimeout(2200);
      const later = await barState(p);
      check(`[${cfg.label}] 2.2 秒后仍保持展开且飞层未消失（修复点）`,
        later.collapsed === false && later.flyout !== null,
        JSON.stringify({ collapsed: later.collapsed, flyout: later.flyout, items: later.flyItems.map((f) => f.name) }));
      // 反向断言：指针真的移开后才应恢复自动收起（否则等于把自动收起整个关掉了）
      await p.mouse.move(20, 700);
      await p.waitForTimeout(1800);
      const afterLeave = await barState(p);
      check(`[${cfg.label}] 指针离开后仍会按 collapseDelay 自动收起（防「永久不再收起」）`,
        afterLeave.collapsed === true, 'collapsed=' + afterLeave.collapsed);
      await p.close();
    }
    console.log('');

    // ================= 3. 飞层不得遮挡直排按钮 =================
    console.log('【3】飞层紧贴分组图标侧边、与图标同行，且每个分组展开各自内容');
    await setConfig(config({ defaultGroupCount: 20 }));
    const p3 = await env.context.newPage();
    await p3.goto(url);
    await p3.waitForTimeout(1600);
    await expandBar(p3);
    const s3 = await barState(p3);
    const groupIdxList = s3.direct.map((d, i) => ({ d, i })).filter(({ d }) => d.groupId).map(({ i }) => i);
    check('直排区里有多个分组可测（前置条件）', groupIdxList.length >= 2, '分组下标=' + JSON.stringify(groupIdxList));
    for (const i of groupIdxList) {
      // 每次确保栏是展开、且没有残留飞层。用「点击触发的那个分组本身」来收起：
      // 旧写法点「更多」，但贴边展开后飞层会盖住「更多」，那一下会落到飞层里。
      await expandBar(p3);
      let now = await barState(p3);
      if (now.flyout) {
        const openGroupIdx = now.direct.findIndex((d) => d.groupId === pinnedOpenGroup);
        if (openGroupIdx >= 0) await realClick(p3, '.entries .entry', openGroupIdx);
        await p3.waitForTimeout(200);
        now = await barState(p3);
      }
      const fresh = now;
      const target = fresh.direct[i];
      if (!target) continue;
      await realClick(p3, '.entries .entry', i);
      const opened = await barState(p3);
      pinnedOpenGroup = target.groupId;
      // 位置契约：飞层要**紧贴在触发图标的侧边、与图标同行**，不是从栏底掉下来。
      const sameRow = opened.flyout !== null && Math.abs(opened.flyout[1] - target.rect[1]) <= 12;
      const besideIcon = opened.flyout !== null
        && (Math.abs(opened.flyout[0] - (target.rect[0] + target.rect[2])) <= 12
          || Math.abs(opened.flyout[0] + opened.flyout[2] - target.rect[0]) <= 12);
      check(`「${target.name}」展开的飞层紧贴图标侧边、与图标同行（位置契约）`,
        besideIcon && sameRow,
        JSON.stringify({ flyout: opened.flyout, icon: target.rect, besideIcon, sameRow }));
      // 代价契约（用户明确接受的取舍，不是缺陷）：飞层宽 170px、图标仅 54px 宽且间距 58px，
      // 「贴图标」与「不盖邻居」在几何上不能同时成立。所以这里**不**断言零重叠，
      // 而是断言遮挡量被限制在「同一行右侧的邻居图标」范围内——不得跑到别处去，
      // 也不得盖住触发图标自己（否则连点开它的结果都看不到）。
      const selfOverlap = overlapRatio(target.rect, opened.flyout);
      check(`「${target.name}」自身不被自己的飞层盖住（代价上限）`,
        selfOverlap === 0, JSON.stringify({ icon: target.rect, flyout: opened.flyout, selfOverlap }));
      const coveredNames = opened.direct
        .filter((d) => d.rect !== target.rect && overlapRatio(d.rect, opened.flyout) > 0.5)
        .map((d) => d.name);
      check(`「${target.name}」的飞层只可能盖住同一行的邻居（代价边界）`,
        coveredNames.every((name) => !name.includes('更多')),
        JSON.stringify({ covered: coveredNames, flyout: opened.flyout }));
      check(`「${target.name}」展开的飞层非空且与分组对应`,
        opened.flyItems.length > 0, JSON.stringify(opened.flyItems.map((f) => f.name)));
    }
    // 飞层展开时点被它盖住的相邻分组：**这就是「贴图标」方案付出的代价**，
// 用例如实记录为预期行为，而不是当成缺陷。曾经的实现（飞层落到栏下方）能通过
// 「展开的是它自己的内容」，因为那时飞层不与任何图标重叠；改贴图标后必然不成立。
// 判定按真实几何走：被盖住的邻居点了会落到飞层条目上（命中飞层内的元素即算代价发生）。
await expandBar(p3);
    const s4 = await barState(p3);
    const firstGroup = s4.direct.findIndex((d) => d.groupId);
    const secondGroup = s4.direct.findIndex((d, i) => d.groupId && i > firstGroup);
    if (firstGroup >= 0 && secondGroup >= 0) {
      await realClick(p3, '.entries .entry', firstGroup);
      const expanded = await barState(p3);
      const firstItems = expanded.flyItems.map((f) => f.name).join(',');
      pinnedOpenGroup = expanded.direct[firstGroup].groupId;
      const neighborCovered = expanded.direct[secondGroup]
        && overlapRatio(expanded.direct[secondGroup].rect, expanded.flyout) > 0.5;
      // 点相邻分组的坐标，看这一下被谁接住。
      // 注意不能靠 elementFromPoint 的返回值去区分「飞层内」还是「.entries 内」：
      // 宿主带 popover、在 top layer，浏览器把它的命中统一重定向成宿主元素本身
      // （与页面侧读 event.target 得到宿主 <div> 是同一机制）。所以只能判「是否落在扩展宿主上」。
      const hitTarget = await p3.evaluate(({ host, i }) => {
        const hostEl = document.querySelector(host);
        const root = hostEl.shadowRoot;
        const btn = Array.from(root.querySelectorAll('.entries .entry'))[i];
        const r = btn.getBoundingClientRect();
        const el = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
        return { onHost: !!(hostEl && el && (el === hostEl || hostEl.contains(el))), tag: el ? el.tagName : null };
      }, { host: PINNED_HOST, i: secondGroup });
      check('被飞层盖住的相邻分组：点击被扩展浮层接住、打不开它自己（已知代价，用户已接受）',
        neighborCovered ? hitTarget.onHost === true : true,
        JSON.stringify({ 飞层: expanded.flyout, 相邻图标: expanded.direct[secondGroup]?.rect, neighborCovered, hitTarget }));
      await realClick(p3, '.entries .entry', secondGroup);
      const switched = await barState(p3);
      const secondItems = switched.flyItems.map((f) => f.name).join(',');
      check('被盖住的相邻分组点击后内容未切换（代价已发生，与上一条一致）',
        neighborCovered ? secondItems === firstItems : true,
        JSON.stringify({ neighborCovered, 第一组: firstItems, 第二组: secondItems }));
    }

    // 代价的边界必须验到：最右侧分组的飞层不盖任何邻居，它左边的分组应能正常切换。
    if (groupIdxList.length >= 2) {
      await expandBar(p3);
      const cur = await barState(p3);
      if (cur.flyout) {
        const openIdx = cur.direct.findIndex((d) => d.groupId === pinnedOpenGroup);
        if (openIdx >= 0) await realClick(p3, '.entries .entry', openIdx);
        await p3.waitForTimeout(250);
      }
      const rightMost = groupIdxList[groupIdxList.length - 1];
      const leftOfRight = groupIdxList[groupIdxList.length - 2];
      await expandBar(p3);
      await realClick(p3, '.entries .entry', rightMost);
      const openRight = await barState(p3);
      pinnedOpenGroup = openRight.direct[rightMost]?.groupId;
      const rightItems = openRight.flyItems.map((f) => f.name).join(',');
      const leftCovered = overlapRatio(openRight.direct[leftOfRight].rect, openRight.flyout) > 0.5;
      await realClick(p3, '.entries .entry', leftOfRight);
      const afterLeft = await barState(p3);
      const afterItems = afterLeft.flyItems.map((f) => f.name).join(',');
      check('未被盖住的邻居仍能切换到自己的内容（代价边界成立）',
        leftCovered === false && afterItems.length > 0 && afterItems !== rightItems,
        JSON.stringify({ 右端分组: openRight.direct[rightMost]?.name, 左侧邻居: openRight.direct[leftOfRight]?.name,
          leftCovered, 右端内容: rightItems, 切换后内容: afterItems }));
    }
    await p3.close();

    // ================= 4. 收起按钮已移除 + 收起动画无横向跳变 =================
    // 两条契约（2026-10-20 按用户要求）：
    //  ① 栏内不再有 `.collapse-button`（用户要求删除；收起只保留自动收起与把手这条路径）；
    //  ② 收起过程**横向零位移**。曾把宿主收窄到 52px 来做热区，导致宿主宽度在同一帧内
    //     377.6 → 52 硬跳变、锚点被拽走 162px，而 .bar 的高度还在走 0.22s 过渡 ——
    //     用户看到「收起的动画一闪一闪地偏移方向」。现在宿主宽度恒定，.bar 原地收高度。
    console.log('【4】收起按钮已移除，且收起动画横向零位移（不闪、不偏移）');
    {
      const p4 = await env.context.newPage();
      await p4.goto(url);
      await p4.waitForTimeout(1500);
      await expandBar(p4);

      const layout = await p4.evaluate((host) => {
        const root = document.querySelector(host)?.shadowRoot;
        if (!root) return null;
        const box = (sel) => {
          const el = root.querySelector(sel);
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return { x: r.x, y: r.y, w: r.width, h: r.height };
        };
        return {
          hasCollapseButton: Boolean(root.querySelector('.collapse-button')),
          order: Array.from(root.querySelector('.bar-content').children).map((el) => el.className),
          handle: box('.reveal-handle'),
        };
      }, PINNED_HOST);

      if (!layout) {
        check('常驻栏已展开（前置条件）', false, 'shadowRoot 缺失');
      } else {
        check('栏内已无收起按钮（用户要求删除）', layout.hasCollapseButton === false, JSON.stringify(layout.order));
        check('栏内只剩输入框行与图标行',
          layout.order.length === 2 && layout.order.includes('pinned-query-row') && layout.order.includes('entries'),
          JSON.stringify(layout.order));
        check('常驻栏已展开（前置条件）', layout.handle.h === 0 || layout.handle.y >= 0, JSON.stringify(layout.handle));
      }

      // 逐帧采样收起过程：宿主横向几何必须恒定。
      // 采样的同时把指针移到栏外触发自动收起，取「class 已切换」那一帧前后作对照。
      // 注意：这里**不能 await 采样**，否则 900ms 采样窗口会在指针移开之前就跑完，
      // 收起永远不会被采到（踩过一次）。采样窗口要盖住 collapseDelay(1000) + 0.22s 过渡。
      const series = p4.evaluate((host) => new Promise((resolve) => {
        const rounds = [];
        const t0 = performance.now();
        const tick = () => {
          const el = document.querySelector(host);
          const bar = el?.shadowRoot?.querySelector('.bar');
          if (!el || !bar) { resolve({ error: 'missing' }); return; }
          const hb = el.getBoundingClientRect();
          const rb = bar.getBoundingClientRect();
          rounds.push({ x: hb.x, w: hb.width, barX: rb.x, barW: rb.width, barH: rb.height,
            collapsed: el.classList.contains('is-collapsed'), t: performance.now() - t0 });
          if (performance.now() - t0 < 2200) requestAnimationFrame(tick);
          else resolve({ rounds });
        };
        requestAnimationFrame(tick);
      }), PINNED_HOST);

      // 采样的同时把指针移开，让自动收起在采样窗口内发生。
      await p4.mouse.move(500, 560);
      await p4.mouse.move(560, 600);
      const result = await series;

      if (result.error) {
        check('收起过程采样成功（前置条件）', false, result.error);
      } else {
        const r = result.rounds;
        const idx = r.findIndex((f) => f.collapsed);
        check('采样窗口内确实发生了收起（前置条件）', idx >= 0, `frames=${r.length} collapsedAt=${idx}`);
        const both = idx > 0;
        const before = both ? r[idx - 1] : null;
        const after = both ? r[idx] : null;
        check('收起那一帧宿主宽度不塌缩（修复点）',
          !both || Math.abs(after.w - before.w) < 2,
          both ? `hostW ${before.w} → ${after.w}` : '未取到切换前后帧');
        check('收起那一帧宿主横向不跳变（修复点）',
          !both || Math.abs(after.x - before.x) < 15,
          both ? `hostX ${before.x} → ${after.x}（旧实现为 +162）` : '未取到切换前后帧');
        // 全程纵向单调收敛：不允许中途回弹（回弹就是用户说的「一闪」）。
        let rebound = 0;
        for (let i = 1; i < r.length; i += 1) if (r[i].barH > r[i - 1].barH + 1) rebound += 1;
        check('收起全程无回弹（不闪）', rebound === 0, `回弹次数=${rebound}`);
        const lateral = r.length ? Math.max(...r.map((f) => f.barX)) - Math.min(...r.map((f) => f.barX)) : -1;
        check('整段动画里 .bar 横向漂移 < 3px', lateral >= 0 && lateral < 3, `最大横向漂移=${Math.round(lateral * 100) / 100}px`);
      }
      await p4.close();
    }

    return summary();
  } finally {
    await env.close();
  }
})().then((code) => process.exit(code)).catch((error) => { console.error(error); process.exit(2); });