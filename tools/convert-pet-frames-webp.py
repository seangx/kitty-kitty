#!/usr/bin/env python3
"""Convert one PNG pet animation state to compact transparent WebP frames."""

from __future__ import annotations

import argparse
import subprocess
from pathlib import Path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("directory", type=Path)
    parser.add_argument("state")
    parser.add_argument("--quality", type=int, default=90)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    if not 0 <= args.quality <= 100:
        raise RuntimeError("--quality must be between 0 and 100")

    sources = sorted(args.directory.glob(f"{args.state}-*.png"))
    if not sources:
        raise RuntimeError(f"No {args.state} PNG frames found in {args.directory}")

    outputs: list[Path] = []
    for source in sources:
        output = source.with_suffix(".webp")
        subprocess.run(
            [
                "cwebp",
                "-quiet",
                "-q",
                str(args.quality),
                "-alpha_q",
                "100",
                "-m",
                "6",
                str(source),
                "-o",
                str(output),
            ],
            check=True,
        )
        outputs.append(output)

    for source in sources:
        source.unlink()

    total = sum(output.stat().st_size for output in outputs)
    print(f"wrote {len(outputs)} {args.state} WebP frames ({total / 1024:.1f} KiB)")


if __name__ == "__main__":
    main()
