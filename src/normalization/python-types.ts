import { z } from "zod";

export const MinerUExtractionResultSchema = z.object({
  error: z.string().optional(),
  source: z.literal("mineru").optional(),
  pages: z.array(z.object({
    page_idx: z.number().int().nonnegative(),
    text: z.string(),
    tokens: z.number().int().nonnegative().optional(),
  })).optional(),
  bookmarks: z.array(z.object({
    level: z.number().int(),
    title: z.string(),
    page: z.number().int(),
  })).optional(),
  markdown: z.string().optional(),
});

export type MinerUExtractionResult = z.infer<typeof MinerUExtractionResultSchema>;

export function parseMinerUResult(data: unknown): MinerUExtractionResult {
  const result = MinerUExtractionResultSchema.safeParse(data);
  if (!result.success) {
    const details = result.error.issues.map(issue => `${issue.path.join(".")}: ${issue.message}`).join("; ");
    throw new Error(`Invalid MinerU extractor output: ${details}`);
  }
  return result.data;
}
