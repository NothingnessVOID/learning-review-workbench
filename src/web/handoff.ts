import type { Note, Review, SourceRef } from "./types";

export type HandoffSelection = {
  note_id: string;
  related_note_ids: string[];
  review_ids: string[];
  feedback_note_ids: string[];
  include_sources: boolean;
  method_intent: "heijin_review" | "general_review";
};
type Excerpt = {
  ref?: SourceRef;
  source_document_id?: string;
  source_version_id?: string;
  source_block_id?: string;
  source_name?: string;
  title_path?: string[] | string;
  text: string;
  content_truncated?: boolean;
  block_order?: number;
  line_start?: number;
  line_end?: number;
};
export type HandoffResult = {
  note: Note;
  related_notes: Note[];
  reviews: Review[];
  feedback_notes: Note[];
  source_refs: SourceRef[];
  source_excerpts: Excerpt[];
  source_summary?: {
    total_refs: number;
    attached_count: number;
    omitted_refs: SourceRef[];
    truncated_refs: SourceRef[];
  };
  gaps: string[];
  capabilities?: {
    workbench_has_full_method_skill?: boolean;
    receiver_capability?: string;
    source_excerpt_limit?: number;
  };
  selected: Omit<HandoffSelection, "note_id"> & { note_id?: string };
};

export function sameHandoffSelection(
  selection: HandoffSelection,
  result: HandoffResult,
) {
  const chosen = result.selected;
  const sameIds = (a: string[], b?: string[]) =>
    JSON.stringify(a) === JSON.stringify(b || []);
  return (
    result.note?.id === selection.note_id &&
    sameIds(selection.related_note_ids, chosen?.related_note_ids) &&
    sameIds(selection.review_ids, chosen?.review_ids) &&
    sameIds(selection.feedback_note_ids, chosen?.feedback_note_ids) &&
    chosen?.include_sources === selection.include_sources &&
    chosen?.method_intent === selection.method_intent
  );
}

function when(note: Pick<Note, "occurred_at" | "created_at">) {
  return `发生时间：${note.occurred_at || "未记录"}\n写入时间：${note.created_at || "未记录"}`;
}
function refText(ref: SourceRef) {
  return `${ref.source_document_id} / ${ref.source_version_id} / ${ref.source_block_id || "区段未标"}`;
}
export function handoffMarkdown(
  result: HandoffResult,
  selection: HandoffSelection,
) {
  const parts = [
    "# 个人复盘交接（发送前请核对）",
    "本交接只包含明确选定的个人记录和资料。保留原话，不推定缺失的动机、事件或方法步骤。复盘结果须由用户检查后独立归档。",
    `复盘意图：${selection.method_intent === "heijin_review" ? "希望按黑金方法复盘" : "一般整理与复盘"}`,
    "工作台未提供完整的专门方法 Skill。接收 Agent 是否具备对应 Skill 和资料，须由接收端实际核验；未核验前不得声称已完整执行。",
    `\n## 当前记录 ${result.note.id}\n${when(result.note)}\n${result.note.original_text}`,
  ];
  for (const note of result.related_notes || [])
    parts.push(
      `\n## 选定相关记录 ${note.id}\n${when(note)}\n${note.original_text}`,
    );
  for (const review of result.reviews || [])
    parts.push(
      `\n## 选定先前复盘 ${review.id}\n写入时间：${review.created_at || "未记录"}\n方法：${review.method_name || "未注明"}${review.method_version ? ` · ${review.method_version}` : ""}\n${review.body_md}`,
    );
  for (const note of result.feedback_notes || [])
    parts.push(
      `\n## 选定后续反馈 ${note.id}\n${when(note)}\n${note.original_text}`,
    );
  const summary = result.source_summary;
  if (selection.include_sources) {
    parts.push(
      `\n## 固定来源\n可定位引用总数：${summary?.total_refs ?? result.source_refs?.length ?? 0}；本次附上：${summary?.attached_count ?? result.source_excerpts?.length ?? 0}。`,
    );
    for (const excerpt of result.source_excerpts || []) {
      const ref = excerpt.ref || {
        source_document_id: excerpt.source_document_id || "",
        source_version_id: excerpt.source_version_id || "",
        source_block_id: excerpt.source_block_id,
      };
      const title = Array.isArray(excerpt.title_path)
        ? excerpt.title_path.join(" / ")
        : excerpt.title_path || "";
      parts.push(
        `\n### ${excerpt.source_name || "原文"} ${title}\n固定引用：${refText(ref)}${excerpt.block_order !== undefined ? ` · 区段序号 ${excerpt.block_order}` : ""}${excerpt.line_start !== undefined ? ` · 行 ${excerpt.line_start}${excerpt.line_end !== undefined ? `–${excerpt.line_end}` : ""}` : ""}\n${excerpt.text}${excerpt.content_truncated ? "\n【此段已截断，请按固定引用回查原文。】" : ""}`,
      );
    }
    if (summary?.omitted_refs?.length)
      parts.push(
        `未附来源：\n${summary.omitted_refs.map((ref) => `- ${refText(ref)}`).join("\n")}`,
      );
    if (summary?.truncated_refs?.length)
      parts.push(
        `已截断来源：\n${summary.truncated_refs.map((ref) => `- ${refText(ref)}`).join("\n")}`,
      );
  } else
    parts.push(
      "\n## 来源\n本次未选择附带来源原文。接收端不应把未附的资料当作已核对。",
    );
  parts.push(
    `\n## 资料缺口\n${result.gaps?.length ? result.gaps.map((gap) => `- ${gap}`).join("\n") : "- 暂无额外说明；接收端仍需核对自身资料与能力。"}`,
  );
  return parts.join("\n");
}
