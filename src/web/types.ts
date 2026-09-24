export type SourceRef = {
  source_document_id: string;
  source_version_id: string;
  source_block_id?: string;
};
export type TeachingBlock = {
  id: string;
  type: string;
  body_md: string;
  origin_kind: string;
  transformation?: string;
  source_refs: SourceRef[];
  verification_status?: string;
};
export type Course = {
  id: string;
  title: string;
  series: string;
  course_date: string | null;
  overview: string;
  revision: number;
  processing_status: string;
  verification_status: string;
  topic_count: number;
  source_version_ids: string[];
  learning_state?: LearningState | null;
  topics?: Topic[];
  pending_drafts?: { id: string; title: string; web_path: string }[];
};
export type Topic = {
  id: string;
  course_id: string;
  parent_id: string | null;
  order: number;
  title: string;
  content_kind: string;
  blocks: TeachingBlock[];
  revision: number;
  course?: Course;
  knowledge_cards?: Card[];
  learning_state?: LearningState | null;
  notes?: Note[];
};
export type Card = {
  id: string;
  title: string;
  original_name: string;
  type: string;
  original_type?: string;
  aliases: string[];
  body_md: string;
  source_refs: SourceRef[];
  topic_ids: string[];
  verification_status: string;
  revision: number;
  topics?: Topic[];
  notes?: Note[];
  learning_state?: LearningState | null;
};
export type Note = {
  id: string;
  original_text: string;
  original_preview?: string;
  content_truncated?: boolean;
  summary_only?: boolean;
  type: string;
  created_at: string;
  updated_at: string;
  occurred_at: string | null;
  privacy: "private";
  author_type: string;
  relation_ids: string[];
  parent_note_id: string | null;
  archived?: boolean;
  revision: number;
  reviews?: Review[];
  followups?: Note[];
  relations?: Relation[];
  resolved_relations?: {
    id: string;
    type: string;
    title: string;
    web_path: string;
  }[];
};
export type Review = {
  id: string;
  note_ids: string[];
  body_md: string;
  author_type: string;
  method_name: string | null;
  method_version: string | null;
  basis: unknown[];
  gaps: unknown[];
  created_at: string;
};
export type Relation = {
  id: string;
  from_id?: string;
  to_id?: string;
  kind?: string;
  status?: string;
  reason?: string;
};
export type LearningState = {
  object_id: string;
  status: string;
  position?: {
    topic_id?: string;
    scroll?: number;
    block_id?: string;
    block_offset?: number;
  };
  updated_at: string;
  revision: number;
};
export type Draft = {
  id: string;
  entity_type: "course" | "knowledge";
  entity_id: string;
  status: "draft" | "accepted" | "rejected" | "reverted";
  expected_revision: number;
  payload: unknown;
  created_at: string;
  revision: number;
  current?: unknown;
  proposed?: unknown;
  validation?: { warnings: string[]; errors: string[] };
};
export type Permissions = {
  read_library: boolean;
  append_notes: boolean;
  save_reviews: boolean;
  submit_courses: boolean;
  submit_knowledge: boolean;
  propose_relations: boolean;
  read_note_ids: string[];
};
export type Status = {
  app_version: string;
  schema_version: string;
  data_dir: string;
  counts: { courses: number; cards: number; notes: number; drafts: number };
  permissions: Permissions;
  read_only: boolean;
  mode: "private" | "demo";
};
