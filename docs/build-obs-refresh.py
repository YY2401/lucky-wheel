"""OBS 更新快取的圖文（實際 OBS 截圖加紅框標註）。
python docs/build-obs-refresh.py <右鍵選單放大截圖（螢幕 276,470–460,690）> <屬性視窗放大截圖（螢幕 298,520–840,640）> <停駐視窗右鍵放大截圖（螢幕 367,117–511,477）>  → docs/OBS更新快取.png"""
import os
import sys
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
menu_src, prop_src, dock_src = sys.argv[1], sys.argv[2], sys.argv[3]
F = 'C:/Windows/Fonts/msjhbd.ttc'
font = lambda n: ImageFont.truetype(F, n)
INK, RED, YEL, BG, PAPER = (20, 20, 20), (230, 59, 59), (255, 207, 51), (244, 239, 228), (255, 253, 247)
W = 1200


def crop(src, box, marks):
    """src 是螢幕上 box 這塊區域的放大截圖；在 marks（螢幕座標）畫紅框"""
    im = Image.open(src).convert('RGB')
    f = im.width / (box[2] - box[0])
    d = ImageDraw.Draw(im)
    for (x0, y0, x1, y1), label, side in marks:
        r = [(x0 - box[0]) * f - 8, (y0 - box[1]) * f - 6, (x1 - box[0]) * f + 8, (y1 - box[1]) * f + 6]
        d.rounded_rectangle(r, 8, outline=RED, width=5)
        if label:  # 截圖的字太小，旁邊標上清楚的字
            lf = font(26); w = lf.getlength(label) + 24
            lx = r[2] + 12 if side == 'r' else r[0] - 12 - w
            ly = (r[1] + r[3]) / 2 - 22
            d.rounded_rectangle([lx, ly, lx + w, ly + 44], 8, fill=YEL, outline=INK, width=3)
            d.text((lx + 12, ly + 5), label, font=lf, fill=INK)
    return im


def cut(im, box, part):
    """從放大截圖裡只取 part（螢幕座標）這一塊"""
    f = im.width / (box[2] - box[0])
    return im.crop(((part[0] - box[0]) * f, (part[1] - box[1]) * f, (part[2] - box[0]) * f, (part[3] - box[1]) * f))


DOCK_BOX = (367, 117, 511, 477)
steps = [
    ('A', '控制面板（放在 OBS 停駐視窗裡的「忠誠點轉盤」面板）：在面板裡的空白處按滑鼠右鍵，選「重新整理」。這樣就更新好了。',
     cut(crop(dock_src, DOCK_BOX, [((437, 365, 477, 379), '', '')]), DOCK_BOX, (420, 326, 511, 470))),
    ('1', '觀眾看的轉盤（OBS「來源」裡的瀏覽器來源）：在下方「來源」找到它（你當初取的名字，例如「忠誠點轉盤」），按滑鼠右鍵，選最下面的「屬性」。',
     crop(menu_src, (276, 470, 460, 690), [((278, 657, 420, 671), '', ''), ((322, 646, 346, 662), '屬性', 'r')])),
    ('2', '跳出的視窗往下捲到最底，按「更新當前頁面快取」，再按右下角「確定」。',
     crop(prop_src, (298, 520, 840, 640), [((343, 586, 422, 602), '更新當前頁面快取', 'r'), ((762, 615, 796, 632), '確定', 'l')])),
]

# 版面
pad = 40
title_h = 150
blocks = []
for no, text, im in steps:
    if im.width < 300:  # 太小的截圖放大一點（放太大會糊）
        im = im.resize((int(im.width * 1.4), int(im.height * 1.4)), Image.LANCZOS)
    if im.width > W - pad * 2:
        r = (W - pad * 2) / im.width
        im = im.resize((int(im.width * r), int(im.height * r)), Image.LANCZOS)
    blocks.append((no, text, im))

tf = font(30)


def wrap(text, width):
    lines, cur = [], ''
    for ch in text:
        if tf.getlength(cur + ch) > width:
            lines.append(cur); cur = ch
        else:
            cur += ch
    return lines + [cur]


H = title_h
layout = []
for no, text, im in blocks:
    lines = wrap(text, W - pad * 2 - 70)
    th = len(lines) * 44 + 20
    layout.append((no, lines, im, H))
    H += th + im.height + 50
H += 150

page = Image.new('RGB', (W, H), BG)
d = ImageDraw.Draw(page)
d.rounded_rectangle([pad, 36, pad + 470, 100], 12, fill=YEL, outline=INK, width=4)
d.text((pad + 20, 42), 'OBS 畫面更新一次', font=font(38), fill=INK)
d.text((pad + 500, 54), '轉盤網頁更新後，OBS 裡兩個地方各做一次', font=font(26), fill=(92, 88, 80))
for no, lines, im, y in layout:
    d.ellipse([pad, y, pad + 50, y + 50], fill=YEL, outline=INK, width=3)
    d.text((pad + 16, y + 4), no, font=font(32), fill=INK)
    for i, ln in enumerate(lines):
        d.text((pad + 70, y + 4 + i * 44), ln, font=tf, fill=INK)
    iy = y + len(lines) * 44 + 20
    x = (W - im.width) // 2
    d.rounded_rectangle([x - 4, iy - 4, x + im.width + 4, iy + im.height + 4], 6, outline=INK, width=4)
    page.paste(im, (x, iy))
y = H - 130
d.rounded_rectangle([pad, y, W - pad, y + 90], 14, fill=INK)
d.rounded_rectangle([pad + 20, y + 24, pad + 110, y + 66], 8, fill=YEL)
d.text((pad + 34, y + 26), '完成', font=font(28), fill=INK)
d.text((pad + 130, y + 26), '兩個都做完就好了。沒放控制面板進 OBS 的，只做 1、2。', font=font(28), fill=PAPER)
out = os.path.join(HERE, 'OBS更新快取.png')
page.save(out)
print(out, page.size)
