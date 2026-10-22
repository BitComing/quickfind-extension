/**
 * 常驻搜索栏「输入内容在重渲染后必须保留」的回归用例。
 *
 * 缺陷本体：`syncPinnedQuery` 每次重渲染都会按「页面搜索框的值 → URL 查询参数 →
 * 历史最近一次」重新推导输入框的值。用户手打的内容既不在页面里、也不在 URL 里，
 * 输入框一旦失焦（点页面别处、常驻栏自动收起），下一次重绘就会把它当成空值、
 * 用历史兜底值覆盖掉——输入的东西就这么没了。页面上已有真实查询时更隐蔽：
 * 用户的改写会被还原成页面上的原查询。
 *
 * 这条用例把「用户留下的值」当成一份需要跨重渲染存活的状态来验，并同时守住
 * 三条既有边界：页面查询真的变化时以页面为准、选区不覆盖用户已有内容、
 * 点击搜索源仍按框里的内容跳转。
 *
 * 全部断言都落在真实产物上：加载构建目录 → 打开真实页面 → 直接读 shadow root 与网络请求。
 * 不依赖 git HEAD，也不依赖任何历史版本。
 */

const { createChecker, launchWithExtension } = require('./helpers.cjs');

const HOST = '#quickfind-pinned-search-host';
const { check, summary } = createChecker();

const PINNED = {
  sites: ['google', 'baidu', 'google-scholar', 'duckduckgo', 'so', 'sogou', 'bing', 'yandex', 'zhihu', 'bilibili', 'douyin'],
  customSites: [],
  defaultGroupCount: 4,
  collapseDelay: 60000,
  openInNewTab: false,
  allSites: true,
  siteConfigVersion: 3,
};

/** 读常驻输入框的值。 */
const queryValue = (page) => page.evaluate((selector) => {
  const root = document.querySelector(selector)?.shadowRoot;
  return root ? root.querySelector('.pinned-query').value : null;
}, HOST);

/** 展开常驻栏（划过把手）。 */
const expand = (page) => page.evaluate((selector) => {
  document.querySelector(selector)?.shadowRoot?.querySelector('.reveal-handle')?.click();
}, HOST);

/**
 * 触发一次「整体重建」的渲染路径，并回报是否真的重建了。
 *
 * 这里必须主动制造一次**结构性变化**（切换「更多」展开态），不能只靠收起/展开。
 * 常驻栏现在按结构指纹决定是否重建（见 content/index.ts 的 pinnedRenderSignatureFor）：
 * 结构没变时只同步取值、不替换节点。收起/展开本身并不改变结构，所以单靠它已经
 * 不会重建节点了——拿「节点被替换」当重渲染的证据会误判成「没重渲染」。
 *
 * 切「更多」会改变直排/飞层的条目构成，是指纹必然变化的真实用户操作；
 * 切换两次即回到原状，不改变后续断言的前提。
 *
 * 收起按钮已于 2026-10-20 移除，这里不再点它；收起态改由调用方用真实指针离开触发
 * （见 collapsePinnedBar）。本函数只负责「让节点被替换」这一件事。
 */
const rerender = (page) => page.evaluate((selector) => {
  const host = document.querySelector(selector);
  const root = host.shadowRoot;
  const first = () => root.querySelector('.entries .entry');
  const before = first();
  root.querySelector('.entry[data-pinned-more="true"]')?.click();
  root.querySelector('.entry[data-pinned-more="true"]')?.click();
  return { collapsed: host.classList.contains('is-collapsed'), rebuilt: before !== first() };
}, HOST);

/** 模拟用户打字：真实 input 事件 + 失焦（失焦正是缺陷的触发前提）。 */
const typeUser = (page, text, { blur = true } = {}) => page.evaluate(({ selector, value, shouldBlur }) => {
  const input = document.querySelector(selector).shadowRoot.querySelector('.pinned-query');
  input.focus();
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  if (shouldBlur) input.blur();
  return input.value;
}, { selector: HOST, value: text, shouldBlur: blur });

/** 在页面上选中某段文字，并补一次 mouseup 让它被扩展捕获。 */
async function selectParagraph(page, id) {
  await page.evaluate((pid) => {
    const node = document.getElementById(pid);
    const range = document.createRange();
    range.selectNodeContents(node);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }, id);
  await page.evaluate(() => {
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: 20, clientY: 40 }));
  });
}

(async () => {
  const env = await launchWithExtension();
  try {
    const optionsPage = await env.openOptionsPage();
    await optionsPage.evaluate((pinned) => new Promise((resolve) => chrome.storage.sync.set({
      searchHistory: [{ query: '历史兜底值', timestamp: Date.now() }],
      pinnedSearch: pinned,
    }, resolve)), PINNED);

    // 无查询参数的页面：草稿曾被历史兜底值覆盖的场景。
    const plainUrl = await env.serve('<!doctype html><meta charset="utf-8"><title>qf draft</title><body style="font:16px sans-serif"><p id="para">对照组用的段落文字，用来产生一个可识别的选区。</p></body>');
    const plain = await env.context.newPage();
    await plain.goto(plainUrl);
    await plain.waitForTimeout(1300);
    await expand(plain);
    await plain.waitForTimeout(400);

    // ---------- A. 缺陷本体：无页面查询时，草稿跨重渲染存活 ----------
    console.log('【A】页面无查询时，用户输入跨重渲染保留');
    check('初始显示历史兜底值（证明取值链路在工作）', (await queryValue(plain)) === '历史兜底值', JSON.stringify(await queryValue(plain)));

    await typeUser(plain, '用户打的草稿');
    check('输入后就位', (await queryValue(plain)) === '用户打的草稿', JSON.stringify(await queryValue(plain)));

    const rebuilt = await rerender(plain);
    check('重渲染确实发生（节点被整体重建）', rebuilt.rebuilt === true, JSON.stringify(rebuilt));
    check('重渲染后草稿仍在（修复点）', (await queryValue(plain)) === '用户打的草稿', JSON.stringify(await queryValue(plain)));

    // 再触发一次另一种重渲染路径（点「更多」重排条目），仍然要保住。
    await plain.evaluate((selector) => {
      document.querySelector(selector).shadowRoot.querySelector('.entry[data-pinned-more="true"]')?.click();
    }, HOST);
    await plain.waitForTimeout(350);
    check('点「更多」重排后草稿仍在', (await queryValue(plain)) === '用户打的草稿', JSON.stringify(await queryValue(plain)));
    console.log('');

    // ---------- B. 用户主动清空同样要被尊重 ----------
    console.log('【B】用户主动清空后，兜底值不得自动填回');
    await typeUser(plain, '');
    check('清空后为空', (await queryValue(plain)) === '', JSON.stringify(await queryValue(plain)));
    const cleared = await rerender(plain);
    check('重渲染确实发生', cleared.rebuilt === true, JSON.stringify(cleared));
    check('重渲染后仍为空（清空意图被尊重）', (await queryValue(plain)) === '', JSON.stringify(await queryValue(plain)));
    console.log('');

    // ---------- C. 选区自动填入照旧，且不覆盖用户已有内容 ----------
    console.log('【C】选区自动填入的既有边界未被破坏');
    await selectParagraph(plain, 'para');
    await plain.waitForTimeout(500);
    check('空框遇新一轮选区会填入（既有行为）', (await queryValue(plain)).includes('对照组用的段落文字'), JSON.stringify(await queryValue(plain)));

    await typeUser(plain, '用户自己写的，不许被选区顶掉');
    await plain.evaluate(() => window.getSelection().removeAllRanges());
    await plain.waitForTimeout(200);
    await selectParagraph(plain, 'para');
    await plain.waitForTimeout(400);
    check('已有用户内容时选区不覆盖（既有行为）', (await queryValue(plain)) === '用户自己写的，不许被选区顶掉', JSON.stringify(await queryValue(plain)));
    console.log('');

    // ---------- D. 页面有真实查询：改写要留住，页面换了查询要让位 ----------
    console.log('【D】页面存在真实查询时的取舍');
    const queryUrl = await env.serve('<!doctype html><meta charset="utf-8"><title>q</title><body style="font:16px sans-serif"><input id="q" name="q" style="width:320px;height:30px"></body>');
    const onQuery = await env.context.newPage();
    await onQuery.goto(`${queryUrl}?q=页面查询`);
    await onQuery.waitForTimeout(1400);
    await expand(onQuery);
    await onQuery.waitForTimeout(400);
    check('初始以页面查询为准', (await queryValue(onQuery)) === '页面查询', JSON.stringify(await queryValue(onQuery)));

    await typeUser(onQuery, '用户改写一半');
    const rewritten = await rerender(onQuery);
    check('重渲染确实发生', rewritten.rebuilt === true, JSON.stringify(rewritten));
    check('重渲染不把改写退回原查询（修复点）', (await queryValue(onQuery)) === '用户改写一半', JSON.stringify(await queryValue(onQuery)));

    // 页面真的换了查询：草稿让位，跟页面走。
    // 这里用真实导航——页面上的「新一次搜索」就是一次导航，草稿只属于它所在的那一页。
    await onQuery.goto(`${queryUrl}?q=新查询`);
    await onQuery.waitForTimeout(1400);
    await expand(onQuery);
    await onQuery.waitForTimeout(400);
    check('页面换成新查询后跟随页面（草稿不跨页泄漏）', (await queryValue(onQuery)) === '新查询', JSON.stringify(await queryValue(onQuery)));
    console.log('');

    // ---------- E. 搜索功能未受影响：仍按框里的内容构造地址 ----------
    console.log('【E】点击搜索源仍按框里内容跳转');
    const requests = [];
    onQuery.on('request', (request) => {
      const url = request.url();
      if (!url.startsWith('http://127.0.0.1')) requests.push(url);
    });
    await typeUser(onQuery, '要搜索的词');
    await onQuery.waitForTimeout(250);
    check('派发前草稿在位', (await queryValue(onQuery)) === '要搜索的词', JSON.stringify(await queryValue(onQuery)));
    await onQuery.evaluate((selector) => {
      const root = document.querySelector(selector).shadowRoot;
      const button = Array.from(root.querySelectorAll('.entries .entry')).find((item) => (item.title || '').includes('使用谷歌'));
      button?.click();
    }, HOST);
    await onQuery.waitForTimeout(1500);
    const navigated = requests.find((url) => url.includes('google'));
    check('确实导航到搜索地址', Boolean(navigated), JSON.stringify(requests.slice(0, 2)));
    check('搜索地址里带着框里的内容', Boolean(navigated && navigated.includes(encodeURIComponent('要搜索的词'))), JSON.stringify(navigated));
    console.log('');

    return summary();
  } finally {
    await env.close();
  }
})().then((code) => process.exit(code));