// 图标相关改动的回归（2026-11-07）：
//   1. 「搜索源图标」弹窗改版：预览 + 获取网站图标 / 上传 / 链接 / 恢复默认；
//   2. 列表行不再有「获取网站图标」按钮，图标位只负责打开弹窗；
//   3. 设置页左上角不再有黑色方块图标；
//   4. 插件图标重做：透明底、单线放大镜（角落必须透明）。
//
// 断言都对着构建产物跑：弹窗是真实 dialog、图标是真实文件、配置是真实 sync 存储。

const path = require('path');
const fs = require('fs');
const { launchWithExtension, createChecker } = require('./helpers.cjs');

const { check, summary } = createChecker();
const ICON_DIR = path.resolve(__dirname, '..', 'public', 'icon');

/** 读 sync 里某个搜索源当前的 iconUrl。 */
function storedIcon(page, sourceId) {
  return page.evaluate((id) => new Promise((resolve) => {
    chrome.storage.sync.get(['sources'], (all) => {
      const source = (all.sources || []).find((item) => item.id === id);
      resolve(source ? String(source.iconUrl || '') : null);
    });
  }), sourceId);
}

(async () => {
  const env = await launchWithExtension();
  try {
    const page = await env.openOptionsPage();
    await page.setViewportSize({ width: 1180, height: 860 });
    await page.click('.nav-item[data-panel="sources"]');
    await page.waitForTimeout(250);

    // ── 1. 左上角不再有黑色图标 ────────────────────────────────────
    console.log('【1】设置页左上角只剩字标');
    const brand = await page.evaluate(() => {
      const root = document.querySelector('.brand');
      const mark = document.querySelector('.brand-mark');
      return {
        text: root?.textContent.trim() || '',
        markCount: document.querySelectorAll('.brand-mark').length,
        // 侧栏里任何带深色背景、尺寸像图标的方块都算复辟
        darkBlocks: Array.from(document.querySelectorAll('.settings-sidebar *')).filter((node) => {
          const style = getComputedStyle(node);
          const rect = node.getBoundingClientRect();
          if (rect.width < 20 || rect.height < 20 || rect.width > 40 || rect.height > 40) return false;
          const match = style.backgroundColor.match(/\d+(\.\d+)?/g);
          if (!match) return false;
          const [r, g, b] = match.map(Number);
          return Math.max(r, g, b) < 80;
        }).length,
        markPresent: Boolean(mark),
      };
    });
    check('侧栏字标为 QuickFind', brand.text === 'QuickFind', brand.text);
    check('没有 .brand-mark 节点', brand.markCount === 0 && brand.markPresent === false, String(brand.markCount));
    check('侧栏里没有深色方块（黑图标已删除）', brand.darkBlocks === 0, String(brand.darkBlocks));
    console.log('');

    // ── 2. 列表行不再有获取图标按钮 ────────────────────────────────
    console.log('【2】列表行的图标按钮已移除');
    const row = await page.evaluate(() => {
      const first = document.querySelector('.source-row[data-source-id]');
      const buttons = Array.from(first?.querySelectorAll('.source-actions button') || []).map((button) => button.title);
      const logos = Array.from(first?.querySelectorAll('button[title*="获取网站图标"], button[title*="图标"]') || []).map((button) => button.title);
      return { buttons, logoTitle: first?.querySelector('.source-logo-button')?.title || '', logos };
    });
    check('行内只剩编辑与删除', JSON.stringify(row.buttons) === JSON.stringify(['编辑搜索源', '删除搜索源']), JSON.stringify(row.buttons));
    check('行内没有「获取网站图标」按钮', !row.buttons.includes('获取网站图标'), JSON.stringify(row.buttons));
    check('图标位提示为「更改图标」', row.logoTitle === '更改图标', row.logoTitle);
    console.log('');

    // ── 3. 弹窗结构与预览 ──────────────────────────────────────────
    console.log('【3】图标弹窗：预览、三个入口与链接输入');
    const sourceId = await page.evaluate(() => document.querySelector('.source-row[data-source-id]')?.dataset.sourceId || '');
    await page.locator('.source-row[data-source-id] .source-logo-button').first().click();
    await page.waitForTimeout(250);
    const dialog = await page.evaluate(() => {
      const node = document.querySelector('#icon-editor');
      const preview = document.querySelector('#icon-editor-preview');
      return {
        open: Boolean(node?.open),
        name: document.querySelector('#icon-editor-name')?.textContent.trim() || '',
        note: document.querySelector('#icon-editor-note')?.textContent.trim() || '',
        previewWidth: Math.round(preview?.getBoundingClientRect().width || 0),
        previewText: preview?.textContent.trim() || '',
        fetchVisible: Boolean(document.querySelector('#fetch-icon')?.getBoundingClientRect().height),
        uploadVisible: Boolean(document.querySelector('#upload-icon')?.getBoundingClientRect().height),
        restoreHidden: document.querySelector('#restore-icon')?.hidden ?? null,
        linkVisible: Boolean(document.querySelector('#icon-url')?.getBoundingClientRect().height),
        applyVisible: Boolean(document.querySelector('#apply-icon-url')?.getBoundingClientRect().height),
        fileInputHidden: document.querySelector('#icon-file')?.hidden ?? null,
      };
    });
    check('点图标位打开弹窗', dialog.open === true);
    check('标题旁显示搜索源名称', Boolean(dialog.name), dialog.name);
    check('预览块尺寸放大了（40px）', dialog.previewWidth === 40, `${dialog.previewWidth}px`);
    check('预览里是默认图标（字母）', Boolean(dialog.previewText), dialog.previewText);
    check('来源说明为「默认图标」', dialog.note === '默认图标', dialog.note);
    check('弹窗内有「获取网站图标」', dialog.fetchVisible === true);
    check('弹窗内有「上传图片」', dialog.uploadVisible === true);
    check('未换过图标时不显示「恢复默认」', dialog.restoreHidden === true, String(dialog.restoreHidden));
    check('弹窗内有链接输入与「使用链接」', dialog.linkVisible && dialog.applyVisible, String(dialog.linkVisible) + '/' + String(dialog.applyVisible));
    check('文件输入仍为隐藏', dialog.fileInputHidden === true, String(dialog.fileInputHidden));
    console.log('');

    // ── 4. 获取网站图标：落盘、预览与行内同步 ──────────────────────
    console.log('【4】「获取网站图标」在弹窗里生效');
    await page.click('#fetch-icon');
    await page.waitForTimeout(600);
    const fetched = await page.evaluate(() => ({
      note: document.querySelector('#icon-editor-note')?.textContent.trim() || '',
      hasImage: Boolean(document.querySelector('#icon-editor-preview img')),
      restoreHidden: document.querySelector('#restore-icon')?.hidden ?? null,
      open: Boolean(document.querySelector('#icon-editor')?.open),
      rowHasImage: Boolean(document.querySelector('.source-row .source-logo-button img')),
    }));
    const fetchedUrl = await storedIcon(page, sourceId);
    check('弹窗仍开着（可以继续换）', fetched.open === true);
    check('预览换成图片', fetched.hasImage === true);
    check('来源说明变为「网站图标」', fetched.note === '网站图标', fetched.note);
    check('出现「恢复默认」', fetched.restoreHidden === false, String(fetched.restoreHidden));
    check('iconUrl 已写入 sync', fetchedUrl.includes('/s2/favicons'), String(fetchedUrl));
    check('列表行同步显示新图标', fetched.rowHasImage === true);
    console.log('');

    // ── 5. 链接与错误提示 ─────────────────────────────────────────
    console.log('【5】链接入口与错误提示');
    await page.fill('#icon-url', 'javascript:alert(1)');
    await page.click('#apply-icon-url');
    await page.waitForTimeout(200);
    const rejected = await page.evaluate(() => document.querySelector('#icon-editor-error')?.textContent.trim() || '');
    check('非 http(s) 链接被拒绝并说明原因', rejected.includes('http'), rejected);
    await page.fill('#icon-url', 'https://example.com/icon.png');
    await page.click('#apply-icon-url');
    await page.waitForTimeout(300);
    const linked = await page.evaluate(() => ({
      note: document.querySelector('#icon-editor-note')?.textContent.trim() || '',
      error: document.querySelector('#icon-editor-error')?.textContent.trim() || '',
      input: document.querySelector('#icon-url')?.value || '',
    }));
    check('使用链接后说明为「自定义链接」', linked.note === '自定义链接', linked.note);
    check('成功后清空输入与错误', linked.input === '' && linked.error === '', JSON.stringify(linked));
    console.log('');

    // ── 6. 恢复默认 ───────────────────────────────────────────────
    console.log('【6】恢复默认');
    await page.click('#restore-icon');
    await page.waitForTimeout(300);
    const restored = await page.evaluate(() => ({
      note: document.querySelector('#icon-editor-note')?.textContent.trim() || '',
      restoreHidden: document.querySelector('#restore-icon')?.hidden ?? null,
      hasImage: Boolean(document.querySelector('#icon-editor-preview img')),
      rowHasImage: Boolean(document.querySelector('.source-row .source-logo-button img')),
    }));
    const restoredUrl = await storedIcon(page, sourceId);
    check('说明回到「默认图标」', restored.note === '默认图标', restored.note);
    check('预览回到字母', restored.hasImage === false);
    check('「恢复默认」再次隐藏', restored.restoreHidden === true, String(restored.restoreHidden));
    check('iconUrl 已清空并落盘', restoredUrl === '', String(restoredUrl));
    check('列表行回到默认图标', restored.rowHasImage === false);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    console.log('');

    // ── 7. 插件图标：透明底 ──────────────────────────────────────
    console.log('【7】插件图标重做且透明底');
    for (const size of [16, 32, 48, 128]) {
      check(`public/icon/${size}.png 存在`, fs.existsSync(path.join(ICON_DIR, `${size}.png`)));
    }
    // 在扩展页面里把 PNG 画进 canvas，直接量四个角的 alpha：旧图标是实底方块，角落 alpha 为 255。
    const alpha = await page.evaluate(async (base) => {
      const image = new Image();
      image.src = `${base}icon/128.png`;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = 128; canvas.height = 128;
      const context = canvas.getContext('2d');
      context.drawImage(image, 0, 0);
      const read = (x, y) => context.getImageData(x, y, 1, 1).data[3];
      // 整张图里不透明的像素数：放大镜是空心环，只采「中心一小块」会量到那个洞。
      const all = context.getImageData(0, 0, 128, 128).data;
      let ink = 0;
      for (let index = 3; index < all.length; index += 4) if (all[index] > 40) ink += 1;
      return { corners: [read(1, 1), read(126, 1), read(1, 126), read(126, 126)], ink };
    }, chromeBaseUrl(env.extId));
    check('四个角都是透明的', alpha.corners.every((value) => value === 0), JSON.stringify(alpha.corners));
    check('图标本身确实画了东西（不是空图）', alpha.ink > 2000, String(alpha.ink));
  } finally {
    await env.close();
  }
  process.exit(summary());
})();

function chromeBaseUrl(extId) {
  return `chrome-extension://${extId}/`;
}