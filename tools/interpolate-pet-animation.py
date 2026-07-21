#!/usr/bin/env python3
"""Add alpha-safe in-between frames to a normalized RGBA pet animation."""

from __future__ import annotations

import argparse
import re
from pathlib import Path

import numpy as np
from PIL import Image


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("input", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--state", default="idle")
    parser.add_argument("--inbetweens", type=int, default=2)
    return parser.parse_args()


def frame_number(path: Path) -> int:
    match = re.search(r"-(\d+)\.png$", path.name)
    if not match:
        raise RuntimeError(f"Invalid frame name: {path.name}")
    return int(match.group(1))


def blend_rgba(first: Image.Image, second: Image.Image, amount: float) -> Image.Image:
    first_rgba = np.asarray(first, dtype=np.float32) / 255.0
    second_rgba = np.asarray(second, dtype=np.float32) / 255.0
    first_alpha = first_rgba[..., 3:4]
    second_alpha = second_rgba[..., 3:4]
    alpha = first_alpha * (1.0 - amount) + second_alpha * amount
    premultiplied = (
        first_rgba[..., :3] * first_alpha * (1.0 - amount)
        + second_rgba[..., :3] * second_alpha * amount
    )
    rgb = np.divide(premultiplied, alpha, out=np.zeros_like(premultiplied), where=alpha > 1e-6)
    rgba = np.concatenate((rgb, alpha), axis=2)
    return Image.fromarray(np.clip(np.rint(rgba * 255.0), 0, 255).astype(np.uint8), "RGBA")


def main() -> None:
    args = parse_args()
    if args.inbetweens < 0:
        raise RuntimeError("--inbetweens cannot be negative")

    paths = sorted(args.input.glob(f"{args.state}-*.png"), key=frame_number)
    if len(paths) < 2:
        raise RuntimeError("At least two input frames are required")
    frames = [Image.open(path).convert("RGBA") for path in paths]
    if len({frame.size for frame in frames}) != 1:
        raise RuntimeError("All input frames must share one canvas size")

    expanded: list[Image.Image] = []
    for index, frame in enumerate(frames[:-1]):
        expanded.append(frame)
        following = frames[index + 1]
        for step in range(1, args.inbetweens + 1):
            expanded.append(blend_rgba(frame, following, step / (args.inbetweens + 1)))
    expanded.append(frames[-1])

    args.output.mkdir(parents=True, exist_ok=True)
    for old in args.output.glob(f"{args.state}-*.png"):
        old.unlink()
    for index, frame in enumerate(expanded):
        frame.save(args.output / f"{args.state}-{index}.png")
    print(f"wrote {len(expanded)} {args.state} frames")


if __name__ == "__main__":
    main()
