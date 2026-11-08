// 「关于」页与免费额度的回归（2026-11-07）。
//
// 需求：设置页新增「关于」；会员信息做成卡片（5 元一年、10 元永久、激活码授权）；
// 免费版最多 2 个搜索源分组 + 20 个已启用的搜索源，会员两项都不限。
//
// 这里测真实产物上的五件事：卡片与价目表；两条免费额度各自拦住；激活后两条都放开；
// 无效码与过期各自的表现；过期后已有配置不删、只是不能再加。
//
// 2026-11-08 起激活改由服务端判定（邮箱 + 码 → 签发许可证），所以这里用 page.route
// 把这层假掉：真接口要连 api.kpopcha.top，用例不该依赖线上服务和真码。码的形状仍由
// scripts/gen-license.mjs 现场生成——那份脚本产的是同一套 12 位格式，用来确认
// 前端 normalize/format 与发码端没有漂移。

const { launchWithExtension, createChecker } = require('./helpers.cjs');

const { check, summary } = createChecker();

/** 默认配置里随扩展附带的预设分组；它们不占免费配额，用来核对该口径。 */
const PRESET_GROUPS = new Set(['group-video']);

/** 全新安装只启用 5 个搜索源（其余内置源在目录里但不启用），免费上限 20，按已启用计数。 */
const DEFAULT_ENABLED_COUNT = 5;
const FREE_SOURCE_LIMIT = 20;

/** 已启用的搜索源数量：配额口径。 */
const enabledCount = (list) => (list || []).filter((source) => source && source.enabled !== false).length;

function userGroupNames(groups) {
  return (groups || [])
    .filter((group) => group && group.id && group.id !== 'default' && !PRESET_GROUPS.has(String(group.id)))
    .map((group) => String(group.name));
}

/** 用例里的购买邮箱。激活要求「码 + 购买时填写的邮箱」，这里固定一份。 */
const BUYER_EMAIL = 'buyer@example.com';

/**
 * 假授权服务：只实现用例走到的三个接口。
 *
 * 返回的许可证是占位串，**不参与验签**——这条路径上客户端只做格式与状态处理，
 * 签名由服务端自己的单测和 `shared/license-api.ts` 的 verifyLicenseToken 负责。
 * 这样用例不依赖线上域名，也不会因为线上发码没库存而红。
 */
async function mockLicenseApi(page, createCode) {
  const issued = new Map();
  let sessions = 0;
  const normalize = (raw) => String(raw || '').toUpperCase().replace(/[^0-9A-Z]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');

  await page.route('https://api.kpopcha.top/**', async (route) => {
    const url = new URL(route.request().url());
    const reply = (status, payload) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(payload) });
    let body = {};
    try {
      body = JSON.parse(route.request().postData() || '{}');
    } catch {
      body = {};
    }
    const now = Math.floor(Date.now() / 1000);

    if (url.pathname.endsWith('/v1/activate')) {
      const record = issued.get(normalize(body.code));
      if (!record) return reply(400, { ok: false, error: 'code_invalid', message: '激活码无效' });
      if (record.email !== String(body.email || '').trim().toLowerCase()) return reply(400, { ok: false, error: 'email_mismatch', message: '邮箱与激活码不匹配' });
      return reply(200, {
        ok: true,
        email: record.email,
        plan: record.plan,
        expires_at: record.plan === 'lifetime' ? null : now + 365 * 86400,
        max_devices: 1,
        license: { token: 'qs1.test.signature', exp: now + 30 * 86400, kid: 'test' },
        refresh: { token: `qfr_test_${(sessions += 1)}`, exp: now + 180 * 86400 },
      });
    }
    if (url.pathname.endsWith('/v1/deactivate')) return reply(200, { ok: true });
    if (url.pathname.endsWith('/v1/refresh')) return reply(401, { ok: false, error: 'session_invalid', message: '登录状态已失效' });
    return reply(404, { ok: false, error: 'not_found', message: 'not found' });
  });

  return {
    issue(plan) {
      const code = createCode(plan);
      issued.set(normalize(code), { plan, email: BUYER_EMAIL });
      return code;
    },
  };
}

(async () => {
  const { createCode } = await import('../scripts/gen-license.mjs');
  const env = await launchWithExtension();
  try {
    const page = await env.openOptionsPage();
    const api = await mockLicenseApi(page, createCode);
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

    // ── 1. 关于页：卡片与价目表 ──────────────────────────────────────
    console.log('【1】设置页新增「关于」，会员信息为卡片');
    const nav = await page.evaluate(() => Array.from(document.querySelectorAll('.nav-item')).map((item) => item.dataset.panel));
    check('侧边栏出现「关于」', nav.includes('about'), JSON.stringify(nav));

    await page.click('.nav-item[data-panel="about"]');
    await page.waitForTimeout(250);
    // 付款码是 public/ 下的静态图片，构建漏拷时会静默 404——先等它们解码完再取状态。
    await page.waitForFunction(
      () => Array.from(document.querySelectorAll('.pay-code img')).every((img) => img.complete && img.naturalWidth > 0),
      null,
      { timeout: 5000 },
    ).catch(() => {});
    const about = await page.evaluate(() => {
      const panel = document.querySelector('[data-panel-content="about"]');
      if (!panel) return null;
      const cards = Array.from(panel.querySelectorAll('#plan-cards .plan-card')).map((card) => ({
        plan: card.dataset.plan,
        current: card.classList.contains('is-current'),
        text: card.textContent.replace(/\s+/g, ' ').trim(),
        features: Array.from(card.querySelectorAll('.plan-features li')).map((li) => li.textContent.trim()),
        amount: card.querySelector('.plan-amount')?.textContent.trim() || '',
      }));
      return {
        visible: !panel.hidden && getComputedStyle(panel).display !== 'none',
        headings: Array.from(panel.querySelectorAll('.setting-block h3')).map((node) => node.textContent.trim()),
        cards,
        version: panel.querySelector('#about-version')?.textContent.trim() || '',
        status: panel.querySelector('#license-status')?.textContent.trim() || '',
        groupQuota: panel.querySelector('#license-group-quota')?.textContent.trim() || '',
        sourceQuota: panel.querySelector('#license-source-quota')?.textContent.trim() || '',
        rows: Array.from(panel.querySelectorAll('.rows .row')).map((row) => row.textContent.replace(/\s+/g, ' ').trim()),
        clearDisplay: getComputedStyle(panel.querySelector('#license-clear-row')).display,
        paySteps: Array.from(panel.querySelectorAll('.pay-steps li')).map((li) => li.textContent.replace(/\s+/g, ' ').trim()),
        payCodes: Array.from(panel.querySelectorAll('.pay-code img')).map((img) => ({
          src: img.getAttribute('src'),
          loaded: img.complete && img.naturalWidth > 0,
        })),
      };
    });
    check('「关于」面板可见', about?.visible === true, JSON.stringify(about));
    check('含「版本」「付费会员」「激活码」三块', ['版本', '付费会员', '激活码'].every((title) => about.headings.includes(title)), String(about.headings));
    check('会员区渲染成三张卡片', about.cards.length === 3, JSON.stringify(about.cards.map((card) => card.plan)));
    check('卡片顺序为免费版 / 一年会员 / 永久会员', about.cards.map((card) => card.plan).join(',') === 'free,yearly,lifetime', about.cards.map((card) => card.plan).join(','));
    check('一年会员卡片标价 5 元', about.cards[1]?.amount === '5 元', about.cards[1]?.amount);
    check('永久会员卡片标价 10 元', about.cards[2]?.amount === '10 元', about.cards[2]?.amount);
    check('免费版卡片写明 2 个分组 / 20 个已启用搜索源', about.cards[0]?.features.join('|') === '最多 2 个搜索源分组|最多启用 20 个搜索源', JSON.stringify(about.cards[0]?.features));
    check('会员卡片写明分组与搜索源都不限', about.cards[1]?.features.join('|') === '搜索源分组不限|搜索源不限数量', JSON.stringify(about.cards[1]?.features));
    check('未激活时「当前」落在免费版卡片上', about.cards.filter((card) => card.current).map((card) => card.plan).join(',') === 'free', JSON.stringify(about.cards.map((card) => [card.plan, card.current])));
    check('授权方式写的是激活码', about.rows.some((row) => row.includes('授权方式') && row.includes('激活码')), JSON.stringify(about.rows));
    check('未激活时状态为「未激活」', about.status === '未激活', about.status);
    check('版本号已渲染', /v\d/.test(about.version), about.version);
    check('分组额度显示 0 / 2', about.groupQuota === '0 / 2', about.groupQuota);
    check('搜索源额度显示 5 / 20', about.sourceQuota === DEFAULT_ENABLED_COUNT + ' / ' + FREE_SOURCE_LIMIT, about.sourceQuota);
    check('未激活时不显示「停用」行', about.clearDisplay === 'none', about.clearDisplay);
    check('「关于」底部有购买说明', about.headings.includes('购买与激活'), String(about.headings));
    check('购买说明是四步', about.paySteps.length === 4, JSON.stringify(about.paySteps));
    check('四步写清付款、加微信、发截图、领激活码', /付款|扫码付款/.test(about.paySteps[0]) && /插件付费/.test(about.paySteps[1]) && /截图/.test(about.paySteps[2]) && /激活码/.test(about.paySteps[3]), JSON.stringify(about.paySteps));
    check('写明了微信号 beta2meta', about.paySteps.some((step) => step.includes('beta2meta')), JSON.stringify(about.paySteps));
    check('收款码与微信二维码都加载成功', about.payCodes.length === 2 && about.payCodes.every((code) => code.loaded), JSON.stringify(about.payCodes));
    console.log('');

    // ── 2. 免费额度：分组 ───────────────────────────────────────────
    console.log('【2】免费版最多两个搜索源分组');
    const groupsBefore = await readStorage(['groups']);
    check('起点没有用户自建分组', userGroupNames(groupsBefore.groups).length === 0, JSON.stringify(userGroupNames(groupsBefore.groups)));
    check('第一个分组可以创建', (await addGroupFromUi('组一')) === true);
    check('第二个分组可以创建', (await addGroupFromUi('组二')) === true);
    const groupLocked = await page.evaluate(() => ({
      title: document.querySelector('#add-group').title,
      locked: document.querySelector('#add-group').classList.contains('is-locked'),
    }));
    check('分组额度用尽后按钮提示写清上限', groupLocked.title.includes('最多创建 2 个'), groupLocked.title);
    check('配额用尽后按钮进入锁定态', groupLocked.locked === true);
    check('第三个分组被拦下（不弹命名框）', (await addGroupFromUi('组三')) === false);
    const afterBlock = await page.evaluate(() => ({
      panel: document.querySelector('.nav-item.active')?.dataset.panel,
      focused: document.activeElement?.id,
    }));
    check('拦下后自动切到「关于」', afterBlock.panel === 'about', afterBlock.panel);
    check('焦点落在激活码输入框', afterBlock.focused === 'license-code', afterBlock.focused);
    const groupNames = userGroupNames((await readStorage(['groups'])).groups);
    check('存储里仍然只有两个自建分组', groupNames.length === 2, JSON.stringify(groupNames));
    console.log('');

    // ── 3. 免费额度：搜索源 ─────────────────────────────────────────
    console.log('【3】免费版最多启用二十个搜索源');
    // 全新安装已启用 5 个，第 6~20 个都要能加；每加一个都会自己启用。
    for (let enabled = DEFAULT_ENABLED_COUNT + 1; enabled <= FREE_SOURCE_LIMIT; enabled += 1) {
      const result = await addSourceFromUi('源' + enabled);
      check(`第 ${enabled} 个已启用搜索源可以添加`, result.added === true, JSON.stringify(result));
    }
    const sourceLocked = await page.evaluate(() => ({
      title: document.querySelector('#add-source').title,
      locked: document.querySelector('#add-source').classList.contains('is-locked'),
    }));
    check('搜索源额度用尽后按钮提示写清上限', sourceLocked.title.includes('最多启用 20 个'), sourceLocked.title);
    check('搜索源配额用尽后按钮进入锁定态', sourceLocked.locked === true);
    const blockedSource = await addSourceFromUi('源D');
    check('第 21 个已启用搜索源被拦下（弹窗不打开）', blockedSource.added === false && blockedSource.alerted === true, JSON.stringify(blockedSource));
    const sourcesAfter = await readStorage(['sources']);
    check('已启用的搜索源正好 20 个', enabledCount(sourcesAfter.sources) === FREE_SOURCE_LIMIT, String(enabledCount(sourcesAfter.sources)));
    console.log('');

    // ── 4. 激活一年会员：两条额度都放开 ────────────────────────────
    console.log('【4】激活码激活一年会员后额度放开');
    const yearlyCode = api.issue('yearly');
    await page.click('.nav-item[data-panel="about"]');
    await page.waitForTimeout(120);
    // 小写、带连字符、前后空格都该能认出来：码是要手抄的。
    await page.fill('#license-email', BUYER_EMAIL);
    await page.fill('#license-code', '  ' + yearlyCode.toLowerCase() + ' ');
    await page.click('#activate-license');
    await page.waitForTimeout(250);
    const activated = await page.evaluate(() => {
      const panel = document.querySelector('[data-panel-content="about"]');
      return {
        status: panel.querySelector('#license-status').textContent.trim(),
        member: panel.querySelector('#license-status').classList.contains('is-member'),
        groupQuota: panel.querySelector('#license-group-quota').textContent.trim(),
        sourceQuota: panel.querySelector('#license-source-quota').textContent.trim(),
        current: Array.from(panel.querySelectorAll('#plan-cards .plan-card.is-current')).map((card) => card.dataset.plan),
        clearDisplay: getComputedStyle(panel.querySelector('#license-clear-row')).display,
        error: panel.querySelector('#license-error').textContent.trim(),
        input: panel.querySelector('#license-code').value,
      };
    });
    check('激活成功且没有报错', activated.error === '', activated.error);
    check('状态显示一年会员与到期日', /一年会员.*\d{4}-\d{2}-\d{2} 到期/.test(activated.status), activated.status);
    check('状态标记为会员', activated.member === true);
    check('分组额度改为不限', activated.groupQuota.includes('不限'), activated.groupQuota);
    check('搜索源额度改为不限', activated.sourceQuota.includes('不限'), activated.sourceQuota);
    check('「当前」移到一年会员卡片上', activated.current.join(',') === 'yearly', JSON.stringify(activated.current));
    check('「清除激活码」行排进了布局', activated.clearDisplay === 'flex', activated.clearDisplay);
    check('激活后清空输入框', activated.input === '', activated.input);

    const stored = await readStorage(['license']);
    check('许可证写入 sync 存储', stored.license && stored.license.plan === 'yearly' && Boolean(stored.license.code), JSON.stringify(stored.license));
    const validDays = stored.license ? Math.round((stored.license.expiresAt - stored.license.activatedAt) / 86400000) : 0;
    check('有效期为一年', validDays === 365, String(validDays));

    check('会员可以添加第 21 个搜索源', (await addSourceFromUi('源D')).added === true);
    check('会员可以创建第三个分组', (await addGroupFromUi('组三')) === true);
    const grown = await readStorage(['groups', 'sources']);
    check('第三个分组已落盘', userGroupNames(grown.groups).length === 3, JSON.stringify(userGroupNames(grown.groups)));
    check('第 21 个已启用搜索源已落盘', enabledCount(grown.sources) === 21, String(enabledCount(grown.sources)));
    console.log('');

    // ── 5. 无效码 ───────────────────────────────────────────────────
    console.log('【5】无效激活码不改变状态');
    await page.click('.nav-item[data-panel="about"]');
    await page.waitForTimeout(120);
    await page.click('#clear-license');
    await page.waitForTimeout(200);
    const cleared = await page.evaluate(() => ({
      status: document.querySelector('#license-status').textContent.trim(),
      groupQuota: document.querySelector('#license-group-quota').textContent.trim(),
      sourceQuota: document.querySelector('#license-source-quota').textContent.trim(),
      clearHidden: document.querySelector('#license-clear-row').hidden,
    }));
    check('清除后回到未激活', cleared.status === '未激活', cleared.status);
    check('清除后分组额度回到 3 / 2（已超额，但分组不删）', cleared.groupQuota === '3 / 2', cleared.groupQuota);
    check('清除后搜索源额度回到 21 / 20', cleared.sourceQuota === '21 / 20', cleared.sourceQuota);
    check('清除后「清除激活码」行收起', cleared.clearHidden === true);

    await page.fill('#license-code', 'QF-0000-0000-0000');
    await page.click('#activate-license');
    await page.waitForTimeout(200);
    const malformed = await page.evaluate(() => document.querySelector('#license-error').textContent.trim());
    check('长度不对的码被判为格式错误', malformed.includes('格式'), malformed);

    // 形状对、签名不对：这才检验的是签名本身。
    await page.fill('#license-code', 'QFY0-0000-0000');
    await page.click('#activate-license');
    await page.waitForTimeout(200);
    const invalid = await page.evaluate(() => ({
      error: document.querySelector('#license-error').textContent.trim(),
      status: document.querySelector('#license-status').textContent.trim(),
    }));
    check('签名不符的码被判为无效', invalid.error.includes('无效'), invalid.error);
    check('无效码不改变状态', invalid.status === '未激活', invalid.status);
    const afterInvalid = await readStorage(['license']);
    check('无效码不写存储', afterInvalid.license === null || afterInvalid.license === undefined, JSON.stringify(afterInvalid.license));
    console.log('');

    // ── 6. 过期会员 ─────────────────────────────────────────────────
    console.log('【6】过期会员回到免费额度（已有配置保留）');
    const expiredCode = createCode('yearly');
    await page.evaluate((code) => new Promise((resolve) => chrome.storage.sync.set({
      license: { code, plan: 'yearly', activatedAt: Date.now() - 800 * 86400000, expiresAt: Date.now() - 435 * 86400000 },
    }, resolve)), expiredCode);
    await page.reload();
    await page.waitForFunction(() => document.querySelector('.nav-item[data-panel="about"]'));
    await page.click('.nav-item[data-panel="about"]');
    await page.waitForTimeout(250);
    const expired = await page.evaluate(() => {
      const panel = document.querySelector('[data-panel-content="about"]');
      return {
        status: panel.querySelector('#license-status').textContent.trim(),
        expiredClass: panel.querySelector('#license-status').classList.contains('is-expired'),
        memberClass: panel.querySelector('#license-status').classList.contains('is-member'),
        groupQuota: panel.querySelector('#license-group-quota').textContent.trim(),
        sourceQuota: panel.querySelector('#license-source-quota').textContent.trim(),
        current: Array.from(panel.querySelectorAll('#plan-cards .plan-card.is-current')).map((card) => card.dataset.plan),
      };
    });
    check('状态显示已过期', expired.status.startsWith('已过期'), expired.status);
    check('过期态与会员态互斥', expired.expiredClass === true && expired.memberClass === false, JSON.stringify(expired));
    check('过期后分组额度回到免费版', expired.groupQuota === '3 / 2', expired.groupQuota);
    check('过期后搜索源额度回到免费版', expired.sourceQuota === '21 / 20', expired.sourceQuota);
    check('过期后「当前」回到免费版卡片', expired.current.join(',') === 'free', JSON.stringify(expired.current));
    check('过期后仍然建不了新分组', (await addGroupFromUi('组四')) === false);
    const blockedAfterExpiry = await addSourceFromUi('源E');
    check('过期后仍然加不了新搜索源', blockedAfterExpiry.added === false && blockedAfterExpiry.alerted === true, JSON.stringify(blockedAfterExpiry));
    const kept = await readStorage(['groups', 'sources']);
    check('过期只是限制新增，已有三个分组都还在', userGroupNames(kept.groups).length === 3, JSON.stringify(userGroupNames(kept.groups)));
    check('过期只是限制新增，已有 21 个已启用搜索源都还在', enabledCount(kept.sources) === 21, String(enabledCount(kept.sources)));
    console.log('');

    // ── 7. 永久会员 ─────────────────────────────────────────────────
    console.log('【7】永久会员没有到期日');
    const lifetimeCode = api.issue('lifetime');
    await page.click('.nav-item[data-panel="about"]');
    await page.waitForTimeout(120);
    await page.fill('#license-email', BUYER_EMAIL);
    await page.fill('#license-code', lifetimeCode);
    await page.click('#activate-license');
    await page.waitForTimeout(250);
    const lifetime = await page.evaluate(() => new Promise((resolve) => chrome.storage.sync.get(['license'], (all) => resolve({
      plan: all.license?.plan,
      expiresAt: all.license?.expiresAt,
      status: document.querySelector('#license-status').textContent.trim(),
      current: Array.from(document.querySelectorAll('#plan-cards .plan-card.is-current')).map((card) => card.dataset.plan),
    }))));
    check('永久会员落盘为 lifetime', lifetime.plan === 'lifetime', JSON.stringify(lifetime));
    check('永久会员不写到期时间', lifetime.expiresAt === null, JSON.stringify(lifetime));
    check('状态显示永久会员且不带日期', lifetime.status === '永久会员', lifetime.status);
    check('「当前」落在永久会员卡片上', lifetime.current.join(',') === 'lifetime', JSON.stringify(lifetime.current));
  } finally {
    await env.close();
  }
  process.exit(summary());
})().catch((error) => { console.error(error); process.exit(2); });