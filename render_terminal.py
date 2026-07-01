import os
from PIL import Image, ImageDraw, ImageFont

FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf"
FONT_BOLD = "/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf"
SIZE = 22
font = ImageFont.truetype(FONT, SIZE)
fontb = ImageFont.truetype(FONT_BOLD, SIZE)

PANE = (21, 23, 28)        # #15171c
BAR = (33, 36, 43)         # #21242b
DEFAULT = (214, 218, 224)  # #d6dae0
BLUE = (108, 182, 255)     # prompt
GRAY = (138, 147, 160)     # INFO
STRING = (197, 225, 165)   # "..."
WARN = (240, 179, 94)      # WARN
GOOD = (126, 226, 168)     # success / balances
KEY = (156, 209, 240)      # json keys
TITLE = (154, 160, 170)

LH = 34          # line height
PADX, PADY = 22, 16
BAR_H = 40

def seg(t, c=DEFAULT, b=False):
    return (t, c, b)

def split_quotes(text, base, qcolor, qchar='"'):
    """Color quoted substrings with qcolor, rest with base."""
    out, parts, inq = [], text.split(qchar), False
    for i, p in enumerate(parts):
        if i > 0:
            inq = not inq
        if p == "":
            continue
        if inq:
            out.append(seg(qchar + p + (qchar if i < len(parts) - 1 else ""), qcolor))
        else:
            out.append(seg(p, base))
    return out

def line_to_segs(line):
    if line == "":
        return []
    if line.startswith("$ "):
        return [seg("$ ", BLUE)] + [seg(line[2:], DEFAULT)]
    if line.startswith("INFO"):
        rest = line[4:]
        return [seg("INFO", GRAY)] + split_quotes(rest, DEFAULT, STRING)
    if line.startswith("WARN"):
        return [seg("WARN", WARN)] + [seg(line[4:], DEFAULT)]
    if line.startswith("\u2713") or "PASSED" in line:
        return [seg(line, GOOD, True)]
    if line.startswith("after "):
        return split_quotes(line, DEFAULT, GOOD, qchar="'")
    # json-ish lines: color double-quoted green-key/value, numbers default
    if any(c in line for c in '{}[]') or '":' in line or line.strip().startswith('"'):
        return split_quotes(line, DEFAULT, STRING)
    return [seg(line, DEFAULT)]

def render(title, lines, path):
    segs = [line_to_segs(l) for l in lines]
    # measure width
    dummy = Image.new("RGBA", (10, 10))
    dd = ImageDraw.Draw(dummy)
    maxw = dd.textlength(title, font=font) + 120
    for ls in segs:
        w = sum(dd.textlength(t, font=(fontb if b else font)) for (t, c, b) in ls)
        maxw = max(maxw, w)
    W = int(maxw) + PADX * 2
    H = BAR_H + PADY * 2 + LH * len(lines)
    img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([0, 0, W - 1, H - 1], radius=12, fill=PANE)
    d.rounded_rectangle([0, 0, W - 1, BAR_H], radius=12, fill=BAR, corners=(True, True, False, False))
    for i, (cx, col) in enumerate([(20, (237, 106, 94)), (40, (244, 190, 79)), (60, (97, 197, 84))]):
        d.ellipse([cx - 6, BAR_H // 2 - 6, cx + 6, BAR_H // 2 + 6], fill=col)
    d.text((80, BAR_H // 2), title, font=font, fill=TITLE, anchor="lm")
    y = BAR_H + PADY
    for ls in segs:
        x = PADX
        for (t, c, b) in ls:
            d.text((x, y), t, font=(fontb if b else font), fill=c)
            x += dd.textlength(t, font=(fontb if b else font))
        y += LH
    img.save(path)
    print("wrote", path, img.size)

reorg = [
    "$ node --version",
    "v22.22.2",
    "$ node test/reorg.test.mjs",
    "",
    'INFO [engine] setup complete {source:"evm", target:"sqlite", streams:["Transfer"]}',
    'INFO [engine] indexed batch {stream:"Transfer", count:4, cursor:"109"}',
    "INFO [engine] backfill caught up",
    "after v1 backfill: { 0xaaaa\u2026aaaa: '-130', 0xbbbb\u2026bbbb: '70', 0xcccc\u2026cccc: '60' }",
    "",
    "WARN [source] tip hash mismatch \u2014 searching common ancestor {block:109}",
    "WARN [engine] reorg detected \u2014 rolled back {toBlock:103, entitiesUndone:6}",
    'INFO [engine] indexed batch {stream:"Transfer", count:2, cursor:"110"}',
    "INFO [engine] backfill caught up",
    "after reorg + reindex: { 0xbbbb\u2026bbbb: '40', 0xcccc\u2026cccc: '40', 0xaaaa\u2026aaaa: '-105', 0xdddd\u2026dddd: '25' }",
    "",
    "\u2713 REORG TEST PASSED \u2014 orphaned writes undone, new chain indexed, balances corrected.",
]

api = [
    "$ indexa deploy --config examples/orders/indexa.config.yaml --port 4099",
    'INFO [cli:engine] setup complete {source:"csv", streams:["orders"]}',
    'INFO [cli] query API listening {url:"http://localhost:4099"}',
    'INFO [cli:engine] indexed batch {stream:"orders", count:6, cursor:"6"}',
    "",
    '$ curl "localhost:4099/orders?status=paid&orderBy=items&desc=true"',
    "{",
    '  "data": [',
    '    { "id":"4", "customer":"Carol", "total":"300.00", "status":"paid", "items":5 },',
    '    { "id":"1", "customer":"Alice", "total":"120.50", "status":"paid", "items":3 },',
    '    { "id":"3", "customer":"Alice", "total":"42.25",  "status":"paid", "items":2 },',
    '    { "id":"6", "customer":"Dave",  "total":"55.00",  "status":"paid", "items":2 }',
    "  ],",
    '  "count": 4',
    "}",
]

os.makedirs("docs/images", exist_ok=True)
render("reorg test \u2014 examples/evm-erc20", reorg, "docs/images/reorg-test.png")
render("live REST API \u2014 examples/orders (CSV \u2192 SQLite)", api, "docs/images/rest-api.png")
