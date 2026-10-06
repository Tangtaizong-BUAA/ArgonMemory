#!/usr/bin/env python3
"""Offline OOXML / PDF extraction with local image evidence, without Office or OCR.

Only selected XML and raster bytes are read. ZIP members are never extracted to
their supplied names, external relationships are never fetched, and macros and
spreadsheet formulae are never executed.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import posixpath
import re
import stat
import sys
import unicodedata
import zipfile
from pathlib import Path
from urllib.parse import unquote
from xml.etree import ElementTree as ET

MAX_INPUT = 512 * 1024 * 1024
MAX_TOTAL = 256 * 1024 * 1024
MAX_XML = 32 * 1024 * 1024
MAX_IMAGE = 10 * 1024 * 1024
MAX_MEMBERS = 10000
MAX_MISLABELED_TEXT = 1024 * 1024
VIDEO_EXTENSIONS = {".mp4", ".m4v", ".mov", ".avi", ".wmv", ".webm", ".mkv", ".mpg", ".mpeg", ".asf", ".flv", ".m2v", ".mts", ".m2ts", ".vob", ".3gp", ".ogv"}
AUDIO_EXTENSIONS = {".mp3", ".wav", ".m4a", ".aac", ".flac", ".wma", ".aiff", ".ogg", ".mid", ".midi"}
REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
FORMATS = {
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
}
TEXT_FORMATS = {"text/plain", "text/markdown", "application/json", "application/yaml", "text/yaml", "text/csv"}


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def source_digest(path: Path) -> str:
    value = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            value.update(chunk)
    return value.hexdigest()


def mislabeled_ooxml_text(source: Path) -> str:
    """A narrow recovery path for small, plainly textual files with an Office MIME."""
    if source.stat().st_size > MAX_MISLABELED_TEXT:
        raise ValueError("non-ZIP Office input exceeds the 1 MiB plain-text fallback limit")
    raw = source.read_bytes()
    if raw.startswith((b"PK\x03\x04", b"PK\x05\x06", b"PK\x07\x08", b"%PDF-", b"\xd0\xcf\x11\xe0")):
        raise ValueError("non-ZIP Office input has a binary/container signature; plain-text fallback is forbidden")
    try:
        text = raw.decode("utf-8", errors="strict")
    except UnicodeDecodeError as error:
        raise ValueError("non-ZIP Office input is not strict UTF-8 plain text") from error
    if not text.strip() or any(unicodedata.category(character) == "Cc" and character not in "\t\r\n" for character in text):
        raise ValueError("non-ZIP Office input is empty or contains binary control characters")
    return text


def tag(node: ET.Element) -> str:
    return node.tag.rsplit("}", 1)[-1]


def attr(node: ET.Element, name: str, default: str = "") -> str:
    return next((value for key, value in node.attrib.items() if key.rsplit("}", 1)[-1] == name), default)


def mime_image(data: bytes) -> tuple[str, str] | None:
    if len(data) >= 24 and data[:8] == b"\x89PNG\r\n\x1a\n" and data[12:16] == b"IHDR":
        return "image/png", "png"
    if len(data) >= 4 and data[:3] == b"\xff\xd8\xff":
        return "image/jpeg", "jpg"
    if len(data) >= 10 and data[:6] in (b"GIF87a", b"GIF89a"):
        return "image/gif", "gif"
    if len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp", "webp"
    return None


def plain(value: str) -> str:
    return value.replace("\x00", "").replace("[", "\\[").replace("]", "\\]")


def table(rows: list[list[str]]) -> str:
    if not rows:
        return ""
    width = max(len(row) for row in rows)
    if not width:
        return ""
    rows = [[value.replace("|", "\\|").replace("\n", "<br>") for value in row] + [""] * (width - len(row)) for row in rows]
    return "\n".join(["| " + " | ".join(rows[0]) + " |", "| " + " | ".join(["---"] * width) + " |", *["| " + " | ".join(row) + " |" for row in rows[1:]]])


class Writer:
    def __init__(self, output: Path):
        self.output = output
        self.images: list[dict] = []
        self.warnings: list[str] = []
        self.total = 0
        self.written: dict[str, str] = {}
        (output / "images").mkdir()

    def warn(self, value: str):
        if value not in self.warnings:
            self.warnings.append(value)

    def write(self, path: str, data: bytes):
        self.total += len(data)
        if self.total > MAX_TOTAL:
            raise ValueError("normalized output exceeds 256 MiB")
        (self.output / path).write_bytes(data)

    def image(self, data: bytes, label: str) -> str:
        if not data or len(data) > MAX_IMAGE:
            self.warn("An embedded image was omitted because it is empty or exceeds 10 MiB.")
            return "[Image unavailable: size limit]"
        detected = mime_image(data)
        if not detected:
            self.warn("An embedded image was omitted because its format is not PNG, JPEG, GIF, or WebP (for example EMF/SVG).")
            return "[Image unavailable: unsupported raster format]"
        sha = digest(data)
        if sha not in self.written:
            path = f"images/{sha}.{detected[1]}"
            self.write(path, data)
            self.written[sha] = path
            self.images.append({"path": path, "sha256": sha, "mime_type": detected[0], "size_bytes": len(data)})
        return f"![{plain(label)}]({self.written[sha]})"


class Package:
    def __init__(self, source: Path, writer: Writer):
        self.zip = zipfile.ZipFile(source)
        self.writer = writer
        self.names: dict[str, zipfile.ZipInfo] = {}
        self.used_media: set[str] = set()
        self.rel_cache: dict[str, dict[str, tuple[str, str]]] = {}
        self.read_bytes = 0
        self.skipped_media: set[str] = set()
        infos = self.zip.infolist()
        if len(infos) > MAX_MEMBERS:
            raise ValueError("OOXML package exceeds the 10,000-member limit")
        for item in infos:
            name = item.filename
            if not name or "\\" in name or name.startswith("/") or re.match(r"^[a-zA-Z]:", name) or ".." in name.split("/") or "\x00" in name:
                raise ValueError("OOXML package contains an unsafe ZIP member path")
            if stat.S_ISLNK(item.external_attr >> 16):
                raise ValueError("OOXML package contains a symlink")
            if name in self.names:
                raise ValueError("OOXML package contains duplicate member names")
            if item.flag_bits & 1:
                raise ValueError("encrypted ZIP members are unsupported")
            self.names[name] = item
            self.skip_media(name)

    def skip_media(self, name: str, relationship_type: str = "") -> bool:
        if posixpath.splitext(name)[1].lower() in VIDEO_EXTENSIONS | AUDIO_EXTENSIONS or relationship_type.endswith(("/video", "/audio", "/media")):
            self.skipped_media.add(name)
            self.writer.warn("Embedded video/audio streams were skipped without decompression; video/audio content was not indexed.")
            return True
        return False

    def read(self, name: str, limit: int) -> bytes:
        info = self.names.get(name)
        if info is None:
            raise ValueError(f"missing OOXML part: {name}")
        if self.skip_media(name) or name in self.skipped_media:
            raise ValueError("video/audio streams cannot be decompressed by this parser")
        limit = min(limit, 64 * 1024 * 1024)
        if info.file_size > limit:
            raise ValueError(f"OOXML part exceeds its byte limit: {name}")
        if info.file_size > 1024 * 1024 and info.file_size > max(info.compress_size, 1) * 1000:
            raise ValueError("OOXML member exceeds compression-ratio limits")
        if self.read_bytes + info.file_size > MAX_TOTAL:
            raise ValueError("cumulative OOXML decompression exceeds the 256 MiB budget")
        chunks: list[bytes] = []
        size = 0
        with self.zip.open(info) as stream:
            while True:
                chunk = stream.read(min(64 * 1024, limit + 1 - size))
                if not chunk:
                    break
                size += len(chunk)
                self.read_bytes += len(chunk)
                if size > limit or self.read_bytes > MAX_TOTAL:
                    raise ValueError("OOXML actual expanded bytes exceed their resource budget")
                chunks.append(chunk)
        return b"".join(chunks)

    def xml(self, name: str) -> ET.Element:
        raw = self.read(name, MAX_XML)
        inspected = raw.upper().replace(b"\x00", b"")
        if b"<!DOCTYPE" in inspected or b"<!ENTITY" in inspected:
            raise ValueError("DTD/entity declarations are forbidden in OOXML parts")
        return ET.fromstring(raw)

    def relationships(self, part: str) -> dict[str, tuple[str, str]]:
        if part in self.rel_cache:
            return self.rel_cache[part]
        rel_path = posixpath.join(posixpath.dirname(part), "_rels", posixpath.basename(part) + ".rels")
        result: dict[str, tuple[str, str]] = {}
        if rel_path in self.names:
            for node in self.xml(rel_path):
                target = unquote(node.attrib.get("Target", "")).split("#", 1)[0]
                if node.attrib.get("TargetMode", "").lower() == "external" or re.match(r"^[a-zA-Z][a-zA-Z0-9+.-]*:", target) or target.startswith("//"):
                    self.writer.warn("External OOXML relationships were not fetched.")
                    continue
                if not target or "\\" in target or "\x00" in target:
                    self.writer.warn("An invalid OOXML relationship was omitted.")
                    continue
                resolved = posixpath.normpath(target.lstrip("/") if target.startswith("/") else posixpath.join(posixpath.dirname(part), target))
                if resolved == ".." or resolved.startswith("../") or resolved not in self.names:
                    self.writer.warn("A missing or out-of-package OOXML relationship was omitted.")
                    continue
                relationship_type = node.attrib.get("Type", "")
                self.skip_media(resolved, relationship_type)
                result[node.attrib.get("Id", "")] = (resolved, relationship_type)
        self.rel_cache[part] = result
        return result

    def picture(self, part: str, relationship: str, label: str) -> str:
        linked = self.relationships(part).get(relationship)
        if not linked:
            self.writer.warn("An image relationship had no readable local target.")
            return "[Image unavailable: no local relationship target]"
        target = linked[0]
        if self.skip_media(target, linked[1]) or target in self.skipped_media:
            return "[Video/audio not indexed]"
        self.used_media.add(target)
        try:
            return self.writer.image(self.read(target, MAX_IMAGE), label or posixpath.basename(target))
        except ValueError as error:
            self.writer.warn(f"An embedded image was omitted by resource limits: {str(error).split(':', 1)[0]}.")
            return "[Image unavailable: resource limit]"

    def inline(self, node: ET.Element, part: str) -> str:
        values: list[str] = []
        description = next((attr(child, "descr") or attr(child, "title") or attr(child, "name") for child in node.iter() if tag(child) in ("docPr", "cNvPr")), "")
        for child in node.iter():
            kind = tag(child)
            if kind == "t":
                values.append(child.text or "")
            elif kind == "tab":
                values.append("\t")
            elif kind in ("br", "cr"):
                values.append("\n")
            elif kind in ("blip", "imagedata"):
                relationship = attr(child, "embed") or attr(child, "id")
                if relationship:
                    values.append("\n" + self.picture(part, relationship, description) + "\n")
                elif attr(child, "link"):
                    self.writer.warn("An externally linked image was not fetched.")
        return "".join(values).strip()

    def remainder_images(self) -> list[str]:
        values: list[str] = []
        for name in sorted(self.names):
            if "/media/" not in name or name in self.used_media or self.names[name].is_dir():
                continue
            if self.skip_media(name) or name in self.skipped_media:
                continue
            try:
                image = self.writer.image(self.read(name, MAX_IMAGE), f"Unplaced embedded image: {posixpath.basename(name)}")
            except ValueError as error:
                self.writer.warn(f"An unplaced embedded image was omitted by resource limits: {str(error).split(':', 1)[0]}.")
                continue
            values.append(image)
        if values:
            self.writer.warn("Some embedded images lack source placement and are listed in an additional-images appendix.")
            return ["## Additional embedded images", *values]
        return []


def docx_blocks(package: Package, node: ET.Element, part: str) -> list[str]:
    values: list[str] = []
    for child in node:
        kind = tag(child)
        if kind == "p":
            text = package.inline(child, part)
            if not text:
                continue
            style = next((attr(value, "val") for value in child.iter() if tag(value) == "pStyle"), "")
            heading = re.search(r"(?:heading|标题)\s*([1-6])", style, re.IGNORECASE)
            outline = next((attr(value, "val") for value in child.iter() if tag(value) == "outlineLvl"), "")
            level = int(heading[1]) if heading else min(6, int(outline) + 1) if outline.isdigit() and int(outline) < 6 else 0
            prefix = "#" * level + " " if level else "- " if any(tag(value) == "numPr" for value in child.iter()) else ""
            values.append(prefix + text)
        elif kind == "tbl":
            rows = [["\n".join(docx_blocks(package, cell, part)) for cell in row if tag(cell) == "tc"] for row in child if tag(row) == "tr"]
            values.append(table(rows))
            if any(tag(value) in ("gridSpan", "vMerge") for value in child.iter()):
                package.writer.warn("Merged table cells retain their text, but merged layout is not reproduced in Markdown.")
        elif kind in ("sdt", "sdtContent", "customXml", "body", "footnote", "endnote", "comment"):
            values.extend(docx_blocks(package, child, part))
        elif kind == "altChunk":
            package.writer.warn("An alternate-format DOCX content part was not rendered.")
    return values


def extract_docx(package: Package) -> tuple[str, int]:
    part = "word/document.xml"
    values = docx_blocks(package, package.xml(part), part)
    extras = sorted(name for name in package.names if re.fullmatch(r"word/(?:header\d+|footer\d+|footnotes|endnotes|comments)\.xml", name))
    for extra in extras:
        content = docx_blocks(package, package.xml(extra), extra)
        if content:
            values.extend([f"## Supplement: {posixpath.basename(extra)}", *content])
    return "\n\n".join([*values, *package.remainder_images()]), 0


def shape_content(package: Package, node: ET.Element, part: str) -> list[str]:
    values: list[str] = []
    for child in node:
        kind = tag(child)
        if kind in ("sp", "pic", "graphicFrame", "cxnSp"):
            tables = [value for value in child.iter() if tag(value) == "tbl"]
            if tables:
                for grid in tables:
                    rows = [[package.inline(cell, part) for cell in row if tag(cell) == "tc"] for row in grid if tag(row) == "tr"]
                    values.append(table(rows))
            else:
                paragraphs = [value for value in child.iter() if tag(value) == "p"]
                text = "\n".join(package.inline(value, part) for value in paragraphs) if paragraphs else package.inline(child, part)
                # Pictures can be outside a text paragraph in a shape.
                if paragraphs:
                    for value in child.iter():
                        if tag(value) == "blip":
                            text += "\n" + package.picture(part, attr(value, "embed"), next((attr(meta, "descr") or attr(meta, "name") for meta in child.iter() if tag(meta) == "cNvPr"), ""))
                if text.strip():
                    is_title = any(tag(value) == "ph" and attr(value, "type") in ("title", "ctrTitle") for value in child.iter())
                    values.append(("### " if is_title else "") + text.strip())
        else:
            values.extend(shape_content(package, child, part))
    return values


def extract_pptx(package: Package) -> tuple[str, int]:
    presentation = "ppt/presentation.xml"
    rels = package.relationships(presentation)
    # sldId carries both numeric id and r:id; use the namespaced relation explicitly.
    slides = [rels[node.attrib.get(f"{{{REL}}}id", "")][0] for node in package.xml(presentation).iter() if tag(node) == "sldId" and node.attrib.get(f"{{{REL}}}id", "") in rels]
    if not slides:
        raise ValueError("PPTX has no addressable slides")
    values: list[str] = []
    for index, part in enumerate(slides, 1):
        values.extend([f"## Slide {index}", *shape_content(package, package.xml(part), part)])
        for target, kind in package.relationships(part).values():
            if kind.endswith("/notesSlide"):
                notes = shape_content(package, package.xml(target), target)
                if notes:
                    values.extend(["### Speaker notes", *notes])
    return "\n\n".join([*values, *package.remainder_images()]), len(slides)


def column_name(index: int) -> str:
    value = ""
    index += 1
    while index:
        index, rem = divmod(index - 1, 26)
        value = chr(65 + rem) + value
    return value


def extract_xlsx(package: Package) -> tuple[str, int]:
    strings = []
    if "xl/sharedStrings.xml" in package.names:
        strings = ["".join(value.text or "" for value in node.iter() if tag(value) == "t") for node in package.xml("xl/sharedStrings.xml") if tag(node) == "si"]
    workbook = "xl/workbook.xml"
    rels = package.relationships(workbook)
    values: list[str] = []
    count = 0
    for sheet in package.xml(workbook).iter():
        if tag(sheet) != "sheet":
            continue
        relation = sheet.attrib.get(f"{{{REL}}}id", "")
        if relation not in rels:
            package.writer.warn("A worksheet has no readable local relationship.")
            continue
        count += 1
        part = rels[relation][0]
        values.append(f"## Sheet {count}: {sheet.attrib.get('name', str(count))}")
        if sheet.attrib.get("state", "visible") != "visible":
            values.append("Sheet state: " + sheet.attrib["state"])
        rows = [["Cell", "Stored value", "Formula (not evaluated)"]]
        for cell in package.xml(part).iter():
            if tag(cell) != "c":
                continue
            cached = next((value.text or "" for value in cell if tag(value) == "v"), "")
            formula_node = next((value for value in cell if tag(value) == "f"), None)
            formula = formula_node.text or "" if formula_node is not None else ""
            kind = cell.attrib.get("t", "")
            if kind == "s":
                try:
                    index = int(cached)
                    if index < 0:
                        raise IndexError("negative shared string index")
                    cached = strings[index]
                except (ValueError, IndexError):
                    package.writer.warn("A cell references a missing shared string.")
            elif kind == "inlineStr":
                cached = "".join(value.text or "" for value in cell.iter() if tag(value) == "t")
            elif kind == "b":
                cached = "TRUE" if cached == "1" else "FALSE"
            if formula_node is not None:
                package.writer.warn("Formula expressions and stored cached values are preserved; formulas were not evaluated.")
            formula_cell = "=" + formula if formula else ET.tostring(formula_node, encoding="unicode") if formula_node is not None else ""
            rows.append([cell.attrib.get("r", "?"), cached, formula_cell])
        values.append(table(rows))
        for target, kind in package.relationships(part).values():
            if kind.endswith("/drawing"):
                for anchor in package.xml(target):
                    start = next((value for value in anchor if tag(value) == "from"), None)
                    fields = {tag(value): value.text or "0" for value in start} if start is not None else {}
                    try:
                        position = column_name(int(fields.get("col", "0"))) + str(int(fields.get("row", "0")) + 1)
                    except ValueError:
                        position = "unknown cell"
                    content = package.inline(anchor, target)
                    if content:
                        values.extend([f"### Drawing at {position}", content])
            elif kind.endswith("/comments"):
                for comment in package.xml(target).iter():
                    if tag(comment) == "comment":
                        values.append(f"Comment {comment.attrib.get('ref', '?')}: {package.inline(comment, target)}")
    if not count:
        raise ValueError("XLSX has no addressable worksheets")
    return "\n\n".join([*values, *package.remainder_images()]), count


def extract_pdf(source: Path, writer: Writer) -> tuple[str, int]:
    try:
        import fitz
    except ImportError as exc:
        raise RuntimeError("PDF extraction requires PyMuPDF (fitz) in ARGON_MEMORY_PYTHON_BIN; no OCR or PDF extraction was performed") from exc
    values: list[str] = []
    low_text = 0
    with fitz.open(source) as document:
        if document.needs_pass:
            raise ValueError("password-protected PDF is unsupported")
        if len(document) > 2000:
            raise ValueError("PDF exceeds the 2,000-page limit")
        for index, page in enumerate(document, 1):
            text = page.get_text("text", sort=True).strip()
            values.append(f"## Page {index}")
            if text:
                values.append(text)
            if len(re.sub(r"\s+", "", text)) < 30:
                low_text += 1
                longest = max(page.rect.width, page.rect.height)
                if longest <= 0:
                    raise ValueError("PDF page has invalid geometry")
                scale = min(2.0, 1800.0 / longest)
                pixels = page.get_pixmap(matrix=fitz.Matrix(scale, scale), colorspace=fitz.csRGB, alpha=False)
                values.append(writer.image(pixels.tobytes("png"), f"Page {index} rendered original layout; no OCR"))
            else:
                seen: set[int] = set()
                for ordinal, image in enumerate(page.get_images(full=True), 1):
                    xref = image[0]
                    if not xref or xref in seen:
                        continue
                    seen.add(xref)
                    if image[2] * image[3] > 40_000_000:
                        writer.warn("A PDF embedded image exceeds the 40-million-pixel decode budget and was omitted.")
                        continue
                    extracted = document.extract_image(xref)
                    data = extracted.get("image", b"") if extracted else b""
                    if data and not mime_image(data) and len(data) <= MAX_IMAGE:
                        # PDF may store JPX/CCITT images; convert these locally to RGB PNG.
                        pixels = fitz.Pixmap(document, xref)
                        if pixels.colorspace and pixels.colorspace.n != 3:
                            pixels = fitz.Pixmap(fitz.csRGB, pixels)
                        data = pixels.tobytes("png")
                    values.append(writer.image(data, f"Page {index} embedded image {ordinal}"))
                if page.get_drawings():
                    writer.warn("Vector graphics on text-bearing PDF pages were not rasterized; inspect the original PDF for vector-only diagrams and page layout.")
        count = len(document)
    writer.warn("PDF text-bearing pages retain extracted text and embedded raster images; low-text pages are rendered locally; no OCR was performed.")
    if low_text:
        writer.warn(f"{low_text} PDF page(s) have fewer than 30 extracted non-whitespace characters; their content requires visual inspection, not text-search completeness.")
    return "\n\n".join(values), count


def main():
    args = argparse.ArgumentParser()
    args.add_argument("--source", required=True)
    args.add_argument("--output", required=True)
    args.add_argument("--mime", required=True)
    args.add_argument("--expected-sha256", required=True)
    request = args.parse_args()
    source, output = Path(request.source), Path(request.output)
    if source.is_symlink() or not source.is_file() or source.stat().st_size > MAX_INPUT:
        raise ValueError("source must be a regular file of at most 512 MiB")
    if output.is_symlink() or not output.is_dir() or any(output.iterdir()):
        raise ValueError("output must be an empty staging directory")
    before = source_digest(source)
    if before != request.expected_sha256:
        raise ValueError("source content hash changed before parsing")
    writer = Writer(output)
    details: dict = {}
    preserve_text = request.mime in TEXT_FORMATS
    if preserve_text:
        if source.stat().st_size > MAX_TOTAL:
            raise ValueError("UTF-8 text source exceeds the 256 MiB normalized-output limit")
        markdown = source.read_bytes().decode("utf-8", errors="strict")
        pages = 0
        parser = "project-inline-utf8-local/v1"
        if request.mime == "text/markdown" and re.search(r"!\[[^\]]*\]\(", markdown):
            writer.warn("Markdown image links were preserved; source-relative dependencies were not copied by UTF-8 normalization.")
    elif request.mime == "application/pdf":
        markdown, pages = extract_pdf(source, writer)
        parser = "project-pdf-fitz-local/v1"
    elif request.mime in FORMATS:
        if not zipfile.is_zipfile(source):
            markdown = mislabeled_ooxml_text(source)
            preserve_text = True
            pages = 0
            parser = "project-mislabeled-utf8-local/v1"
            details["mime_mismatch"] = True
            writer.warn("Declared Office MIME does not match file bytes: a small strict UTF-8 plain-text body was preserved; no Office-format parsing was performed.")
        else:
            package = Package(source, writer)
            try:
                markdown, pages = {"docx": extract_docx, "pptx": extract_pptx, "xlsx": extract_xlsx}[FORMATS[request.mime]](package)
                details.update({"zip_read_bytes": package.read_bytes, "zip_skipped_media": len(package.skipped_media)})
            finally:
                package.zip.close()
            parser = "project-ooxml-stdlib-local/v1"
    else:
        raise ValueError("local normalization supports DOCX, PPTX, XLSX and PDF; legacy binary Office is not parsed")
    if source_digest(source) != before:
        raise ValueError("source content hash changed during parsing")
    if not preserve_text:
        markdown = markdown.strip() + "\n"
    if not markdown.strip():
        writer.warn("The document contains no extracted text or supported image references.")
    encoded = markdown.encode("utf-8")
    writer.write("document.md", encoded)
    print(json.dumps({"parser": parser, "page_count": pages, "warnings": writer.warnings, "source_sha256": before, "markdown_sha256": digest(encoded), "images": writer.images, **details}, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(json.dumps({"error": f"{type(error).__name__}: {error}"}, ensure_ascii=False))
        sys.exit(1)
