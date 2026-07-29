export type FramingQuestion = {
  key: string;
  prompt: string;
  choices: string[];
};

export const FRAMING_QUESTIONS: FramingQuestion[] = [
  {
    key: "comfort_vs_challenge",
    prompt: "Do you prefer being comforted or challenged by what you watch?",
    choices: ["Comforted", "Challenged", "Depends on my mood"],
  },
  {
    key: "pace",
    prompt: "Fast-paced or slow-burn?",
    choices: ["Fast-paced", "Slow-burn", "Either works"],
  },
  {
    key: "rewatch",
    prompt: "Do you rewatch favorites often, or always want something new?",
    choices: ["I rewatch a lot", "Always something new", "A mix of both"],
  },
  {
    key: "watch_with",
    prompt: "Do you watch mostly alone, or with others?",
    choices: ["Mostly alone", "Mostly with others", "About even"],
  },
];
