import Anthropic from "@anthropic-ai/sdk";
import { SYSTEM_PROMPT, formatSynthesisInput } from "./prompt";

export type QuizResponseInput = {
  title: string;
  genres: string[];
  keywords: string[];
  overview: string | null;
  release_year: number | null;
  response: string;
};

export type FramingAnswerInput = {
  question: string;
  answer: string;
};

export type TasteProfile = {
  favorite_genres: string[];
  favorite_eras: string[];
  preferred_tones: string[];
  preferred_themes: string[];
  pacing_preference: "slow_burn" | "brisk" | "variable" | "unclear";
  comfort_vs_challenge: "comfort" | "challenge" | "both" | "unclear";
  things_to_avoid: string[];
  confidence: "low" | "medium" | "high";
  summary: string;
};

export type SynthesisFailureReason =
  | "api_error"
  | "refusal"
  | "empty_response"
  | "invalid_json"
  | "invalid_shape";

export class SynthesisError extends Error {
  reason: SynthesisFailureReason;

  constructor(reason: SynthesisFailureReason, message: string) {
    super(message);
    this.name = "SynthesisError";
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

const PACING_VALUES = ["slow_burn", "brisk", "variable", "unclear"];
const COMFORT_VALUES = ["comfort", "challenge", "both", "unclear"];
const CONFIDENCE_VALUES = ["low", "medium", "high"];
const STRING_ARRAY_FIELDS = [
  "favorite_genres",
  "favorite_eras",
  "preferred_tones",
  "preferred_themes",
  "things_to_avoid",
] as const;

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

function validateShape(data: unknown): TasteProfile {
  if (typeof data !== "object" || data === null) {
    throw new SynthesisError("invalid_shape", "Response was not a JSON object");
  }
  const d = data as Record<string, unknown>;

  for (const field of STRING_ARRAY_FIELDS) {
    if (!isStringArray(d[field])) {
      throw new SynthesisError("invalid_shape", `Field "${field}" must be an array of strings`);
    }
  }
  if (!PACING_VALUES.includes(d.pacing_preference as string)) {
    throw new SynthesisError("invalid_shape", `Field "pacing_preference" had unexpected value: ${d.pacing_preference}`);
  }
  if (!COMFORT_VALUES.includes(d.comfort_vs_challenge as string)) {
    throw new SynthesisError("invalid_shape", `Field "comfort_vs_challenge" had unexpected value: ${d.comfort_vs_challenge}`);
  }
  if (!CONFIDENCE_VALUES.includes(d.confidence as string)) {
    throw new SynthesisError("invalid_shape", `Field "confidence" had unexpected value: ${d.confidence}`);
  }
  if (typeof d.summary !== "string" || d.summary.trim() === "") {
    throw new SynthesisError("invalid_shape", `Field "summary" must be a non-empty string`);
  }

  return d as unknown as TasteProfile;
}

/**
 * Calls Claude with the taste-profile synthesis prompt and returns the parsed,
 * shape-validated profile. Throws SynthesisError on any API, refusal, or
 * parsing/shape failure — callers decide how to surface that (HTTP status,
 * CLI message, etc).
 */
export async function synthesizeTasteProfile(
  quizResponses: QuizResponseInput[],
  framingAnswers: FramingAnswerInput[]
): Promise<TasteProfile> {
  const userMessage = formatSynthesisInput(quizResponses, framingAnswers);

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
    throw new SynthesisError("api_error", err instanceof Error ? err.message : String(err));
  }

  if (response.stop_reason === "refusal") {
    throw new SynthesisError("refusal", "Claude declined to synthesize a profile for this input");
  }

  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new SynthesisError("empty_response", "Claude response contained no text block");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripCodeFence(textBlock.text));
  } catch (err) {
    throw new SynthesisError(
      "invalid_json",
      `Claude response was not valid JSON: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  return validateShape(parsed);
}
