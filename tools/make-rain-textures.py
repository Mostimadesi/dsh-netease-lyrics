"""Generate rain-on-glass textures (v3): solid water bodies with lens shading.

What was wrong in v1/v2 (both rejected on the real machine):

  v1  a highlight dot + dark ring  -> "a shiny circle", reads as a starfield.
  v2  refracted bokeh inside the bead -> the bead's interior inherited the
      BACKGROUND's dark areas, so beads looked like empty rings.

The fix is ordering, not more layers: a droplet's BODY must be a solid, bright
volume first (water collects light), and only then does the rim darken and the
refraction bend what is behind. So:

  body   = flat bright interior (opaque), brightest slightly up-left
  lens   = a soft inverted highlight inside the lower-right (the refracted sky)
  rim    = a NARROW dark ring at the edge only (water/air interface)
  spec   = one small hard specular tick up-left
  edge   = a short soft falloff so the bead sits in the glass

Density is a CLI multiplier; the alpha ceiling is a separate knob so the user
can dial "how much rain" without touching the shape.

Usage: python tools/make-rain-textures.py lib [density] [alpha]
"""
import random
import sys

from PIL import Image, ImageChops, ImageDraw, ImageFilter

W, H = 640, 320
RW, RH = 512, 512


def bead_body(r, elong=1.0):
    """Opaque water body with a soft edge (an ellipse, not a hard disc)."""
    pad = int(r * 2.2) + 2
    size = pad * 2
    mask = Image.new("L", (size, size), 0)
    d = ImageDraw.Draw(mask)
    rx, ry = r, r * elong
    d.ellipse((pad - rx, pad - ry, pad + rx, pad + ry), fill=255)
    # A gentle edge blur keeps the outline from looking die-cut.
    return mask.filter(ImageFilter.GaussianBlur(radius=max(0.5, r * 0.07))), pad, size


def bead_shade(r, elong=1.0, pad=None, size=None):
    """Brightness inside one bead: bright body, inverted lens, narrow rim, spec."""
    pad = pad or int(r * 2.2) + 2
    size = size or pad * 2
    rx, ry = r, r * elong

    # Start from a bright body: water gathers light, so the interior is LIGHT.
    shade = Image.new("L", (size, size), 205)

    # Inverted refracted highlight: sits low-right (the sky it bent over).
    lens = Image.new("L", (size, size), 0)
    ld = ImageDraw.Draw(lens)
    lx, ly = pad + rx * 0.16, pad + ry * 0.20
    lrx, lry = rx * 0.62, ry * 0.58
    ld.ellipse((lx - lrx, ly - lry, lx + lrx, ly + lry), fill=255)
    lens = lens.filter(ImageFilter.GaussianBlur(radius=max(0.8, r * 0.20)))
    shade = ImageChops.lighter(shade, lens.point(lambda v: int(v * 0.92)))

    # Bright refracted core (the reference photos show a near-white body
    # inside each drop). Offset slightly up-left, feathering into the water.
    core = Image.new("L", (size, size), 0)
    cd = ImageDraw.Draw(core)
    cx0, cy0 = pad - rx * 0.10, pad - ry * 0.12
    crx, cry = rx * 0.52, ry * 0.50
    cd.ellipse((cx0 - crx, cy0 - cry, cx0 + crx, cy0 + cry), fill=255)
    core = core.filter(ImageFilter.GaussianBlur(radius=max(1.0, r * 0.24)))
    shade = ImageChops.lighter(shade, core.point(lambda v: int(v * 0.55)))

    # Narrow dark interface ring: only the very edge darkens.
    rim = Image.new("L", (size, size), 0)
    rd = ImageDraw.Draw(rim)
    rd.ellipse((pad - rx, pad - ry, pad + rx, pad + ry), outline=255,
               width=max(1, int(r * 0.095)))
    rim = rim.filter(ImageFilter.GaussianBlur(radius=max(0.4, r * 0.055)))
    shade = ImageChops.subtract(shade, rim.point(lambda v: int(v * 0.70)))

    # Hard specular: the one thing that makes it read as glass.
    spec = Image.new("L", (size, size), 0)
    sd = ImageDraw.Draw(spec)
    hx, hy = pad - rx * 0.44, pad - ry * 0.48
    hr = max(0.8, r * 0.17)
    sd.ellipse((hx - hr, hy - hr, hx + hr, hy + hr), fill=255)
    spec = spec.filter(ImageFilter.GaussianBlur(radius=max(0.3, r * 0.04)))
    shade = ImageChops.lighter(shade, spec)

    return shade


def paste_wrapped(layer, sprite, ox, oy, tw, th):
    acc = Image.new("L", layer.size, 0)
    for dx in (-tw, 0, tw):
        for dy in (-th, 0, th):
            acc.paste(sprite, (ox + dx, oy + dy), sprite)
    return ImageChops.lighter(layer, acc)


def build(path, width, height, tiers, seed, alpha_scale, runs=False):
    rng = random.Random(seed)
    alpha = Image.new("L", (width, height), 0)
    shade = Image.new("L", (width, height), 128)

    for count, rmin, rmax, e0, e1, o0, o1 in tiers:
        for _ in range(count):
            cx, cy = rng.uniform(0, width), rng.uniform(0, height)
            r = rng.uniform(rmin, rmax)
            elong = rng.uniform(e0, e1)
            mask, pad, size = bead_body(r, elong)
            shadeSprite = bead_shade(r, elong, pad, size)
            ox, oy = int(cx - pad), int(cy - pad)

            op = int(rng.randint(o0, o1) * alpha_scale / 255)
            mask = mask.point(lambda v, op=op: int(v * op))
            alpha = paste_wrapped(alpha, mask, ox, oy, width, height)

            local = paste_wrapped(Image.new("L", (width, height), 0), mask, ox, oy, width, height)
            patched = paste_wrapped(Image.new("L", (width, height), 128), shadeSprite, ox, oy, width, height)
            shade.paste(patched, (0, 0), local)

    if runs:
        # Wet tails: thin tapered strokes that end in their own head bead.
        for _ in range(int(9 * (alpha_scale / 200.0))):
            x = rng.uniform(0, width)
            y = rng.uniform(0, height)
            length = rng.uniform(40, min(150, height * 0.45))
            r = rng.uniform(1.8, 3.4)
            tail = Image.new("L", (width, height), 0)
            td = ImageDraw.Draw(tail)
            steps = max(10, int(length))
            for i in range(steps):
                t = i / max(1, steps - 1)
                w = max(1.2, r * (1.0 - t) * 1.5)
                av = int(78 * (1.0 - t) ** 2.0 * alpha_scale / 255)
                yy = y - i
                for dx in (-width, 0, width):
                    td.line((x - w + dx, yy, x + w + dx, yy), fill=av)
            tail = tail.filter(ImageFilter.GaussianBlur(radius=1.6))
            alpha = ImageChops.lighter(alpha, tail)

    # Colour: pale cool water. `shade` is brightness, 128 = neutral.
    out = Image.new("RGBA", (width, height))
    a, s, px = alpha.load(), shade.load(), out.load()
    for y in range(height):
        for x in range(width):
            av = a[x, y]
            if av == 0:
                px[x, y] = (0, 0, 0, 0)
                continue
            k = s[x, y] / 128.0
            px[x, y] = (int(min(255, 176 * k ** 0.72)), int(min(255, 214 * k ** 0.72)), int(min(255, 252 * k ** 0.72)), av)
    out.save(path)


if __name__ == "__main__":
    base = sys.argv[1]
    density = float(sys.argv[2]) if len(sys.argv) > 2 else 1.0
    alpha_scale = float(sys.argv[3]) if len(sys.argv) > 3 else 1.0

    bead_tiers = [
        (int(150 * density), 1.7, 3.2, 0.95, 1.45, 150, 205),   # fine mist
        (int(46 * density), 3.2, 6.0, 1.00, 1.50, 190, 240),    # medium
        (int(12 * density), 6.0, 12.0, 1.05, 1.60, 225, 255),   # fat, about to run
    ]
    build(base + "/decor-rain-beads.png", W, H, bead_tiers, 20261110, alpha_scale * 255)

    run_tiers = [
        (int(6 * density), 2.6, 5.0, 1.20, 1.60, 210, 255),
    ]
    build(base + "/decor-rain-runs.png", RW, RH, run_tiers, 778899, alpha_scale * 255, runs=True)
    print("written, density=", density, "alpha=", alpha_scale)
