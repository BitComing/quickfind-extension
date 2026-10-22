/**
 * Markdown 渲染（无依赖，纯字符串 → 字符串）。
 *
 * 为什么自己写而不引库：内容脚本要内联进每个页面，依赖体积与 CSP 都是现实约束；
 * 而对话面板需要的只是「把模型回复排成看起来对的 HTML」这一档能力，
 * 不需要 CommonMark 全覆盖。所以这里只做高频子集，并把安全边界写死。
 *
 * 安全：**先转义再套标签**，只输出本文件自己产生的标签。模型回复与用户输入都当作不可信文本，
 * 不允许原始 HTML 穿透（`<script>` 会变成可见的 `&lt;script&gt;`）；链接只放行
 * http/https/mailto 与站内相对路径，`javascript:` 一律降级成纯文本。
 *
 * 这是纯函数，两处宿主（内容脚本的对话窗口）共用一份，也便于单测。
 */

/** 转义表。`'` 也要转，避免属性里用单引号时被提前闭合。 */
const ESCAPE_MAP: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/**
 * 行内代码先抠出来占位，避免其中 `*` `_` `[` 被后续规则误伤。
 * 哨兵用私用区字符（U+E000）而不是控制字符：控制字符会被 lint 拒掉，
 * 而这个码位在正常文本里不会出现，同样不会与正文冲突。
 */
const CODE_SENTINEL = '\uE000';
const CODE_SENTINEL_PATTERN = /\uE000(\d+)\uE000/g;

/** 只放行这几种链接目标；其余（javascript:、data: 等）一律降级成纯文本。 */
const SAFE_LINK = /^(?:https?:|mailto:|#|\/|\.\/|\.\.\/)/i;

export function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ESCAPE_MAP[char] ?? char);
}

/**
 * 行内规则：代码 → 粗体 → 斜体 → 链接。
 *
 * 顺序有讲究：链接最后处理，因为它的 label 可能含 `**`；而行内代码最先被替换成哨兵，
 * 保证代码里的标记不会被当成格式。
 */
function renderInline(raw: string): string {
  const codeSpans: string[] = [];
  let out = escapeHtml(raw).replace(/`([^`]+)`/g, (_match, code: string) => {
    codeSpans.push(code);
    return `${CODE_SENTINEL}${codeSpans.length - 1}${CODE_SENTINEL}`;
  });
  out = out
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_]+)__/g, '<strong>$1</strong>')
    // 斜体要避开紧邻的 `*`/`_`，否则 `**bold**` 的残片会被再吃一次。
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/(^|[^_])_([^_\n]+)_/g, '$1<em>$2</em>');
  // 链接目标允许一层配对括号：`[x](https://en.wikipedia.org/wiki/A_(b))` 这类地址很常见，
// 用 `[^)\s]+` 会在第一个 `)` 处截断，把多余的 `)` 漏成正文。
  out = out.replace(/\[([^\]]+)\]\(((?:[^()\s]|\([^()\s]*\))+)\)/g, (match, label: string, href: string) => (
    SAFE_LINK.test(href)
      ? `<a href="${href}" target="_blank" rel="noopener noreferrer">${label}</a>`
      : label
  ));
  return out.replace(CODE_SENTINEL_PATTERN, (_match, index: string) => `<code>${codeSpans[Number(index)] ?? ''}</code>`);
}

/** 单行判定：三个及以上的 `-`/`*`/`_`（可带空格）即分隔线。 */
const HR_PATTERN = /^\s{0,3}(?:[-*_]\s*){3,}$/;
const FENCE_PATTERN = /^\s*```(.*)$/;
const HEADING_PATTERN = /^(#{1,6})\s+(.*)$/;
const QUOTE_PATTERN = /^\s*>\s?(.*)$/;
const BULLET_PATTERN = /^\s*[-*+]\s+(.*)$/;
const ORDERED_PATTERN = /^\s*\d+[.)]\s+(.*)$/;

/** 把连续的同类列表项收成一个列表；返回吃掉的行数（含首行）。 */
function collectList(lines: string[], start: number, pattern: RegExp): string[] {
  const items: string[] = [];
  let index = start;
  while (index < lines.length) {
    const match = pattern.exec(lines[index] ?? '');
    if (!match) break;
    items.push(match[1] ?? '');
    index += 1;
  }
  return items;
}

/**
 * 块级渲染。逐行扫描而非正则整篇替换，是因为「段落/列表/代码块」的边界必须显式维护，
 * 一次性替换的写法在嵌套与空行上很难做对。
 */
export function renderMarkdown(source: unknown): string {
  const text = String(source ?? '').replace(/\r\n?/g, '\n');
  if (!text.trim()) return '';
  const lines = text.split('\n');
  const html: string[] = [];
  let paragraph: string[] = [];

  const flushParagraph = (): void => {
    if (!paragraph.length) return;
    html.push(`<p>${paragraph.map(renderInline).join('<br>')}</p>`);
    paragraph = [];
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';

    // 代码块优先于其它规则：里面的 #、- 都是字面内容。
    const fence = FENCE_PATTERN.exec(line);
    if (fence) {
      flushParagraph();
      const language = (fence[1] ?? '').trim();
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !FENCE_PATTERN.test(lines[index] ?? '')) {
        body.push(lines[index] ?? '');
        index += 1;
      }
      const className = language ? ` class="language-${escapeHtml(language)}"` : '';
      html.push(`<pre><code${className}>${escapeHtml(body.join('\n'))}</code></pre>`);
      continue;
    }

    if (!line.trim()) {
      flushParagraph();
      continue;
    }

    if (HR_PATTERN.test(line)) {
      flushParagraph();
      html.push('<hr>');
      continue;
    }

    const heading = HEADING_PATTERN.exec(line);
    if (heading) {
      flushParagraph();
      const level = (heading[1] ?? '').length;
      html.push(`<h${level}>${renderInline((heading[2] ?? '').trim())}</h${level}>`);
      continue;
    }

    const quote = QUOTE_PATTERN.exec(line);
    if (quote) {
      flushParagraph();
      const body = collectList(lines, index, QUOTE_PATTERN);
      index += body.length - 1;
      html.push(`<blockquote>${body.map(renderInline).join('<br>')}</blockquote>`);
      continue;
    }

    if (BULLET_PATTERN.test(line)) {
      flushParagraph();
      const items = collectList(lines, index, BULLET_PATTERN);
      index += items.length - 1;
      html.push(`<ul>${items.map((item) => `<li>${renderInline(item)}</li>`).join('')}</ul>`);
      continue;
    }

    if (ORDERED_PATTERN.test(line)) {
      flushParagraph();
      const items = collectList(lines, index, ORDERED_PATTERN);
      index += items.length - 1;
      html.push(`<ol>${items.map((item) => `<li>${renderInline(item)}</li>`).join('')}</ol>`);
      continue;
    }

    paragraph.push(line);
  }

  flushParagraph();
  return html.join('');
}

/** 取一段纯文本预览：去掉标记后压成一行，供历史卡片与标题用。 */
export function markdownToPlainText(source: unknown, limit = 0): string {
  const text = String(source ?? '')
    .replace(FENCE_PATTERN, '')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_>#~-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!limit || text.length <= limit) return text;
  return `${text.slice(0, limit)}…`;
}