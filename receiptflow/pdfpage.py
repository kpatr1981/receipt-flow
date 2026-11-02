"""Lay one month's receipt crops out on a single numbered A4 page."""
from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

DPI = 200
A4 = (round(210 / 25.4 * DPI), round(297 / 25.4 * DPI))  # portrait px
MARGIN = 50
GAP = 30


def _font(size: int) -> ImageFont.ImageFont:
    for p in ("/System/Library/Fonts/Supplemental/Arial Bold.ttf", "/Library/Fonts/Arial Bold.ttf",
              "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"):
        try:
            return ImageFont.truetype(p, size)
        except OSError:
            continue
    return ImageFont.load_default(size=size)


def _layout(sizes: list[tuple[int, int]], page: tuple[int, int]):
    """Best grid: same scale for every crop (keeps real proportions), biggest scale wins."""
    pw, ph = page[0] - 2 * MARGIN, page[1] - 2 * MARGIN
    best = None
    n = len(sizes)
    for cols in range(1, n + 1):
        rows = [sizes[i : i + cols] for i in range(0, n, cols)]
        need_w = max(sum(w for w, _ in r) for r in rows)
        need_h = sum(max(h for _, h in r) for r in rows)
        gaps_w = GAP * (cols - 1)
        gaps_h = GAP * (len(rows) - 1)
        scale = min((pw - gaps_w) / need_w, (ph - gaps_h) / need_h)
        if best is None or scale > best[0]:
            best = (scale, cols, rows)
    return best


def compose_month_page(crops: list[Image.Image], numbers: list[int], title: str) -> Image.Image:
    sizes = [c.size for c in crops]
    title_h = 70
    candidates = []
    for page in (A4, (A4[1], A4[0])):
        lay = _layout(sizes, (page[0], page[1] - title_h))
        candidates.append((lay[0], page, lay))
    scale, page, (scale, cols, rows) = max(candidates, key=lambda c: c[0])
    scale = min(scale, 1.0)  # never blow photos up past their pixels

    canvas = Image.new("RGB", page, "white")
    draw = ImageDraw.Draw(canvas)
    draw.text((MARGIN, MARGIN // 2), title, fill="black", font=_font(40))
    num_font = _font(48)

    y = MARGIN + title_h
    i = 0
    for row in rows:
        row_w = sum(w for w, _ in row) * scale + GAP * (len(row) - 1)
        x = (page[0] - row_w) / 2
        row_h = max(h for _, h in row) * scale
        for w, h in row:
            img = crops[i].resize((max(1, round(w * scale)), max(1, round(h * scale))), Image.LANCZOS)
            canvas.paste(img, (round(x), round(y)))
            draw.rectangle([round(x), round(y), round(x) + img.width, round(y) + img.height], outline="#999", width=2)
            label = str(numbers[i])
            r = 38
            cx, cy = round(x) + r + 6, round(y) + r + 6
            draw.ellipse([cx - r, cy - r, cx + r, cy + r], fill="#d00000")
            draw.text((cx, cy), label, fill="white", font=num_font, anchor="mm")
            x += w * scale + GAP
            i += 1
        y += row_h + GAP
    return canvas


def save_pdf(page: Image.Image, path: Path) -> None:
    page.save(path, "PDF", resolution=DPI, quality=85)
