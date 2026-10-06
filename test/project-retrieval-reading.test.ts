import { describe, expect, test } from "vitest";
import { outlineText, readTextSlice } from "../src/project/retrieval/reading.js";

const resource = (text: string) => ({ uri: "kb://record/test", title: "Test", text });
function readAll(text: string, range: { start_line?: number; end_line?: number } = {}) {
  const source = resource(text); const chunks: string[] = []; let cursor: string | undefined; let calls = 0;
  do {
    const page = readTextSlice(source, { max_tokens: 100, ...(!cursor ? range : { cursor }) });
    expect(page.end_char).toBeGreaterThanOrEqual(page.start_char);
    expect(page.text).toBe(text.slice(page.start_char, page.end_char));
    expect(page.text).not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/u);
    chunks.push(page.text); cursor = page.next_cursor; calls++;
    expect(calls).toBeLessThan(100);
  } while (cursor);
  return chunks.join("");
}

describe("Revision-bound reading and outline", () => {
  test("outline spans nested headings until the next peer or ancestor, including the last leaf", () => {
    const text = "# A\nbody\n## B\nbody\n### C\nbody\n## D\nbody\n# E\nlast";
    expect(outlineText(text).headings).toEqual([
      { title: "A", level: 1, start_line: 1, end_line: 8 },
      { title: "B", level: 2, start_line: 3, end_line: 6 },
      { title: "C", level: 3, start_line: 5, end_line: 6 },
      { title: "D", level: 2, start_line: 7, end_line: 8 },
      { title: "E", level: 1, start_line: 9, end_line: 10 },
    ]);
    expect(outlineText("没有标题\n最后一行")).toMatchObject({ total_lines: 2, headings: [] });
  });

  test.each([
    `${"a".repeat(199)}😀${"单行中文🌉e\u0301".repeat(300)}`,
    `# 标题\n${"第一行😀\n第二行🌉\n".repeat(200)}结尾\n`,
    "",
  ])("cursor pages concatenate to the original bytes and never split surrogate pairs %#", text => {
    expect(readAll(text)).toBe(text);
  });

  test("range continuation stays within the requested lines even with a long Unicode line", () => {
    const lines = ["before", "before too", "😀中文".repeat(500), "fourth", "fifth", "after"];
    const text = lines.join("\n");
    expect(readAll(text, { start_line: 3, end_line: 5 })).toBe(`${lines.slice(2, 5).join("\n")}\n`);
    expect(readAll(text, { start_line: 6, end_line: 6 })).toBe("after");
  });

  test("rejects stale, cross-resource and tampered cursors", () => {
    const source = resource("长文本".repeat(300));
    const page = readTextSlice(source, { max_tokens: 100 });
    expect(page.next_cursor).toBeTruthy();
    expect(() => readTextSlice({ ...source, text: `${source.text} changed` }, { cursor: page.next_cursor })).toThrow("stale");
    expect(() => readTextSlice({ ...source, uri: "kb://record/other" }, { cursor: page.next_cursor })).toThrow("another resource");
    const decoded = JSON.parse(Buffer.from(page.next_cursor!, "base64url").toString("utf8"));
    const invalid = Buffer.from(JSON.stringify({ ...decoded, offset: source.text.length + 1 })).toString("base64url");
    expect(() => readTextSlice(source, { cursor: invalid })).toThrow("range");
    expect(() => readTextSlice(source, { start_line: 2, end_line: 1 })).toThrow("range");
  });
});
