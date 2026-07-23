#!/usr/bin/env python3
"""Convert a MAME-format Neo Geo ROM zip into a TerraOnion NeoSD .neo file.

Dev/test helper — NOT a full NeoBuilder replacement: it handles the common
cartridge layout only (no SMA/PCM2 encryption, no per-game patch database).
Good enough for straightforward sets like mslug.

.neo layout (see geolith src/geo_neo.c):
  0..3    'N' 'E' 'O' 0x01
  4..27   P, S, M, V1, V2, C region sizes (u32 LE each)
  28..43  year, genre, screenshot, NGH (u32 LE each)
  44..76  name (33 bytes)
  77..93  manufacturer (17 bytes)
  ...     zero padding to 4096
  4096..  P + S + M + V1 [+ V2] + C region data

Region construction from a MAME set:
  P: p-roms concatenated in order. A single 2MB p1 (e.g. mslug) is stored by
     MAME as high-half-first (ROM_CONTINUE), so its halves are swapped to get
     the address-ordered image.
  S/M: concatenated as-is.
  V: v-roms concatenated into V1, V2 left empty (shared ADPCM-A/B region).
  C: pairs (c1,c2), (c3,c4), ... byte-interleaved (c_odd -> even offsets,
     c_even -> odd offsets), matching ROM_LOAD16_BYTE.
"""

from __future__ import annotations

import argparse
import re
import struct
import zipfile
from pathlib import Path


def natural_key(name: str) -> list:
    return [int(t) if t.isdigit() else t for t in re.split(r"(\d+)", name)]


def collect(zf: zipfile.ZipFile, kind: str) -> list[bytes]:
    """All members whose extension starts with `kind` (p1, p2, c1, ...)."""
    members = [n for n in zf.namelist() if re.search(rf"\.{kind}(\d+)$", n.lower())]
    members.sort(key=lambda n: natural_key(n.lower()))
    return [zf.read(n) for n in members]


def build_neo(zip_path: Path, out_path: Path, name: str, ngh: int, year: int,
              manufacturer: str) -> None:
    zf = zipfile.ZipFile(zip_path)

    p_files = collect(zf, "p")
    s_files = collect(zf, "s")
    m_files = collect(zf, "m")
    v_files = collect(zf, "v")
    c_files = collect(zf, "c")

    if not p_files or not s_files or not m_files or not c_files:
        raise SystemExit(
            f"missing regions: p={len(p_files)} s={len(s_files)} "
            f"m={len(m_files)} v={len(v_files)} c={len(c_files)}"
        )

    # P region: address-ordered program image.
    if len(p_files) == 1 and len(p_files[0]) == 0x200000:
        p1 = p_files[0]
        p_region = p1[0x100000:] + p1[:0x100000]
        print("P: single 2MB p1 — swapped halves (ROM_CONTINUE layout)")
    else:
        p_region = b"".join(p_files)

    s_region = b"".join(s_files)
    m_region = b"".join(m_files)
    v_region = b"".join(v_files)

    if len(c_files) % 2 != 0:
        raise SystemExit("odd number of C ROMs — unsupported layout")
    c_parts = []
    for i in range(0, len(c_files), 2):
        even, odd = c_files[i], c_files[i + 1]
        if len(even) != len(odd):
            raise SystemExit("C ROM pair size mismatch — unsupported layout")
        inter = bytearray(len(even) * 2)
        inter[0::2] = even
        inter[1::2] = odd
        c_parts.append(bytes(inter))
    c_region = b"".join(c_parts)

    header = bytearray(4096)
    header[0:4] = b"NEO\x01"
    struct.pack_into(
        "<6I", header, 4,
        len(p_region), len(s_region), len(m_region),
        len(v_region), 0, len(c_region),
    )
    struct.pack_into("<4I", header, 28, year, 0, 0, ngh)
    header[44:44 + 33] = name.encode("ascii", "replace")[:33].ljust(33, b"\x00")
    header[77:77 + 17] = manufacturer.encode("ascii", "replace")[:17].ljust(17, b"\x00")

    out_path.write_bytes(bytes(header) + p_region + s_region + m_region + v_region + c_region)
    total = out_path.stat().st_size
    print(f"wrote {out_path} ({total:,} bytes)")
    print(f"  P={len(p_region):,} S={len(s_region):,} M={len(m_region):,} "
          f"V1={len(v_region):,} V2=0 C={len(c_region):,}")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("zip", type=Path, help="MAME-format ROM zip (e.g. mslug.zip)")
    ap.add_argument("out", type=Path, nargs="?", help="output .neo path")
    ap.add_argument("--name", default=None, help="game title for the header")
    ap.add_argument("--ngh", type=lambda x: int(x, 0), default=0, help="NGH number (e.g. 0x201)")
    ap.add_argument("--year", type=int, default=0)
    ap.add_argument("--manufacturer", default="")
    args = ap.parse_args()

    out = args.out or args.zip.with_suffix(".neo")
    name = args.name or args.zip.stem
    build_neo(args.zip, out, name, args.ngh, args.year, args.manufacturer)


if __name__ == "__main__":
    main()
