"""把收款码 / 微信二维码裁剪成「关于」页可以直接放的小图。

输入是两张原始截图（白底或绿底、四周留白很大），输出 public/pay/ 下两张 320px 的方图：
- wechat-pay.png：微信收款码本体（卡片上的收款人姓名那行与绿边都裁掉，姓名改由
  卡片下方的说明显示，二维码因此能占满卡片）
- wechat-contact.png：绿点阵二维码本体

用法：python scripts/make-pay-qrcode.py <收款码.png> <微信二维码.png>
"""

import sys
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'public' / 'pay'
# 页面上二维码按 148px 宽显示，2 倍图足够清晰；再大只是白占扩展体积。
TARGET_WIDTH = 320


def is_white(pixel: tuple[int, int, int]) -> bool:
    return min(pixel[:3]) >= 240


def is_green(pixel: tuple[int, int, int]) -> bool:
    r, g, b = pixel[:3]
    return g >= 110 and g - r >= 40 and g - b >= 40


def bbox_of(image: Image.Image, predicate, min_run: int = 40) -> tuple[int, int, int, int]:
    """按行列扫描，返回 predicate 命中的最外围连续区间。

    直接取所有命中像素的包围盒会被边角杂色带跑偏，所以先要求某一列（行）至少命中
    `min_run` 个像素才承认它属于图形本体。
    """
    width, height = image.size
    pixels = image.load()
    left = right = top = bottom = None
    for x in range(width):
        hits = sum(1 for y in range(height) if predicate(pixels[x, y]))
        if hits >= min_run:
            left = x if left is None else left
            right = x
    for y in range(height):
        hits = sum(1 for x in range(width) if predicate(pixels[x, y]))
        if hits >= min_run:
            top = y if top is None else top
            bottom = y
    if left is None or top is None:
        raise SystemExit('没有找到目标区域')
    return left, top, right + 1, bottom + 1


def white_card_bbox(image: Image.Image) -> tuple[int, int, int, int]:
    """收款码那张图里有两块白：中间的二维码卡片、底部的微信支付页脚。

    页脚是整屏宽的纯白，会一路顶到图片左右边缘；卡片则被绿色背景包着。所以只认
    「不碰左右边缘、且足够宽」的白色横段——得到的就是卡片本身。
    """
    width, height = image.size
    pixels = image.load()
    left = right = top = bottom = None
    for y in range(height):
        run_start = None
        for x in range(width + 1):
            white = x < width and is_white(pixels[x, y])
            if white and run_start is None:
                run_start = x
            elif not white and run_start is not None:
                length = x - run_start
                if length >= 400 and run_start > 0 and x < width:
                    left = run_start if left is None else min(left, run_start)
                    right = x if right is None else max(right, x)
                    top = y if top is None else min(top, y)
                    bottom = y
                run_start = None
    if left is None or top is None:
        raise SystemExit('没有找到收款码卡片')
    return left, top, right, bottom + 1


def crop_pay(path: Path) -> Image.Image:
    image = Image.open(path).convert('RGB')
    box = white_card_bbox(image)
    print(f'收款码白色卡片：{box}')
    # 卡片上方是二维码，下方一行是收款人姓名。只留二维码：姓名在 140px 的卡片里只有
    # 五六个像素高、根本认不出，留着既占地方又把二维码挤小；核对收款方交给付款前的
    # 提示去做，扫开微信后也能看到收款人。
    left, top, right, bottom = box
    inset = 14
    card = image.crop((left + inset, top + inset, right - inset, bottom - inset))
    return crop_ink(card)


def crop_ink(image: Image.Image) -> Image.Image:
    """裁到第一块成片的深色内容（二维码本体），四周留 12px 白边当静区。"""
    width, height = image.size
    pixels = image.load()
    rows = [sum(1 for x in range(width) if max(pixels[x, y]) < 160) for y in range(height)]
    bands: list[tuple[int, int, int]] = []
    start = None
    for y, hits in enumerate(rows + [0]):
        if hits >= 5 and start is None:
            start = y
        elif hits < 5 and start is not None:
            bands.append((start, y, sum(rows[start:y])))
            start = None
    if not bands:
        raise SystemExit('没有找到二维码')
    # 二维码是最高的一整块；姓名那行是独立的窄带，会被排除在外。
    top, bottom, _ = max(bands, key=lambda band: band[1] - band[0])
    columns = [x for x in range(width) if any(max(pixels[x, y]) < 160 for y in range(top, bottom))]
    left, right = min(columns), max(columns) + 1
    pad = 12
    return image.crop((max(0, left - pad), max(0, top - pad), min(width, right + pad), min(height, bottom + pad)))


def crop_contact(path: Path) -> Image.Image:
    image = Image.open(path).convert('RGB')
    box = bbox_of(image, is_green, min_run=120)
    print(f'微信二维码本体：{box}')
    left, top, right, bottom = box
    pad = 10
    box = (max(0, left - pad), max(0, top - pad), min(image.width, right + pad), min(image.height, bottom + pad))
    return image.crop(box)


def save(image: Image.Image, name: str) -> None:
    # 二维码是纯色块，缩小时用 NEAREST 会锯齿、用 LANCZOS 只会让黑块边缘发灰，
    # 但两者都不影响识别；这里选 LANCZOS，缩小后看起来更接近屏幕渲染的原图。
    if image.width > TARGET_WIDTH:
        ratio = TARGET_WIDTH / image.width
        image = image.resize((TARGET_WIDTH, round(image.height * ratio)), Image.LANCZOS)
    OUT.mkdir(parents=True, exist_ok=True)
    target = OUT / name
    image.save(target, optimize=True)
    print(f'{target.relative_to(ROOT)}  {image.width}x{image.height}  {target.stat().st_size / 1024:.1f} KB')


def main() -> None:
    if len(sys.argv) != 3:
        raise SystemExit(__doc__)
    save(crop_pay(Path(sys.argv[1])), 'wechat-pay.png')
    save(crop_contact(Path(sys.argv[2])), 'wechat-contact.png')


if __name__ == '__main__':
    main()
