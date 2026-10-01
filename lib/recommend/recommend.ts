import Anthropic from "@anthropic-ai/sdk";
import { SYSTEM_PROMPT, buildCandidateRefMap, formatRecommendInput } from "./prompt";
import type { Candidate } from "./candidates";
import type { TasteProfile } from "@/lib/taste-profile/synthesize";
import { effortFromEnv, logUsage, modelFromEnv, thinkingFromEnv } from "@/lib/claude-config";

export type Pick = {
  title_id: string;
  why_it_fits: string;
};

export type PassedOver = {
  title_id: string;
  why_not: string;
};

// What Claude returns: candidates are identified by their prompt ref, not
// their title_id. validateShape maps these back to Pick / PassedOver.
type RawPick = {
  ref: number;
  name: string;
  why_it_fits: string;
};

type RawPassedOver = {
  ref: number;
  name: string;
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
  | "unknown_title"
  | "mismatched_title";

export class RecommendError extends Error {
  reason: RecommendFailureReason;

  constructor(reason: RecommendFailureReason, message: string) {
    super(message);
    this.name = "RecommendError";
    this.reason = reason;
  }
}

const MODEL = modelFromEnv("RECOMMEND_MODEL", "claude-opus-4-8");
const EFFORT = effortFromEnv("RECOMMEND_EFFORT", "high");
const THINKING = thinkingFromEnv("RECOMMEND_THINKING", "adaptive");

// A model instructed to "return ONLY valid JSON" will still occasionally wrap
// the object in a ```json fence — strip one if present before parsing.
function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return fenced ? fenced[1] : trimmed;
}

function isRawPick(value: unknown): value is RawPick {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    Number.isInteger(v.ref) &&
    typeof v.name === "string" &&
    typeof v.why_it_fits === "string"
  );
}

function isRawPassedOver(value: unknown): value is RawPassedOver {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    Number.isInteger(v.ref) &&
    typeof v.name === "string" &&
    typeof v.why_not === "string"
  );
}

function normalizeName(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * Resolves a ref Claude returned to its candidate. The ref must exist (the
 * hallucination guard), and the name Claude echoed back must match that
 * candidate's name — catches the model attaching an explanation written for
 * one title to a different, also-valid ref.
 */
function resolveRef(
  { ref, name }: { ref: number; name: string },
  candidateByRef: Map<number, Candidate>
): Candidate {
  const candidate = candidateByRef.get(ref);
  if (!candidate) {
    throw new RecommendError("unknown_title", `Claude returned a ref not in the candidate set: ${ref}`);
  }
  if (normalizeName(name) !== normalizeName(candidate.name)) {
    throw new RecommendError(
      "mismatched_title",
      `Claude returned ref ${ref} with name "${name}", but that ref is "${candidate.name}"`
    );
  }
  return candidate;
}

/**
 * Validates the shape of Claude's response, checks every ref against the
 * candidate set (see resolveRef), and maps refs back to real title_ids.
 * Throws RecommendError on any failure.
 */
function validateShape(data: unknown, candidateByRef: Map<number, Candidate>): RecommendationResult {
  if (typeof data !== "object" || data === null) {
    throw new RecommendError("invalid_shape", "Response was not a JSON object");
  }
  const d = data as Record<string, unknown>;

  if (!Array.isArray(d.picks) || !d.picks.every(isRawPick)) {
    throw new RecommendError("invalid_shape", `Field "picks" must be an array of { ref, name, why_it_fits }`);
  }
  if (d.picks.length < 2 || d.picks.length > 3) {
    throw new RecommendError("invalid_shape", `Field "picks" must contain 2-3 items, got ${d.picks.length}`);
  }

  let rawPassedOver: RawPassedOver[] = [];
  if (d.passed_over !== undefined) {
    if (!Array.isArray(d.passed_over) || !d.passed_over.every(isRawPassedOver)) {
      throw new RecommendError("invalid_shape", `Field "passed_over" must be an array of { ref, name, why_not }`);
    }
    if (d.passed_over.length > 2) {
      throw new RecommendError("invalid_shape", `Field "passed_over" must contain 0-2 items, got ${d.passed_over.length}`);
    }
    rawPassedOver = d.passed_over;
  }

  const picks: Pick[] = (d.picks as RawPick[]).map((raw) => ({
    title_id: resolveRef(raw, candidateByRef).id,
    why_it_fits: raw.why_it_fits,
  }));
  const passedOver: PassedOver[] = rawPassedOver.map((raw) => ({
    title_id: resolveRef(raw, candidateByRef).id,
    why_not: raw.why_not,
  }));

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
  const candidateByRef = buildCandidateRefMap(candidates);
  const userMessage = formatRecommendInput(profile, context, candidates);

  let response;
  try {
    const anthropic = new Anthropic();
    response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 4096,
      // Smaller models (e.g. Haiku) reject adaptive thinking and effort, so
      // "off" omits both params entirely.
      ...(THINKING === "adaptive" && {
        thinking: { type: "adaptive" },
        output_config: { effort: EFFORT },
      }),
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userMessage }],
    });
  } catch (err) {
    throw new RecommendError("api_error", err instanceof Error ? err.message : String(err));
  }

  logUsage("recommend", MODEL, THINKING, response.usage);

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

  return validateShape(parsed, candidateByRef);
}
