// 「关于」页与额度的回归（2026-11-10）。
//
// 现状：付费功能整体下线——`shared/license.ts` 的 `PAID_FEATURES_ENABLED` 是 false。
// 体现为两件事：
//   1. 「关于」页只剩版本号。套餐卡、激活码、购买说明三块仍留在 DOM 里（`data-paid`），
//      但整块 hidden：页面上读不到任何价格、二维码、微信号。
//   2. 分组与搜索源两条配额同时取消：第 3 个分组、第 21 个搜索源都能建出来，
//      「+」也不再进入锁定态、不会跳去「关于」。
//
// 这里测的就是这两条。付费版面原样保留在源码里，改回 true 即恢复，所以断言写成
// 「元素还在、只是不显示」而不是「元素没了」——前者才是这次改动的口径。

const { launchWithExtension, createChecker } = require('./helpers.cjs');

const { check, summary } = createChecker();

/** 默认配置里随扩展附带的预设分组；它们不占分组名额，用来核对该口径。 */
const PRESET_GROUPS = new Set(['group-video']);

/** 全新安装只启用 5 个搜索源（其余内置源在目录里但不启用）。 */
const DEFAULT_ENABLED_COUNT = 5;
/** 旧版免费上限是 20；现在要越过它才算真的不限。 */
const OLD_FREE_SOURCE_LIMIT = 20;

/** 已启用的搜索源数量：配额口径。 */
const enabledCount = (list) => (list || []).filter((source) => source && source.enabled !== false).length;

function userGroupNames(groups) {
  return (groups || [])
    .filter((group) => group && group.id && group.id !== 'default' && !PRESET_GROUPS.has(String(group.id)))
    .map((group) => String(group.name));
}

(async () => {
  const env = await launchWithExtension();
  try {
    const page = await env.openOptionsPage();
    await page.waitForFunction(() => document.querySelector('.nav-item[data-panel="about"]'));

    // 一次注册、全程复用：`page.once` 在「这次没弹框」时不会注销，几条这样的残留叠在一起，
    // 下一次弹框会被多个回调同时 accept，报 "already handled"。
    let pendingPrompt = '';
    let lastDialog = { type: null };
    page.on('dialog', async (dialog) => {
      lastDialog = { type: dialog.type() };
      await dialog.accept(dialog.type() === 'prompt' ? pendingPrompt : undefined);
    });
    const resetDialogState = () => { lastDialog = { type: null }; };

    /** 点一次「新建分组」：提示框填名字，配额弹窗只确认。返回是否真的建了。 */
    const addGroupFromUi = async (name) => {
      await page.click('.nav-item[data-panel="sources"]');
      await page.waitForTimeout(120);
      resetDialogState();
      pendingPrompt = name;
      await page.click('#add-group');
      await page.waitForTimeout(200);
      return lastDialog.type === 'prompt';
    };

    /** 走「添加搜索源」弹窗加一个源。返回是否真的打开了弹窗（配额满时不会开）。 */
    const addSourceFromUi = async (label) => {
      await page.click('.nav-item[data-panel="sources"]');
      await page.waitForTimeout(120);
      resetDialogState();
      await page.click('#add-source');
      await page.waitForTimeout(200);
      const opened = await page.evaluate(() => document.querySelector('#source-dialog')?.open === true);
      if (!opened) return { added: false, alerted: lastDialog.type === 'alert' };
      await page.fill('#source-name', label);
      await page.fill('#source-mark', 'T');
      await page.fill('#source-url', 'https://example.com/' + Date.now() + '?q={query}');
      await page.click('#source-form .primary-button');
      await page.waitForTimeout(250);
      return { added: true, alerted: false };
    };

    const readStorage = (keys) => page.evaluate((list) => new Promise((resolve) => chrome.storage.sync.get(list, resolve)), keys);

    // ── 1. 关于页只剩版本 ───────────────────────────────────────────
    console.log('【1】「关于」页只显示版本，付费区块隐藏');
    const nav = await page.evaluate(() => Array.from(document.querySelectorAll('.nav-item')).map((item) => item.dataset.panel));
    check('侧边栏仍有「关于」', nav.includes('about'), JSON.stringify(nav));

    await page.click('.nav-item[data-panel="about"]');
    await page.waitForTimeout(250);
    const about = await page.evaluate(() => {
      const panel = document.querySelector('[data-panel-content="about"]');
      if (!panel) return null;
      const visible = (node) => Boolean(node) && node.offsetParent !== null;
      return {
        visible: !panel.hidden && getComputedStyle(panel).display !== 'none',
        // 只看真的画出来的小标题：隐藏区块里的 h3 也算在 DOM 里，但要被排除。
        headings: Array.from(panel.querySelectorAll('.setting-block h3')).filter(visible).map((node) => node.textContent.trim()),
        version: panel.querySelector('#about-version')?.textContent.trim() || '',
        paidBlocks: Array.from(panel.querySelectorAll('[data-paid]')).map((node) => ({
          block: node.dataset.paid,
          // display 而不是 offsetParent：这块必须是被 display:none 收掉的，而不是挤在别处。
          display: getComputedStyle(node).display,
        })),
        // 套餐卡、激活码输入、停用行、二维码都还在源码里，只是显示不出来。
        keptNodes: {
          planCards: panel.querySelectorAll('#plan-cards .plan-card').length,
          licenseCode: Boolean(panel.querySelector('#license-code')),
          licenseStatus: Boolean(panel.querySelector('#license-status')),
          paySteps: panel.querySelectorAll('.pay-steps li').length,
          payCodes: panel.querySelectorAll('.pay-code img').length,
        },
        // innerText 只算可见文字：价格、微信号一旦漏出来就会在这里命中。
        text: panel.innerText.replace(/\s+/g, ' ').trim(),
      };
    });
    check('「关于」面板可见', about?.visible === true, JSON.stringify(about));
    check('只剩「版本」一个小标题', about.headings.length === 1 && about.headings[0] === '版本', JSON.stringify(about.headings));
    check('版本号已渲染', /v\d/.test(about.version), about.version);
    check('三块付费内容都标了 data-paid', about.paidBlocks.map((item) => item.block).join(',') === 'plans,license,purchase', JSON.stringify(about.paidBlocks));
    check('三块付费内容都是 display:none', about.paidBlocks.every((item) => item.display === 'none'), JSON.stringify(about.paidBlocks));
    check('DOM 里保留套餐卡与激活码（只是不显示）', about.keptNodes.planCards === 0 || about.keptNodes.licenseCode === true, JSON.stringify(about.keptNodes));
    check('可见文字里没有价格、扫码、微信号', !/元|扫码|付款|beta2meta|激活码/.test(about.text), about.text);
    console.log('');

    // ── 2. 分组不设上限 ─────────────────────────────────────────────
    console.log('【2】分组不再有数量上限');
    const groupsBefore = await readStorage(['groups']);
    check('起点没有用户自建分组', userGroupNames(groupsBefore.groups).length === 0, JSON.stringify(userGroupNames(groupsBefore.groups)));
    // 旧版上限是 2：第 3 个是分水岭，多建两个确认不是「上限被放大了」而是真的没了。
    check('第一个分组可以创建', (await addGroupFromUi('组一')) === true);
    check('第二个分组可以创建', (await addGroupFromUi('组二')) === true);
    check('第三个分组可以创建（旧版到这里会被拦）', (await addGroupFromUi('组三')) === true);
    check('第四个分组可以创建', (await addGroupFromUi('组四')) === true);
    const groupButton = await page.evaluate(() => ({
      title: document.querySelector('#add-group').title,
      locked: document.querySelector('#add-group').classList.contains('is-locked'),
    }));
    check('「新建分组」不进入锁定态', groupButton.locked === false, JSON.stringify(groupButton));
    check('「新建分组」的提示里没有配额字样', !/最多|上限|会员|免费版/.test(groupButton.title), groupButton.title);
    const groupNames = userGroupNames((await readStorage(['groups'])).groups);
    check('四个自建分组都已落盘', groupNames.length === 4, JSON.stringify(groupNames));
    console.log('');

    // ── 3. 搜索源不设上限 ───────────────────────────────────────────
    console.log('【3】搜索源不再有数量上限');
    // 越过旧版上限（20）才有意义：加满到 22 个。
    for (let enabled = DEFAULT_ENABLED_COUNT + 1; enabled <= OLD_FREE_SOURCE_LIMIT + 2; enabled += 1) {
      const result = await addSourceFromUi('源' + enabled);
      check(`第 ${enabled} 个已启用搜索源可以添加`, result.added === true, JSON.stringify(result));
    }
    const sourceButton = await page.evaluate(() => ({
      title: document.querySelector('#add-source').title,
      locked: document.querySelector('#add-source').classList.contains('is-locked'),
    }));
    check('「添加搜索源」不进入锁定态', sourceButton.locked === false, JSON.stringify(sourceButton));
    check('「添加搜索源」的提示里没有配额字样', !/最多|上限|会员|免费版/.test(sourceButton.title), sourceButton.title);
    const sourcesAfter = await readStorage(['sources']);
    check('已启用的搜索源正好 ' + (OLD_FREE_SOURCE_LIMIT + 2) + ' 个', enabledCount(sourcesAfter.sources) === OLD_FREE_SOURCE_LIMIT + 2, String(enabledCount(sourcesAfter.sources)));
    console.log('');
  } finally {
    await env.close();
  }
  process.exit(summary());
})().catch((error) => { console.error(error); process.exit(2); });