"""Build redistributable font geometry and palette from the unmodified reference fonts."""
from __future__ import annotations

import json
import shutil
import sys
from dataclasses import asdict
from pathlib import Path

# Maintainer tool; npm builds use the checked-in geometry.
import argparse
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("upstream", type=Path, help="open-diagram source checkout at 387b2c09")
ROOT = parser.parse_args().upstream.resolve()
PACKAGE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
from fontTools.pens.basePen import BasePen
from open_diagram.fonts import FILES, FONT_DIR, face, fmt
from open_diagram.theme import Theme


class RelativePen(BasePen):
    """One absolute start per glyph lets the JS renderer position a whole run in one path."""

    def __init__(self, glyphs):
        super().__init__(glyphs)
        self.commands = []
        self.start = None
        self.current = self.contour = (0, 0)

    def differences(self, *points):
        x, y = self.current
        return " ".join(fmt(v) for px, py in points for v in (px - x, py - y))

    def _moveTo(self, point):
        if self.start is None:
            self.start = point
        else:
            self.commands.append("m" + self.differences(point))
        self.current = self.contour = point

    def _lineTo(self, point):
        self.commands.append("l" + self.differences(point))
        self.current = point

    def _qCurveToOne(self, control, point):
        self.commands.append("q" + self.differences(control, point))
        self.current = point

    def _curveToOne(self, a, b, point):
        self.commands.append("c" + self.differences(a, b, point))
        self.current = point

    def _closePath(self):
        self.commands.append("z")
        self.current = self.contour


def pack(weight, common):
    f = face(weight)
    cmap = {k: v for k, v in f.cmap.items() if not common or 32 <= k <= 126 or k in COMMON}
    names = list(dict.fromkeys([".notdef", *cmap.values()]))
    ids = {name: i for i, name in enumerate(names)}
    glyphs = []
    for name in names:
        pen = RelativePen(f.glyphs)
        f.glyphs[name].draw(pen)
        glyphs.append([f.hmtx[name][0], *(pen.start or (0, 0)), "".join(pen.commands)])
    lookups = []
    for sub, coverage in f._pairs:
        covered = [name for name in names if name in coverage]
        if not covered:
            continue
        if sub.Format == 1:
            pairs = {}
            for left in covered:
                for rec in sub.PairSet[coverage[left]].PairValueRecord:
                    if rec.SecondGlyph in ids:
                        pairs[ids[left]*65536 + ids[rec.SecondGlyph]] = getattr(rec.Value1, "XAdvance", 0) or 0
            if pairs:
                lookups.append({"pairs": pairs})
        elif sub.Format == 2:
            left = {ids[n]: sub.ClassDef1.classDefs.get(n, 0) for n in covered}
            right = {ids[n]: sub.ClassDef2.classDefs[n] for n in names if n in sub.ClassDef2.classDefs}
            values = {}
            for a in set(left.values()):
                for b in {0, *right.values()}:
                    v = getattr(sub.Class1Record[a].Class2Record[b].Value1, "XAdvance", 0)
                    if v:
                        values[a*65536+b] = v
            lookups.append({"left": left, "right": right, "values": values})
    return {"upm": f.upm, "cap": f.cap, "map": {k: ids[v] for k, v in cmap.items()},
            "glyphs": glyphs, "lookups": lookups}


COMMON = set(map(ord, "‘’“”–—…·→←×éÉüöäñçèáóíú"))
if __name__ == "__main__":
    dest = PACKAGE / "fonts"
    dest.mkdir(exist_ok=True)
    def export(name, value):
        return "export const "+name+"="+json.dumps(value,separators=(",", ":"))+";\n"

    common = {w: pack(w, True) for w in FILES}
    (dest/"assets.js").write_text(export("fonts",common)+export("defaults",asdict(Theme())),encoding="utf-8")
    for weight in FILES:
        (dest/(weight+"-face.js")).write_text(export("face",pack(weight,False)),encoding="utf-8")
    shutil.copyfile(Path(FONT_DIR)/"OFL.txt", dest/"OFL.txt")
