"""Furry Everpony 图标候选生成器（v2）。

几何原语 → 同时渲染 PNG 预览与 SVG 源文件，保证两者一致。
纯几何，不含任何具体角色形象。

用法：python gen-logos.py
输出：docs/assets/ 下 logo-*.svg/.png 与对比图 sheet.png
"""

import math
from pathlib import Path

from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent
S = 2048
SIZE = 512
K = SIZE / S

ACCENT = (204, 120, 92)      # #cc785c
INK = (20, 20, 19)           # #141413
DAWN = (250, 249, 245)       # #faf9f5
RAIL = (20, 22, 26)          # #14161a
LIGHT = (232, 230, 224)

C = S // 2


def ring(r, w):
    return {"t": "ring", "r": r, "w": w}


def ring_gap(r, w, gap):
    return {"t": "ring_gap", "r": r, "w": w, "gap": gap}


def disc(ang, radius, r):
    return {"t": "disc", "ang": ang, "radius": radius, "r": r}


def tri(cy_off, side, up=True, fill=True, w=52):
    return {"t": "tri", "cy": C + cy_off, "side": side, "up": up, "fill": fill, "w": w}


def hole(sh):
    s = dict(sh)
    s["hole"] = True
    return s


def pt(ang, radius):
    a = math.radians(ang)
    return C + radius * math.cos(a), C - radius * math.sin(a)


def tri_pts(cy, side, up):
    h = side * 0.866
    if up:
        return [(C, cy - h * 2 / 3), (C - side / 2, cy + h / 3), (C + side / 2, cy + h / 3)]
    return [(C, cy + h * 2 / 3), (C - side / 2, cy - h / 3), (C + side / 2, cy - h / 3)]


def draw(shapes, d):
    for s in shapes:
        v = 0 if s.get("hole") else 255
        t = s["t"]
        if t in ("ring", "ring_gap"):
            r, w = s["r"], s["w"]
            d.ellipse([C - r, C - r, C + r, C + r], outline=v, width=w)
            if t == "ring_gap":
                g = s["gap"] / 2
                d.rectangle([C - g, C + r * 0.55, C + g, S], fill=0)
        elif t == "disc":
            x, y = pt(s["ang"], s["radius"])
            d.ellipse([x - s["r"], y - s["r"], x + s["r"], y + s["r"]], fill=v)
        elif t == "tri":
            if s["fill"]:
                d.polygon(tri_pts(s["cy"], s["side"], s["up"]), fill=v)
            else:
                p = tri_pts(s["cy"], s["side"], s["up"])
                d.line(p + [p[0]], fill=v, width=s["w"], joint="curve")


def to_svg(shapes, bg):
    def f(v):
        return round(v * K, 2)

    out = ['<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">']
    for s in shapes:
        col = bg if s.get("hole") else "currentColor"
        t = s["t"]
        if t in ("ring", "ring_gap"):
            out.append(f'<circle cx="256" cy="256" r="{f(s["r"])}" fill="none" stroke="currentColor" stroke-width="{f(s["w"])}"/>')
            if t == "ring_gap":
                g = f(s["gap"] / 2)
                out.append(f'<rect x="{256-g}" y="{f(C + s["r"] * 0.55)}" width="{g*2}" height="{f(S)}" fill="{bg}"/>')
        elif t == "disc":
            x, y = pt(s["ang"], s["radius"])
            out.append(f'<circle cx="{f(x)}" cy="{f(y)}" r="{f(s["r"])}" fill="{col}"/>')
        elif t == "tri":
            p = tri_pts(s["cy"], s["side"], s["up"])
            pts = " ".join(f"{f(x)},{f(y)}" for x, y in p)
            if s["fill"]:
                out.append(f'<polygon points="{pts}" fill="{col}"/>')
            else:
                out.append(f'<polygon points="{pts}" fill="none" stroke="currentColor" stroke-width="{f(s["w"])}" stroke-linejoin="round"/>')
    out.append("</svg>")
    return "\n".join(out)


VARIANTS = {
    "a": ("A 环 + 三钉 + 中央三角", [
        ring(760, 70), disc(90, 470, 150), disc(210, 470, 150), disc(330, 470, 150),
        tri(30, 420, True, True),
    ]),
    "b": ("B 细线版（更精致）", [
        ring(790, 44), disc(90, 480, 128), disc(210, 480, 128), disc(330, 480, 128),
        tri(20, 360, True, True),
    ]),
    "c": ("C 负空间（实心盘挖空）", [
        disc(0, 0, 830),
        hole(disc(90, 460, 155)), hole(disc(210, 460, 155)), hole(disc(330, 460, 155)),
        hole(tri(20, 430, True, True)),
    ]),
    "d": ("D 马蹄铁开口环", [
        ring_gap(760, 70, 240), disc(30, 560, 118), disc(90, 560, 118), disc(150, 560, 118),
        tri(40, 400, True, True),
    ]),
    "e": ("E 全线框（UI 图标用）", [
        ring(780, 52), disc(90, 470, 150), disc(210, 470, 150), disc(330, 470, 150),
        tri(20, 380, True, False, 52),
    ]),
    "f": ("F 上三下三（爪印感）", [
        ring(760, 70), disc(45, 470, 118), disc(90, 470, 118), disc(135, 470, 118),
        tri(260, 430, False, True),
    ]),
}


def render(shapes, color):
    m = Image.new("L", (S, S), 0)
    draw(shapes, ImageDraw.Draw(m))
    m = m.resize((SIZE, SIZE), Image.LANCZOS)
    img = Image.new("RGBA", (SIZE, SIZE), color + (255,))
    img.putalpha(m)
    return img


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    keys = list(VARIANTS)
    for key in keys:
        _, shapes = VARIANTS[key]
        render(shapes, ACCENT).save(OUT / f"logo-{key}.png")
        render(shapes, INK).save(OUT / f"logo-{key}-ink.png")
        (OUT / f"logo-{key}.svg").write_text(to_svg(shapes, "#faf9f5"), encoding="utf-8")

    cell = 240
    cols = 3
    rows = 2
    sheet = Image.new("RGB", (cell * cols, cell * rows * 2), DAWN)
    for i, key in enumerate(keys):
        cx = (i % cols) * cell
        cy = (i // cols) * cell
        img = render(VARIANTS[key][1], ACCENT).resize((cell - 70, cell - 70), Image.LANCZOS)
        sheet.paste(img, (cx + 35, cy + 35), img)
        light = render(VARIANTS[key][1], LIGHT).resize((cell - 70, cell - 70), Image.LANCZOS)
        sheet.paste(light, (cx + 35, cy + cell * rows + 35), light)
    dark = Image.new("RGB", (cell * cols, cell * rows), RAIL)
    for i, key in enumerate(keys):
        cx = (i % cols) * cell
        cy = (i // cols) * cell
        light = render(VARIANTS[key][1], LIGHT).resize((cell - 70, cell - 70), Image.LANCZOS)
        dark.paste(light, (cx + 35, cy + 35), light)
    sheet.paste(dark, (0, cell * rows))
    sheet.save(OUT / "sheet.png")

    print("done:", OUT)
    for k in keys:
        print(f"  {k}: {VARIANTS[k][0]}")
    for f in sorted(OUT.iterdir()):
        print(f"  {f.name:22s} {f.stat().st_size:>8} bytes")


if __name__ == "__main__":
    main()
