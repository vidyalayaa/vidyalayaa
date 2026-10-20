import os
from PIL import Image, ImageDraw, ImageFont

SRC = r"C:\Users\anubh\.gemini\antigravity-ide\brain\63b8dd24-49ee-423d-8294-e09e3952adbe\.user_uploaded\media_1792514498561.png"
OUT_DIR = r"d:\AI\vidyalayaa\apps\web\public"

os.makedirs(OUT_DIR, exist_ok=True)

src_img = Image.open(SRC).convert("RGBA")
BG_COLOR = (199, 245, 91, 255) # #c7f55b
DARK_COLOR = (89, 103, 79, 255) # #59674f
ring_color = (182, 230, 75, 255)

# 1. Extract the V. logo with transparent background
w, h = src_img.size
logo_mask = Image.new("RGBA", (w, h), (0, 0, 0, 0))
for y in range(h):
    for x in range(w):
        r, g, b, a = src_img.getpixel((x, y))
        if r < 125 and g < 135 and b < 105:
            logo_mask.putpixel((x, y), (r, g, b, 255))

bbox = (138, 115, 325, 280)
v_cropped = logo_mask.crop(bbox)
aspect = v_cropped.width / v_cropped.height

# 2. Create square icon (512x512)
icon_512 = Image.new("RGBA", (512, 512), BG_COLOR)
draw_icon = ImageDraw.Draw(icon_512)

center_pt = (256, 256)
for radius in [180, 260, 360]:
    draw_icon.ellipse(
        [center_pt[0] - radius, center_pt[1] - radius, center_pt[0] + radius, center_pt[1] + radius],
        outline=ring_color,
        width=3
    )

target_w = 290
target_h = int(target_w / aspect)
v_resized = v_cropped.resize((target_w, target_h), Image.Resampling.LANCZOS)

pos_x = (512 - target_w) // 2
pos_y = (512 - target_h) // 2
icon_512.paste(v_resized, (pos_x, pos_y), v_resized)

icon_512.save(os.path.join(OUT_DIR, "icon-512.png"))

icon_180 = icon_512.resize((180, 180), Image.Resampling.LANCZOS)
icon_180.save(os.path.join(OUT_DIR, "apple-touch-icon.png"))

icon_64 = icon_512.resize((64, 64), Image.Resampling.LANCZOS)
icon_64.save(os.path.join(OUT_DIR, "favicon.png"))

icon_32 = icon_512.resize((32, 32), Image.Resampling.LANCZOS)
icon_32.save(os.path.join(OUT_DIR, "favicon-32x32.png"))

icon_16 = icon_512.resize((16, 16), Image.Resampling.LANCZOS)
icon_16.save(os.path.join(OUT_DIR, "favicon-16x16.png"))

icon_512.save(os.path.join(OUT_DIR, "favicon.ico"), format="ICO", sizes=[(16, 16), (32, 32), (48, 48), (64, 64)])

# 3. Create Open Graph Image (1200x630) for WhatsApp, Facebook, Twitter, iMessage
og = Image.new("RGBA", (1200, 630), BG_COLOR)
draw_og = ImageDraw.Draw(og)

for radius in [200, 340, 500, 680, 880, 1100]:
    draw_og.ellipse(
        [280 - radius, 315 - radius, 280 + radius, 315 + radius],
        outline=ring_color,
        width=4
    )

font_title = None
font_subtitle = None
font_badge = None
font_url = None

font_candidates = [
    r"C:\Windows\Fonts\segoeuib.ttf",
    r"C:\Windows\Fonts\arialbd.ttf",
]
for f in font_candidates:
    if os.path.exists(f):
        try:
            font_title = ImageFont.truetype(f, 80)
            font_subtitle = ImageFont.truetype(r"C:\Windows\Fonts\arial.ttf" if os.path.exists(r"C:\Windows\Fonts\arial.ttf") else f, 34)
            font_badge = ImageFont.truetype(f, 22)
            font_url = ImageFont.truetype(f, 28)
            break
        except Exception:
            pass

if not font_title:
    font_title = ImageFont.load_default()
    font_subtitle = ImageFont.load_default()
    font_badge = ImageFont.load_default()
    font_url = ImageFont.load_default()

# Left badge card
badge_size = 360
badge_x, badge_y = 100, (630 - badge_size) // 2
draw_og.rounded_rectangle([badge_x, badge_y, badge_x + badge_size, badge_y + badge_size], radius=36, fill=(255, 255, 255, 200), outline=(255, 255, 255, 240), width=4)

v_og_size = 270
v_og_h = int(v_og_size / aspect)
v_og = v_cropped.resize((v_og_size, v_og_h), Image.Resampling.LANCZOS)
logo_x = badge_x + (badge_size - v_og_size) // 2
logo_y = badge_y + (badge_size - v_og_h) // 2
og.paste(v_og, (logo_x, logo_y), v_og)

# Right content
text_x = 510
# Title
draw_og.text((text_x, 150), "Vidyalayaa", fill=(40, 50, 35, 255), font=font_title)

# Tagline
draw_og.text((text_x, 255), "Your school, in sync.", fill=(65, 80, 55, 255), font=font_subtitle)

# Sub description
draw_og.text((text_x, 305), "Smart management, NFC attendance & real-time sync", fill=(85, 100, 75, 255), font=font_badge)

# Pill badges
badges = ["NFC Attendance", "Live Analytics", "Parent & Teacher Portal"]
curr_x = text_x
pill_y = 370
for b in badges:
    bbox = draw_og.textbbox((curr_x, pill_y), b, font=font_badge)
    pw = bbox[2] - bbox[0] + 28
    ph = 42
    draw_og.rounded_rectangle([curr_x, pill_y, curr_x + pw, pill_y + ph], radius=21, fill=(255, 255, 255, 210))
    draw_og.text((curr_x + 14, pill_y + 8), b, fill=(50, 65, 45, 255), font=font_badge)
    curr_x += pw + 12

# Domain pill at bottom
domain_box = [text_x, 445, text_x + 360, 495]
draw_og.rounded_rectangle(domain_box, radius=12, fill=(45, 58, 40, 255))
draw_og.text((text_x + 20, 455), "https://vidyalayaa-tech.web.app", fill=(210, 250, 115, 255), font=font_url)

og.convert("RGB").save(os.path.join(OUT_DIR, "og-image.png"), quality=95)
print("Updated asset generation complete!")
