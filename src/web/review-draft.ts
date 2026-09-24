import type { VersionedDraft } from "./drafts";

export type ReviewLinkDraft = VersionedDraft & {
  linkSelectedNotes: boolean;
  linkedNoteIds: string[];
};

/** Keep link scope in the same persistent version as the review body. */
export function changeReviewLinks<T extends ReviewLinkDraft>(
  current: T,
  selectedNoteIds: string[],
  enabled: boolean,
  nextRequestId: string,
): T {
  return {
    ...current,
    linkSelectedNotes: enabled,
    linkedNoteIds: enabled ? [...new Set(selectedNoteIds)] : [],
    requestId: nextRequestId,
  };
}

export function reviewNoteIds(noteId: string, submitted: ReviewLinkDraft) {
  return [
    noteId,
    ...(submitted.linkSelectedNotes
      ? (submitted.linkedNoteIds || []).filter((id) => id !== noteId)
      : []),
  ];
}
