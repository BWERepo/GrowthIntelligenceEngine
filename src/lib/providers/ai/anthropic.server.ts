// Classification through the Claude API. The model gets no tools, so text in a
// fetched page cannot make it do anything; its answer is constrained to the
// Zod schema by structured outputs and then checked again in code.
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { ClassificationOutput, SYSTEM_PROMPT } from "@/lib/discovery/classification";

export type ClassifyModel = "claude-opus-5-5" | "claude-haiku-5-5";

// List prices per million tokens (input, output), checked 2026-11-14.
// Haiku 5.5's price applies to prompts up to 100K tokens; page text is capped well below that.
const PRICES: Record<string, { input: number; output: number }> = {
  "claude-opus-5-5": { input: 4, output: 20 },
  "claude-opus-4-8": { input: 5, output: 25 }, // possible server-side fallback model
  "claude-opus-5": { input: 5, output: 25 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5 },
};

export function estimateCostUsd(model: string, inputTokens: number, outputTokens: number): number {
  const p = PRICES[model] ?? PRICES["claude-opus-5-5"]!; // unknown model: price as the default, never as free
  return Math.round(((inputTokens * p.input + outputTokens * p.output) / 1_000_000) * 1_000_000) / 1_000_000;
}

/** Upper-bound estimate checked against the budget before a call is made. */
export function worstCaseCostUsd(model: ClassifyModel, promptChars: number, maxTokens = MAX_TOKENS): number {
  return estimateCostUsd(model, Math.ceil(promptChars / 3) + 1_500, maxTokens);
}

const MAX_TOKENS = 4_000;

export type ClassifyResult =
  | { kind: "answer"; output: unknown; model: string; inputTokens: number; outputTokens: number; requestId: string | null }
  | { kind: "refused"; model: string; inputTokens: number; outputTokens: number; requestId: string | null; detail: string }
  | { kind: "error"; detail: string; retryable: boolean };

export async function classifyPage(apiKey: string, model: ClassifyModel, userPrompt: string): Promise<ClassifyResult> {
  const client = new Anthropic({ apiKey, maxRetries: 2, timeout: 120_000 });
  try {
    const response = await client.beta.messages.parse({
      model,
      max_tokens: MAX_TOKENS,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userPrompt }],
      // Low effort: this is extraction, not open-ended reasoning.
      output_config: { effort: "low", format: betaZodOutputFormat(ClassificationOutput) },
      // On Opus, a safety decline is retried server-side on a fallback model.
      // Haiku has no server-side fallback, so a decline simply rejects the candidate.
      ...(model === "claude-opus-5-5" ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
    });
    const usage = { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens };
    const requestId = response._request_id ?? null;
    if (response.stop_reason === "refusal") {
      return { kind: "refused", model: response.model, ...usage, requestId, detail: response.stop_details?.category ?? "declined" };
    }
    if (response.stop_reason === "max_tokens") {
      return { kind: "answer", output: null, model: response.model, ...usage, requestId };
    }
    // parsed_output is null when the text did not parse; the checker then rejects it as schema_invalid.
    return { kind: "answer", output: response.parsed_output ?? null, model: response.model, ...usage, requestId };
  } catch (error) {
    if (error instanceof Anthropic.RateLimitError) return { kind: "error", detail: "rate limited", retryable: true };
    if (error instanceof Anthropic.InternalServerError) return { kind: "error", detail: `server error ${error.status}`, retryable: true };
    if (error instanceof Anthropic.APIConnectionError) return { kind: "error", detail: "connection failed", retryable: true };
    if (error instanceof Anthropic.AuthenticationError) return { kind: "error", detail: "API key rejected", retryable: false };
    if (error instanceof Anthropic.APIError) return { kind: "error", detail: `API error ${error.status ?? ""}`.trim(), retryable: false };
    return { kind: "error", detail: error instanceof Error ? error.message.slice(0, 200) : "unknown error", retryable: false };
  }
}
