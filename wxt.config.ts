import fs from 'node:fs';
import path from 'node:path';
import { defineConfig } from 'wxt';

/**
 * 产物快照插件。
 *
 * 背景：在本机环境下，Vite 写完产物后，文件会在 wxt 收尾汇总之前被非 JS 层的
 * 清理动作移除 —— writeBundle 时刻磁盘上 9 个产物全部完好，wxt 统计时已全部 ENOENT，
 * 且 fs/fs.promises 的 rm / unlink / rmdir / rename 都观测不到对应调用。
 *
 * 因此这里在 writeBundle 钩子里（文件刚写完、内容最终态的瞬间）立即把磁盘内容读入
 * 内存，由 build.mjs 在构建结束后写回。
 *
 * 注意必须读磁盘而不是 bundle 对象：Vite 的 html 插件在写入前会对 HTML 追加注入，
 * bundle 中 asset.source 的长度与磁盘实际内容不一致。
 */
function snapshotPlugin() {
  return {
    name: 'qf-snapshot',
    enforce: 'post' as const,
    writeBundle(options: any, bundle: any) {
      const outDir: string = options?.dir ?? path.resolve('.output/chrome-mv3');
      (globalThis as any).__QF_SNAPSHOT_DIR__ = outDir;
      const store: Map<string, Buffer> = ((globalThis as any).__QF_SNAPSHOT__ ||= new Map());
      for (const name of Object.keys(bundle ?? {})) {
        try {
          store.set(name, fs.readFileSync(path.join(outDir, name)));
        } catch {
          // 读不到就跳过，由 build.mjs 的校验环节报告缺失
        }
      }
    },
  };
}

export default defineConfig({
  outDir: process.env.QF_OUT_DIR || '.output',
  manifest: {
    name: 'QuickFind - 选中文字搜索',
    description: '选中文字后，在文字末端快速打开常用搜索引擎。',
    version: '1.0.0',
    permissions: ['storage', 'activeTab', 'contextMenus'],
    host_permissions: ['<all_urls>'],
    action: {
      default_title: 'QuickFind',
    },
  },
  vite: () => ({
    plugins: [snapshotPlugin()],
  }),
});
