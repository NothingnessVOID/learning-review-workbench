type Item = {
  id?: string;
  title?: string;
  body_md?: string;
  source_refs?: unknown[];
  blocks?: Item[];
  topics?: Item[];
  origin_kind?: string;
  transformation?: string;
  verification_status?: string;
};

export type ReadableChange = {
  kind: "added" | "removed" | "changed";
  area: string;
  title: string;
  details: string[];
};

function text(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}
function sourceKey(refs: unknown) {
  return JSON.stringify(Array.isArray(refs) ? refs : []);
}
function changedParagraphs(before: string, after: string) {
  const parts = (value: string) =>
    value
      .split(/\n\s*\n|\n/)
      .map((part) => part.trim())
      .filter(Boolean);
  const old = parts(before),
    next = parts(after);
  const removed = old.filter((part) => !next.includes(part));
  const added = next.filter((part) => !old.includes(part));
  const result: string[] = [];
  for (const part of removed.slice(0, 2))
    result.push(`移除：${part.slice(0, 160)}${part.length > 160 ? "…" : ""}`);
  for (const part of added.slice(0, 2))
    result.push(`新增：${part.slice(0, 160)}${part.length > 160 ? "…" : ""}`);
  if (removed.length > 2 || added.length > 2)
    result.push(
      `还有 ${Math.max(0, removed.length - 2)} 段移除、${Math.max(0, added.length - 2)} 段新增；请看下方完整对照。`,
    );
  if (removed.some((part) => /如果|只有|除非|前提|条件|但是|然而/.test(part)))
    result.push("原文中的条件或限制发生移除，请特别核对含义是否改变。");
  return result.length ? result : ["正文有变化，请对照下方完整内容。"];
}

export function readableChanges(
  current: unknown,
  proposed: unknown,
  entityType: "course" | "knowledge",
): ReadableChange[] {
  const before = (current || {}) as Item;
  const after = (proposed || {}) as Item;
  const result: ReadableChange[] = [];
  const compare = (a: Item, b: Item, area: string, title: string) => {
    const details: string[] = [];
    if (text(a.title) !== text(b.title))
      details.push(`标题：${a.title || "未填写"} → ${b.title || "未填写"}`);
    if (text(a.body_md) !== text(b.body_md))
      details.push(...changedParagraphs(text(a.body_md), text(b.body_md)));
    if (sourceKey(a.source_refs) !== sourceKey(b.source_refs))
      details.push(
        `出处：${a.source_refs?.length || 0} → ${b.source_refs?.length || 0} 处，请核对引用是否仍能定位。`,
      );
    if (a.origin_kind !== b.origin_kind)
      details.push(
        `来源身份：${a.origin_kind || "未标"} → ${b.origin_kind || "未标"}`,
      );
    if (a.transformation !== b.transformation)
      details.push(
        `加工方式：${a.transformation || "未标"} → ${b.transformation || "未标"}`,
      );
    if (a.verification_status !== b.verification_status)
      details.push(
        `核验状态：${a.verification_status || "未标"} → ${b.verification_status || "未标"}`,
      );
    if (details.length) result.push({ kind: "changed", area, title, details });
  };
  compare(
    before,
    after,
    entityType === "course" ? "课程" : "知识卡",
    after.title || before.title || "未命名",
  );
  if (entityType === "knowledge") return result;
  if ((before as any).overview !== (after as any).overview)
    result.push({
      kind: "changed",
      area: "课程概览",
      title: after.title || "概览",
      details: ["概览有变化，请对照下方全文。"],
    });
  const oldTopics = new Map(
    (before.topics || []).map((item, index) => [
      item.id || `index:${index}`,
      item,
    ]),
  );
  const newTopics = new Map(
    (after.topics || []).map((item, index) => [
      item.id || `index:${index}`,
      item,
    ]),
  );
  for (const [id, topic] of newTopics) {
    const prior = oldTopics.get(id);
    if (!prior) {
      result.push({
        kind: "added",
        area: "主题",
        title: topic.title || id,
        details: [`新增 ${topic.blocks?.length || 0} 段讲义`],
      });
      continue;
    }
    compare(prior, topic, "主题", topic.title || id);
    const oldBlocks = new Map(
      (prior.blocks || []).map((item, index) => [
        item.id || `index:${index}`,
        item,
      ]),
    );
    const newBlocks = new Map(
      (topic.blocks || []).map((item, index) => [
        item.id || `index:${index}`,
        item,
      ]),
    );
    for (const [blockId, block] of newBlocks) {
      const old = oldBlocks.get(blockId);
      if (!old)
        result.push({
          kind: "added",
          area: `${topic.title || id} · 讲义`,
          title: block.title || blockId,
          details: [
            `新增正文：${text(block.body_md).slice(0, 150) || "空白"}`,
            `出处 ${block.source_refs?.length || 0} 处；来源身份 ${block.origin_kind || "未标"}；加工方式 ${block.transformation || "未标"}。`,
            ...(/ai|example/i.test(
              `${block.origin_kind} ${block.transformation}`,
            )
              ? ["此段标为 AI 示例，请核对是否被误当原文或真实案例。"]
              : []),
          ],
        });
      else
        compare(
          old,
          block,
          `${topic.title || id} · 讲义`,
          block.title || blockId,
        );
    }
    for (const [blockId, block] of oldBlocks)
      if (!newBlocks.has(blockId))
        result.push({
          kind: "removed",
          area: `${topic.title || id} · 讲义`,
          title: block.title || blockId,
          details: ["此段原有讲义将不再出现在拟采用版本。"],
        });
  }
  for (const [id, topic] of oldTopics)
    if (!newTopics.has(id))
      result.push({
        kind: "removed",
        area: "主题",
        title: topic.title || id,
        details: [
          `原有 ${topic.blocks?.length || 0} 段讲义将不再出现在拟采用版本。`,
        ],
      });
  return result;
}
