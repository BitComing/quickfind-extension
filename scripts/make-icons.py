"""QuickFind 插件图标：透明底、单色放大镜 + 一枚金色焦点。

设计约束（2026-11-07 用户要求）：
  · 不要背景色块——旧图标是深墨绿方块 + 金色放大镜，放在深色工具栏上像一块补丁；
  · 清爽：只留一条等宽描边的放大镜，镜内一点金色，暗示「快速定位到那一处」；
  · 16px 也要立得住，所以小尺寸按比例加粗描边，而不是把 128 直接缩下去。

几何定义在 24 网格上，按 32 倍超采样绘制后 LANCZOS 缩小，避免锯齿。
用法：python scripts/make-icons.py（产物落进 public/icon/）
"""
from PIL import Image, ImageDraw
import os

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
OUT = os.path.join(ROOT, 'public', 'icon')
SS = 32
GRID = 24
ACCENT = (47, 121, 91, 255)   # --qf-accent
GOLD = (245, 197, 107, 255)   # --qf-gold


def draw_icon(thickness, dot_radius):
    """在 24 网格上画一枚放大镜：圆环 + 45° 手柄 + 镜内金点。"""
    size = GRID * SS
    image = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)

    def ring(center, radius, width, color):
        w = width * SS
        cx, cy = center[0] * SS, center[1] * SS
        r = radius * SS
        draw.ellipse([cx - r - w / 2, cy - r - w / 2, cx + r + w / 2, cy + r + w / 2], fill=color)
        draw.ellipse([cx - r + w / 2, cy - r + w / 2, cx + r - w / 2, cy + r - w / 2], fill=(0, 0, 0, 0))

    def stroke(start, end, width, color):
        w = width * SS
        draw.line([(start[0] * SS, start[1] * SS), (end[0] * SS, end[1] * SS)], fill=color, width=int(round(w)))
        for x, y in (start, end):
            r = w / 2
            draw.ellipse([x * SS - r, y * SS - r, x * SS + r, y * SS + r], fill=color)

    ring((10.4, 10.4), 6.4, thickness, ACCENT)
    stroke((15.0, 15.0), (20.3, 20.3), thickness + 0.1, ACCENT)
    # 16px 省掉金点：4px 的镜内空间放不下，点只会和描边糊成一团。
    if dot_radius:
        d = dot_radius * SS
        draw.ellipse([8.5 * SS - d, 8.5 * SS - d, 8.5 * SS + d, 8.5 * SS + d], fill=GOLD)
    return image


# 小尺寸按比例加粗：16px 用 3.2，32px 用 2.6，48 及以上回到 2.4。
PLAN = {16: (3.2, None), 32: (2.6, 1.5), 48: (2.4, 1.6), 128: (2.4, 1.6)}

os.makedirs(OUT, exist_ok=True)
for size, (thickness, dot) in PLAN.items():
    icon = draw_icon(thickness, dot).resize((size, size), Image.LANCZOS)
    icon.save(os.path.join(OUT, f'{size}.png'), optimize=True)
    print(f'icon/{size}.png')