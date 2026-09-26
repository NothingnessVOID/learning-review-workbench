import type { Note, Review } from "./types";

export type NoteTimelineItem =
  | {
      kind: "review";
      id: string;
      effective_at: string | null;
      time_source: "created_at";
      value: Review;
    }
  | {
      kind: "followup";
      id: string;
      effective_at: string | null;
      time_source: "occurred_at" | "created_at" | "missing";
      value: Note;
    };

/** Date-bearing entries are chronological; undated entries stay last with a stable key. */
export function noteTimeline(
  note: Pick<Note, "reviews" | "followups">,
): NoteTimelineItem[] {
  const entries: NoteTimelineItem[] = [
    ...(note.reviews || []).map((value): NoteTimelineItem => ({
      kind: "review",
      id: value.id,
      effective_at: value.created_at || null,
      time_source: "created_at",
      value,
    })),
    ...(note.followups || []).map((value): NoteTimelineItem => ({
      kind: "followup",
      id: value.id,
      effective_at: value.occurred_at || value.created_at || null,
      time_source: value.occurred_at
        ? "occurred_at"
        : value.created_at
          ? "created_at"
          : "missing",
      value,
    })),
  ];
  return entries.sort((a, b) => {
    const aTime = a.effective_at ? Date.parse(a.effective_at) : NaN;
    const bTime = b.effective_at ? Date.parse(b.effective_at) : NaN;
    const aValid = Number.isFinite(aTime);
    const bValid = Number.isFinite(bTime);
    if (aValid !== bValid) return aValid ? -1 : 1;
    if (aValid && bValid && aTime !== bTime) return aTime - bTime;
    return `${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`);
  });
}
