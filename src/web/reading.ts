import { rpc, rpcKeepalive } from "./api";
import type { LearningState } from "./types";

export type ReaderPosition = {
  topic_id: string;
  scroll?: number;
  teaching_block_id?: string;
  block_offset?: number;
};
type LocalPosition = ReaderPosition & { saved_at: number };
let positionQueue: Promise<unknown> = Promise.resolve();

export function chooseReaderPosition(
  courseId: string,
  server: LearningState | null | undefined,
): ReaderPosition | null {
  let local: LocalPosition | null = null;
  try {
    local = JSON.parse(
      localStorage.getItem(`workbench.reader.${courseId}`) || "null",
    );
  } catch {
    /* malformed local position */
  }
  const serverTime = server?.updated_at ? Date.parse(server.updated_at) : 0;
  if (local?.topic_id && local.saved_at > serverTime) return local;
  return server?.position?.topic_id
    ? (server.position as ReaderPosition)
    : null;
}

export function saveReaderPosition(courseId: string, position: ReaderPosition) {
  const normalized: ReaderPosition = {
    topic_id: position.topic_id,
    scroll: position.scroll,
  };
  if (position.teaching_block_id)
    normalized.teaching_block_id = position.teaching_block_id;
  if (position.block_offset !== undefined && position.teaching_block_id)
    normalized.block_offset = position.block_offset;
  localStorage.setItem(
    `workbench.reader.${courseId}`,
    JSON.stringify({ ...normalized, saved_at: Date.now() }),
  );
  positionQueue = positionQueue
    .catch(() => {})
    .then(() =>
      rpc("set_learning_state", { object_id: courseId, position: normalized }),
    );
  return positionQueue;
}

export function saveReaderOnPageHide(
  courseId: string,
  position: ReaderPosition,
) {
  const normalized: ReaderPosition = {
    topic_id: position.topic_id,
    scroll: position.scroll,
  };
  if (position.teaching_block_id)
    normalized.teaching_block_id = position.teaching_block_id;
  if (position.block_offset !== undefined && position.teaching_block_id)
    normalized.block_offset = position.block_offset;
  localStorage.setItem(
    `workbench.reader.${courseId}`,
    JSON.stringify({ ...normalized, saved_at: Date.now() }),
  );
  rpcKeepalive("set_learning_state", {
    object_id: courseId,
    position: normalized,
  });
}

export function captureReaderPosition(topicId: string): ReaderPosition {
  const scroll = Math.max(0, window.scrollY);
  const blocks = [
    ...document.querySelectorAll<HTMLElement>("[data-teaching-block-id]"),
  ];
  const current = blocks
    .filter((block) => block.getBoundingClientRect().top <= 135)
    .at(-1);
  if (!current) return { topic_id: topicId, scroll };
  return {
    topic_id: topicId,
    scroll,
    teaching_block_id: current.dataset.teachingBlockId,
    block_offset: Math.max(
      0,
      Math.round(135 - current.getBoundingClientRect().top),
    ),
  };
}

export function restoreReaderPosition(
  position: ReaderPosition | null,
  topicId: string,
) {
  if (position?.topic_id !== topicId) {
    window.scrollTo(0, 0);
    return;
  }
  const anchor =
    position.teaching_block_id ||
    (position as ReaderPosition & { block_id?: string }).block_id;
  const block = anchor
    ? [
        ...document.querySelectorAll<HTMLElement>("[data-teaching-block-id]"),
      ].find((element) => element.dataset.teachingBlockId === anchor)
    : undefined;
  if (block) {
    const top =
      window.scrollY +
      block.getBoundingClientRect().top -
      135 +
      (position.block_offset || 0);
    window.scrollTo({ top: Math.max(0, top), behavior: "instant" });
  } else window.scrollTo({ top: position.scroll || 0, behavior: "instant" });
}
