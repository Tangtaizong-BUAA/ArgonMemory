import { createHash } from "node:crypto";
import { PROTECTED_BLOCK, type MutableDocumentBlock } from "./contracts.js";

type Heading = { index: number; end: number; level: number; title: string };
const digest = (text: string) => createHash("sha256").update(text).digest("hex");

function headingsOf(body: string, requireClosedFence = false): Heading[] {
  const lines = body.split("\n"), headings: Heading[] = [];
  let fence: { char: string; length: number } | undefined;
  for (const [index, line] of lines.entries()) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) {
      if (!fence) fence = { char: marker[0]!, length: marker.length };
      else if (marker[0] === fence.char && marker.length >= fence.length) fence = undefined;
      continue;
    }
    if (fence) continue;
    const match = /^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (match) headings.push({ index, end: lines.length, level: match[1]!.length, title: match[2]! });
  }
  if (requireClosedFence && fence) throw new Error("Maintenance replacement has an unclosed code fence");
  for (const [index, heading] of headings.entries()) heading.end = headings.slice(index + 1).find(next => next.level <= heading.level)?.index ?? lines.length;
  return headings;
}

function safeHeading(body: string, blockKey: string): Heading {
  if (!blockKey.startsWith("heading:")) throw new Error("Maintenance accepts only routed heading blocks");
  const headings = headingsOf(body), title = blockKey.slice("heading:".length);
  const matches = headings.filter(heading => heading.title === title);
  if (matches.length !== 1) throw new Error(`Stable heading block is missing or ambiguous: ${blockKey}`);
  const heading = matches[0]!;
  // A title or parent heading must not become a whole-document/conflict edit.
  if (heading.level === 1 || headings.some(child => child.index >= heading.index && child.index < heading.end && PROTECTED_BLOCK.test(child.title))) throw new Error("Maintenance block includes protected document content");
  return heading;
}

export function mutableHeadingBlocks(body: string, targetRef: string, expectedRevision: string): Array<{ capability: MutableDocumentBlock; content: string; title: string }> {
  const blocks: ReturnType<typeof mutableHeadingBlocks> = [];
  for (const heading of headingsOf(body)) {
    const blockKey = `heading:${heading.title}`;
    if (blockKey.length > 160) continue;
    try {
      const safe = safeHeading(body, blockKey);
      const content = body.split("\n").slice(safe.index + 1, safe.end).join("\n").trim();
      if (!content || content.length > 2500) continue;
      blocks.push({ title: heading.title, content, capability: { target_ref: targetRef, expected_revision: expectedRevision, block_key: blockKey, previous_block_hash: digest(content) } });
    } catch { /* Protected and ambiguous headings are not write capabilities. */ }
  }
  return blocks;
}

export function patchMutableHeading(body: string, block: MutableDocumentBlock, replacement: string): string {
  const heading = safeHeading(body, block.block_key), lines = body.split("\n");
  if (digest(lines.slice(heading.index + 1, heading.end).join("\n").trim()) !== block.previous_block_hash) throw new Error("Maintenance document block hash conflict");
  if (/<\/?[A-Za-z!]|^ {0,3}(?:=+|-+)\s*$/m.test(replacement) || headingsOf(replacement, true).some(child => child.level <= heading.level || PROTECTED_BLOCK.test(child.title))) throw new Error("Maintenance replacement escapes its heading or introduces protected content");
  return [...lines.slice(0, heading.index + 1), "", replacement.trim(), "", ...lines.slice(heading.end)].join("\n");
}

export function renderMutableBlock(block: { capability: MutableDocumentBlock; content: string }): string {
  const capability = block.capability;
  return `## Mutable document block\ntarget_ref: ${capability.target_ref}\nexpected_revision: ${capability.expected_revision}\nblock_key: ${capability.block_key}\nprevious_block_hash: ${capability.previous_block_hash}\n\n${block.content}`;
}
