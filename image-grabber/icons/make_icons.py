#!/usr/bin/env python3
"""生成插件所需的 PNG 图标（纯标准库实现，无需 PIL）。

图标为圆角方形的品牌色背景 + 白色下载箭头，象征"抓取/下载图片"。
运行： python3 make_icons.py
"""
import struct
import zlib
import os

# 品牌主色（青蓝渐变的中间色）
BG_TOP = (56, 132, 255)      # 顶部蓝
BG_BOTTOM = (99, 82, 255)    # 底部紫
ARROW = (255, 255, 255)      # 白色箭头
TRANSPARENT = (0, 0, 0, 0)


def lerp(a, b, t):
    return int(round(a + (b - a) * t))


def make_image(size):
    """返回 size x size 的 RGBA 像素矩阵。"""
    r = size / 2.0 - 0.5
    cx = cy = size / 2.0 - 0.5
    radius = size * 0.22  # 圆角半径
    px = [[list(TRANSPARENT) for _ in range(size)] for _ in range(size)]

    for y in range(size):
        t = y / max(1, size - 1)
        bg = (
            lerp(BG_TOP[0], BG_BOTTOM[0], t),
            lerp(BG_TOP[1], BG_BOTTOM[1], t),
            lerp(BG_TOP[2], BG_BOTTOM[2], t),
        )
        for x in range(size):
            # 圆角矩形遮罩
            dx = 0.0
            dy = 0.0
            if x < radius:
                dx = radius - x
            elif x > size - 1 - radius:
                dx = x - (size - 1 - radius)
            if y < radius:
                dy = radius - y
            elif y > size - 1 - radius:
                dy = y - (size - 1 - radius)
            if dx > 0 and dy > 0 and (dx * dx + dy * dy) > radius * radius:
                continue  # 角外，保持透明
            px[y][x] = [bg[0], bg[1], bg[2], 255]

    # 绘制下载箭头（竖线 + 三角 + 底部托盘）
    stroke = max(1, int(round(size * 0.08)))
    # 竖线
    top_y = size * 0.24
    mid_y = size * 0.56
    for y in range(int(top_y), int(mid_y)):
        for x in range(int(cx - stroke / 2), int(cx + stroke / 2) + 1):
            if 0 <= x < size and 0 <= y < size and px[y][x][3]:
                px[y][x] = [ARROW[0], ARROW[1], ARROW[2], 255]
    # 箭头三角
    tip_y = size * 0.72
    half = size * 0.20
    for y in range(int(mid_y - half * 0.2), int(tip_y) + 1):
        prog = (y - (mid_y - half * 0.2)) / max(1, (tip_y - (mid_y - half * 0.2)))
        w = half * (1 - prog)
        for x in range(int(cx - w), int(cx + w) + 1):
            if 0 <= x < size and 0 <= y < size and px[y][x][3]:
                px[y][x] = [ARROW[0], ARROW[1], ARROW[2], 255]
    # 底部托盘
    tray_y = size * 0.80
    for y in range(int(tray_y), int(tray_y + stroke)):
        for x in range(int(cx - half), int(cx + half) + 1):
            if 0 <= x < size and 0 <= y < size and px[y][x][3]:
                px[y][x] = [ARROW[0], ARROW[1], ARROW[2], 255]
    return px


def write_png(path, px):
    size = len(px)
    raw = bytearray()
    for y in range(size):
        raw.append(0)  # filter type 0
        for x in range(size):
            raw.extend(px[y][x])

    def chunk(tag, data):
        c = struct.pack(">I", len(data)) + tag + data
        crc = zlib.crc32(tag + data) & 0xFFFFFFFF
        return c + struct.pack(">I", crc)

    sig = b"\x89PNG\r\n\x1a\n"
    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)  # 8bit RGBA
    idat = zlib.compress(bytes(raw), 9)
    with open(path, "wb") as f:
        f.write(sig)
        f.write(chunk(b"IHDR", ihdr))
        f.write(chunk(b"IDAT", idat))
        f.write(chunk(b"IEND", b""))


if __name__ == "__main__":
    here = os.path.dirname(os.path.abspath(__file__))
    for s in (16, 48, 128):
        img = make_image(s)
        out = os.path.join(here, f"icon{s}.png")
        write_png(out, img)
        print("wrote", out)
