"""Generate seamless rain-on-glass textures for the dsh-netease-lyrics decor.

Design notes (learned from the first attempt, which read as a starfield):

* A droplet only reads as water when it has THREE layers: a dark refracted ring
  (the glass bending light away), a lighter interior, and a small hard
  specular highlight offset up-left. A bright dot on transparency has none of
  that and looks like a star.
* Size hierarchy matters more than count: dense fine mist + medium beads +
  a few fat ones. Uniform dots look mechanical.
* The output is ALPHA (an erase mask), not luminance: CSS tints it, so the
  droplet must be opaque where water is and transparent elsewhere. Painting
  white-on-black and using it as a mask keeps the dark rim out of the alpha.

Outputs: lib/decor-rain-beads.png (clinging drops), lib/decor-rain-runs.png
(vertical runnels). Both tile horizontally; the runs layer also tiles vertically
so it can scroll continuously.
"""
import random

from PIL import Image, ImageChops, ImageDraw, ImageFilter

BEADS_W, BEADS_H = 560, 280
RUNS_W, RUNS_H = 512, 512


def drop_mask(size, rng, elongation=1.0):
    """Alpha mask for one droplet: solid core, soft edge, NOT a hard circle."""
    s = max(8, int(size * 3.0))
    m = Image.new("L", (s, s), 0)
    d = ImageDraw.Draw(m)
    c = s / 2
    rx = size / 2
    ry = (size / 2) * elongation
    d.ellipse((c - rx, c - ry, c + rx, c + ry), fill=255)
    return m.filter(ImageFilter.GaussianBlur(radius=max(0.5, size * 0.14)))


def drop_grain(size, rng, elongation=1.0):
    """Shading inside the droplet, returned as a multiplier 0..255.

    Dark ring at the rim, bright caustic up-left, hard spec dot. This is applied
    to the droplet's colour AFTER masking, so it survives CSS tinting.
    """
    s = max(8, int(size * 3.0))
    c = s / 2
    rx = size / 2
    ry = (size / 2) * elongation
    grain = Image.new("L", (s, s), 128)

    # Dark refracted ring: an ellipse outline, blurred into the interior.
    ring = Image.new("L", (s, s), 0)
    rd = ImageDraw.Draw(ring)
    rd.ellipse((c - rx, c - ry, c + rx, c + ry), outline=255,
               width=max(1, int(size * 0.16)))
    ring = ring.filter(ImageFilter.GaussianBlur(radius=max(0.6, size * 0.09)))
    grain = ImageChops.subtract(grain, ring.point(lambda v: int(v * 0.75)))

    # Bright caustic: offset toward the upper-left where the sky reflects.
    caustic = Image.new("L", (s, s), 0)
    cd = ImageDraw.Draw(caustic)
    ox, oy = -rx * 0.26, -ry * 0.30
    crx, cry = rx * 0.46, ry * 0.44
    cd.ellipse((c + ox - crx, c + oy - cry, c + ox + crx, c + oy + cry), fill=255)
    caustic = caustic.filter(ImageFilter.GaussianBlur(radius=max(0.8, size * 0.13)))
    grain = ImageChops.add(grain, caustic.point(lambda v: int(v * 0.55)))

    # Hard specular tick, very small and bright.
    spec = Image.new("L", (s, s), 0)
    sd = ImageDraw.Draw(spec)
    hx, hy = c - rx * 0.40, c - ry * 0.42
    hr = max(0.8, size * 0.11)
    sd.ellipse((hx - hr, hy - hr, hx + hr, hy + hr), fill=255)
    grain = ImageChops.lighter(grain, spec)
    return grain


def paste_wrapped(canvas, sprite, x, y, tile_w=None, tile_h=None):
    """Paste with wrapping on the given tile, so the texture tiles seamlessly."""
    w, h = tile_w or canvas.size[0], tile_h or canvas.size[1]
    sw, sh = sprite.size
    x0 = int(round(x - sw / 2))
    y0 = int(round(y - sh / 2))
    acc = Image.new("L", canvas.size, 0)
    for dx in (-w, 0, w):
        for dy in (-h, 0, h):
            acc.paste(sprite, (x0 + dx, y0 + dy), sprite)
    canvas.paste(ImageChops.lighter(canvas, acc))


def make_beads(path):
    """Drops clinging to the pane.

    Colour is baked as premultiplied grey so CSS can tint+multiply it: the beads
    PNG is shipped as a shaded RGBA image (pale blue-white water with a darker
    rim), not as a flat mask.
    """
    rng = random.Random(20261110)
    alpha = Image.new("L", (BEADS_W, BEADS_H), 0)
    shaded = Image.new("L", (BEADS_W, BEADS_H), 128)

    def add(x, y, size, deform=1.0, opacity=255):
        mask = drop_mask(size, rng, deform)
        grain = drop_grain(size, rng, deform)
        if opacity < 255:
            mask = mask.point(lambda v: int(v * opacity / 255))
        paste_wrapped(alpha, mask, x, y)
        # Where this drop lands, its own shading wins over the background.
        patch = Image.new("L", (BEADS_W, BEADS_H), 128)
        paste_wrapped(patch, grain, x, y)
        # Only paint shading where THIS drop is (avoid shading other drops).
        local = Image.new("L", (BEADS_W, BEADS_H), 0)
        paste_wrapped(local, mask, x, y)
        shaded.paste(patch, (0, 0), local)
        return mask

    # Fine mist: dense, near-invisible individually, gives the glass texture.
    for _ in range(360):
        add(rng.uniform(0, BEADS_W), rng.uniform(0, BEADS_H), rng.uniform(1.6, 3.4),
            rng.uniform(0.9, 1.5), rng.randint(110, 175))
    # Medium bead layer.
    for _ in range(120):
        add(rng.uniform(0, BEADS_W), rng.uniform(0, BEADS_H), rng.uniform(3.4, 6.2),
            rng.uniform(1.0, 1.5), rng.randint(170, 230))
    # Fat, slightly elongated drops (about to run).
    for _ in range(26):
        add(rng.uniform(0, BEADS_W), rng.uniform(0, BEADS_H), rng.uniform(6.2, 11.0),
            rng.uniform(1.1, 1.7), rng.randint(200, 250))

    # Composite: pale cool water, darker at the refracted rim (the grain value).
    out = Image.new("RGBA", (BEADS_W, BEADS_H))
    g = shaded.load()
    a = alpha.load()
    px = out.load()
    for y in range(BEADS_H):
        for x in range(BEADS_W):
            av = a[x, y]
            if av == 0:
                px[x, y] = (0, 0, 0, 0)
                continue
            lum = g[x, y] / 255.0            # 0.5 = neutral water
            r = int(196 * (0.55 + lum * 0.62))
            gg = int(214 * (0.55 + lum * 0.62))
            b = int(238 * (0.55 + lum * 0.62))
            px[x, y] = (min(255, r), min(255, gg), min(255, b), av)
    out.save(path)


def make_runs(path):
    """Vertical runnels: head drop + a tapering wet tail above it."""
    rng = random.Random(778899)
    alpha = Image.new("L", (RUNS_W, RUNS_H), 0)
    shaded = Image.new("L", (RUNS_W, RUNS_H), 128)

    for _ in range(30):
        x = rng.uniform(0, RUNS_W)
        y = rng.uniform(0, RUNS_H)
        length = rng.uniform(70, 260)
        r = rng.uniform(1.6, 3.6)
        mask = drop_mask(r * 2.8, rng, 1.3)
        grain = drop_grain(r * 2.8, rng, 1.3)
        paste_wrapped(alpha, mask, x, y)
        paste_wrapped(shaded, grain, x, y)

        # Tail: thin, dim, tapering upward from the head.
        tail = Image.new("L", (RUNS_W, RUNS_H), 0)
        td = ImageDraw.Draw(tail)
        steps = int(length)
        for i in range(steps):
            t = i / max(1, steps - 1)
            w = max(0.7, r * (1.0 - t) * 0.9)
            av = int(150 * (1.0 - t) ** 1.4)
            td.line((x - w, y - i, x + w, y - i), fill=av)
        tail = tail.filter(ImageFilter.GaussianBlur(radius=0.6))
        paste_wrapped(alpha, tail, x, y - length / 2, tile_h=None)

    out = Image.new("RGBA", (RUNS_W, RUNS_H))
    g = shaded.load()
    a = alpha.load()
    px = out.load()
    for y in range(RUNS_H):
        for x in range(RUNS_W):
            av = a[x, y]
            if av == 0:
                px[x, y] = (0, 0, 0, 0)
                continue
            lum = g[x, y] / 255.0
            r = int(198 * (0.55 + lum * 0.60))
            gg = int(216 * (0.55 + lum * 0.60))
            b = int(240 * (0.55 + lum * 0.60))
            px[x, y] = (min(255, r), min(255, gg), min(255, b), av)
    out.save(path)


if __name__ == "__main__":
    import sys
    base = sys.argv[1]
    make_beads(base + "/decor-rain-beads.png")
    make_runs(base + "/decor-rain-runs.png")
    print("written")

