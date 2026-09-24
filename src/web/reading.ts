import { rpc, rpcKeepalive } from "./api";
import type { LearningState } from "./types";

export type ReaderPosition = NonNullable<LearningState["position"]> & {
  topic_id: string;
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
  localStorage.setItem(
    `workbench.reader.${courseId}`,
    JSON.stringify({ ...position, saved_at: Date.now() }),
  );
  positionQueue = positionQueue
    .catch(() => {})
    .then(() => rpc("set_learning_state", { object_id: courseId, position }));
  return positionQueue;
}

export function saveReaderOnPageHide(
  courseId: string,
  position: ReaderPosition,
) {
  localStorage.setItem(
    `workbench.reader.${courseId}`,
    JSON.stringify({ ...position, saved_at: Date.now() }),
  );
  rpcKeepalive("set_learning_state", { object_id: courseId, position });
}

export function captureReaderPosition(topicId: string): ReaderPosition {
  const scroll = Math.max(0, window.scrollY);
  const blocks = [
    ...document.querySelectorAll<HTMLElement>("[data-reader-block]"),
  ];
  const current = blocks
    .filter((block) => block.getBoundingClientRect().top <= 135)
    .at(-1);
  if (!current) return { topic_id: topicId, scroll };
  return {
    topic_id: topicId,
    scroll,
    block_id: current.dataset.readerBlock,
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
  const block = position.block_id
    ? [...document.querySelectorAll<HTMLElement>("[data-reader-block]")].find(
        (element) => element.dataset.readerBlock === position.block_id,
      )
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
