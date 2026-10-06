import { createHash } from "node:crypto";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
export function outlineText(text: string) {
  const lines = text.split("\n");
  const headings = lines.flatMap((line, index) => {
    const match = /^(#{1,6})\s+(.+)/.exec(line);
    return match ? [{ title: match[2]!, level: match[1]!.length, start_line: index + 1 }] : [];
  });
  return { revision: hash(text), total_lines: lines.length, headings: headings.map((heading, index) => ({ ...heading,
    end_line: headings.slice(index + 1).find(next => next.level <= heading.level)?.start_line! - 1 || lines.length })) };
}

export function readTextSlice(resource: { uri: string; title: string; text: string }, input: { max_tokens?: number; start_line?: number; end_line?: number; cursor?: string }) {
  const revision = hash(resource.text);
  const binding = hash(resource.uri);
  const maxChars = Math.max(100, Math.min(input.max_tokens ?? 800, 4000)) * 2;
  let start = 0;
  let stop = resource.text.length;
  if (input.cursor) {
    let parsed: { revision: string; binding: string; offset: number; stop: number };
    try { parsed = JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8")); } catch { throw new Error("Invalid read cursor"); }
    if (parsed.revision !== revision || parsed.binding !== binding) throw new Error("Read cursor is stale or belongs to another resource; reopen its outline");
    if (!Number.isSafeInteger(parsed.offset) || !Number.isSafeInteger(parsed.stop) || parsed.offset < 0 || parsed.stop > resource.text.length || parsed.stop < parsed.offset) throw new Error("Invalid read cursor range");
    start = parsed.offset; stop = parsed.stop;
  } else if (input.start_line !== undefined || input.end_line !== undefined) {
    const lines = resource.text.split("\n");
    const first = input.start_line ?? 1;
    const last = input.end_line ?? lines.length;
    if (!Number.isInteger(first) || !Number.isInteger(last) || first < 1 || last < first || first > lines.length) throw new Error("Invalid line range");
    start = lines.slice(0, first - 1).reduce((n, line) => n + line.length + 1, 0);
    stop = Math.min(resource.text.length, lines.slice(0, last).reduce((n, line) => n + line.length + 1, 0));
  }
  let end = Math.min(stop, start + maxChars);
  // Avoid splitting UTF-16 surrogate pairs when continuing long lines.
  if (end < stop && /[\uD800-\uDBFF]/.test(resource.text.charAt(end - 1))) end--;
  const truncated = end < stop;
  return { uri: resource.uri, title: resource.title, revision, text: resource.text.slice(start, end),
    start_char: start, end_char: end, total_characters: resource.text.length,
    start_line: resource.text.slice(0, start).split("\n").length,
    end_line: resource.text.slice(0, end).split("\n").length,
    truncated, ...(truncated ? { next_cursor: Buffer.from(JSON.stringify({ revision, binding, offset: end, stop })).toString("base64url") } : {}) };
}
