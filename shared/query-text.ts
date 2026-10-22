/**
 * 查询文本的百分号编码还原。
 *
 * 为什么需要：站点的搜索地址如果对查询参数编码了两次，`URLSearchParams` 只解一层，
 * 解出来仍是 `%E4%B8%AD%E6%96%87` 这样的编码串。常驻搜索栏以「页面查询」为准显示这个值，
 * 用户看到的就是一串「符号 + 数字」而不是中文。搜索历史同样会被这串编码污染：
 * 一旦从编码 URL 抄来一次，之后每个没有查询的页面上兜底值都是它。
 *
 * 判定刻意保守，避免误伤正常的数字与符号：
 *  - 必须存在 `%XX` 形状的转义才尝试解码；「100%」「C++」这类没有转义的输入原样返回；
 *  - 整串解不动（如「50% off」里的 `% o` 不是合法转义）时 `decodeURIComponent` 抛错，
 *    此时保留原值；
 *  - 解出替换字符（U+FFFD）说明原串不是 UTF-8 百分号编码（如 GBK 站点），保留原值。
 * 最多解两轮，够覆盖「二次/三次编码」又不会无限递归。
 *
 * 已知取舍：用户若真的想搜字面量 `%2B`（URL 里写作 `%252B`），会被还原成 `+`。
 * 这种查询在实践中可以忽略，而中文能正常显示是更重要的默认。
 */
export function decodeQueryText(value: unknown): string {
  let text = String(value ?? '');
  for (let pass = 0; pass < 2; pass += 1) {
    if (!/%[0-9A-Fa-f]{2}/.test(text)) break;
    let next: string;
    try {
      next = decodeURIComponent(text);
    } catch {
      break;
    }
    if (next === text || next.includes('\uFFFD')) break;
    text = next;
  }
  return text;
}

/**
 * 选区文本规整。
 *
 * 页面上的选区几乎不会是干净的一行：多段正文、列表项、代码片段都带换行与缩进。
 * 此前统一按 `\s+ → ' '` 压平，多段内容挤成一行既不可读、也无法再按原结构拿去搜。
 * 所以这里区分两种控件能力：
 *  - `multiline = true`：保留换行与段间空行（压缩连续空行、去掉行首尾空白），
 *    行内空白仍折叠成一个空格。多行输入控件（浮层面板的 textarea）用它。
 *  - `multiline = false`：压成单行。<input type="text"> 显示不了换行，压平才是正确取舍。
 *
 * 代码里的缩进会因此变成单个空格：这是可读性与「结构还原」之间的取舍——
 * 保留列对齐需要保留连续空格，那会让普通正文里被复制来的 `&nbsp;` 缩进挤出一片空白。
 */
export function normalizeSelectionText(value: unknown, multiline = false): string {
  const text = String(value ?? '')
    .replace(/\r\n?/g, '\n')
    // 折叠行内空白（`[^\S\n]` 是「除换行以外的空白」），换行本身留着。
    .replace(/[^\S\n]+/g, ' ')
    .replace(/ *\n */g, '\n');
  if (!multiline) return text.replace(/\s+/g, ' ').trim();
  // 段间最多留一个空行，首尾的换行一并去掉。
  return text.replace(/\n{3,}/g, '\n\n').replace(/^\n+|\n+$/g, '');
}