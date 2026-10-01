"use client";

import { useState } from "react";
import Image from "next/image";
import { SignOutButton } from "@/components/SignOutButton";
import {
  CHIP_GROUPS,
  buildContext,
  type ChipGroupKey,
  type ChipSelections,
} from "@/lib/ask/context";

type Pick = {
  title_id: string;
  why_it_fits: string;
  name: string | null;
  poster_url: string | null;
  type: string | null;
  release_year: number | null;
};

export function AskClient({ userEmail }: { userEmail: string }) {
  const [text, setText] = useState("");
  const [chips, setChips] = useState<ChipSelections>({});
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [picks, setPicks] = useState<Pick[] | null>(null);

  const context = buildContext(chips, text);
  const canSubmit = context !== "" && !loading;

  function toggleChip(group: ChipGroupKey, option: string) {
    setChips((prev) => ({
      ...prev,
      [group]: prev[group] === option ? undefined : option,
    }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;

    setLoading(true);
    setErrorMessage(null);
    setPicks(null);

    try {
      const res = await fetch("/api/recommend", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ context }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(data?.error ?? `Request failed (${res.status})`);
      }
      setPicks(data.picks);
    } catch (err) {
      setErrorMessage(
        err instanceof Error ? err.message : "Something went wrong. Please try again."
      );
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex flex-1 flex-col">
      <div className="flex items-center justify-between px-6 py-4 text-xs text-zinc-500 dark:text-zinc-400">
        <span>{userEmail}</span>
        <SignOutButton />
      </div>
      <div className="mx-auto flex w-full max-w-xl flex-1 flex-col gap-8 px-6 py-10">
        <form onSubmit={handleSubmit} className="flex flex-col gap-6">
          <h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-50">
            What are you in the mood for?
          </h1>

          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={3}
            placeholder="Anything specific? e.g. something I can half-watch while doing homework"
            className="w-full rounded-lg border border-zinc-200 bg-transparent px-3 py-2 text-sm text-zinc-900 placeholder:text-zinc-400 focus:border-zinc-400 focus:outline-none dark:border-zinc-800 dark:text-zinc-50 dark:placeholder:text-zinc-600 dark:focus:border-zinc-600"
          />

          {CHIP_GROUPS.map((group) => (
            <div key={group.key} className="flex flex-col gap-2">
              <span className="text-xs font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                {group.label}
              </span>
              <div className="flex flex-wrap gap-2">
                {group.options.map((option) => {
                  const selected = chips[group.key] === option;
                  return (
                    <button
                      key={option}
                      type="button"
                      aria-pressed={selected}
                      onClick={() => toggleChip(group.key, option)}
                      className={
                        selected
                          ? "rounded-full border border-zinc-900 bg-zinc-900 px-3 py-1 text-sm text-white dark:border-zinc-50 dark:bg-zinc-50 dark:text-zinc-900"
                          : "rounded-full border border-zinc-200 px-3 py-1 text-sm text-zinc-900 transition-colors hover:bg-zinc-100 dark:border-zinc-800 dark:text-zinc-50 dark:hover:bg-zinc-900"
                      }
                    >
                      {option}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}

          <button
            type="submit"
            disabled={!canSubmit}
            className="rounded-lg bg-zinc-900 px-4 py-3 text-sm font-medium text-white transition-opacity disabled:opacity-40 dark:bg-zinc-50 dark:text-zinc-900"
          >
            {loading ? "Finding something good..." : "Get recommendations"}
          </button>

          {errorMessage && (
            <p className="text-sm text-red-600 dark:text-red-400">{errorMessage}</p>
          )}
        </form>

        {picks && (
          <ul className="flex flex-col gap-6">
            {picks.map((pick) => (
              <li key={pick.title_id} className="flex gap-4">
                {pick.poster_url && (
                  <Image
                    src={pick.poster_url}
                    alt={pick.name ?? ""}
                    width={80}
                    height={120}
                    className="h-[120px] w-[80px] shrink-0 rounded object-cover"
                  />
                )}
                <div className="flex flex-col gap-1">
                  <p className="font-medium text-zinc-900 dark:text-zinc-50">
                    {pick.name ?? "Unknown title"}
                    {pick.release_year && (
                      <span className="ml-2 text-sm font-normal text-zinc-500 dark:text-zinc-400">
                        {pick.release_year}
                      </span>
                    )}
                  </p>
                  <p className="text-sm text-zinc-600 dark:text-zinc-400">{pick.why_it_fits}</p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
