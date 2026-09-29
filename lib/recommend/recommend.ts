import Anthropic from "@anthropic-ai/sdk";
import { SYSTEM_PROMPT, formatRecommendInput } from "./prompt";
import type { Candidate } from "./candidates";
import type { TasteProfile } from "@/lib/taste-profile/synthesize";

export type Pick = {
  title_id: string;
  why_it_fits: string;
};

export type PassedOver = {
  title_id: string;
  why_not: string;
};

export type RecommendationResult = {
  picks: Pick[];
  passed_over: PassedOver[];
};

export type RecommendFailureReason =
  | "api_error"
  | "refusal"
  | "empty_response"
  | "invalid_json"
  | "invalid_shape"
  | "unknown_title";

export class RecommendError extends Error {
  reason: RecommendFailureReason;

  constructor(reason: RecommendFailureReason, message: string) {
    super(message);
    this.name = "RecommendError";
    this.reason = reason;
  }
}

const MODEL = "claude-opus-4-8";

// A model instructed to "return ONLY valid JSON" will still occasionally wrap
// the object in a ```json fence — strip one if present before parsing.
function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return fenced ? fenced[1] : trimmed;
}

function isPick(value: unknown): value is Pick {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.title_id === "string" && typeof v.why_it_fits === "string";
}

function isPassedOver(value: unknown): value is PassedOver {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.title_id === "string" && typeof v.why_not === "string";
}

/**
 * Validates the shape of Claude's response and, critically, that every
 * title_id it returned is actually in the candidate set it was given — the
 * hallucination guard. Throws RecommendError on any failure.
 */
function validateShape(data: unknown, candidateIds: Set<string>): RecommendationResult {
  if (typeof data !== "object" || data === null) {
    throw new RecommendError("invalid_shape", "Response was not a JSON object");
  }
  const d = data as Record<string, unknown>;

  if (!Array.isArray(d.picks) || !d.picks.every(isPick)) {
    throw new RecommendError("invalid_shape", `Field "picks" must be an array of { title_id, why_it_fits }`);
  }
  if (d.picks.length < 2 || d.picks.length > 3) {
    throw new RecommendError("invalid_shape", `Field "picks" must contain 2-3 items, got ${d.picks.length}`);
  }

  let passedOver: PassedOver[] = [];
  if (d.passed_over !== undefined) {
    if (!Array.isArray(d.passed_over) || !d.passed_over.every(isPassedOver)) {
      throw new RecommendError("invalid_shape", `Field "passed_over" must be an array of { title_id, why_not }`);
    }
    if (d.passed_over.length > 2) {
      throw new RecommendError("invalid_shape", `Field "passed_over" must contain 0-2 items, got ${d.passed_over.length}`);
    }
    passedOver = d.passed_over;
  }

  const picks = d.picks as Pick[];
  for (const { title_id } of [...picks, ...passedOver]) {
    if (!candidateIds.has(title_id)) {
      throw new RecommendError("unknown_title", `Claude returned a title_id not in the candidate set: ${title_id}`);
    }
  }

  return { picks, passed_over: passedOver };
}

/**
 * Calls Claude with the recommendation prompt and returns the parsed,
 * shape-validated (and hallucination-checked) result. Throws RecommendError
 * on any API, refusal, or parsing/shape failure — callers decide how to
 * surface that (HTTP status, CLI message, etc).
 */
export async function getRecommendations(
  profile: TasteProfile,
  context: string,
  candidates: Candidate[]
): Promise<RecommendationResult> {
  const candidateIds = new Set(candidates.map((c) => c.id));
  const userMessage = formatRecommendInput(profile, context, candidates);

  let response;
  try {
    const anthropic = new Anthropic();
    response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 4096,
      thinking: { type: "adaptive" },
      output_config: { effort: "high" },
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userMessage }],
    });
  } catch (err) {
    throw new RecommendError("api_error", err instanceof Error ? err.message : String(err));
  }

  if (response.stop_reason === "refusal") {
    throw new RecommendError("refusal", "Claude declined to generate recommendations for this input");
  }

  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new RecommendError("empty_response", "Claude response contained no text block");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripCodeFence(textBlock.text));
  } catch (err) {
    throw new RecommendError(
      "invalid_json",
      `Claude response was not valid JSON: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  return validateShape(parsed, candidateIds);
}
