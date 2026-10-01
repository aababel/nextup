// Chip options for the /ask page and the function that turns the user's
// selections into the plain-text `context` string sent to POST /api/recommend.

export const CHIP_GROUPS = [
  {
    key: "mood",
    label: "Mood",
    options: ["Cozy", "Funny", "Emotional", "Thrilling", "Thought-provoking"],
  },
  {
    key: "time",
    label: "Time",
    options: ["Under 30 min", "About an hour", "A full movie", "Long binge"],
  },
  {
    key: "watching",
    label: "Watching",
    options: ["Alone", "With a partner", "With friends", "With family"],
  },
] as const;

export type ChipGroupKey = (typeof CHIP_GROUPS)[number]["key"];
export type ChipSelections = Partial<Record<ChipGroupKey, string>>;

// e.g. "Mood: cozy. Time: under 30 min. Watching: with friends. Also: <text>"
// Empty parts are skipped. The typed text is not quoted — the recommend
// prompt already quotes the whole context string.
export function buildContext(chips: ChipSelections, text: string): string {
  const parts: string[] = [];

  for (const group of CHIP_GROUPS) {
    const selected = chips[group.key];
    if (selected) {
      parts.push(`${group.label}: ${selected.toLowerCase()}.`);
    }
  }

  const typed = text.trim();
  if (typed) {
    // "Also:" only makes sense when it follows chip selections.
    parts.push(parts.length > 0 ? `Also: ${typed}` : typed);
  }

  return parts.join(" ");
}
