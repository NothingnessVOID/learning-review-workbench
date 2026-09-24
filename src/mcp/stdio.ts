#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  id,
  courseDraft,
  knowledgeDraft,
  noteSchema,
  reviewSchema,
  relationSchema,
} from "../domain/schema.js";

const short = z.string().min(1).max(500);
const revision = z.number().int().nonnegative();
const cursor = z.string().min(1).max(2000);

const specs = {
  get_status: {
    description: "读取工作台状态、版本与当前授权范围，不返回凭据。",
    schema: z.strictObject({}),
  },
  get_agent_context: {
    description: "按需读取工作台使用说明、来源纪律和方法边界。",
    schema: z.strictObject({ sections: z.array(short).max(30).optional() }),
  },
  get_schema: {
    description: "读取业务对象的字段定义与限制。",
    schema: z.strictObject({ entity_type: short.optional() }),
  },
  list_courses: {
    description: "列出获授权的课程。",
    schema: z.strictObject({
      query: short.optional(),
      series: short.optional(),
    }),
  },
  get_course: {
    description: "按 ID 读取课程、地图和来源版本。",
    schema: z.strictObject({ course_id: id, revision: revision.optional() }),
  },
  get_topic: {
    description: "按 ID 读取主题讲义与来源引用。",
    schema: z.strictObject({ topic_id: id, revision: revision.optional() }),
  },
  list_knowledge: {
    description: "列出或筛选知识卡。",
    schema: z.strictObject({ query: short.optional(), type: short.optional() }),
  },
  get_knowledge_card: {
    description: "按 ID 读取知识卡及关联主题。",
    schema: z.strictObject({ card_id: id, revision: revision.optional() }),
  },
  get_source_excerpt: {
    description: "分段读取真实来源原文，返回下一页游标。",
    schema: z.strictObject({
      source_version_id: id,
      source_block_id: id.optional(),
      cursor: cursor.optional(),
      limit: z.number().int().min(1).max(20).optional(),
    }),
  },
  search_library: {
    description: "在授权范围内搜索课程、知识和记录。",
    schema: z.strictObject({
      query: short,
      types: z.array(short).max(10).optional(),
      limit: z.number().int().min(1).max(100).optional(),
      cursor: cursor.optional(),
    }),
  },
  list_notes: {
    description: "列出获单独授权的个人记录。",
    schema: z.strictObject({
      type: short.optional(),
      relation_id: id.optional(),
      limit: z.number().int().min(1).max(100).optional(),
      cursor: cursor.optional(),
    }),
  },
  get_note: {
    description: "按 ID 读取获授权的个人记录与复盘。",
    schema: z.strictObject({ note_id: id }),
  },
  list_drafts: { description: "列出草稿状态。", schema: z.strictObject({}) },
  get_draft_status: {
    description: "读取草稿校验结果与收录状态。",
    schema: z.strictObject({ draft_id: id }),
  },
  list_audit: {
    description: "读取授权范围内的变更记录。",
    schema: z.strictObject({}),
  },
  list_relations: {
    description: "读取已有关系和待确认关系。",
    schema: z.strictObject({}),
  },
  create_note: {
    description: "追加一条原始记录；需要记录追加权限和幂等请求 ID。",
    schema: noteSchema,
  },
  save_review_result: {
    description: "为原始记录新增关联复盘；不会覆盖原话。",
    schema: reviewSchema,
  },
  propose_relations: {
    description: "提交待确认关系，不直接确认事实。",
    schema: relationSchema,
  },
  submit_course_draft: {
    description: "提交课程草稿，等待网页审核。",
    schema: courseDraft,
  },
  submit_knowledge_draft: {
    description: "提交知识卡草稿，保留来源与版本差异。",
    schema: knowledgeDraft,
  },
} as const;

const serviceUrl = (() => {
  const value = process.env.LEARNING_WORKBENCH_URL ?? "http://127.0.0.1:47831";
  const url = new URL(value);
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error("LEARNING_WORKBENCH_URL 只允许 http://127.0.0.1:端口");
  }
  return url;
})();

function credentialsPath() {
  return join(
    process.env.LEARNING_WORKBENCH_DATA_DIR ??
      join(homedir(), "Library/Application Support/LearningWorkbench"),
    "credentials.json",
  );
}

async function token(): Promise<string> {
  const parsed: unknown = JSON.parse(await readFile(credentialsPath(), "utf8"));
  if (
    !parsed ||
    typeof parsed !== "object" ||
    !("token" in parsed) ||
    typeof parsed.token !== "string" ||
    !parsed.token
  ) {
    throw new Error("凭据文件缺少 token");
  }
  return parsed.token;
}

type ApiResult = {
  ok: boolean;
  data?: unknown;
  error?: { code?: string; message?: string; details?: unknown };
  warnings?: unknown[];
  next_cursor?: string | null;
};
function result(value: ApiResult, isError = false) {
  const structuredContent = value as Record<string, unknown>;
  const summary = isError
    ? `${value.error?.code ?? "SERVICE_ERROR"}：${value.error?.message ?? "请求失败"}`
    : JSON.stringify(value);
  return {
    content: [{ type: "text" as const, text: summary }],
    structuredContent,
    isError,
  };
}

async function callService(tool: string, args: Record<string, unknown>) {
  let bearer: string;
  try {
    bearer = await token();
  } catch {
    try {
      await fetch(new URL("/health", serviceUrl), {
        signal: AbortSignal.timeout(2_000),
      });
      return result(
        {
          ok: false,
          error: {
            code: "PERMISSION_DENIED",
            message: "工作台 MCP 凭据不可读取。请在网页设置中检查 MCP 连接。",
          },
          warnings: [],
        },
        true,
      );
    } catch {
      return result(
        {
          ok: false,
          error: {
            code: "SERVICE_UNAVAILABLE",
            message:
              "本地工作台服务未启动。请在项目目录运行 npm start，再重试。",
          },
          warnings: [],
        },
        true,
      );
    }
  }
  try {
    const response = await fetch(new URL("/api/mcp", serviceUrl), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${bearer}`,
      },
      body: JSON.stringify({ tool, args }),
      signal: AbortSignal.timeout(15_000),
    });
    const body: unknown = await response.json();
    if (
      !body ||
      typeof body !== "object" ||
      !("ok" in body) ||
      typeof body.ok !== "boolean"
    )
      throw new Error("invalid response");
    return result(body as ApiResult, !(body as ApiResult).ok);
  } catch {
    return result(
      {
        ok: false,
        error: {
          code: "SERVICE_UNAVAILABLE",
          message:
            "本地工作台服务未启动或无响应。请在项目目录运行 npm start，再重试。",
        },
        warnings: [],
      },
      true,
    );
  }
}

const server = new McpServer({ name: "learning-workbench", version: "1.0.0" });
for (const [name, spec] of Object.entries(specs)) {
  server.registerTool(
    name,
    {
      description: spec.description,
      inputSchema: spec.schema,
      annotations: {
        readOnlyHint: ![
          "create_note",
          "save_review_result",
          "propose_relations",
          "submit_course_draft",
          "submit_knowledge_draft",
        ].includes(name),
        openWorldHint: false,
      },
    },
    async (args: Record<string, unknown>) => callService(name, args),
  );
}
await server.connect(new StdioServerTransport());
