#!/usr/bin/env python3
"""Bounded, local JPEG display derivative. Originals arrive on stdin unchanged."""
import argparse
import struct
import sys

MAX_INPUT = 10 * 1024 * 1024
MAX_OUTPUT = 256 * 1024
MAX_PIXELS = 80_000_000


def image_dimensions(raw, mime):
    """Read raster headers before decoding, independent of optional image libraries."""
    if mime == "image/png" and raw.startswith(b"\x89PNG\r\n\x1a\n") and raw[12:16] == b"IHDR":
        return struct.unpack(">II", raw[16:24])
    if mime == "image/gif" and raw[:6] in (b"GIF87a", b"GIF89a"):
        return struct.unpack("<HH", raw[6:10])
    if mime == "image/jpeg" and raw[:2] == b"\xff\xd8":
        offset = 2
        while offset + 4 <= len(raw):
            if raw[offset] != 255:
                break
            while offset < len(raw) and raw[offset] == 255:
                offset += 1
            marker = raw[offset]
            offset += 1
            if marker in (0xD9, 0xDA):
                break
            if marker == 1 or 0xD0 <= marker <= 0xD7:
                continue
            length = int.from_bytes(raw[offset:offset + 2], "big")
            if length < 2 or offset + length > len(raw):
                break
            if marker in (0xC0, 0xC1, 0xC2):
                height, width = struct.unpack(">HH", raw[offset + 3:offset + 7])
                return width, height
            offset += length
    if mime == "image/webp" and raw[:4] == b"RIFF" and raw[8:12] == b"WEBP":
        kind = raw[12:16]
        if kind == b"VP8X" and len(raw) >= 30:
            return 1 + int.from_bytes(raw[24:27], "little"), 1 + int.from_bytes(raw[27:30], "little")
        if kind == b"VP8L" and len(raw) >= 25 and raw[20] == 0x2F:
            bits = int.from_bytes(raw[21:25], "little")
            return 1 + (bits & 0x3FFF), 1 + ((bits >> 14) & 0x3FFF)
        if kind == b"VP8 " and len(raw) >= 30 and raw[23:26] == b"\x9d\x01\x2a":
            return int.from_bytes(raw[26:28], "little") & 0x3FFF, int.from_bytes(raw[28:30], "little") & 0x3FFF
    raise ValueError("image MIME or raster header is invalid")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--mime", required=True, choices=["image/png", "image/jpeg", "image/webp", "image/gif"])
    args = parser.parse_args()
    raw = sys.stdin.buffer.read(MAX_INPUT + 1)
    if not raw or len(raw) > MAX_INPUT:
        raise ValueError("image input exceeds 10 MiB")
    import fitz

    width, height = image_dimensions(raw, args.mime)
    if min(width, height) < 1 or width * height > MAX_PIXELS:
        raise ValueError("invalid image or excessive decoded dimensions")
    with fitz.open(stream=raw) as document:
        if document.is_pdf or len(document) != 1:
            raise ValueError("preview input must be a single raster image")
        page = document[0]
        longest = max(width, height)
        for bound in [720, 612, 520, 442, 376, 320]:
            scale = min(1, bound / longest)
            matrix = fitz.Matrix(width * scale / page.rect.width, height * scale / page.rect.height)
            # alpha=False composites transparency onto a white page background.
            pixels = page.get_pixmap(matrix=matrix, colorspace=fitz.csRGB, alpha=False)
            encoded = pixels.tobytes("jpeg", jpg_quality=75)
            if len(encoded) <= MAX_OUTPUT and max(pixels.width, pixels.height) <= 720:
                sys.stdout.buffer.write(encoded)
                return
        raise ValueError("JPEG preview exceeds 256 KiB")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        # Do not echo image bytes, file content, or environment into diagnostics.
        print(f"Image preview failed: {type(error).__name__}", file=sys.stderr)
        sys.exit(1)
