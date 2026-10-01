"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import Link from "next/link";
import { SignOutButton } from "@/components/SignOutButton";
import type { FramingQuestion } from "@/lib/quiz/framing-questions";
import {
  submitFramingResponse,
  submitTitleResponse,
  type TitleResponseValue,
} from "./actions";

type Title = {
  id: string;
  name: string;
  release_year: number | null;
  poster_url: string | null;
};

const TITLE_RESPONSES: { value: TitleResponseValue; label: string }[] = [
  { value: "loved", label: "Loved it" },
  { value: "liked", label: "Liked it" },
  { value: "meh", label: "Not for me" },
  { value: "havent_seen", label: "Haven't seen it" },
];

type Phase = "titles" | "framing" | "building" | "error" | "done";

function initialPhase(titles: Title[], framingQuestions: FramingQuestion[]): Phase {
  if (titles.length > 0) return "titles";
  if (framingQuestions.length > 0) return "framing";
  return "done";
}

export function QuizClient({
  titles,
  framingQuestions,
  userEmail,
}: {
  titles: Title[];
  framingQuestions: FramingQuestion[];
  userEmail: string;
}) {
  const [phase, setPhase] = useState<Phase>(() =>
    initialPhase(titles, framingQuestions)
  );
  const [titleIndex, setTitleIndex] = useState(0);
  const [framingIndex, setFramingIndex] = useState(0);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const router = useRouter();

  // Answers are saved in the background so the quiz never waits on the
  // network between cards. Every save is tracked here so finishing the quiz
  // can wait for all of them, and any that failed can be retried.
  const pendingSaves = useRef<Promise<void>[]>([]);
  const failedSaves = useRef<(() => Promise<void>)[]>([]);
  // Guards the finish → build-profile flow against double clicks, which can
  // land before React re-renders and disables the buttons.
  const finishing = useRef(false);

  function save(label: string, run: () => Promise<void>) {
    pendingSaves.current.push(
      run().catch((err) => {
        console.error(`Failed to save ${label}`, err);
        failedSaves.current.push(run);
      })
    );
  }

  async function finishQuiz() {
    if (finishing.current) return;
    finishing.current = true;
    setPhase("building");
    setErrorMessage(null);

    await Promise.all(pendingSaves.current);
    pendingSaves.current = [];

    // Only resubmit answers that actually failed; everything else is saved.
    const failed = failedSaves.current;
    failedSaves.current = [];
    for (const run of failed) {
      try {
        await run();
      } catch (err) {
        console.error("Retrying save failed", err);
        failedSaves.current.push(run);
      }
    }
    if (failedSaves.current.length > 0) {
      showError("Some of your answers couldn't be saved.");
      return;
    }

    try {
      const res = await fetch("/api/taste-profile", { method: "POST" });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error ?? `Request failed (${res.status})`);
      }
    } catch (err) {
      console.error("Taste profile generation failed", err);
      showError("We couldn't build your taste profile.");
      return;
    }

    // Leave `finishing` set: the loading state stays up until /ask renders.
    router.push("/ask");
  }

  function showError(message: string) {
    setErrorMessage(message);
    setPhase("error");
    finishing.current = false;
  }

  function handleTitleResponse(response: TitleResponseValue) {
    const title = titles[titleIndex];
    save("title response", () => submitTitleResponse(title.id, response));

    const nextIndex = titleIndex + 1;
    if (nextIndex < titles.length) {
      setTitleIndex(nextIndex);
    } else if (framingQuestions.length > 0) {
      setPhase("framing");
    } else {
      finishQuiz();
    }
  }

  function handleFramingResponse(choice: string) {
    if (finishing.current) return;
    const question = framingQuestions[framingIndex];
    save("framing response", () => submitFramingResponse(question.key, choice));

    const nextIndex = framingIndex + 1;
    if (nextIndex < framingQuestions.length) {
      setFramingIndex(nextIndex);
    } else {
      finishQuiz();
    }
  }

  return (
    <div className="flex flex-1 flex-col">
      <Header userEmail={userEmail} />
      {phase === "done" && <DoneScreen />}
      {phase === "building" && <BuildingScreen />}
      {phase === "error" && (
        <ErrorScreen message={errorMessage} onRetry={finishQuiz} />
      )}
      {phase === "framing" && (
        <FramingCard
          question={framingQuestions[framingIndex]}
          progress={{ current: framingIndex + 1, total: framingQuestions.length }}
          onAnswer={handleFramingResponse}
        />
      )}
      {phase === "titles" && (
        <TitleCard
          title={titles[titleIndex]}
          progress={{ current: titleIndex + 1, total: titles.length }}
          onAnswer={handleTitleResponse}
        />
      )}
    </div>
  );
}

function Header({ userEmail }: { userEmail: string }) {
  return (
    <div className="flex items-center justify-between px-6 py-4 text-xs text-zinc-500 dark:text-zinc-400">
      <span>{userEmail}</span>
      <SignOutButton />
    </div>
  );
}

function Progress({ current, total }: { current: number; total: number }) {
  return (
    <div className="w-full max-w-sm">
      <div className="mb-2 text-center text-sm text-zinc-500 dark:text-zinc-400">
        {current} / {total}
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
        <div
          className="h-full rounded-full bg-zinc-900 transition-all dark:bg-zinc-50"
          style={{ width: `${(current / total) * 100}%` }}
        />
      </div>
    </div>
  );
}

function TitleCard({
  title,
  progress,
  onAnswer,
}: {
  title: Title;
  progress: { current: number; total: number };
  onAnswer: (response: TitleResponseValue) => void;
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-6 px-6 py-10">
      <Progress {...progress} />

      <div className="relative aspect-[2/3] w-full max-w-xs overflow-hidden rounded-xl bg-zinc-100 shadow-sm dark:bg-zinc-900">
        {title.poster_url ? (
          <Image
            key={title.id}
            src={title.poster_url}
            alt={title.name}
            fill
            sizes="320px"
            className="object-cover"
            priority
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center p-4 text-center text-sm text-zinc-400 dark:text-zinc-600">
            {title.name}
          </div>
        )}
      </div>

      <div className="text-center">
        <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-50">
          {title.name}
        </h1>
        {title.release_year && (
          <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
            {title.release_year}
          </p>
        )}
      </div>

      <div className="grid w-full max-w-sm grid-cols-2 gap-3">
        {TITLE_RESPONSES.map((option) => (
          <button
            key={option.value}
            onClick={() => onAnswer(option.value)}
            className="rounded-lg border border-zinc-200 px-4 py-3 text-sm font-medium text-zinc-900 transition-colors hover:bg-zinc-100 dark:border-zinc-800 dark:text-zinc-50 dark:hover:bg-zinc-900"
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function FramingCard({
  question,
  progress,
  onAnswer,
}: {
  question: FramingQuestion;
  progress: { current: number; total: number };
  onAnswer: (choice: string) => void;
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-8 px-6 py-10">
      <Progress {...progress} />

      <h1 className="max-w-sm text-center text-xl font-semibold text-zinc-900 dark:text-zinc-50">
        {question.prompt}
      </h1>

      <div className="flex w-full max-w-sm flex-col gap-3">
        {question.choices.map((choice) => (
          <button
            key={choice}
            onClick={() => onAnswer(choice)}
            className="rounded-lg border border-zinc-200 px-4 py-3 text-sm font-medium text-zinc-900 transition-colors hover:bg-zinc-100 dark:border-zinc-800 dark:text-zinc-50 dark:hover:bg-zinc-900"
          >
            {choice}
          </button>
        ))}
      </div>
    </div>
  );
}

function BuildingScreen() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-6 py-10 text-center">
      <p className="text-sm text-zinc-500 dark:text-zinc-400">
        Building your taste profile...
      </p>
    </div>
  );
}

function ErrorScreen({
  message,
  onRetry,
}: {
  message: string | null;
  onRetry: () => void;
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 px-6 py-10 text-center">
      <p className="text-sm text-zinc-900 dark:text-zinc-50">
        {message ?? "Something went wrong."}
      </p>
      <button
        onClick={onRetry}
        className="rounded-lg border border-zinc-200 px-4 py-2 text-sm font-medium text-zinc-900 transition-colors hover:bg-zinc-100 dark:border-zinc-800 dark:text-zinc-50 dark:hover:bg-zinc-900"
      >
        Try again
      </button>
    </div>
  );
}

function DoneScreen() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 py-10 text-center">
      <h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-50">
        You&apos;re all set
      </h1>
      <p className="max-w-sm text-sm text-zinc-500 dark:text-zinc-400">
        Thanks for taking the quiz — we&apos;ve got what we need to start
        building your taste profile.
      </p>
      <Link
        href="/"
        className="mt-4 text-sm font-medium text-zinc-900 underline dark:text-zinc-50"
      >
        Back home
      </Link>
    </div>
  );
}
