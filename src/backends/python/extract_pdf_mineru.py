#!/usr/bin/env python3
"""
Extract Markdown and addressable content from a MinerU-supported document using
the MinerU cloud SDK (mineru-open-sdk).

Usage:
    MINERU_API_KEY=... extract_pdf_mineru.py <filepath>

Output (stdout, JSON):
    { "pages": [{"page_idx": N, "text": "...", "tokens": N}], "bookmarks": [] }

On error:
    { "error": "message" }
"""
import sys
import json
import os
import argparse
import hashlib
import io
import ipaddress
import posixpath
import re
import socket
import stat
import time
import zipfile
from pathlib import Path, PurePosixPath
from types import SimpleNamespace
from urllib.parse import urlsplit, urljoin, unquote
from collections import defaultdict

MAX_DOWNLOAD = 128 * 1024 * 1024
MAX_EXPANDED = 256 * 1024 * 1024
MAX_ENTRY = 32 * 1024 * 1024
MAX_IMAGE = 10 * 1024 * 1024
MAX_MEMBERS = 10000


def safe_output(path):
    if path is None:
        return None
    target = Path(path).absolute()
    if ".." in Path(path).parts:
        raise ValueError("unsafe assets output path")
    for part in [*reversed(target.parents), target]:
        if part.is_symlink():
            raise ValueError("assets output cannot use symlinks")
    if not target.is_dir() or any(target.iterdir()):
        raise ValueError("assets output must be an existing empty directory")
    return target.resolve()


def image_type(data):
    if len(data) >= 24 and data[:8] == b"\x89PNG\r\n\x1a\n" and data[12:16] == b"IHDR":
        return "image/png", "png"
    if len(data) >= 4 and data[:3] == b"\xff\xd8\xff":
        return "image/jpeg", "jpg"
    if len(data) >= 10 and data[:6] in (b"GIF87a", b"GIF89a"):
        return "image/gif", "gif"
    if len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp", "webp"
    return None


def public_https(url):
    parsed = urlsplit(url)
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password or parsed.port not in (None, 443):
        raise ValueError("unsafe MinerU download URL")
    addresses = socket.getaddrinfo(parsed.hostname, 443, type=socket.SOCK_STREAM)
    if not addresses or any(not ipaddress.ip_address(item[4][0]).is_global for item in addresses):
        raise ValueError("MinerU download must use a public HTTPS address")


def download_zip(url):
    import httpx
    for _ in range(4):
        public_https(url)
        # The signed object URL does not receive the service bearer token.
        with httpx.stream("GET", url, timeout=httpx.Timeout(30.0, read=300.0), follow_redirects=False, trust_env=False) as response:
            if response.status_code in (301, 302, 303, 307, 308):
                if "location" not in response.headers:
                    raise ValueError("invalid MinerU download redirect")
                url = urljoin(url, response.headers["location"])
                continue
            response.raise_for_status()
            if int(response.headers.get("content-length", "0")) > MAX_DOWNLOAD:
                raise ValueError("MinerU ZIP exceeds 128 MiB download budget")
            result = io.BytesIO()
            for chunk in response.iter_bytes(64 * 1024):
                if result.tell() + len(chunk) > MAX_DOWNLOAD:
                    raise ValueError("MinerU ZIP exceeds 128 MiB download budget")
                result.write(chunk)
            return result.getvalue()
    raise ValueError("too many MinerU download redirects")


def parse_safe_zip(raw, output=None, task_id=""):
    if len(raw) > MAX_DOWNLOAD:
        raise ValueError("MinerU ZIP exceeds 128 MiB download budget")
    assets, warnings, paths, written = [], [], {}, {}
    markdown, markdown_path, content_list = "", "", []
    expanded = 0
    with zipfile.ZipFile(io.BytesIO(raw)) as package:
        infos = package.infolist()
        if len(infos) > MAX_MEMBERS:
            raise ValueError("MinerU ZIP member limit exceeded")
        names = set()
        for info in infos:
            name = info.filename
            clean = name.rstrip("/")
            if not clean or "\\" in name or "\x00" in name or name.startswith("/") or re.match(r"^[A-Za-z]:", name) or any(part in ("..", ".", "") for part in clean.split("/")):
                raise ValueError("unsafe MinerU ZIP path")
            if clean in names or stat.S_ISLNK(info.external_attr >> 16) or info.flag_bits & 1:
                raise ValueError("unsafe duplicate/symlink/encrypted MinerU ZIP member")
            names.add(clean)
        for info in infos:
            if info.is_dir():
                continue
            name = info.filename
            suffix = PurePosixPath(name).suffix.lower()
            image = suffix in (".png", ".jpg", ".jpeg", ".gif", ".webp")
            selected = image or suffix == ".md" or name.endswith("content_list.json")
            if not selected:
                if suffix in (".svg", ".bmp", ".tif", ".tiff"):
                    warnings.append("Unsupported raster/vector asset omitted; only PNG/JPEG/GIF/WebP are retained.")
                continue
            limit = MAX_IMAGE if image else MAX_ENTRY
            if info.file_size > limit or (info.file_size > 1024 * 1024 and info.file_size / max(1, info.compress_size) > 1000):
                raise ValueError("MinerU ZIP member exceeds size/compression budget")
            if expanded + info.file_size > MAX_EXPANDED:
                raise ValueError("MinerU ZIP exceeds expanded budget")
            chunks, size = [], 0
            with package.open(info) as source:
                while True:
                    chunk = source.read(min(64 * 1024, limit - size + 1))
                    if not chunk:
                        break
                    size += len(chunk); expanded += len(chunk)
                    if size > limit or expanded > MAX_EXPANDED:
                        raise ValueError("MinerU ZIP exceeds read budget")
                    chunks.append(chunk)
            data = b"".join(chunks)
            if image:
                detected = image_type(data)
                if not detected:
                    warnings.append("Image omitted because its byte signature is not a supported raster format.")
                    continue
                if output is None:
                    warnings.append("Image bytes were not retained because no assets output directory was supplied.")
                    continue
                digest = hashlib.sha256(data).hexdigest()
                path = f"images/{digest}.{detected[1]}"
                paths[name] = path
                if digest not in written:
                    directory = output / "images"
                    directory.mkdir(exist_ok=True)
                    if directory.is_symlink() or not directory.is_dir():
                        raise ValueError("unsafe assets image directory")
                    with (output / path).open("xb") as destination:
                        destination.write(data)
                    written[digest] = path
                    assets.append({"path": path, "sha256": digest, "size_bytes": len(data), "mime_type": detected[0]})
            elif suffix == ".md":
                if markdown_path:
                    raise ValueError("ambiguous multiple MinerU Markdown files")
                markdown, markdown_path = data.decode("utf-8", errors="strict"), name
            else:
                value = json.loads(data)
                if not isinstance(value, list) or any(not isinstance(item, dict) for item in value):
                    raise ValueError("invalid MinerU content list")
                content_list = value
    def rewrite(match):
        prefix, reference, end = match.groups()
        decoded = unquote(reference)
        if urlsplit(decoded).scheme or decoded.startswith(("/", "\\")):
            return match.group(0)
        key = posixpath.normpath(posixpath.join(posixpath.dirname(markdown_path), decoded))
        path = paths.get(key) or paths.get(decoded)
        return prefix + path + end if path else match.group(0)
    # Inline Markdown, reference definitions and HTML image src; URLs are never fetched.
    markdown = re.sub(r'(\]\(<?)([^\s)>]+)(>?)(?=[\s)])', rewrite, markdown)
    markdown = re.sub(r'(?m)^(\s*\[[^]\n]+\]:\s*<?)([^\s>]+)(>?)', rewrite, markdown)
    markdown = re.sub(r'(?i)(<img\b[^>]*?\bsrc=[\"\'])([^\"\']+)([\"\'])', rewrite, markdown)
    return SimpleNamespace(state="done", task_id=task_id, markdown=markdown, content_list=content_list,
                           assets=assets, asset_warnings=list(dict.fromkeys(warnings)), zip_url=None)


def bounded_client_class(base):
    class BoundedMinerU(base):
        def _download_and_parse(self, result):
            self.mineru_task_id = result.task_id or None
            if self.assets_output is not None:
                request_path = self.assets_output / "mineru-request.json"
                if request_path.is_symlink():
                    raise ValueError("unsafe MinerU request manifest")
                # Persist the task identity before downloading: a failed result
                # transfer must not force a second OCR submission.
                with request_path.open("w", encoding="utf-8") as request:
                    json.dump({"mineru_batch_id": self.mineru_batch_id, "mineru_task_id": self.mineru_task_id}, request)
            return parse_safe_zip(download_zip(result.zip_url), self.assets_output, result.task_id)
    return BoundedMinerU



def extract_text_from_item(item: dict) -> str:
    """Extract text from a single MinerU content_list item."""
    text = item.get("text", "")
    if text:
        return text.strip()
    table_body = item.get("table_body", "")
    if table_body:
        return table_body.strip()
    code_body = item.get("code_body", "")
    if code_body:
        return code_body.strip()
    list_items = item.get("list_items", [])
    if list_items:
        return "\n".join(list_items).strip()
    return ""


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("filepath")
    parser.add_argument("--output-dir")
    args = parser.parse_args()
    api_key = os.environ.get("MINERU_API_KEY")
    if not api_key:
        print(json.dumps({"error": "MINERU_API_KEY is not configured"}))
        sys.exit(1)
    client, batch_id, task_id = None, None, None
    try:
        from mineru import MinerU
        output = safe_output(args.output_dir)
        client = bounded_client_class(MinerU)(token=api_key)
        client.assets_output = output
        # submit uses the same upload path as extract, while exposing recovery identity.
        batch_id = client.submit(args.filepath, model="vlm")
        client.mineru_batch_id = batch_id
        if output is not None:
            with (output / "mineru-request.json").open("x", encoding="utf-8") as request:
                json.dump({"mineru_batch_id": batch_id}, request)
        deadline, interval = time.monotonic() + 600, 2
        while True:
            results = client.get_batch(batch_id)
            if len(results) != 1:
                raise ValueError("MinerU single-file batch returned an unexpected result count")
            result = results[0]
            task_id = result.task_id or None
            if result.state == "failed":
                raise ValueError("MinerU extraction task failed")
            if result.state == "done":
                if not hasattr(result, "assets"):
                    raise ValueError("MinerU task completed without a downloadable result package")
                break
            if time.monotonic() >= deadline:
                raise TimeoutError("MinerU extraction timed out")
            time.sleep(min(interval, max(0, deadline - time.monotonic())))
            interval = min(interval * 2, 30)
        content_list = result.content_list or []
        markdown = result.markdown or ""
    except Exception as error:
        # SDK/http errors can contain signed URLs; do not expose exception text.
        task_id = task_id or getattr(client, "mineru_task_id", None)
        print(json.dumps({"error": "MinerU extraction failed: " + type(error).__name__, "mineru_batch_id": batch_id, "mineru_task_id": task_id}))
        sys.exit(1)
    finally:
        if client is not None:
            client.close()

    # Group items by page_idx
    by_page: dict = defaultdict(list)
    for item in content_list:
        page_idx = item.get("page_idx", 0)
        by_page[page_idx].append(item)

    pages = []
    for page_idx in sorted(by_page.keys()):
        items = by_page[page_idx]
        texts = [t for t in (extract_text_from_item(i) for i in items) if t]
        page_text = "\n".join(texts)
        pages.append({
            "page_idx": page_idx,
            "text": page_text,
            "tokens": len(page_text) // 4,
        })

    print(json.dumps({
        "source": "mineru",
        "pages": pages,
        "bookmarks": [],
        "markdown": markdown,
        "mineru_batch_id": batch_id,
        "mineru_task_id": task_id,
        "assets": result.assets,
        "asset_warnings": result.asset_warnings,
    }))


if __name__ == "__main__":
    main()
