import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { cpus, tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { Service } from "../src/domain/service.js";
import { uid } from "../src/domain/store.js";

type Rpc = {
  ok: boolean;
  data?: any;
  error?: { code: string; message: string };
};

const projectDir = process.cwd();
const sampleCount = 30;

function percentile(values: number[], percentileValue: number) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[
    Math.min(sorted.length - 1, Math.ceil(percentileValue * sorted.length) - 1)
  ];
}

function measureSummary(values: number[]) {
  return {
    samples: values.length,
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    mean: values.reduce((total, value) => total + value, 0) / values.length,
  };
}

async function measure(operation: () => Promise<unknown>, count: number) {
  const values: number[] = [];
  for (let index = 0; index < count; index++) {
    const start = performance.now();
    await operation();
    values.push(performance.now() - start);
  }
  return measureSummary(values);
}

function elapsedText(ms: number) {
  if (ms < 1000) return `${ms.toFixed(1)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

async function main() {
  const dataDir = await mkdtemp(
    join(tmpdir(), "learning-workbench-benchmark-"),
  );
  const service = new Service(dataDir, projectDir);
  const startGenerated = performance.now();
  const courseIds: string[] = [];
  try {
    service.store.tx(() => {
      for (let index = 0; index < 100; index++) {
        const id = uid("bench_course");
        courseIds.push(id);
        service.store.put(
          "courses",
          {
            id,
            title: `DEMO 性能基准课程 ${String(index + 1).padStart(3, "0")}`,
            series: "DEMO 工程规模基准",
            course_date: null,
            overview: "DEMO 基准记录，只用于隔离库性能测试。",
            source_version_ids: [],
            processing_status: "accepted",
            verification_status: "needs_review",
            topic_count: 3,
          },
          0,
        );
        for (let topicIndex = 0; topicIndex < 3; topicIndex++) {
          service.store.put(
            "topics",
            {
              id: uid("bench_topic"),
              course_id: id,
              parent_id: null,
              order: topicIndex,
              title: `DEMO 课程主题 ${topicIndex + 1}`,
              content_kind: "lesson",
              blocks: [],
            },
            0,
          );
        }
      }
      for (let index = 0; index < 2000; index++) {
        const id = uid("bench_card");
        service.store.put(
          "cards",
          {
            id,
            title: `DEMO 性能基准知识卡 ${String(index + 1).padStart(4, "0")}`,
            original_name: `DEMO 性能基准知识卡 ${index + 1}`,
            type: "concept",
            aliases: [],
            body_md: "DEMO 性能基准内容，生成于临时测试数据库。",
            source_refs: [],
            topic_ids: [],
            verification_status: "needs_review",
          },
          0,
        );
      }
      for (let index = 0; index < 10000; index++) {
        const id = uid("bench_note");
        service.store.put(
          "notes",
          {
            id,
            original_text: `DEMO 性能基准短记录 ${String(index + 1).padStart(5, "0")}：隔离库生成，不含真实私人内容。`,
            type: "quick",
            privacy: "private",
            author_type: "local_user",
            relation_ids: [],
            parent_note_id: null,
            occurred_at: null,
          },
          0,
        );
      }
    });
    const generatedMs = performance.now() - startGenerated;

    const openArgs = { course_id: courseIds[0] };
    for (let index = 0; index < 5; index++) {
      const warmup = (await service.invoke("get_course", openArgs)) as Rpc;
      if (!warmup.ok)
        throw new Error(`课程打开预热失败：${warmup.error?.code}`);
    }
    const courseOpen = await measure(async () => {
      const result = (await service.invoke("get_course", openArgs)) as Rpc;
      if (!result.ok) throw new Error(`课程打开失败：${result.error?.code}`);
    }, sampleCount);

    const searchArgs = {
      query: "基准",
      types: ["course", "knowledge", "note"],
      limit: 30,
    };
    let searchTotal = 0;
    for (let index = 0; index < 3; index++) {
      const warmup = (await service.invoke(
        "search_library",
        searchArgs,
      )) as Rpc;
      if (!warmup.ok) throw new Error(`搜索预热失败：${warmup.error?.code}`);
    }
    const librarySearch = await measure(async () => {
      const result = (await service.invoke(
        "search_library",
        searchArgs,
      )) as Rpc;
      if (!result.ok) throw new Error(`搜索失败：${result.error?.code}`);
      searchTotal = result.data.total;
    }, sampleCount);

    let writeIndex = 0;
    const noteWrite = await measure(async () => {
      const index = ++writeIndex;
      const result = (await service.invoke("create_note", {
        original_text: `DEMO 性能基准实时写入 ${index}，短句测试。`,
        type: "quick",
        client_request_id: `bench_note_request_${index}`,
      })) as Rpc;
      if (!result.ok)
        throw new Error(`个人记录写入失败：${result.error?.code}`);
    }, sampleCount);

    const environment = {
      date: new Date().toISOString(),
      node: process.version,
      platform: `${process.platform}/${process.arch}`,
      cpu: cpus()[0]?.model ?? "unavailable",
    };
    const report =
      `# 本地性能基准\n\n` +
      `此报告由 \`scripts/benchmark.ts\` 在 ${environment.date} 生成。测试数据库位于操作系统临时目录，结束后自动删除。所有课程、知识卡和记录都是代码生成的 DEMO 数据，不含用户资料。\n\n` +
      `## 环境与数据规模\n\n` +
      `- Node.js：${environment.node}\n` +
      `- 平台：${environment.platform}\n` +
      `- CPU：${environment.cpu}\n` +
      `- SQLite：Node.js 内置 \`node:sqlite\`\n` +
      `- 数据：100 门课程、每课 3 个主题、2,000 张知识卡、10,000 条短记录；搜索词“基准”命中 ${searchTotal.toLocaleString()} 条记录。\n` +
      `- 初始化耗时：${elapsedText(generatedMs)}（单事务插入，包含修订快照）。\n` +
      `- 预热后每类测量 ${sampleCount} 次；响应时间按每次完整 \`Service.invoke\` 调用计。\n\n` +
      `## 结果\n\n| 操作 | 样本 | P50 | P95 | 平均 |\n|---|---:|---:|---:|---:|\n` +
      `| 打开课程（\`get_course\`） | ${courseOpen.samples} | ${courseOpen.p50.toFixed(2)} ms | ${courseOpen.p95.toFixed(2)} ms | ${courseOpen.mean.toFixed(2)} ms |\n` +
      `| 中文搜索（课程、知识、记录） | ${librarySearch.samples} | ${librarySearch.p50.toFixed(2)} ms | ${librarySearch.p95.toFixed(2)} ms | ${librarySearch.mean.toFixed(2)} ms |\n` +
      `| 新增短记录（\`create_note\`） | ${noteWrite.samples} | ${noteWrite.p50.toFixed(2)} ms | ${noteWrite.p95.toFixed(2)} ms | ${noteWrite.mean.toFixed(2)} ms |\n\n` +
      `## 测量边界\n\n` +
      `这是本机 Node 服务层和 SQLite 的隔离库基准，未通过浏览器、HTTP 或 MCP 传输测量，也不代表用户真实课程、附件体积或多人并发。课程打开对象包含 3 个 DEMO 主题，没有来源段落；搜索词“基准”预期命中 12,100 条共同匹配记录，用于测量数据库扫描、结果排序和分页。报告仅在运行脚本时更新：\n\n` +
      `\`\`\`sh\nnpx tsx scripts/benchmark.ts\n\`\`\`\n`;

    await writeFile(join(projectDir, "docs/PERFORMANCE.md"), report, "utf8");
    process.stdout.write(report);
  } finally {
    service.store.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

await main();
