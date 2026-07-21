#!/usr/bin/env python3
"""Extract a Kling green-screen clip into normalized RGBA pet sprite frames."""

from __future__ import annotations

import argparse
import subprocess
import tempfile
from pathlib import Path

import cv2
import numpy as np


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("input", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("state")
    parser.add_argument("--fps", type=float, default=8)
    parser.add_argument("--max-frames", type=int)
    parser.add_argument("--size", type=int, default=256)
    parser.add_argument("--width", type=int)
    parser.add_argument("--height", type=int)
    parser.add_argument("--margin", type=int, default=16)
    parser.add_argument(
        "--anchor-image",
        type=Path,
        help="Preserve the first frame's subject width from this RGBA sprite.",
    )
    parser.add_argument("--align-y", choices=("center", "bottom"), default="bottom")
    return parser.parse_args()


def extract_frames(video: Path, directory: Path, fps: float) -> list[Path]:
    pattern = directory / "source-%04d.png"
    subprocess.run(
        ["ffmpeg", "-loglevel", "error", "-y", "-i", str(video), "-vf", f"fps={fps:g}", str(pattern)],
        check=True,
    )
    return sorted(directory.glob("source-*.png"))


def isolate_subject(frame: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    b, g, r = cv2.split(frame)
    hsv = cv2.cvtColor(frame, cv2.COLOR_BGR2HSV)
    hue, saturation, value = cv2.split(hsv)

    green_hue = (hue >= 30) & (hue <= 100) & (saturation >= 45) & (value >= 35)
    green_dominant = (g.astype(np.int16) - r.astype(np.int16) >= 18) & (
        g.astype(np.int16) - b.astype(np.int16) >= 10
    )
    foreground = (~(green_hue & green_dominant)).astype(np.uint8)
    foreground = cv2.morphologyEx(foreground, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
    foreground = cv2.morphologyEx(foreground, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8))

    count, labels, stats, _ = cv2.connectedComponentsWithStats(foreground, 8)
    if count <= 1:
        raise RuntimeError("No foreground subject found")
    largest = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
    mask = (labels == largest).astype(np.uint8) * 255
    mask = cv2.GaussianBlur(mask, (0, 0), 0.8)

    # Suppress chroma spill on anti-aliased fur edges without changing neutral fur.
    color = frame.copy()
    b2, g2, r2 = cv2.split(color)
    green_spill = g2.astype(np.float32) > np.maximum(r2, b2).astype(np.float32) * 1.18
    green_limit = np.minimum(255, np.maximum(r2, b2).astype(np.float32) * 1.08 + 8).astype(np.uint8)
    g2[green_spill] = green_limit[green_spill]
    color = cv2.merge((b2, g2, r2))
    return color, mask


def alpha_bounds(mask: np.ndarray) -> tuple[int, int, int, int]:
    ys, xs = np.where(mask > 12)
    if len(xs) == 0:
        raise RuntimeError("Empty alpha mask")
    return int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1


def anchor_subject_width(path: Path) -> int:
    image = cv2.imread(str(path), cv2.IMREAD_UNCHANGED)
    if image is None or image.ndim != 3 or image.shape[2] < 4:
        raise RuntimeError(f"Anchor must be a readable RGBA image: {path}")
    x1, _, x2, _ = alpha_bounds(image[:, :, 3])
    return x2 - x1


def main() -> None:
    args = parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    canvas_width = args.width or args.size
    canvas_height = args.height or args.size
    if canvas_width <= args.margin * 2 or canvas_height <= args.margin * 2:
        raise RuntimeError("Canvas must be larger than twice the margin")

    with tempfile.TemporaryDirectory(prefix="kitty-pet-frames-") as temp:
        paths = extract_frames(args.input, Path(temp), args.fps)
        if args.max_frames:
            paths = paths[: args.max_frames]
        if not paths:
            raise RuntimeError("No frames extracted")

        subjects = [isolate_subject(cv2.imread(str(path), cv2.IMREAD_COLOR)) for path in paths]
        bounds = [alpha_bounds(mask) for _, mask in subjects]
        union = (
            min(item[0] for item in bounds),
            min(item[1] for item in bounds),
            max(item[2] for item in bounds),
            max(item[3] for item in bounds),
        )
        x1, y1, x2, y2 = union
        available_width = canvas_width - args.margin * 2
        available_height = canvas_height - args.margin * 2
        if args.anchor_image:
            first_x1, _, first_x2, _ = bounds[0]
            scale = anchor_subject_width(args.anchor_image) / (first_x2 - first_x1)
            required_width = round((x2 - x1) * scale)
            required_height = round((y2 - y1) * scale)
            if required_width > available_width or required_height > available_height:
                raise RuntimeError(
                    "Anchored subject does not fit the requested canvas: "
                    f"needs {required_width}x{required_height}, "
                    f"available {available_width}x{available_height}"
                )
        else:
            scale = min(available_width / (x2 - x1), available_height / (y2 - y1))
        width = max(1, round((x2 - x1) * scale))
        height = max(1, round((y2 - y1) * scale))
        left = (canvas_width - width) // 2
        top = (
            canvas_height - args.margin - height
            if args.align_y == "bottom"
            else (canvas_height - height) // 2
        )

        for old in args.output.glob(f"{args.state}-*.png"):
            old.unlink()

        for index, (color, alpha) in enumerate(subjects):
            crop_color = color[y1:y2, x1:x2]
            crop_alpha = alpha[y1:y2, x1:x2]
            resized_color = cv2.resize(crop_color, (width, height), interpolation=cv2.INTER_AREA)
            resized_alpha = cv2.resize(crop_alpha, (width, height), interpolation=cv2.INTER_AREA)
            # Keep transparent pixels truly empty. Some preview/render paths show
            # hidden RGB data even when alpha is zero, which looks like a green box.
            resized_color[resized_alpha < 8] = 0

            canvas = np.zeros((canvas_height, canvas_width, 4), dtype=np.uint8)
            canvas[top : top + height, left : left + width, :3] = resized_color
            canvas[top : top + height, left : left + width, 3] = resized_alpha
            target = args.output / f"{args.state}-{index}.png"
            if not cv2.imwrite(str(target), canvas):
                raise RuntimeError(f"Failed to write {target}")

    print(f"wrote {len(paths)} {args.state} frames to {args.output}")


if __name__ == "__main__":
    main()
