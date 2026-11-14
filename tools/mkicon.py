# 全平台图标生成脚本（Furry Everpony）
# 用法：python tools/mkicon.py
# 源图：build/icon.png（唯一的原画，浅色 pony 画）
# 产物：build/icon.ico（16~256 七档）、web/public/icons/*.png、android/res/drawable-*dpi/ic_launcher.png
# 规矩：所有图标必须是浅色底（白→#E8F7FC 渐变）+ 圆角，禁止深色底，用户明确骂过"变得这么黑"。

from PIL import Image, ImageDraw
import os
P = r"C:\Users\36328\Documents\deepseek-harness\default-workspace\projects\furry-everpony"
art = Image.open(os.path.join(P, "build", "icon.png")).convert("RGBA")

def light_bg(size, radius_ratio=0.22):
    bg = Image.new("RGBA", (size, size), (0,0,0,0))
    d = ImageDraw.Draw(bg)
    for y in range(size):
        t = y / max(1, size-1)
        d.line([(0,y),(size,y)], fill=(int(255+(232-255)*t), int(255+(247-255)*t), int(255+(252-255)*t), 255))
    if radius_ratio > 0:
        mask = Image.new("L", (size,size), 0)
        ImageDraw.Draw(mask).rounded_rectangle([0,0,size-1,size-1], radius=int(size*radius_ratio), fill=255)
        bg.putalpha(mask)
    return bg

def make(size, inner=0.94, radius=0.22):
    bg = light_bg(size, radius)
    a = art.copy()
    a.thumbnail((int(size*inner), int(size*inner)), Image.LANCZOS)
    layer = Image.new("RGBA", (size,size), (0,0,0,0))
    layer.paste(a, ((size-a.width)//2, (size-a.height)//2), a)
    bg.alpha_composite(layer)
    return bg

# 1) ico（多尺寸，桌面窗口/托盘/任务栏/快捷方式都用它）
sizes = [16,24,32,48,64,128,256]
frames = [make(s, inner=0.98 if s < 48 else 0.94) for s in sizes]
frames[-1].save(os.path.join(P, "build", "icon.ico"), format="ICO", sizes=[(s,s) for s in sizes])
print("ico ok")

# 2) PWA / 网页图标
out = os.path.join(P, "web", "public", "icons")
os.makedirs(out, exist_ok=True)
make(192).save(os.path.join(out, "icon-192.png"))
make(512).save(os.path.join(out, "icon-512.png"))
make(180).save(os.path.join(out, "apple-touch-icon-180.png"))
# maskable：满幅不透明底，图形缩到安全区
make(192, inner=0.72, radius=0).save(os.path.join(out, "icon-192-maskable.png"))
make(512, inner=0.72, radius=0).save(os.path.join(out, "icon-512-maskable.png"))
print("pwa ok")

# 3) 安卓启动图标（按密度出 PNG，替换原来的深色矢量图）
for dpi, s in [("mdpi",48),("hdpi",72),("xhdpi",96),("xxhdpi",144),("xxxhdpi",192)]:
    d = os.path.join(P, "android", "res", "drawable-" + dpi)
    os.makedirs(d, exist_ok=True)
    make(s, inner=0.92, radius=0).save(os.path.join(d, "ic_launcher.png"))
print("android ok")
