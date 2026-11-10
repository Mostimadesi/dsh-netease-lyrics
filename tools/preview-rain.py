"""Preview the rain textures on the capsule's real background.

This exists because of a wrong conclusion that cost several iterations: the
textures were judged on a WHITE viewer background, where pale water is
invisible and only the dark rim shows - the beads looked like empty rings. The
capsule is dark, and `mix-blend-mode: screen` adds light, so the honest test is
dark background + screen blend. This script composites exactly that.

Usage: python tools/preview-rain.py lib/preview-rain.png
"""
import sys

from PIL import Image, ImageChops


def screen(a, b):
    """Photoshop/CSS `screen` blend on 0..1 channels, per pixel."""
    return ImageChops.screen(a, b)


def main(out_path):
    beads = Image.open("lib/decor-rain-beads.png").convert("RGBA")
    runs = Image.open("lib/decor-rain-runs.png").convert("RGBA")

    # The arknights-ish dark panel the rain actually sits on.
    base = Image.new("RGB", (beads.width, beads.height), (16, 21, 28))
    # A soft vertical gradient so the panel does not read as flat black.
    px = base.load()
    for y in range(base.height):
        t = y / max(1, base.height - 1)
        for x in range(base.width):
            r, g, b = px[x, y]
            px[x, y] = (r + int(6 * t), g + int(8 * t), b + int(11 * t))

    def over(img, opacity):
        """Composite one texture with `screen` at the CSS opacity."""
        tinted = img.convert("RGB")
        # screen only where the texture has alpha: premultiply by opacity
        alpha = img.getchannel("A").point(lambda v: int(v * opacity))
        layer = Image.new("RGB", img.size, (0, 0, 0))
        layer.paste(tinted, (0, 0), alpha)
        return layer

    out = base.copy()
    out = ImageChops.screen(out, over(beads, 0.55))
    # The runnel layer is only shown in its top-left region for the preview.
    runs_crop = runs.crop((0, 0, min(runs.width, beads.width), min(runs.height, beads.height)))
    out = ImageChops.screen(out, over(runs_crop, 0.34))

    out.save(out_path)
    print("preview written:", out_path)


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "lib/preview-rain.png")
