import { z } from "zod";

export const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
export const JEV_ROUTING_VERSION = "argon-memory-jev-routing/1";
export type JevQuestion = { type: "noul"; instructions: string; criteria: { true: string; false: string } };
export type JevEvaluation = { model: string; probabilities: Record<string, number>; input_tokens: number; output_tokens: number };
export interface JevEvaluator {
  evaluate(state: unknown, questions: Record<string, JevQuestion>): Promise<JevEvaluation>;
}

const responseSchema = z.object({
  model: z.string().regex(/^jev-[a-zA-Z0-9._-]+$/).max(100),
  answers: z.record(z.string(), z.object({ type: z.literal("noul"), noul: z.number().finite().min(0).max(1) })),
  usage: z.object({ input_tokens: z.number().int().nonnegative(), output_tokens: z.number().int().nonnegative() }),
});

// No caller-controlled endpoint, redirects, upstream error bodies or credentials
// in errors. The caller authorizes egress before constructing any model state.
export class JevHttpEvaluator implements JevEvaluator {
  constructor(private readonly apiKey: string, private readonly fetcher: typeof fetch = fetch) {}

  async evaluate(state: unknown, questions: Record<string, JevQuestion>): Promise<JevEvaluation> {
    if (!this.apiKey) throw new Error("jev_missing_key");
    const keys = Object.keys(questions);
    if (!keys.length || keys.length > 16) throw new Error("jev_question_budget");
    const body = JSON.stringify({ model: "jev-latest", state, questions });
    if (Buffer.byteLength(body) > 80_000) throw new Error("jev_request_budget");
    try {
      const response = await this.fetcher(JEV_ENDPOINT, {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(6_000),
        headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" }, body,
      });
      if (!response.ok) { await response.body?.cancel(); throw new Error(`jev_http_${response.status}`); }
      const reader = response.body?.getReader();
      if (!reader) throw new Error("jev_invalid_response");
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > 64_000) throw new Error("jev_response_budget");
          chunks.push(value);
        }
      } finally { await reader.cancel().catch(() => {}); }
      const parsed = responseSchema.safeParse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      if (!parsed.success || keys.some(key => !(key in parsed.data.answers)) || Object.keys(parsed.data.answers).some(key => !keys.includes(key))) {
        throw new Error("jev_invalid_response");
      }
      return {
        model: parsed.data.model,
        probabilities: Object.fromEntries(keys.map(key => [key, parsed.data.answers[key]!.noul])),
        ...parsed.data.usage,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (/^jev_(http_\d{3}|invalid_response|request_budget|response_budget)$/.test(message)) throw new Error(message);
      if (error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name)) throw new Error("jev_timeout");
      throw new Error("jev_unavailable");
    }
  }
}
