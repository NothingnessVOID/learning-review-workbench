import { z } from "zod";
export const id = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[\w.-]+$/);
export const text = z.string().min(1).max(300000);
export const requestId = id;
export const ref = z
  .object({
    source_document_id: id,
    source_version_id: id,
    source_block_id: id,
    source_path: z.string().max(1000).optional(),
    block_order: z.number().int().min(0).max(1000000).optional(),
    content_identity: z.string().max(300).optional(),
  })
  .strict();
export const teachingBlock = z
  .object({
    id: id.optional(),
    type: z.string().max(60),
    body_md: text,
    origin_kind: z.string().max(80),
    transformation: z.string().max(80),
    source_refs: z.array(ref).max(500),
    verification_status: z.string().max(80).default("needs_review"),
  })
  .strict()
  .superRefine((block, ctx) => {
    if (block.type !== "source_quote") return;
    if (block.source_refs.length === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["source_refs"],
        message: "source_quote 必须关联至少一个原文来源。",
      });
    }
    if (
      !["original_quote", "direct_quote", "verbatim", "quote"].includes(
        block.transformation,
      )
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["transformation"],
        message: "source_quote 只能标记为实际引用原文的 transformation。",
      });
    }
  });
export const topic = z
  .object({
    id: id,
    course_id: id.optional(),
    title: z.string().min(1).max(500),
    parent_id: id.nullable().default(null),
    order: z.number().int().min(0),
    content_kind: z.string().max(60),
    content_identity: z.string().min(1).max(300).optional(),
    blocks: z.array(teachingBlock).max(300),
    revision: z.number().int().optional(),
  })
  .strict();
export const courseDraft = z
  .object({
    schema_version: z.literal("1.0.0").optional(),
    course_id: id.optional(),
    title: z.string().min(1).max(500).optional(),
    series: z.string().max(200).optional(),
    course_date: z.string().max(40).nullable().optional(),
    overview: z.string().max(50000),
    expected_revision: z.number().int().min(0),
    source_version_ids: z.array(id).min(1).max(100),
    topics: z.array(topic).min(1).max(500),
    coverage: z
      .array(
        z
          .object({
            source_block_id: id,
            disposition: z.enum([
              "main_teaching",
              "recap",
              "case",
              "question_answer",
              "background",
              "notice",
              "retained",
              "unresolved",
              "included",
            ]),
            topic_ids: z.array(id).max(100),
            content_identity: z.string().min(1).max(300).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(10000),
    knowledge_candidates: z.array(z.unknown()).max(500).default([]),
    unresolved_questions: z.array(z.string().max(2000)).max(500).default([]),
    authorship: z
      .object({ kind: z.string().max(80), name: z.string().max(100) })
      .optional(),
    client_request_id: requestId,
  })
  .strict();
export const knowledgeDraft = z
  .object({
    card_id: id.optional(),
    title: z.string().min(1).max(500),
    original_name: z.string().max(500).optional(),
    type: z
      .enum(["model", "concept", "viewpoint", "method"])
      .default("concept"),
    original_type: z.string().max(100).optional(),
    aliases: z.array(z.string().max(200)).max(100).default([]),
    body_md: text,
    source_refs: z.array(ref).max(500),
    topic_ids: z.array(id).max(500).default([]),
    verification_status: z.string().max(80).default("needs_review"),
    expected_revision: z.number().int().min(0),
    client_request_id: requestId,
  })
  .strict();
export const noteSchema = z
  .object({
    original_text: text,
    type: z
      .enum(["quick", "understanding", "question", "event", "feedback", "seed"])
      .default("quick"),
    relation_ids: z.array(id).max(100).default([]),
    parent_note_id: id.nullable().optional(),
    occurred_at: z.iso.datetime({ offset: true }).nullable().optional(),
    client_request_id: requestId,
  })
  .strict();
export const reviewSchema = z
  .object({
    note_ids: z.array(id).min(1).max(50),
    body_md: text,
    method_name: z.string().max(200).nullable().optional(),
    method_version: z.string().max(100).nullable().optional(),
    basis: z.array(z.unknown()).max(100).default([]),
    gaps: z.array(z.string().max(2000)).max(100).default([]),
    client_request_id: requestId,
  })
  .strict();
export const relationSchema = z
  .object({
    relations: z
      .array(
        z
          .object({
            from_id: id,
            to_id: id,
            kind: z.string().min(1).max(100),
            reason: z.string().max(3000).optional(),
            source_refs: z.array(ref).max(100).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(100),
    client_request_id: requestId,
  })
  .strict();
export const permissionsSchema = z
  .object({
    read_library: z.boolean(),
    append_notes: z.boolean(),
    save_reviews: z.boolean(),
    submit_courses: z.boolean(),
    submit_knowledge: z.boolean(),
    propose_relations: z.boolean(),
    read_note_ids: z.array(id).max(10000),
  })
  .strict();
export const schemas = {
  course_draft: courseDraft,
  knowledge_draft: knowledgeDraft,
  note: noteSchema,
  review_result: reviewSchema,
  relation: relationSchema,
  permissions: permissionsSchema,
};
export class AppError extends Error {
  constructor(
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}
export function check(
  condition: unknown,
  code: string,
  message: string,
  details?: unknown,
): asserts condition {
  if (!condition) throw new AppError(code, message, details);
}
export function parse<T extends z.ZodType>(
  schema: T,
  value: unknown,
): z.infer<T> {
  const r = schema.safeParse(value);
  if (!r.success)
    throw new AppError(
      "VALIDATION_ERROR",
      "输入格式有误，请检查字段。",
      r.error.issues.map((i) => ({ path: i.path, message: i.message })),
    );
  return r.data;
}
