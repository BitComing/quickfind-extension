// 由实时配置生成回归基准 tests/fixtures/_sync-state.txt（与旧的 KEY(n)/VAL(n) 格式一致）。
// 只写基准文件，不改源码。用法：node output/gen-sync-fixture.cjs
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const live = JSON.parse(fs.readFileSync(path.join(ROOT, 'output/_live-sync-state.json'), 'utf8'));

// 保持原基准的键顺序，最小化 diff。
const ORDER = [
  'defaultGroupCount', 'editableTriggerMode', 'enabled', 'groups', 'llm',
  'pinnedSearch', 'selectionTriggerDelay', 'sourceConfigVersion', 'sources',
  'triggerMode', 'llmDockVisible', 'searchHistory',
];

const blocks = [];
for (const key of ORDER) {
  if (!(key in live)) continue;
  const value = live[key];
  // 搜索历史不参与比对（canonical 不读它），沿用原来的单条占位，避免基准里塞个人数据。
  const valueText = key === 'searchHistory'
    ? '[{"query":"绿电炼铝","timestamp":1.789573890056e+12}]'
    : (typeof value === 'string' ? JSON.stringify(value) : JSON.stringify(value));
  blocks.push(`KEY(${Buffer.byteLength(key, 'utf8')}) "${key}"\nVAL(${Buffer.byteLength(valueText, 'utf8')}) ${valueText}`);
}

const out = blocks.join('\n\n') + '\n';
const target = path.join(ROOT, 'tests/fixtures/_sync-state.txt');
fs.writeFileSync(target, out);
console.log('已写入', target, Buffer.byteLength(out, 'utf8'), 'bytes');
console.log('键顺序:', ORDER.join(', '));