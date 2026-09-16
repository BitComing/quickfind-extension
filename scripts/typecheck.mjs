#!/usr/bin/env node
/**
 * QuickFind 类型检查与类型债务度量。
 *
 * 背景：三个入口由早期手写 JavaScript 迁移而来，顶部仍带 `// @ts-nocheck`。
 * 该标记对 tsc 完全静默，因此 `tsc --noEmit` 会「干净通过」却什么也没检查——
 * 类型债务既看不见，也不会因为新增代码而暴露。
 *
 * 本脚本解决两件事：
 *   1. 真实类型检查：运行 tsc，报告未被屏蔽文件的实际结果。
 *   2. 影子检查（--debt）：把被屏蔽文件里的标记临时移除后编译一次，
 *      得出每个文件的真实错误数，再严格恢复原文件；据此生成债务报告与基线。
 *
 * 有了基线，`--fail-on-regression` 就能在提交前拦住「债务变多」的改动，
 * 也可以用来确认「这次补了多少」。
 *
 * 用法：
 *   node scripts/typecheck.mjs                     只做真实类型检查
 *   node scripts/typecheck.mjs --debt              额外度量被屏蔽文件的真实错误
 *   node scripts/typecheck.mjs --update-baseline   写入或更新 .typecheck-baseline.json
 *   node scripts/typecheck.mjs --fail-on-regression  错误数超过基线即失败（退出码 1）
 *
 * 影子检查会短暂修改源文件，因此恢复逻辑放在 finally 与进程退出钩子里双重兜底，
 * 恢复后用内容比对确认与原文完全一致，不一致则以失败退出并明确指出文件。
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TSC = path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
const BASELINE_PATH = path.join(ROOT, '.typecheck-baseline.json');

/** 只在首个注释块里起作用的屏蔽标记。 */
const NOCHECK = /^\s*\/\/\s*@ts-nocheck\s*$/;
/** 参与检查的目录，以及一律跳过的目录。 */
const SCAN_DIRS = ['entrypoints', 'shared', 'types'];
const SKIP_DIRS = new Set(['node_modules', '.output', '.output2', '.wxt', 'legacy', 'output', '.git', '.git.bak', '.workbuddy', '.playwright-cli']);
/** 非 pretty 输出下每条诊断独占一行，形如 `path(line,col): error TS7006: msg`。 */
const DIAG = /^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+(TS\d+):\s*(.*)$/;

const argv = process.argv.slice(2);
const debt = argv.includes('--debt') || argv.includes('--update-baseline') || argv.includes('--fail-on-regression');
const updateBaseline = argv.includes('--update-baseline');
const gate = argv.includes('--fail-on-regression');

const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/');
const pad = (value, width) => String(value).padEnd(width);

// ---------- 源文件扫描 ----------

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const target = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(target));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) out.push(target);
  }
  return out;
}

function sourceFiles() {
  const out = [];
  for (const entry of fs.readdirSync(ROOT, { withFileTypes: true })) {
    const target = path.join(ROOT, entry.name);
    if (entry.isFile() && entry.name.endsWith('.ts')) out.push(target);
    else if (entry.isDirectory() && SCAN_DIRS.includes(entry.name)) out.push(...walk(target));
  }
  return out.sort();
}

function maskedFiles() {
  return sourceFiles().filter((file) => fs.readFileSync(file, 'utf8').split(/\r?\n/).some((line) => NOCHECK.test(line)));
}

// ---------- 编译与诊断解析 ----------

function runTsc() {
  if (!fs.existsSync(TSC)) {
    console.error(`[typecheck] 找不到 TypeScript：${TSC}`);
    console.error('[typecheck] 请先安装依赖（npm install）。');
    process.exit(2);
  }
  const result = spawnSync(process.execPath, [TSC, '--noEmit', '--pretty', 'false'], { cwd: ROOT, encoding: 'utf8' });
  if (result.error) throw result.error;
  return { status: result.status ?? 1, ...parseDiagnostics(`${result.stdout || ''}${result.stderr || ''}`) };
}

function parseDiagnostics(text) {
  const byFile = new Map();
  const byCode = new Map();
  const messages = new Map();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const match = DIAG.exec(line);
    if (!match) continue; // 诊断消息的续行，忽略
    const file = match[1].split(path.sep).join('/').replace(`${ROOT.split(path.sep).join('/')}/`, '');
    const code = match[5];
    byFile.set(file, (byFile.get(file) ?? 0) + 1);
    byCode.set(code, (byCode.get(code) ?? 0) + 1);
    if (!messages.has(code)) messages.set(code, match[6]);
  }
  const total = [...byFile.values()].reduce((sum, n) => sum + n, 0);
  return { byFile, byCode, messages, total };
}

// ---------- 影子检查（带强制恢复） ----------

/** 非空表示当前处于「源文件已被改写、尚未恢复」的窗口内。 */
let pendingRestore = null;

function restoreNow() {
  if (!pendingRestore) return [];
  const backups = pendingRestore;
  pendingRestore = null;
  const failed = [];
  for (const [file, original] of backups) {
    try {
      if (fs.readFileSync(file, 'utf8') !== original) fs.writeFileSync(file, original);
      if (fs.readFileSync(file, 'utf8') !== original) failed.push(file);
    } catch {
      failed.push(file);
    }
  }
  return failed;
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    restoreNow();
    process.exit(130);
  });
}
process.on('exit', () => {
  restoreNow();
});

function shadowCheck(files) {
  const backups = new Map(files.map((file) => [file, fs.readFileSync(file, 'utf8')]));
  pendingRestore = backups;
  let diagnostics;
  try {
    for (const [file, original] of backups) {
      fs.writeFileSync(file, original.split(/\r?\n/).filter((line) => !NOCHECK.test(line)).join('\n'));
    }
    diagnostics = runTsc();
  } finally {
    const failed = restoreNow();
    if (failed.length) {
      console.error('[typecheck] 恢复源文件失败，请用 git 检查以下文件：');
      for (const file of failed) console.error('  - ' + rel(file));
      process.exit(2);
    }
  }
  return diagnostics;
}

// ---------- 基线 ----------

function loadBaseline() {
  try {
    return JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));
  } catch {
    return null;
  }
}

// ---------- 主流程 ----------

const checked = sourceFiles();
const masked = maskedFiles();

console.log('QuickFind 类型检查');
console.log('='.repeat(64));

const real = runTsc();
console.log(`\n真实类型检查（tsc --noEmit）`);
console.log(`  扫描源文件 ${checked.length} 个，其中 ${checked.length - masked.length} 个在检查范围内`);
if (real.total === 0) {
  console.log('  结果：通过，未发现错误');
} else {
  console.log(`  结果：${real.total} 个错误`);
  for (const [file, count] of [...real.byFile].sort((a, b) => b[1] - a[1])) console.log(`    ${pad(count, 5)} ${file}`);
}

if (!masked.length) {
  console.log('\n没有文件被 @ts-nocheck 屏蔽，类型检查已全覆盖。');
  process.exit(real.status === 0 ? 0 : 1);
}

console.log(`\n被 @ts-nocheck 屏蔽的文件（tsc 对其完全静默）`);
for (const file of masked) console.log('    ' + rel(file));

if (!debt) {
  console.log('\n提示：加 --debt 可以量出这些文件的真实错误数。');
  process.exit(real.status === 0 ? 0 : 1);
}

console.log('\n正在做影子检查：临时移除屏蔽标记后编译一次，随后原样恢复……');
const shadow = shadowCheck(masked);
const shadowByFile = new Map(masked.map((file) => [rel(file), shadow.byFile.get(rel(file)) ?? 0]));
const shadowTotal = [...shadowByFile.values()].reduce((sum, n) => sum + n, 0);

const baseline = loadBaseline();
const baselineFiles = baseline?.files ?? {};

console.log(`\n类型债务（真实错误数）`);
console.log(`  ${pad('文件', 40)}${pad('当前', 8)}${pad('基线', 8)}变化`);
for (const [file, count] of [...shadowByFile].sort((a, b) => b[1] - a[1])) {
  const before = baselineFiles[file];
  const delta = before === undefined ? '新增' : String(count - before);
  console.log(`  ${pad(file, 40)}${pad(count, 8)}${pad(before ?? '-', 8)}${delta}`);
}
const baselineTotal = baseline?.total ?? 0;
console.log(`  ${pad('合计', 40)}${pad(shadowTotal, 8)}${pad(baseline ? baselineTotal : '-', 8)}${baseline ? String(shadowTotal - baselineTotal) : '新增'}`);

if (shadow.byCode.size) {
  const top = [...shadow.byCode].sort((a, b) => b[1] - a[1]).slice(0, 8);
  console.log('\n债务构成（按错误码，取前 8）');
  for (const [code, count] of top) {
    console.log(`  ${pad(code, 9)}${pad(count, 6)}${(shadow.messages.get(code) ?? '').slice(0, 72)}`);
  }
}

if (updateBaseline) {
  const payload = {
    note: '由 scripts/typecheck.mjs --update-baseline 生成。数字代表各文件真实类型错误数，只应下降。',
    generatedAt: new Date().toISOString(),
    total: shadowTotal,
    files: Object.fromEntries([...shadowByFile].sort((a, b) => b[1] - a[1])),
    byCode: Object.fromEntries([...shadow.byCode].sort((a, b) => b[1] - a[1])),
  };
  fs.writeFileSync(BASELINE_PATH, JSON.stringify(payload, null, 2) + '\n');
  console.log(`\n已写入基线：${rel(BASELINE_PATH)}`);
}

let failed = real.status !== 0;
if (gate) {
  if (!baseline) {
    console.log('\n门禁：没有基线可比，先跑一次 --update-baseline。');
  } else {
    const worse = [];
    if (shadowTotal > baseline.total) worse.push(`合计 ${baseline.total} → ${shadowTotal}`);
    for (const [file, count] of shadowByFile) {
      const before = baselineFiles[file];
      if (before !== undefined && count > before) worse.push(`${file} ${before} → ${count}`);
    }
    if (worse.length) {
      console.log('\n门禁未通过：类型债务增加');
      for (const item of worse) console.log('  - ' + item);
      failed = true;
    } else {
      console.log('\n门禁通过：类型债务未增加');
    }
  }
}

console.log('='.repeat(64));
process.exit(failed ? 1 : 0);
