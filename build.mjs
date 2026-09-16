/**
 * QuickFind 构建入口。
 *
 * 流程：wxt 构建 → 写回产物快照 → 校验产物完整性。
 *
 * 为什么要写回：见 wxt.config.ts 中 qf-snapshot 插件的说明。简单说，Vite 写出的
 * 产物会在 wxt 收尾阶段被本机环境的非 JS 层清理动作移除，writeBundle 时刻是文件
 * 内容最终态、且尚在磁盘上的唯一窗口，因此在那个瞬间抓取内容、构建后写回。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
process.chdir(ROOT);

const OUT_ROOT = path.resolve(ROOT, process.env.QF_OUT_DIR || '.output');
/** 构建后由快照插件写入，以兼容 chrome-mv3 / firefox-mv2 等不同目标目录。 */
let OUT_DIR = '';

/** wxt 会把 entrypoints/<name>/index.html 移动到 <name>.html，这里做同样的映射。 */
function toFinalPath(name) {
  const m = /^entrypoints\/([^/]+)\/index\.html$/.exec(name);
  return m ? `${m[1]}.html` : name;
}

function listFiles(dir, base = dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listFiles(p, base));
    else out.push(path.relative(base, p).split(path.sep).join('/'));
  }
  return out;
}

/** 校验：manifest 引用的每个文件都必须存在，且各类产物齐全。 */
function verify() {
  const problems = [];
  const manifestPath = path.join(OUT_DIR, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    problems.push('manifest.json 缺失');
    return problems;
  }
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (e) {
    problems.push(`manifest.json 解析失败: ${e.message}`);
    return problems;
  }

  const refs = new Set();
  if (manifest.background?.service_worker) refs.add(manifest.background.service_worker);
  for (const s of manifest.background?.scripts ?? []) refs.add(s);
  for (const cs of manifest.content_scripts ?? []) {
    for (const f of cs.js ?? []) refs.add(f);
    for (const f of cs.css ?? []) refs.add(f);
  }
  if (manifest.action?.default_popup) refs.add(manifest.action.default_popup);
  if (manifest.options_page) refs.add(manifest.options_page);
  if (manifest.options_ui?.page) refs.add(manifest.options_ui.page);
  for (const v of Object.values(manifest.icons ?? {})) refs.add(v);
  for (const war of manifest.web_accessible_resources ?? []) {
    for (const r of war.resources ?? []) refs.add(r);
  }

  for (const ref of refs) {
    if (ref.includes('*')) continue;
    if (!fs.existsSync(path.join(OUT_DIR, ref))) problems.push(`manifest 引用了不存在的文件: ${ref}`);
  }

  const files = listFiles(OUT_DIR);
  for (const ext of ['.js', '.css', '.html', '.png']) {
    if (!files.some((f) => f.endsWith(ext))) problems.push(`缺少 ${ext} 类产物`);
  }
  return problems;
}

// ---------- 1. 构建 ----------
const argv = process.argv.slice(2);
const bi = argv.findIndex((a) => a === '-b' || a === '--browser');
const browser = bi >= 0 && argv[bi + 1] ? argv[bi + 1] : 'chrome';

fs.rmSync(OUT_ROOT, { recursive: true, force: true });
console.log(`[build] wxt 构建中（${browser}）...`);
const t0 = Date.now();
const wxt = await import('wxt');
await wxt.build({ browser, mode: 'production', root: ROOT });
console.log(`[build] wxt 构建返回，用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);

// ---------- 2. 写回快照 ----------
const snapshot = globalThis.__QF_SNAPSHOT__;
if (!snapshot || snapshot.size === 0) {
  console.error('[build] 未捕获到任何产物快照，构建中止');
  process.exit(1);
}
OUT_DIR = globalThis.__QF_SNAPSHOT_DIR__;
if (!OUT_DIR) {
  console.error('[build] 未获取到输出目录，构建中止');
  process.exit(1);
}

let written = 0;
for (const [name, buf] of snapshot) {
  const rel = toFinalPath(name);
  const target = path.join(OUT_DIR, rel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, buf);
  written++;
}
console.log(`[build] 已写回 ${written} 个产物（快照共 ${snapshot.size} 项）`);

// 静态资源兜底：public/ 下的文件若未出现在产物中，直接补齐
const publicDir = path.resolve(ROOT, 'public');
if (fs.existsSync(publicDir)) {
  for (const rel of listFiles(publicDir)) {
    const target = path.join(OUT_DIR, rel);
    if (!fs.existsSync(target)) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(path.join(publicDir, rel), target);
      console.log(`[build] 补充静态资源 ${rel}`);
    }
  }
}

// ---------- 3. 校验 ----------
let problems = verify();
if (problems.length) {
  console.error('\n[build] 校验未通过：');
  for (const p of problems) console.error('  - ' + p);
  process.exit(1);
}

// 产物可能在写回后再次被环境清理，延迟复检一次
await new Promise((r) => setTimeout(r, 2000));
problems = verify();
if (problems.length) {
  console.error('\n[build] 延迟复检未通过（产物写回后再度消失）：');
  for (const p of problems) console.error('  - ' + p);
  process.exit(1);
}

const files = listFiles(OUT_DIR).sort();
let total = 0;
console.log('\n[build] 产物清单：');
for (const f of files) {
  const size = fs.statSync(path.join(OUT_DIR, f)).size;
  total += size;
  console.log(`  ${String(size).padStart(8)}  ${f}`);
}
console.log(`\n[build] 共 ${files.length} 个文件，合计 ${(total / 1024).toFixed(1)} KB`);
console.log(`[build] 输出目录：${OUT_DIR}`);
console.log('[build] 构建成功');
