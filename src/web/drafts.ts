import { useEffect, useRef, useState } from "react";
import { localDraft } from "./api";

export type VersionedDraft = { requestId: string };

/** A response may clear only the exact draft version it submitted. */
export function sameSubmittedDraft<T extends VersionedDraft>(
  current: T,
  submitted: T,
) {
  return (
    current.requestId === submitted.requestId &&
    JSON.stringify(current) === JSON.stringify(submitted)
  );
}

/** Writes edits synchronously so navigation or a pending RPC cannot erase later text. */
export function usePersistentDraft<T extends VersionedDraft>(
  key: string,
  empty: () => T,
) {
  const [draft, setState] = useState<T>(() => localDraft(key, empty()));
  const current = useRef(draft);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const update = (value: T | ((previous: T) => T)) => {
    const next =
      typeof value === "function"
        ? (value as (previous: T) => T)(current.current)
        : value;
    current.current = next;
    localStorage.setItem(key, JSON.stringify(next));
    setState(next);
  };
  const clearSubmitted = (submitted: T) => {
    if (!mounted.current) return false;
    if (!sameSubmittedDraft(current.current, submitted)) return false;
    const stored = localDraft<T | null>(key, null);
    if (!stored || !sameSubmittedDraft(stored, submitted)) return false;
    update(empty());
    return true;
  };
  return { draft, update, current, clearSubmitted };
}

export type ExportParams = {
  scope: "all" | "course" | "knowledge" | "notes";
  ids: string[];
  share: boolean;
  redactions: string[];
};
export function normalizeExportParams(
  scope: ExportParams["scope"],
  rawIds: string,
  share: boolean,
  rawRedactions: string,
): ExportParams {
  const split = (value: string) => [
    ...new Set(
      value
        .split(/[\n,，]/)
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ];
  return {
    scope,
    ids: scope === "all" ? [] : split(rawIds),
    share,
    redactions: share ? split(rawRedactions) : [],
  };
}
