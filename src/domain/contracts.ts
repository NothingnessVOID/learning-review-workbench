import { z } from "zod";
import {
  id,
  courseDraft,
  knowledgeDraft,
  noteSchema,
  reviewSchema,
  relationSchema,
} from "./schema.js";

const dateRange = z.union([z.iso.date(), z.iso.datetime({ offset: true })]);
const pageLimit = z.number().int().min(1).max(100).default(30);
const pageCursor = z
  .union([
    z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    z.string().regex(/^\d+$/).max(16),
  ])
  .transform(Number)
  .refine(Number.isSafeInteger)
  .default(0);
export const listNotesSchema = z
  .object({
    limit: pageLimit,
    cursor: pageCursor,
    from: dateRange.optional(),
    to: dateRange.optional(),
    to_exclusive: z.iso.datetime({ offset: true }).optional(),
    include_archived: z.boolean().optional(),
    type: z.string().max(60).optional(),
    relation_id: id.optional(),
  })
  .strict();

export const searchLibrarySchema = z
  .object({
    query: z.string().min(1).max(300),
    types: z
      .array(
        z.enum([
          "course",
          "courses",
          "topic",
          "topics",
          "knowledge",
          "card",
          "cards",
          "source",
          "sources",
          "note",
          "notes",
          "case",
          "cases",
          "review",
          "reviews",
        ]),
      )
      .max(8)
      .optional(),
    series: z.string().max(200).optional(),
    source_id: id.optional(),
    from: dateRange.optional(),
    to: dateRange.optional(),
    to_exclusive: z.iso.datetime({ offset: true }).optional(),
    limit: pageLimit,
    cursor: pageCursor,
  })
  .strict();

const getId = (key: string) => z.object({ [key]: id }).strict();
const pagination = z.object({ limit: pageLimit, cursor: pageCursor }).strict();
const sourceExcerpt = z
  .object({
    source_version_id: id,
    source_block_id: id.optional(),
    limit: z.number().int().min(1).max(20).default(3),
    cursor: pageCursor,
  })
  .strict();
export const readToolSchemas = {
  get_status: z.object({}).strict(),
  get_agent_context: z
    .object({
      sections: z
        .array(
          z.enum([
            "user",
            "worldview",
            "heijin",
            "rules",
            "course",
            "knowledge",
            "learning",
            "review",
          ]),
        )
        .max(8)
        .optional(),
    })
    .strict(),
  get_schema: z.object({ entity_type: z.string().max(60).optional() }).strict(),
  list_courses: z
    .object({
      query: z.string().max(300).optional(),
      series: z.string().max(200).optional(),
      limit: pagination.shape.limit,
      cursor: pagination.shape.cursor,
    })
    .strict(),
  get_course: getId("course_id")
    .extend({ revision: z.number().int().positive().optional() })
    .strict(),
  get_topic: getId("topic_id")
    .extend({ revision: z.number().int().positive().optional() })
    .strict(),
  list_knowledge: z
    .object({
      query: z.string().max(300).optional(),
      type: z.string().max(60).optional(),
      limit: pagination.shape.limit,
      cursor: pagination.shape.cursor,
    })
    .strict(),
  get_knowledge_card: getId("card_id")
    .extend({ revision: z.number().int().positive().optional() })
    .strict(),
  get_source_excerpt: sourceExcerpt,
  search_library: searchLibrarySchema,
  list_notes: listNotesSchema,
  get_note: getId("note_id"),
  get_case: getId("case_id"),
  get_review_result: getId("review_id"),
  list_drafts: pagination,
  get_draft_status: getId("draft_id"),
  list_relations: pagination,
  list_audit: pagination,
};

export const sharedToolSchemas = {
  ...readToolSchemas,
  create_note: noteSchema,
  save_review_result: reviewSchema,
  propose_relations: relationSchema,
  submit_course_draft: courseDraft,
  submit_knowledge_draft: knowledgeDraft,
};
