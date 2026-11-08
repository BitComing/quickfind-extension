// 「更多」展开的菜单在两处保持同一套设计（2026-11-07 需求）。
//
// 需求原文：「在选词时，工具栏的『更多』要和常驻搜索框的更多设计保持一致。」
// 澄清后指的不是那枚按钮，而是**点开「更多」之后展开的菜单**。
//
// 此前两处是两种东西：常驻栏展开的是一张浮在栏外的白卡（170px、7px 圆角、
// 半透明白底 + 投影 + 背景模糊、23px 高的紧凑行）；选区工具栏却是面板内部
// 一段内联列表——展开后面板被整体撑高、列表上方多一条分隔线，行高也大一圈。
// 同一功能在两个界面长得不一样。
//
// 这里钉住：两边容器是同一张卡（宽度/圆角/内边距/底色/投影一致），行是同一档
// 尺寸（23px 高、11px 字、17px 图标块、5px 圆角），且选区菜单浮在面板外、
// 不再改变面板高度。

const { launchWithExtension, createChecker } = require('./helpers.cjs');

const { check, summary } = createChecker();
const PANEL_HOST = '#quickfind-shadow-host';
const PINNED_HOST = '#quickfind-pinned-search-host';

const PAGE = '<!doctype html><meta charset="utf-8"><body style="font:16px sans-serif;padding:24px">'
  + '<p id="text" style="width:460px;line-height:2">这段话用来产生选区，重点看「更多」展开后的菜单。</p></body>';

const SOURCES = [
  ['google', '谷歌', 'G', 'google'],
  ['baidu', '百度', 'B', 'baidu'],
  ['bing', '必应', 'b', 'bing'],
  ['duckduckgo', 'DuckDuckGo', 'D', 'duckduckgo'],
  ['zhihu', '知乎', '知', 'zhihu'],
  ['bilibili', '哔哩哔哩', 'B', 'bilibili'],
  ['xiaohongshu', '小红书', '红', 'xiaohongshu'],
].map(([id, name, mark, className]) => ({
  id, name, mark, className, url: 'https://example.com/?q={query}', enabled: true, iconOnly: false,
}));

const SEED = {
  sources: SOURCES,
  groups: [
    // 第 4 条之后放一个分组 + 一个源：它们都进「更多」，顺便覆盖
    // 「从更多菜单里点分组」——分组按钮会随菜单一起收掉，飞层要挂到「更多」上。
    { id: 'default', name: '默认组', items: ['google', 'baidu', 'bing', 'duckduckgo', 'zhihu', 'group:g1', 'xiaohongshu'], visible: true },
    { id: 'g1', name: '视频', items: ['bilibili'], visible: true },
  ],
  triggerMode: 'click',
  editableTriggerMode: 'click',
  selectionTriggerDelay: 0,
  // 4 条直排，其余进「更多」——两处都必须真的展开出菜单。
  defaultGroupCount: 4,
  searchHistory: [],
  llmDockVisible: false,
  pinnedSearch: {
    sites: [], customSites: [], allSites: true, siteConfigVersion: 3,
    collapseDelay: 60000, defaultGroupCount: 4, openInNewTab: false,
  },
};

/** 量一张「更多」菜单：容器外观、首行尺寸、和触发按钮/面板的相对位置。 */
const readFlyout = (page, hostSelector, containerSelector, itemSelector, buttonSelector) => page.evaluate(({ host, container, item, button }) => {
  const root = document.querySelector(host)?.shadowRoot;
  const list = root?.querySelector(container);
  if (!list) return null;
  const row = list.querySelector(item);
  const trigger = root.querySelector(button);
  const panel = root.querySelector('.quickfind-panel');
  const listRect = list.getBoundingClientRect();
  const rowRect = row?.getBoundingClientRect();
  const triggerRect = trigger?.getBoundingClientRect();
  const listStyle = getComputedStyle(list);
  const rowStyle = row ? getComputedStyle(row) : null;
  const mark = row?.querySelector('.mark, .engine-mark');
  const name = row?.querySelector('.name, .engine-name');
  return {
    count: list.childElementCount,
    visible: !list.hidden && listRect.width > 0,
    rect: { x: listRect.x, y: listRect.y, width: listRect.width, height: listRect.height },
    buttonTop: triggerRect?.top ?? null,
    buttonRight: triggerRect?.right ?? null,
    buttonLeft: triggerRect?.left ?? null,
    panelHeight: panel?.getBoundingClientRect().height ?? null,
    position: listStyle.position,
    width: listStyle.width,
    radius: listStyle.borderRadius,
    padding: listStyle.padding,
    background: listStyle.backgroundColor,
    shadow: listStyle.boxShadow,
    row: rowRect ? {
      height: rowRect.height,
      width: rowRect.width,
      padding: rowStyle.padding,
      radius: rowStyle.borderRadius,
      fontSize: rowStyle.fontSize,
      borderColor: rowStyle.borderColor,
      shadow: rowStyle.boxShadow,
      markSize: mark ? [mark.offsetWidth, mark.offsetHeight] : null,
      nameFontSize: name ? getComputedStyle(name).fontSize : null,
    } : null,
  };
}, { host: hostSelector, container: containerSelector, item: itemSelector, button: buttonSelector });

(async () => {
  const env = await launchWithExtension();
  try {
    const optionsPage = await env.openOptionsPage();
    await optionsPage.evaluate((seed) => new Promise((resolve) => chrome.storage.sync.set(seed, resolve)), SEED);

    const page = await env.context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(await env.serve(PAGE));
    await page.waitForSelector(PANEL_HOST, { state: 'attached', timeout: 10000 });
    await page.waitForSelector(PINNED_HOST, { state: 'attached', timeout: 10000 });
    await page.waitForTimeout(900);

    // ── 1. 常驻搜索栏：更多菜单 ─────────────────────────────────────
    console.log('【1】常驻搜索栏点开「更多」：栏外一张白卡');
    await page.evaluate((host) => {
      document.querySelector(host)?.shadowRoot?.querySelector('.reveal-handle')
        ?.dispatchEvent(new MouseEvent('pointerenter', { bubbles: true, pointerType: 'mouse' }));
    }, PINNED_HOST);
    await page.waitForTimeout(450);
    await page.locator(`${PINNED_HOST} .entry[data-pinned-more="true"]`).dispatchEvent('click');
    await page.waitForTimeout(350);
    const pinned = await readFlyout(page, PINNED_HOST, '.pinned-group-list', '.entry', '.entry[data-pinned-more="true"]');
    check('常驻栏的更多菜单展开', pinned?.visible === true && pinned?.count === 3, JSON.stringify(pinned));
    check('常驻栏菜单是栏外浮层（fixed）', pinned?.position === 'fixed', String(pinned?.position));

    // ── 2. 选区工具栏：更多菜单 ─────────────────────────────────────
    console.log('【2】选区工具栏点开「更多」：同一张白卡，不再撑高面板');
    await page.evaluate(() => {
      const node = document.getElementById('text');
      const range = document.createRange();
      range.selectNodeContents(node);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: 220, clientY: 100 }));
    });
    await page.waitForTimeout(450);
    await page.locator(`${PANEL_HOST} .quickfind-trigger`).dispatchEvent('click');
    await page.waitForTimeout(350);
    const panelHeightBefore = await page.evaluate((host) => {
      return document.querySelector(host)?.shadowRoot?.querySelector('.quickfind-panel')?.getBoundingClientRect().height ?? null;
    }, PANEL_HOST);
    await page.locator(`${PANEL_HOST} .engine-list .more-engine`).dispatchEvent('click');
    await page.waitForTimeout(350);
    const selection = await readFlyout(page, PANEL_HOST, '.hidden-engine-list', '.engine', '.engine-list .more-engine');
    check('选区工具栏的更多菜单展开', selection?.visible === true && selection?.count === 3, JSON.stringify(selection));
    check('菜单是浮在面板外的卡片，不是内联列表（absolute）', selection?.position === 'absolute', String(selection?.position));
    check('展开菜单不改变面板高度', selection?.panelHeight === panelHeightBefore,
      JSON.stringify({ before: panelHeightBefore, after: selection?.panelHeight }));

    // ── 3. 两处菜单逐项对齐 ─────────────────────────────────────────
    console.log('【3】两处菜单容器与行尺寸一致');
    // 常驻栏菜单是 content-box（width:auto + min-width），选区菜单是 border-box，
// 两边 computed width 的字面值不同；比外框实际宽度才是用户看到的那条边。
    check('外框宽度一致（170px）',
      Math.round(pinned?.rect.width || 0) === 170 && Math.round(selection?.rect.width || 0) === 170,
      `${pinned?.rect.width} / ${selection?.rect.width}`);
    check('圆角一致', pinned?.radius === selection?.radius, `${pinned?.radius} / ${selection?.radius}`);
    check('内边距一致', pinned?.padding === selection?.padding, `${pinned?.padding} / ${selection?.padding}`);
    check('底色一致', pinned?.background === selection?.background, `${pinned?.background} / ${selection?.background}`);
    check('投影一致', pinned?.shadow === selection?.shadow, `${pinned?.shadow} / ${selection?.shadow}`);
    check('行高一致（23px）', pinned?.row?.height === 23 && selection?.row?.height === 23,
      `${pinned?.row?.height} / ${selection?.row?.height}`);
    check('行内边距一致', pinned?.row?.padding === selection?.row?.padding, `${pinned?.row?.padding} / ${selection?.row?.padding}`);
    check('行圆角一致', pinned?.row?.radius === selection?.row?.radius, `${pinned?.row?.radius} / ${selection?.row?.radius}`);
    check('行字号一致', pinned?.row?.fontSize === selection?.row?.fontSize, `${pinned?.row?.fontSize} / ${selection?.row?.fontSize}`);
    check('行描边一致', pinned?.row?.borderColor === selection?.row?.borderColor, `${pinned?.row?.borderColor} / ${selection?.row?.borderColor}`);
    check('行没有浮起阴影', pinned?.row?.shadow === selection?.row?.shadow, `${pinned?.row?.shadow} / ${selection?.row?.shadow}`);
    check('图标块尺寸一致（17×17）',
      JSON.stringify(pinned?.row?.markSize) === '[17,17]' && JSON.stringify(selection?.row?.markSize) === '[17,17]',
      JSON.stringify({ pinned: pinned?.row?.markSize, selection: selection?.row?.markSize }));
    check('行文字字号一致（11px）', pinned?.row?.nameFontSize === '11px' && selection?.row?.nameFontSize === '11px',
      `${pinned?.row?.nameFontSize} / ${selection?.row?.nameFontSize}`);

    // 摆法：与触发按钮同高、贴在按钮外侧——和常驻栏的更多飞层一致。
    const beside = selection && selection.buttonTop !== null && (
      Math.abs(selection.rect.y - selection.buttonTop) <= 1
      && (selection.rect.x >= selection.buttonRight - 1 || selection.rect.x + selection.rect.width <= selection.buttonLeft + 1)
    );
    check('菜单与触发按钮同高、贴在按钮外侧', Boolean(beside), JSON.stringify({
      flyoutTop: selection?.rect.y, buttonTop: selection?.buttonTop,
      flyoutLeft: selection?.rect.x, buttonRight: selection?.buttonRight, buttonLeft: selection?.buttonLeft,
    }));

    // 「更多」菜单里的分组行也要和常驻栏一样：23px 紧凑行 + 「组」角标。
    const groupRow = await page.evaluate((host) => {
      const root = document.querySelector(host)?.shadowRoot;
      const row = root?.querySelector('.hidden-engine-list .engine[data-group-id="g1"]');
      if (!row) return null;
      const mark = row.querySelector('.engine-mark');
      return {
        height: row.getBoundingClientRect().height,
        mark: mark?.textContent ?? null,
        markSize: mark ? [mark.offsetWidth, mark.offsetHeight] : null,
        name: row.textContent,
      };
    }, PANEL_HOST);
    check('更多菜单里的分组行与搜索源同档（23px、带「组」角标）',
      groupRow?.height === 23 && groupRow?.mark === '组' && JSON.stringify(groupRow?.markSize) === '[17,17]',
      JSON.stringify(groupRow));

    // 「更多」菜单里点分组：菜单收掉，换成该分组的飞层，且飞层不会因为
    // 分组按钮随菜单一起消失而立刻被藏掉（挂到「更多」按钮旁，与常驻栏一致）。
    await page.locator(`${PANEL_HOST} .hidden-engine-list .engine[data-group-id="g1"]`).dispatchEvent('click');
    await page.waitForTimeout(350);
    const groupState = await page.evaluate((host) => {
      const root = document.querySelector(host)?.shadowRoot;
      const groupList = root?.querySelector('.group-engine-list');
      return {
        moreHidden: root?.querySelector('.hidden-engine-list')?.hidden ?? null,
        groupHidden: groupList?.hidden ?? null,
        groupCount: groupList?.childElementCount ?? 0,
        rect: groupList?.getBoundingClientRect().toJSON() ?? null,
      };
    }, PANEL_HOST);
    check('从更多菜单点分组：更多菜单收起、分组飞层出现',
      groupState.moreHidden === true && groupState.groupHidden === false && groupState.groupCount === 1,
      JSON.stringify(groupState));

    const groupLook = await page.evaluate((host) => {
      const root = document.querySelector(host)?.shadowRoot;
      const list = root?.querySelector('.group-engine-list');
      const row = list?.querySelector('.engine');
      const listStyle = getComputedStyle(list);
      return {
        width: list.getBoundingClientRect().width,
        radius: listStyle.borderRadius,
        padding: listStyle.padding,
        rowHeight: row?.getBoundingClientRect().height ?? null,
      };
    }, PANEL_HOST);
    check('分组飞层与更多菜单共用同一张卡（170px / 7px / 23px 行）',
      Math.round(groupLook.width) === 170 && groupLook.radius === '7px' && groupLook.padding === '4px' && groupLook.rowHeight === 23,
      JSON.stringify(groupLook));

    // 再点「更多」：回到更多菜单；再点一次收起。
    await page.locator(`${PANEL_HOST} .engine-list .more-engine`).dispatchEvent('click');
    await page.waitForTimeout(300);
    const reopened = await page.evaluate((host) => {
      const root = document.querySelector(host)?.shadowRoot;
      return root?.querySelector('.hidden-engine-list')?.hidden ?? null;
    }, PANEL_HOST);
    check('再点「更多」重新展开菜单', reopened === false, String(reopened));
    await page.locator(`${PANEL_HOST} .engine-list .more-engine`).dispatchEvent('click');
    await page.waitForTimeout(300);
    const closed = await page.evaluate((host) => {
      const root = document.querySelector(host)?.shadowRoot;
      return root?.querySelector('.hidden-engine-list')?.hidden ?? null;
    }, PANEL_HOST);
    check('再点一次「更多」收起菜单', closed === true, String(closed));

    check('页面未抛出脚本错误', errors.length === 0, JSON.stringify(errors));
    process.exitCode = summary();
  } finally {
    await env.close();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });