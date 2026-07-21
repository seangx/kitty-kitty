#!/usr/bin/env python3
"""Normalize an image-generated pet idle strip against an approved anchor frame."""

from __future__ import annotations

import argparse
from pathlib import Path

from PIL import Image


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("input", type=Path)
    parser.add_argument("anchor", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--frames", type=int, default=5)
    parser.add_argument("--state", default="idle")
    parser.add_argument("--width", type=int, default=320)
    parser.add_argument("--height", type=int, default=256)
    parser.add_argument("--alpha-threshold", type=int, default=8)
    return parser.parse_args()


def content_box(image: Image.Image, threshold: int) -> tuple[int, int, int, int]:
    alpha = image.getchannel("A").point(lambda value: 255 if value > threshold else 0)
    box = alpha.getbbox()
    if box is None:
        raise RuntimeError("No visible subject found")
    return box


def split_strip(strip: Image.Image, count: int) -> list[Image.Image]:
    if count < 1:
        raise RuntimeError("--frames must be positive")
    return [
        strip.crop((round(index * strip.width / count), 0, round((index + 1) * strip.width / count), strip.height))
        for index in range(count)
    ]


def clear_hidden_rgb(image: Image.Image) -> Image.Image:
    pixels = image.load()
    for y in range(image.height):
        for x in range(image.width):
            red, green, blue, alpha = pixels[x, y]
            if alpha == 0 and (red or green or blue):
                pixels[x, y] = (0, 0, 0, 0)
    return image


def locked_anchor_frame(anchor: Image.Image, width: int, height: int) -> Image.Image:
    if anchor.width == width and anchor.height >= height:
        return clear_hidden_rgb(anchor.crop((0, anchor.height - height, width, anchor.height)))
    raise RuntimeError("Anchor must match the output width and be at least as tall as the output")


def main() -> None:
    args = parse_args()
    strip = Image.open(args.input).convert("RGBA")
    anchor = Image.open(args.anchor).convert("RGBA")
    slots = split_strip(strip, args.frames)

    anchor_box = content_box(anchor, args.alpha_threshold)
    anchor_width = anchor_box[2] - anchor_box[0]
    anchor_bottom_inset = anchor.height - anchor_box[3]
    first_box = content_box(slots[0], args.alpha_threshold)
    first_width = first_box[2] - first_box[0]
    shared_scale = anchor_width / first_width

    args.output.mkdir(parents=True, exist_ok=True)
    for old in args.output.glob(f"{args.state}-*.png"):
        old.unlink()

    locked_anchor_frame(anchor, args.width, args.height).save(args.output / f"{args.state}-0.png")

    for index, slot in enumerate(slots[1:], start=1):
        box = content_box(slot, args.alpha_threshold)
        subject = slot.crop(box)
        target_width = max(1, round(subject.width * shared_scale))
        target_height = max(1, round(subject.height * shared_scale))
        if target_width > args.width or target_height + anchor_bottom_inset > args.height:
            raise RuntimeError(
                f"Frame {index} does not fit: {target_width}x{target_height} in {args.width}x{args.height}"
            )
        subject = subject.resize((target_width, target_height), Image.Resampling.LANCZOS)
        canvas = Image.new("RGBA", (args.width, args.height), (0, 0, 0, 0))
        left = (args.width - target_width) // 2
        top = args.height - anchor_bottom_inset - target_height
        canvas.alpha_composite(subject, (left, top))
        clear_hidden_rgb(canvas).save(args.output / f"{args.state}-{index}.png")

    print(
        f"wrote {args.frames} {args.state} frames; shared_scale={shared_scale:.4f}; "
        f"anchor_width={anchor_width}; bottom_inset={anchor_bottom_inset}"
    )


if __name__ == "__main__":
    main()
