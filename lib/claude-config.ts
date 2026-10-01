const EFFORT_VALUES = ["low", "medium", "high"] as const;

export type Effort = (typeof EFFORT_VALUES)[number];

/**
 * Reads an effort level from an env var, falling back to the default if it's
 * unset or not one of low/medium/high.
 */
export function effortFromEnv(name: string, fallback: Effort): Effort {
  const value = process.env[name]?.trim().toLowerCase();
  if (!value) return fallback;
  if ((EFFORT_VALUES as readonly string[]).includes(value)) return value as Effort;
  console.warn(`[config] ${name}="${process.env[name]}" is not one of ${EFFORT_VALUES.join("/")}; using "${fallback}"`);
  return fallback;
}

export function modelFromEnv(name: string, fallback: string): string {
  return process.env[name]?.trim() || fallback;
}

/** Logs token usage for one Claude call so costs show up in the terminal. */
export function logUsage(
  label: string,
  model: string,
  usage: { input_tokens: number; output_tokens: number }
): void {
  console.log(`[${label}] model=${model} input_tokens=${usage.input_tokens} output_tokens=${usage.output_tokens}`);
}
