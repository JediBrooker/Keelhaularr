#!/usr/bin/env python3

"""Regenerate Keelhaularr's favicon assets with Pillow."""

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


ROOT = Path(__file__).resolve().parent.parent
PUBLIC = ROOT / "public"
SIZE = 512


def find_font(size: int) -> ImageFont.FreeTypeFont:
    candidates = (
        "/System/Library/Fonts/Supplemental/Georgia Bold.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSerif-Bold.ttf",
    )
    for candidate in candidates:
        if Path(candidate).exists():
            return ImageFont.truetype(candidate, size)
    return ImageFont.load_default(size=size)


def emblem() -> Image.Image:
    image = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    draw.ellipse((22, 22, 490, 490), fill="#0d3538", outline="#d59b36", width=24)
    draw.ellipse((53, 53, 459, 459), outline="#f8f4ea", width=7)

    font = find_font(310)
    box = draw.textbbox((0, 0), "K", font=font, stroke_width=2)
    width = box[2] - box[0]
    height = box[3] - box[1]
    position = ((SIZE - width) / 2 - box[0], (SIZE - height) / 2 - box[1] - 8)
    draw.text(position, "K", font=font, fill="#f8f4ea", stroke_width=2, stroke_fill="#f8f4ea")
    return image


def main() -> None:
    PUBLIC.mkdir(parents=True, exist_ok=True)
    source = emblem()
    source.resize((32, 32), Image.Resampling.LANCZOS).save(PUBLIC / "favicon-32x32.png")
    source.resize((180, 180), Image.Resampling.LANCZOS).save(PUBLIC / "apple-touch-icon.png")
    source.save(PUBLIC / "favicon.ico", format="ICO", sizes=[(16, 16), (32, 32), (48, 48)])


if __name__ == "__main__":
    main()
