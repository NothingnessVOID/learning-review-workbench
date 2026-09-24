import React, { useCallback, useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { downloadUrl, localDraft, messageOf, requestId, rpc } from "./api";
import type {
  Card,
  Course,
  Draft,
  LearningState,
  Note,
  Permissions,
  Relation,
  SourceRef,
  Status,
  Topic,
} from "./types";

type Route = { page: string; id?: string; query?: string; blockId?: string };
type ComposerDraft = {
  text: string;
  type: string;
  relationId: string;
  requestId: string;
};
const emptyComposer = (): ComposerDraft => ({
  text: "",
  type: "quick",
  relationId: "",
  requestId: requestId(),
});
const ROUTE_RE = /^#(course|topic|card|note|draft)\/([^/?#]+)/;
function routeFromHash(): Route {
  const hash = decodeURI(location.hash || "#courses");
  const source = /^#source\/([^/?#]+)\/([^/?#]+)/.exec(hash);
  if (source) return { page: "source", id: source[1], blockId: source[2] };
  const match = ROUTE_RE.exec(hash);
  if (match) return { page: match[1], id: match[2] };
  if (hash.startsWith("#search"))
    return {
      page: "search",
      query: new URLSearchParams(hash.split("?")[1] || "").get("q") || "",
    };
  return { page: hash.slice(1) || "courses" };
}
function go(path: string) {
  location.hash = path;
}
function dateLabel(date?: string | null) {
  return date
    ? new Date(date).toLocaleDateString("zh-CN", {
        year: "numeric",
        month: "long",
        day: "numeric",
      })
    : "日期未记录";
}
function safeHref(href?: string) {
  if (!href) return undefined;
  try {
    const url = new URL(href, location.origin);
    return ["http:", "https:", "mailto:"].includes(url.protocol)
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}
function Markdown({ children }: { children: string }) {
  return (
    <div className="prose">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        components={{
          a: ({ href, children }) => {
            const url = safeHref(href);
            return url ? (
              <a href={url} target="_blank" rel="noopener noreferrer">
                {children}
              </a>
            ) : (
              <span>{children}</span>
            );
          },
          img: ({ alt }) => (
            <span className="remote-image-note">
              〔图片未自动加载：{alt || "无说明"}〕
            </span>
          ),
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
function humanLabel(value: string) {
  return (
    (
      {
        accepted: "已整理",
        ready: "可导入",
        duplicate: "重复",
        new_version: "新版本",
        unsupported: "不支持",
        pending: "待确认",
        confirmed: "已确认",
        draft: "待审核",
        rejected: "已拒绝",
        reverted: "已撤回",
        needs_review: "待核对",
        secondary_only: "二手来源，待核",
        source_text: "原文资料",
        main_teaching: "主题讲义",
        source_quote: "原文引述",
        source_locatable: "可定位原文",
        demo_material: "演示资料",
        transcript: "转写稿",
        cleaned_transcript: "清洗稿",
        peer_summary: "同修整理",
        original_book: "原书",
        other: "其他来源",
        reading: "在读",
        read: "读过",
        not_started: "未开始",
        can_explain: "能讲清",
        practiced: "已实践",
        local_user: "我",
        external_agent: "外部 Agent",
        method: "方法",
        model: "模型",
        concept: "概念",
        viewpoint: "观点",
        source: "原文",
        topic: "主题",
        course: "课程",
        knowledge: "知识卡",
        note: "记录",
      } as Record<string, string>
    )[value] || value
  );
}
function Pill({ children }: { children: React.ReactNode }) {
  return (
    <span className="pill">
      {typeof children === "string" ? humanLabel(children) : children}
    </span>
  );
}
function Empty({ children }: { children: React.ReactNode }) {
  return <div className="empty">{children}</div>;
}
function ErrorBox({ error, retry }: { error: string; retry?: () => void }) {
  return (
    <div className="error" role="alert">
      {error}{" "}
      {retry && (
        <button className="text-button" onClick={retry}>
          重试
        </button>
      )}
    </div>
  );
}
function useRemote<T>(
  tool: string,
  args: Record<string, unknown>,
  deps: unknown[],
  enabled = true,
) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [version, setVersion] = useState(0);
  const key = JSON.stringify(args);
  useEffect(() => {
    let alive = true;
    if (!enabled) {
      setData(null);
      setError("");
      setLoading(false);
      return () => {
        alive = false;
      };
    }
    setLoading(true);
    setError("");
    rpc<T>(tool, args)
      .then((result) => {
        if (alive) setData(result);
      })
      .catch((e) => {
        if (alive) setError(messageOf(e));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [tool, key, version, enabled, ...deps]);
  return { data, error, loading, refresh: () => setVersion((n) => n + 1) };
}

export default function App() {
  const [route, setRoute] = useState<Route>(routeFromHash);
  const [drawer, setDrawer] = useState(false);
  const [composerOpen, setComposerOpen] = useState(false);
  const [composer, setComposer] = useState<ComposerDraft>(() =>
    localDraft("workbench.quick-draft", emptyComposer()),
  );
  const [composerState, setComposerState] = useState<
    "idle" | "saving" | "saved" | "failed"
  >("idle");
  const [composerError, setComposerError] = useState("");
  const [fontSize, setFontSize] = useState(() =>
    Number(localStorage.getItem("workbench.font-size") || 18),
  );
  const [search, setSearch] = useState("");
  const [notice, setNotice] = useState("");
  const [change, setChange] = useState(0);
  const status = useRemote<Status>("get_status", {}, [change]);
  useEffect(() => {
    const handler = () => {
      setRoute(routeFromHash());
      setDrawer(false);
      window.scrollTo(0, 0);
    };
    addEventListener("hashchange", handler);
    return () => removeEventListener("hashchange", handler);
  }, []);
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setDrawer(false);
        setComposerOpen(false);
      }
    };
    addEventListener("keydown", handler);
    return () => removeEventListener("keydown", handler);
  }, []);
  useEffect(() => {
    localStorage.setItem("workbench.quick-draft", JSON.stringify(composer));
  }, [composer]);
  useEffect(() => {
    localStorage.setItem("workbench.font-size", String(fontSize));
    document.documentElement.style.setProperty(
      "--reader-size",
      `${fontSize}px`,
    );
  }, [fontSize]);
  useEffect(() => {
    if (route.page === "topic")
      setComposer((c) => (c.text ? c : { ...c, relationId: route.id || "" }));
    else if (route.page === "card")
      setComposer((c) => (c.text ? c : { ...c, relationId: route.id || "" }));
  }, [route.page, route.id]);
  const notify = (message: string) => {
    setNotice(message);
    setTimeout(() => setNotice(""), 4500);
  };
  const refreshed = () => setChange((n) => n + 1);
  const saveQuick = async () => {
    if (!composer.text.trim()) return;
    setComposerState("saving");
    setComposerError("");
    try {
      await rpc("create_note", {
        original_text: composer.text.trim(),
        type: composer.type,
        relation_ids: composer.relationId ? [composer.relationId] : [],
        client_request_id: composer.requestId,
      });
      setComposerState("saved");
      setComposer(emptyComposer());
      setComposerOpen(false);
      refreshed();
      notify("记录已保存");
    } catch (e) {
      setComposerState("failed");
      setComposerError(messageOf(e));
    }
  };
  const activeMain = ["courses", "course", "topic"].includes(route.page)
    ? "courses"
    : ["knowledge", "card"].includes(route.page)
      ? "knowledge"
      : ["notes", "note"].includes(route.page)
        ? "notes"
        : "";
  return (
    <div className="app-shell">
      <a
        href="#main"
        className="skip-link"
        onClick={(e) => {
          e.preventDefault();
          document.getElementById("main")?.focus();
        }}
      >
        跳到正文
      </a>
      <aside className={`sidebar ${drawer ? "is-open" : ""}`}>
        <div
          className="brand"
          onClick={() => go("courses")}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === "Enter") go("courses");
          }}
        >
          <span className="brand-mark">学</span>
          <span>
            <strong>学习与复盘</strong>
            <small>个人工作台</small>
          </span>
        </div>
        <nav aria-label="主导航" className="main-nav">
          {[
            ["courses", "课程", "01"],
            ["knowledge", "知识", "02"],
            ["notes", "我的记录", "03"],
          ].map(([id, label, no]) => (
            <a
              key={id}
              href={`#${id}`}
              className={activeMain === id ? "active" : ""}
            >
              <span className="nav-index">{no}</span>
              {label}
            </a>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <button className="quiet-nav" onClick={() => go("drafts")}>
            待审草稿{" "}
            {status.data?.counts.drafts ? (
              <b>{status.data.counts.drafts}</b>
            ) : null}
          </button>
          <button className="quiet-nav" onClick={() => go("import")}>
            导入资料
          </button>
          <button className="quiet-nav" onClick={() => go("settings")}>
            设置与备份
          </button>
          <div className="sidebar-rule" />
          <span className="small-muted">
            {status.data?.mode === "demo" ? "独立演示资料" : "本地私人资料"} ·{" "}
            {status.data?.read_only ? "只读" : "可保存"}
          </span>
        </div>
      </aside>
      {drawer && (
        <button
          className="drawer-scrim"
          aria-label="关闭菜单"
          onClick={() => setDrawer(false)}
        />
      )}
      <div className="workspace">
        <header className="topbar">
          <button
            className="mobile-menu"
            onClick={() => setDrawer(true)}
            aria-label="打开菜单"
          >
            ☰
          </button>
          <div className="breadcrumb">
            个人工作台 <span>／</span> {pageLabel(route.page)}
          </div>
          <form
            className="global-search"
            onSubmit={(e) => {
              e.preventDefault();
              go(`search?q=${encodeURIComponent(search.trim())}`);
            }}
          >
            <label className="sr-only" htmlFor="global-query">
              搜索资料
            </label>
            <input
              id="global-query"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="搜索课程、知识与记录"
            />
            <button aria-label="搜索" type="submit">
              ⌕
            </button>
          </form>
          <button className="top-action" onClick={() => setComposerOpen(true)}>
            ＋ <span>记一句</span>
          </button>
        </header>
        <main id="main" className="main-area" tabIndex={-1}>
          {status.error && (
            <ErrorBox error={status.error} retry={status.refresh} />
          )}
          {route.page === "courses" && <Courses key={change} notify={notify} />}
          {route.page === "course" && route.id && (
            <CoursePage key={route.id} id={route.id} notify={notify} />
          )}
          {route.page === "topic" && route.id && (
            <TopicPage
              key={`${route.id}-${change}`}
              id={route.id}
              notify={notify}
              openComposer={() => setComposerOpen(true)}
            />
          )}
          {route.page === "knowledge" && <Knowledge key={change} />}
          {route.page === "card" && route.id && (
            <CardPage
              key={`${route.id}-${change}`}
              id={route.id}
              notify={notify}
              openComposer={() => setComposerOpen(true)}
            />
          )}
          {route.page === "notes" && <Notes key={change} />}
          {route.page === "note" && route.id && (
            <NotePage key={route.id} id={route.id} notify={notify} />
          )}
          {route.page === "drafts" && <Drafts notify={notify} />}
          {route.page === "draft" && route.id && (
            <DraftPage key={route.id} id={route.id} notify={notify} />
          )}
          {route.page === "search" && <SearchPage query={route.query || ""} />}
          {route.page === "source" && route.id && route.blockId && (
            <>
              <button className="back" onClick={() => go("search")}>
                ← 返回搜索
              </button>
              <PageHead
                eyebrow="固定来源版本"
                title="原文片段"
                description="此处保留原始段落，可继续展开上下文。"
              />
              <SourceReader
                refData={{
                  source_document_id: "",
                  source_version_id: route.id,
                  source_block_id: route.blockId,
                }}
              />
            </>
          )}
          {route.page === "import" && <ImportPage notify={notify} />}
          {route.page === "settings" && (
            <Settings
              status={status.data}
              refresh={status.refresh}
              notify={notify}
            />
          )}
        </main>
      </div>
      {notice && (
        <div role="status" className="toast">
          {notice}
        </div>
      )}
      {composerOpen && (
        <div
          className="modal-backdrop"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setComposerOpen(false);
          }}
        >
          <section
            className="modal compose-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="compose-title"
          >
            <div className="modal-top">
              <span className="eyebrow">随手记</span>
              <button
                className="icon-button"
                onClick={() => setComposerOpen(false)}
                aria-label="关闭"
              >
                ×
              </button>
            </div>
            <h2 id="compose-title">先把这一句留下</h2>
            <p className="muted">
              此刻不必整理完整。原话会独立保存，之后还能补充和复盘。
            </p>
            <label htmlFor="quick-text" className="sr-only">
              记录内容
            </label>
            <textarea
              id="quick-text"
              autoFocus
              rows={6}
              value={composer.text}
              onChange={(e) => {
                setComposer({
                  ...composer,
                  text: e.target.value,
                  requestId: requestId(),
                });
                setComposerState("idle");
                setComposerError("");
              }}
              placeholder="刚才发生了什么，或者想到什么？"
            />
            <div className="compose-controls">
              <label>
                类型{" "}
                <select
                  value={composer.type}
                  onChange={(e) =>
                    setComposer({
                      ...composer,
                      type: e.target.value,
                      requestId: requestId(),
                    })
                  }
                >
                  <option value="quick">随手记</option>
                  <option value="understanding">我的理解</option>
                  <option value="question">疑问</option>
                  <option value="event">事件</option>
                  <option value="seed">内容种子</option>
                </select>
              </label>
              {composer.relationId && (
                <button
                  className="relation-chip"
                  onClick={() =>
                    setComposer({
                      ...composer,
                      relationId: "",
                      requestId: requestId(),
                    })
                  }
                  title="移除自动关联"
                >
                  关联当前内容 ×
                </button>
              )}
            </div>
            {composerError && (
              <ErrorBox error={composerError} retry={saveQuick} />
            )}
            <div className="modal-footer">
              <span className="save-state" role="status">
                {composerState === "saving"
                  ? "正在保存…"
                  : composerState === "saved"
                    ? "已保存"
                    : composerState === "failed"
                      ? "保存失败，草稿已留在本机"
                      : "只需一句话"}
              </span>
              <div>
                {composerState === "failed" && (
                  <button
                    className="text-button"
                    onClick={() =>
                      navigator.clipboard
                        .writeText(composer.text)
                        .then(() => notify("已复制记录"))
                    }
                  >
                    复制文字
                  </button>
                )}
                <button
                  className="primary"
                  onClick={saveQuick}
                  disabled={!composer.text.trim() || composerState === "saving"}
                >
                  {composerState === "failed" ? "重试保存" : "保存记录"}
                </button>
              </div>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

function pageLabel(page: string) {
  return (
    (
      {
        courses: "课程",
        course: "课程",
        topic: "主题讲义",
        knowledge: "知识",
        card: "知识卡",
        notes: "我的记录",
        note: "记录详情",
        drafts: "待审草稿",
        draft: "差异审核",
        import: "导入资料",
        settings: "设置与备份",
        search: "搜索",
        source: "原文",
      } as Record<string, string>
    )[page] || "课程"
  );
}
function PageHead({
  eyebrow,
  title,
  description,
  aside,
}: {
  eyebrow: string;
  title: string;
  description?: string;
  aside?: React.ReactNode;
}) {
  return (
    <div className="page-head">
      <div>
        <span className="eyebrow">{eyebrow}</span>
        <h1>{title}</h1>
        {description && <p>{description}</p>}
      </div>
      {aside && <div className="head-aside">{aside}</div>}
    </div>
  );
}

function Courses({ notify }: { notify: (s: string) => void }) {
  const [query, setQuery] = useState("");
  const [series, setSeries] = useState("");
  const { data, error, loading, refresh } = useRemote<{
    items: Course[];
    series: string[];
  }>("list_courses", { query, series }, []);
  const recent = useMemo(
    () =>
      (data?.items || [])
        .filter(
          (c) =>
            c.learning_state?.position?.topic_id ||
            c.learning_state?.status === "reading",
        )
        .sort((a, b) =>
          (b.learning_state?.updated_at || "").localeCompare(
            a.learning_state?.updated_at || "",
          ),
        )[0],
    [data],
  );
  return (
    <>
      <PageHead
        eyebrow="课程 · 按主题走进原文"
        title="继续学习，从这里开始"
        description="选一门课，沿着主题读下去。每处整理都能回到来源。"
      />
      {recent && (
        <section className="continue">
          <div>
            <span className="eyebrow">上次读到</span>
            <h2>{recent.title}</h2>
            <p>
              {recent.series} · {dateLabel(recent.course_date)}
            </p>
          </div>
          <button
            className="primary"
            onClick={() =>
              go(
                recent.learning_state?.position?.topic_id
                  ? `topic/${recent.learning_state.position.topic_id}`
                  : `course/${recent.id}`,
              )
            }
          >
            继续阅读 →
          </button>
        </section>
      )}
      <div className="section-heading">
        <h2>全部课程</h2>
        <span>{data?.items.length ?? 0} 门</span>
      </div>
      <div className="filters">
        <label className="sr-only" htmlFor="course-query">
          课程标题或日期
        </label>
        <input
          id="course-query"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="输入课程标题或日期"
        />
        <label className="sr-only" htmlFor="course-series">
          来源系列
        </label>
        <select
          id="course-series"
          value={series}
          onChange={(e) => setSeries(e.target.value)}
        >
          <option value="">全部系列</option>
          {(data?.series || []).map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </div>
      {error && <ErrorBox error={error} retry={refresh} />}{" "}
      {loading && <p className="muted">正在读取课程…</p>}
      {!loading && !error && !data?.items.length && (
        <Empty>这里还没有符合条件的课程。可以从“导入资料”加入来源。</Empty>
      )}
      <div className="course-list">
        {data?.items.map((course) => (
          <button
            className="course-row"
            key={course.id}
            onClick={() => go(`course/${course.id}`)}
          >
            <span className="course-date">
              {course.course_date ? dateLabel(course.course_date) : "日期待核"}
            </span>
            <span className="course-main">
              <span className="row-kicker">
                {course.series || "未分类系列"} · {course.topic_count} 个主题
              </span>
              <strong>{course.title}</strong>
              <span className="row-summary">
                {course.overview || "概览尚待整理"}
              </span>
            </span>
            <span className="course-tail">
              <Pill>{course.processing_status}</Pill>
              <span className="arrow">↗</span>
            </span>
          </button>
        ))}
      </div>
    </>
  );
}

function CoursePage({
  id,
  notify,
}: {
  id: string;
  notify: (s: string) => void;
}) {
  const {
    data: course,
    error,
    loading,
    refresh,
  } = useRemote<Course>("get_course", { course_id: id }, []);
  const [busy, setBusy] = useState(false);
  const state = course?.learning_state;
  const setState = async (status: string) => {
    if (!course) return;
    setBusy(true);
    try {
      await rpc("set_learning_state", {
        object_id: course.id,
        status,
        expected_revision: state?.revision,
      });
      refresh();
      notify("学习状态已保存");
    } catch (e) {
      notify(messageOf(e));
    } finally {
      setBusy(false);
    }
  };
  if (error) return <ErrorBox error={error} retry={refresh} />;
  if (loading || !course) return <p className="muted">正在读取课程…</p>;
  const topics = (course.topics || [])
    .slice()
    .sort((a, b) => a.order - b.order);
  return (
    <>
      <button className="back" onClick={() => go("courses")}>
        ← 返回课程
      </button>
      <PageHead
        eyebrow={`${course.series || "课程"} · ${dateLabel(course.course_date)}`}
        title={course.title}
        description={course.overview || "课程概览尚待整理"}
        aside={
          <div className="status-stack">
            <Pill>{course.processing_status}</Pill>
            <Pill>{course.verification_status}</Pill>
          </div>
        }
      />
      {course.pending_drafts?.length ? (
        <div className="pending-course-drafts">
          <div>
            <span className="eyebrow">已有整理草稿 · 等待人工核对</span>
            <p>
              这门课已有拟整理的讲义。可先预览主题地图、正文与原文出处，再决定是否采用。
            </p>
          </div>
          <div>
            {course.pending_drafts.map((draft) => (
              <button
                className="secondary"
                key={draft.id}
                onClick={() => go(`draft/${draft.id}`)}
              >
                查看待审讲义 ↗
              </button>
            ))}
          </div>
        </div>
      ) : null}
      <section className="paper-block">
        <div className="section-heading">
          <h2>本课概览</h2>
          <span>{topics.length} 个主题</span>
        </div>
        <p className="reader-intro">
          {course.overview || "这门课尚无可读的概览。"}
        </p>
      </section>
      <section className="paper-block">
        <div className="section-heading">
          <h2>主题目录</h2>
          <span>循序阅读，也可以直接进入</span>
        </div>
        {topics.length ? (
          <TopicTree topics={topics} />
        ) : (
          <Empty>主题讲义尚待整理，原始材料与整理状态会继续保留。</Empty>
        )}
      </section>
      <div className="learning-bar">
        <span>我的学习状态：{humanLabel(state?.status || "not_started")}</span>
        <div>
          <button
            disabled={busy}
            className="secondary"
            onClick={() => setState("reading")}
          >
            标记在读
          </button>
          <button
            disabled={busy}
            className="secondary"
            onClick={() => setState("read")}
          >
            标记读过
          </button>
        </div>
      </div>
    </>
  );
}
function TopicTree({ topics }: { topics: Topic[] }) {
  const [closed, setClosed] = useState<Set<string>>(() => new Set());
  const roots = topics.filter(
    (t) => !t.parent_id || !topics.some((p) => p.id === t.parent_id),
  );
  const children = (id: string) => topics.filter((t) => t.parent_id === id);
  const toggle = (id: string) =>
    setClosed((current) => {
      const next = new Set(current);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  const render = (topic: Topic, depth: number): React.ReactNode => {
    const nested = children(topic.id);
    return (
      <li key={topic.id}>
        <div
          className="topic-line"
          style={{ paddingLeft: `${12 + depth * 22}px` }}
        >
          <button
            className="topic-link"
            onClick={() => go(`topic/${topic.id}`)}
          >
            <span className="topic-dot">{depth ? "└" : "○"}</span>
            <span>{topic.title}</span>
            <span className="arrow">↗</span>
          </button>
          {nested.length > 0 && (
            <button
              className="topic-toggle"
              onClick={() => toggle(topic.id)}
              aria-expanded={!closed.has(topic.id)}
              aria-label={`${closed.has(topic.id) ? "展开" : "收起"}“${topic.title}”的子主题`}
            >
              {closed.has(topic.id) ? "＋" : "－"}
            </button>
          )}
        </div>
        {nested.length > 0 && !closed.has(topic.id) && (
          <ul>{nested.map((t) => render(t, depth + 1))}</ul>
        )}
      </li>
    );
  };
  return <ul className="topic-tree">{roots.map((t) => render(t, 0))}</ul>;
}

function TopicPage({
  id,
  notify,
  openComposer,
}: {
  id: string;
  notify: (s: string) => void;
  openComposer: () => void;
}) {
  const {
    data: topic,
    error,
    loading,
    refresh,
  } = useRemote<Topic>("get_topic", { topic_id: id }, []);
  const [activeRef, setActiveRef] = useState<SourceRef | null>(null);
  const [busy, setBusy] = useState(false);
  const [scrollState, setScrollState] = useState<LearningState | null>(null);
  useEffect(() => {
    if (topic) setScrollState(topic.learning_state || null);
  }, [topic]);
  useEffect(() => {
    if (!topic) return;
    const position = topic.course?.learning_state?.position;
    if (position?.topic_id === topic.id && position.scroll) {
      const timer = setTimeout(
        () => window.scrollTo({ top: position.scroll, behavior: "instant" }),
        80,
      );
      return () => clearTimeout(timer);
    }
  }, [topic?.id]);
  useEffect(() => {
    if (!topic) return;
    const onScroll = () => {
      clearTimeout((onScroll as any).timer);
      (onScroll as any).timer = setTimeout(() => {
        rpc("set_learning_state", {
          object_id: topic.course_id,
          position: { topic_id: topic.id, scroll: window.scrollY },
        }).catch(() => {});
      }, 900);
    };
    addEventListener("scroll", onScroll, { passive: true });
    return () => {
      removeEventListener("scroll", onScroll);
      clearTimeout((onScroll as any).timer);
    };
  }, [topic?.id]);
  const setState = async (status: string) => {
    if (!topic) return;
    setBusy(true);
    try {
      const result = await rpc<LearningState>("set_learning_state", {
        object_id: topic.id,
        status,
        expected_revision: scrollState?.revision,
      });
      setScrollState(result);
      notify("学习状态已保存");
    } catch (e) {
      notify(messageOf(e));
    } finally {
      setBusy(false);
    }
  };
  if (error) return <ErrorBox error={error} retry={refresh} />;
  if (loading || !topic) return <p className="muted">正在读取主题…</p>;
  const refs = topic.blocks.flatMap((b) => b.source_refs || []);
  return (
    <>
      <button className="back" onClick={() => go(`course/${topic.course_id}`)}>
        ← 返回课程地图
      </button>
      <PageHead
        eyebrow={`${topic.course?.series || "课程"} · 主题讲义`}
        title={topic.title}
        description={topic.course?.title}
      />
      <div className="reading-layout">
        <article className="reading-paper">
          <div className="reading-meta">
            <Pill>{topic.content_kind}</Pill>
            <span>资料整理层</span>
          </div>
          {topic.blocks.length ? (
            topic.blocks.map((block) => (
              <section className="teaching-block" key={block.id}>
                <div className="block-label">
                  {blockType(block.type)}{" "}
                  <span>· {humanLabel(block.origin_kind || "整理内容")}</span>
                </div>
                <Markdown>{block.body_md}</Markdown>
                {block.verification_status && (
                  <span className="verification">
                    {humanLabel(block.verification_status)}
                  </span>
                )}
                {block.source_refs?.length > 0 && (
                  <div className="block-sources">
                    {block.source_refs.map((ref, i) => (
                      <button
                        key={`${ref.source_version_id}-${ref.source_block_id}-${i}`}
                        onClick={() => setActiveRef(ref)}
                      >
                        查看出处 {i + 1} ↗
                      </button>
                    ))}
                  </div>
                )}
              </section>
            ))
          ) : (
            <Empty>这段主题的讲义还没有整理完成。</Empty>
          )}
          <div className="reader-end">
            <span>读到这里，可以留下一句自己的理解。</span>
            <button className="primary" onClick={openComposer}>
              写下我的理解
            </button>
          </div>
        </article>
        <aside className="reading-aside">
          <div className="aside-section">
            <span className="eyebrow">回到资料</span>
            <h3>出处与关联</h3>
            <p>每段讲义的“查看出处”对应到保存的来源版本。</p>
            <button
              className="aside-link"
              disabled={!refs.length}
              onClick={() => setActiveRef(refs[0])}
            >
              原文片段 <span>{refs.length}</span>
            </button>
            <div className="aside-title">相关知识卡</div>
            {topic.knowledge_cards?.length ? (
              topic.knowledge_cards.map((card) => (
                <button
                  key={card.id}
                  className="aside-link"
                  onClick={() => go(`card/${card.id}`)}
                >
                  {card.title}
                  <span>↗</span>
                </button>
              ))
            ) : (
              <p className="small-muted">暂未关联</p>
            )}
            <div className="aside-title">我的记录</div>
            {topic.notes?.length ? (
              topic.notes.map((note) => (
                <button
                  key={note.id}
                  className="aside-link"
                  onClick={() => go(`note/${note.id}`)}
                >
                  {note.original_text.slice(0, 22)}
                  <span>↗</span>
                </button>
              ))
            ) : (
              <p className="small-muted">尚无记录</p>
            )}
          </div>
          <div className="aside-section">
            <div className="aside-title">学习状态</div>
            <p>{humanLabel(scrollState?.status || "not_started")}</p>
            <div className="aside-actions">
              <button
                className="secondary"
                disabled={busy}
                onClick={() => setState("reading")}
              >
                在读
              </button>
              <button
                className="secondary"
                disabled={busy}
                onClick={() => setState("read")}
              >
                读过
              </button>
            </div>
          </div>
        </aside>
      </div>
      {activeRef && (
        <SourceDialog refData={activeRef} close={() => setActiveRef(null)} />
      )}
    </>
  );
}
function blockType(type: string) {
  return (
    (
      {
        source_quote: "原文引述",
        main_teaching: "核心讲义",
        question: "本段的问题",
        explanation: "核心解释",
        reasoning: "推理展开",
        case: "讲者案例",
        distinction: "重要区别",
        supplement: "补充",
        background: "背景",
        source: "原文",
      } as Record<string, string>
    )[type] || type
  );
}
function SourceDialog({
  refData,
  close,
}: {
  refData: SourceRef;
  close: () => void;
}) {
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    addEventListener("keydown", handler);
    return () => removeEventListener("keydown", handler);
  }, [close]);
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <section
        className="modal source-modal"
        role="dialog"
        aria-modal="true"
        aria-label="来源原文"
      >
        <div className="modal-top">
          <span className="eyebrow">原文核对 · 固定来源版本</span>
          <button
            className="icon-button"
            autoFocus
            onClick={close}
            aria-label="关闭原文"
          >
            ×
          </button>
        </div>
        <SourceReader refData={refData} />
      </section>
    </div>
  );
}
function SourceReader({ refData }: { refData: SourceRef }) {
  const [documentInfo, setDocumentInfo] = useState<any>(null);
  const [blocks, setBlocks] = useState<any[]>([]);
  const [start, setStart] = useState(0);
  const [next, setNext] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const loadInitial = useCallback(async () => {
    setLoading(true);
    setError("");
    setBlocks([]);
    try {
      const result = await rpc<any>("get_source_excerpt", {
        source_version_id: refData.source_version_id,
        source_block_id: refData.source_block_id,
        limit: 4,
      });
      setDocumentInfo(result.source_document);
      setBlocks(result.blocks || []);
      setStart(result.actual_range?.start ?? result.blocks?.[0]?.order ?? 0);
      setNext(result.next_cursor);
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setLoading(false);
    }
  }, [refData.source_version_id, refData.source_block_id]);
  useEffect(() => {
    void loadInitial();
  }, [loadInitial]);
  const more = async (direction: "before" | "after") => {
    setBusy(true);
    setError("");
    try {
      const cursor =
        direction === "before" ? String(Math.max(0, start - 4)) : next;
      if (cursor === null) return;
      const limit = direction === "before" ? start - Number(cursor) : 4;
      const result = await rpc<any>("get_source_excerpt", {
        source_version_id: refData.source_version_id,
        cursor,
        limit,
      });
      setBlocks((current) => {
        const seen = new Set(current.map((b) => b.id));
        return direction === "before"
          ? [
              ...(result.blocks || []).filter((b: any) => !seen.has(b.id)),
              ...current,
            ]
          : [
              ...current,
              ...(result.blocks || []).filter((b: any) => !seen.has(b.id)),
            ];
      });
      if (direction === "before")
        setStart(result.actual_range?.start ?? Number(cursor));
      else setNext(result.next_cursor);
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <h2>
        {documentInfo?.original_name || documentInfo?.title || "来源原文"}
      </h2>
      <p className="muted">
        版本 {refData.source_version_id} · 此处显示保存的原文片段，不替换讲义。
      </p>
      {error && <ErrorBox error={error} retry={loadInitial} />}{" "}
      {loading && <p>正在读取原文…</p>}
      {start > 0 && (
        <button
          className="secondary"
          disabled={busy}
          onClick={() => more("before")}
        >
          ↑ 查看前文
        </button>
      )}
      {blocks.map((block) => (
        <div className="source-block" key={block.id}>
          <div className="small-muted">
            {Array.isArray(block.title_path)
              ? block.title_path.join(" › ")
              : block.title_path || "原文"}{" "}
            {block.line_start
              ? `· 行 ${block.line_start}${block.line_end ? `–${block.line_end}` : ""}`
              : ""}
          </div>
          <p>{block.text}</p>
        </div>
      ))}
      {next && (
        <button
          className="secondary"
          disabled={busy}
          onClick={() => more("after")}
        >
          继续展开后文 ↓
        </button>
      )}
    </>
  );
}

function Knowledge() {
  const [query, setQuery] = useState("");
  const [type, setType] = useState("");
  const { data, error, loading, refresh } = useRemote<{ items: Card[] }>(
    "list_knowledge",
    { query, type },
    [],
  );
  return (
    <>
      <PageHead
        eyebrow="知识 · 跨课程的索引"
        title="从一张卡，找到多处讲述"
        description="资料解释和自己的理解各有位置。相同词语的不同语境保留来源。"
      />
      <div className="filters">
        <input
          aria-label="搜索知识卡"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索概念、别名、方法"
        />
        <select
          aria-label="筛选卡片类型"
          value={type}
          onChange={(e) => setType(e.target.value)}
        >
          <option value="">全部类型</option>
          <option value="model">模型</option>
          <option value="concept">概念</option>
          <option value="viewpoint">观点</option>
          <option value="method">方法</option>
        </select>
      </div>
      {error && <ErrorBox error={error} retry={refresh} />}{" "}
      {loading && <p className="muted">正在读取知识卡…</p>}
      {!loading && !error && !data?.items.length && (
        <Empty>尚无匹配的知识卡。</Empty>
      )}
      <div className="card-grid">
        {data?.items.map((card) => (
          <button
            key={card.id}
            className="knowledge-card"
            onClick={() => go(`card/${card.id}`)}
          >
            <span className="row-kicker">
              {humanLabel(card.original_type || card.type)} ·{" "}
              {card.topic_ids.length} 处主题
            </span>
            <h2>{card.title}</h2>
            <p>
              {card.original_name && card.original_name !== card.title
                ? `原名：${card.original_name}`
                : card.aliases?.join("、") || "查看资料与出处"}
            </p>
            <span className="card-bottom">
              {humanLabel(card.verification_status)}
              <span>阅读 ↗</span>
            </span>
          </button>
        ))}
      </div>
    </>
  );
}
function CardPage({
  id,
  notify,
  openComposer,
}: {
  id: string;
  notify: (s: string) => void;
  openComposer: () => void;
}) {
  const {
    data: card,
    error,
    loading,
    refresh,
  } = useRemote<Card>("get_knowledge_card", { card_id: id }, []);
  const [ref, setRef] = useState<SourceRef | null>(null);
  if (error) return <ErrorBox error={error} retry={refresh} />;
  if (loading || !card) return <p className="muted">正在读取知识卡…</p>;
  return (
    <>
      <button className="back" onClick={() => go("knowledge")}>
        ← 返回知识
      </button>
      <PageHead
        eyebrow={`知识卡 · ${humanLabel(card.original_type || card.type)}`}
        title={card.title}
        description={
          card.aliases?.length ? `别名：${card.aliases.join("、")}` : undefined
        }
      />
      <div className="reading-layout">
        <article className="reading-paper">
          <div className="reading-meta">
            <Pill>资料整理层</Pill>
            <span>{humanLabel(card.verification_status)}</span>
          </div>
          {card.original_name && (
            <p className="source-name">原名：{card.original_name}</p>
          )}
          <Markdown>{card.body_md || "这张卡的资料正文尚待整理。"}</Markdown>
          <div className="block-sources">
            {card.source_refs?.map((s, i) => (
              <button key={i} onClick={() => setRef(s)}>
                查看出处 {i + 1} ↗
              </button>
            ))}
          </div>
          <div className="reader-end">
            <span>我的学习层</span>
            <button className="primary" onClick={openComposer}>
              写下理解或问题
            </button>
          </div>
          {card.notes?.length ? (
            card.notes.map((n) => (
              <button
                key={n.id}
                className="note-inline"
                onClick={() => go(`note/${n.id}`)}
              >
                {n.original_text}
                <small>{dateLabel(n.created_at)}</small>
              </button>
            ))
          ) : (
            <p className="small-muted">还没有与这张卡关联的个人记录。</p>
          )}
        </article>
        <aside className="reading-aside">
          <div className="aside-section">
            <span className="eyebrow">关联课程</span>
            <h3>不同课程中的讲述</h3>
            {card.topics?.length ? (
              card.topics.map((t) => (
                <button
                  key={t.id}
                  className="aside-link"
                  onClick={() => go(`topic/${t.id}`)}
                >
                  {t.title}
                  <span>↗</span>
                </button>
              ))
            ) : (
              <p className="small-muted">暂无关联主题</p>
            )}
          </div>
        </aside>
      </div>
      {ref && <SourceDialog refData={ref} close={() => setRef(null)} />}
    </>
  );
}

const noteTypes: Record<string, string> = {
  quick: "随手记",
  understanding: "我的理解",
  question: "疑问",
  event: "事件",
  feedback: "后续反馈",
  seed: "内容种子",
};
function Notes() {
  const [type, setType] = useState("");
  const [includeArchived, setIncludeArchived] = useState(false);
  const { data, error, loading, refresh } = useRemote<{
    items: Note[];
    next_cursor: string | null;
  }>("list_notes", { type, limit: 100, include_archived: includeArchived }, []);
  return (
    <>
      <PageHead
        eyebrow="我的记录 · 私人时间线"
        title="每一次想起，都有地方可回"
        description="原话留在原处。补充、行动反馈和外部复盘接在后面。"
      />
      <div className="filters">
        <select
          aria-label="筛选记录类型"
          value={type}
          onChange={(e) => setType(e.target.value)}
        >
          <option value="">全部记录</option>
          {Object.entries(noteTypes).map(([key, value]) => (
            <option key={key} value={key}>
              {value}
            </option>
          ))}
        </select>
        <label className="check-row">
          <input
            type="checkbox"
            checked={includeArchived}
            onChange={(e) => setIncludeArchived(e.target.checked)}
          />
          含已归档
        </label>
      </div>
      {error && <ErrorBox error={error} retry={refresh} />}{" "}
      {loading && <p className="muted">正在读取记录…</p>}
      {!loading && !error && !data?.items.length && (
        <Empty>目前还没有记录。随时点右上角“记一句”开始。</Empty>
      )}
      <div className="timeline">
        {data?.items.map((note) => (
          <button
            className="timeline-item"
            onClick={() => go(`note/${note.id}`)}
            key={note.id}
          >
            <span className="timeline-date">{dateLabel(note.created_at)}</span>
            <span className="timeline-body">
              <small>
                {noteTypes[note.type] || note.type} · 私人
                {note.archived ? " · 已归档" : ""}
              </small>
              <strong>{note.original_text}</strong>
              <span>查看原话与后续 ↗</span>
            </span>
          </button>
        ))}
      </div>
      {data?.next_cursor && (
        <p className="small-muted">还有较早记录；可以通过搜索查找。</p>
      )}
    </>
  );
}
function NotePage({ id, notify }: { id: string; notify: (s: string) => void }) {
  const {
    data: note,
    error,
    loading,
    refresh,
  } = useRemote<Note>("get_note", { note_id: id }, []);
  const [feedback, setFeedback] = useState(() =>
    localDraft(`workbench.feedback.${id}`, {
      text: "",
      requestId: requestId(),
    }),
  );
  const [review, setReview] = useState(() =>
    localDraft(`workbench.review.${id}`, {
      text: "",
      method: "",
      requestId: requestId(),
    }),
  );
  const [busy, setBusy] = useState("");
  const [writeError, setWriteError] = useState("");
  useEffect(() => {
    localStorage.setItem(`workbench.feedback.${id}`, JSON.stringify(feedback));
  }, [id, feedback]);
  useEffect(() => {
    localStorage.setItem(`workbench.review.${id}`, JSON.stringify(review));
  }, [id, review]);
  const saveFeedback = async () => {
    if (!feedback.text.trim()) return;
    setBusy("feedback");
    setWriteError("");
    try {
      await rpc("create_note", {
        original_text: feedback.text.trim(),
        type: "feedback",
        parent_note_id: id,
        client_request_id: feedback.requestId,
      });
      setFeedback({ text: "", requestId: requestId() });
      refresh();
      notify("后续反馈已保存");
    } catch (e) {
      setWriteError(messageOf(e));
    } finally {
      setBusy("");
    }
  };
  const saveReview = async () => {
    if (!review.text.trim()) return;
    setBusy("review");
    setWriteError("");
    try {
      await rpc("save_review_result", {
        note_ids: [id],
        body_md: review.text.trim(),
        method_name: review.method.trim() || undefined,
        client_request_id: review.requestId,
      });
      setReview({ text: "", method: "", requestId: requestId() });
      refresh();
      notify("外部复盘结果已归档，原始记录仍保留");
    } catch (e) {
      setWriteError(messageOf(e));
    } finally {
      setBusy("");
    }
  };
  const archive = async () => {
    if (!note) return;
    try {
      await rpc("archive_note", {
        note_id: id,
        expected_revision: note.revision,
        archived: !note.archived,
      });
      notify(note.archived ? "记录已恢复" : "记录已归档，可在“含已归档”中找回");
      go("notes");
    } catch (e) {
      notify(messageOf(e));
    }
  };
  if (error) return <ErrorBox error={error} retry={refresh} />;
  if (loading || !note) return <p className="muted">正在读取记录…</p>;
  return (
    <>
      <button className="back" onClick={() => go("notes")}>
        ← 返回我的记录
      </button>
      <PageHead
        eyebrow={`${noteTypes[note.type] || note.type} · ${dateLabel(note.created_at)}`}
        title="一条真实的记录"
        description="原话、整理结果和后来发生的事，按时间留在一起。"
      />
      <div className="note-detail">
        <section className="original-note">
          <span className="eyebrow">
            原始输入 · {humanLabel(note.author_type)}
            {note.archived ? " · 已归档" : ""}
          </span>
          <p>{note.original_text}</p>
          <span className="small-muted">
            仅自己可见 · {new Date(note.created_at).toLocaleString("zh-CN")}
          </span>
        </section>
        {note.relations?.length ? (
          <section className="paper-block">
            <h2>关联资料</h2>
            <div className="relation-list">
              {note.relations.map((r) => (
                <div key={r.id}>
                  <span>
                    {r.kind || "关联"}：{r.to_id || r.from_id}
                  </span>
                  <span>{humanLabel(r.status || "pending")}</span>
                </div>
              ))}
            </div>
          </section>
        ) : null}
        <div className="section-heading">
          <h2>后续时间线</h2>
          <span>保留变化，不覆盖当时的自己</span>
        </div>
        {!note.reviews?.length && !note.followups?.length && (
          <Empty>目前还没有后续。稍后回来也来得及。</Empty>
        )}
        {note.reviews?.map((r) => (
          <section className="timeline-panel" key={r.id}>
            <span className="eyebrow">
              外部复盘 · {dateLabel(r.created_at)}
            </span>
            {r.method_name && (
              <p className="small-muted">
                方法：{r.method_name}
                {r.method_version ? ` · ${r.method_version}` : ""}
              </p>
            )}
            <Markdown>{r.body_md}</Markdown>
            {r.gaps?.length ? (
              <p className="small-muted">
                待核：{r.gaps.map(String).join("、")}
              </p>
            ) : null}
          </section>
        ))}
        {note.followups?.map((f) => (
          <button
            className="timeline-panel followup-panel"
            key={f.id}
            onClick={() => go(`note/${f.id}`)}
          >
            <span className="eyebrow">
              后续反馈 · {dateLabel(f.created_at)}
            </span>
            <p>{f.original_text}</p>
            <span className="small-muted">查看这条记录 ↗</span>
          </button>
        ))}
        <section className="entry-panel">
          <h2>补一条后续</h2>
          <p className="muted">后来做了什么、结果如何，可以只写一句。</p>
          <textarea
            rows={4}
            value={feedback.text}
            onChange={(e) => {
              setFeedback({
                ...feedback,
                text: e.target.value,
                requestId: requestId(),
              });
              setWriteError("");
            }}
            placeholder="后来……"
          />
          <div className="entry-action">
            <button
              className="primary"
              disabled={busy !== "" || !feedback.text.trim()}
              onClick={saveFeedback}
            >
              保存后续反馈
            </button>
          </div>
        </section>
        <section className="entry-panel">
          <h2>保存外部复盘</h2>
          <p className="muted">
            粘贴 Agent
            返回的结果。它会作为独立版本保存，原话不会被替换。若未使用完整方法，请不要填写其名称。
          </p>
          <input
            value={review.method}
            onChange={(e) => {
              setReview({
                ...review,
                method: e.target.value,
                requestId: requestId(),
              });
              setWriteError("");
            }}
            placeholder="方法名称（可留空）"
            aria-label="复盘方法名称"
          />
          <textarea
            rows={8}
            value={review.text}
            onChange={(e) => {
              setReview({
                ...review,
                text: e.target.value,
                requestId: requestId(),
              });
              setWriteError("");
            }}
            placeholder="粘贴外部复盘结果（Markdown 可用）"
          />
          <div className="entry-action">
            <button
              className="primary"
              disabled={busy !== "" || !review.text.trim()}
              onClick={saveReview}
            >
              归档复盘结果
            </button>
          </div>
        </section>
        {writeError && (
          <ErrorBox
            error={`保存失败，内容已留在本机。${writeError}`}
            retry={busy ? undefined : feedback.text ? saveFeedback : saveReview}
          />
        )}
        <button className="text-button subdued" onClick={archive}>
          {note.archived ? "恢复这条记录" : "归档这条记录"}
        </button>
      </div>
    </>
  );
}

function Drafts({ notify }: { notify: (s: string) => void }) {
  const { data, error, loading, refresh } = useRemote<{ items: Draft[] }>(
    "list_drafts",
    {},
    [],
  );
  const relations = useRemote<{ items: Relation[] }>("list_relations", {}, []);
  const [busy, setBusy] = useState("");
  const pending =
    relations.data?.items.filter((r) => r.status === "pending") || [];
  const reviewRelation = async (
    id: string,
    status: "confirmed" | "rejected",
  ) => {
    setBusy(id);
    try {
      await rpc("review_relation", { relation_id: id, status });
      relations.refresh();
      notify(status === "confirmed" ? "关联已确认" : "关联已拒绝");
    } catch (e) {
      notify(messageOf(e));
    } finally {
      setBusy("");
    }
  };
  return (
    <>
      <PageHead
        eyebrow="审阅 · 人工确认"
        title="待审草稿"
        description="外部整理先停在这里。核对差异和来源后，再决定采用。"
      />
      {error && <ErrorBox error={error} retry={refresh} />}{" "}
      {loading && <p className="muted">正在读取草稿…</p>}
      {!loading && !error && !data?.items.length && (
        <Empty>目前没有课程或知识卡草稿。</Empty>
      )}
      <div className="draft-list">
        {data?.items.map((d) => (
          <button
            key={d.id}
            className="draft-row"
            onClick={() => go(`draft/${d.id}`)}
          >
            <span>
              <Pill>{d.entity_type === "course" ? "课程" : "知识"}</Pill>{" "}
              <Pill>{d.status}</Pill>
            </span>
            <strong>
              {(d.payload as any)?.title || d.entity_id || "新条目"}
            </strong>
            <small>{dateLabel(d.created_at)} · 查看变更 ↗</small>
          </button>
        ))}
      </div>
      <section className="relations-review">
        <div className="section-heading">
          <h2>待确认关联</h2>
          <span>{pending.length} 条</span>
        </div>
        <p className="muted">Agent 提议的资料关联由你决定是否收录。</p>
        {relations.error && (
          <ErrorBox error={relations.error} retry={relations.refresh} />
        )}{" "}
        {!relations.loading && !relations.error && !pending.length && (
          <Empty>目前没有待确认的关联。</Empty>
        )}
        {pending.map((relation) => (
          <div className="relation-review-row" key={relation.id}>
            <div>
              <span className="eyebrow">{relation.kind || "资料关联"}</span>
              <p>
                <code>{relation.from_id}</code> → <code>{relation.to_id}</code>
              </p>
              {relation.reason && (
                <p className="muted">理由：{relation.reason}</p>
              )}
            </div>
            <div className="review-actions">
              <button
                className="secondary"
                disabled={!!busy}
                onClick={() => reviewRelation(relation.id, "confirmed")}
              >
                确认关联
              </button>
              <button
                className="text-button"
                disabled={!!busy}
                onClick={() => reviewRelation(relation.id, "rejected")}
              >
                拒绝
              </button>
            </div>
          </div>
        ))}
      </section>
    </>
  );
}
function DraftContent({
  value,
  entityType,
}: {
  value: any;
  entityType: "course" | "knowledge";
}) {
  if (!value) return <Empty>这是新条目，当前还没有正式内容。</Empty>;
  if (entityType === "knowledge")
    return (
      <div className="draft-readable">
        <h3>{value.title || "未命名知识卡"}</h3>
        <p className="small-muted">
          {humanLabel(value.original_type || value.type || "knowledge")} ·{" "}
          {humanLabel(value.verification_status || "needs_review")}
        </p>
        <Markdown>{value.body_md || "正文尚无内容"}</Markdown>
        <div className="draft-sources">
          <span className="eyebrow">来源</span>
          {value.source_refs?.length ? (
            value.source_refs.map((ref: SourceRef, i: number) => (
              <button
                key={i}
                className="aside-link"
                onClick={() =>
                  go(`source/${ref.source_version_id}/${ref.source_block_id}`)
                }
              >
                来源版本 {i + 1} ↗
              </button>
            ))
          ) : (
            <p className="small-muted">未附原始来源</p>
          )}
        </div>
      </div>
    );
  return (
    <div className="draft-readable">
      <h3>{value.title || "未命名课程"}</h3>
      <p className="small-muted">
        {value.series || "未分类"} · {dateLabel(value.course_date)}
      </p>
      <p className="draft-overview">{value.overview || "尚无课程概览"}</p>
      <h4>主题地图与讲义</h4>
      {value.topics?.length ? (
        value.topics.map((topic: Topic) => (
          <section className="draft-topic" key={topic.id}>
            <h5>
              {topic.parent_id ? "↳ " : ""}
              {topic.title}
            </h5>
            {topic.blocks?.map((block) => (
              <div className="draft-block" key={block.id}>
                <span className="eyebrow">
                  {blockType(block.type)} · {humanLabel(block.origin_kind)}
                </span>
                <Markdown>{block.body_md}</Markdown>
                {block.source_refs?.map((ref, i) => (
                  <button
                    className="text-button"
                    key={i}
                    onClick={() =>
                      go(
                        `source/${ref.source_version_id}/${ref.source_block_id}`,
                      )
                    }
                  >
                    查看出处 {i + 1} ↗
                  </button>
                ))}
              </div>
            ))}
          </section>
        ))
      ) : (
        <p className="small-muted">当前版本没有主题讲义。</p>
      )}
    </div>
  );
}
function DraftPage({
  id,
  notify,
}: {
  id: string;
  notify: (s: string) => void;
}) {
  const {
    data: draft,
    error,
    loading,
    refresh,
  } = useRemote<Draft>("get_draft_status", { draft_id: id }, []);
  const existing = useRemote<Course>(
    "get_course",
    { course_id: draft?.entity_id || "" },
    [draft?.entity_id],
    !!draft?.current && draft.entity_type === "course",
  );
  const [busy, setBusy] = useState(false);
  const run = async (action: "accept" | "reject" | "revert") => {
    if (!draft) return;
    setBusy(true);
    try {
      await rpc("review_draft", {
        draft_id: draft.id,
        action,
        expected_revision: draft.revision,
      });
      refresh();
      notify(
        action === "accept"
          ? "草稿已采用"
          : action === "reject"
            ? "草稿已拒绝"
            : "已撤回采用",
      );
    } catch (e) {
      notify(messageOf(e));
    } finally {
      setBusy(false);
    }
  };
  if (error) return <ErrorBox error={error} retry={refresh} />;
  if (loading || !draft) return <p className="muted">正在读取差异…</p>;
  const current =
    draft.entity_type === "course"
      ? existing.data || draft.current
      : draft.current;
  const proposed = draft.proposed || draft.payload;
  return (
    <>
      <button className="back" onClick={() => go("drafts")}>
        ← 返回草稿
      </button>
      <PageHead
        eyebrow={`草稿审核 · ${draft.entity_type === "course" ? "课程" : "知识卡"}`}
        title={(draft.payload as any)?.title || "待核变更"}
        description={`当前状态：${humanLabel(draft.status)}。请核对正文、主题和出处后决定是否采用。`}
      />
      {draft.validation?.errors?.length ? (
        <ErrorBox error={`校验问题：${draft.validation.errors.join("；")}`} />
      ) : null}
      {draft.validation?.warnings?.length ? (
        <div className="warning">
          待核：{draft.validation.warnings.join("；")}
        </div>
      ) : null}
      <div className="diff-grid">
        <section className="diff-pane">
          <span className="eyebrow">当前正式资料</span>
          <DraftContent value={current} entityType={draft.entity_type} />
        </section>
        <section className="diff-pane proposed">
          <span className="eyebrow">草稿拟采用内容</span>
          <DraftContent value={proposed} entityType={draft.entity_type} />
        </section>
      </div>
      <details className="raw-diff">
        <summary>高级：查看完整字段差异</summary>
        <div className="raw-diff-grid">
          <pre>
            {current ? JSON.stringify(current, null, 2) : "当前无正式资料"}
          </pre>
          <pre>{JSON.stringify(proposed, null, 2)}</pre>
        </div>
      </details>
      <div className="review-actions">
        {draft.status === "draft" && (
          <>
            <button
              className="primary"
              disabled={busy || !!draft.validation?.errors?.length}
              onClick={() => run("accept")}
            >
              确认采用
            </button>
            <button
              className="secondary"
              disabled={busy}
              onClick={() => run("reject")}
            >
              拒绝草稿
            </button>
          </>
        )}
        {draft.status === "accepted" && (
          <button
            className="secondary"
            disabled={busy}
            onClick={() => run("revert")}
          >
            撤回采用
          </button>
        )}
      </div>
    </>
  );
}

function SearchPage({ query }: { query: string }) {
  const [text, setText] = useState(query);
  const { data, error, loading, refresh } = useRemote<{
    items: {
      id: string;
      type: string;
      title: string;
      snippet: string;
      source: string;
      web_path: string;
    }[];
    searched_scope?: string[];
  }>("search_library", { query, limit: 50 }, [query], !!query.trim());
  return (
    <>
      <PageHead
        eyebrow="检索 · 进入具体位置"
        title="搜索资料与记录"
        description="结果保留类型与来源；原始字词不会因别名搜索被改写。"
      />
      <form
        className="search-page-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (text.trim()) go(`search?q=${encodeURIComponent(text.trim())}`);
        }}
      >
        <input
          aria-label="搜索关键词"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="试试课程名、概念或一句原话"
        />
        <button className="primary">搜索</button>
      </form>
      {query && (
        <p className="small-muted">
          “{query}”的结果 · 搜索范围：
          {data?.searched_scope?.join("、") || "本地资料"}
        </p>
      )}
      {error && <ErrorBox error={error} retry={refresh} />}{" "}
      {loading && query && <p className="muted">正在检索…</p>}
      {!loading && !error && !data?.items?.length && (
        <Empty>
          {query
            ? "没有找到匹配结果。可换一个词或缩短查询。"
            : "输入关键词开始搜索。"}
        </Empty>
      )}
      <div className="search-results">
        {data?.items.map((item, i) => (
          <button
            className="result-row"
            key={`${item.id}-${i}`}
            onClick={() =>
              go(item.web_path.replace(/^\//, "").replace(/^#/, ""))
            }
          >
            <span className="row-kicker">
              {humanLabel(item.type)} · {item.source}
            </span>
            <strong>{item.title}</strong>
            <span>{item.snippet}</span>
            <small>打开对应位置 ↗</small>
          </button>
        ))}
      </div>
    </>
  );
}

function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
    reader.onerror = () => reject(new Error("无法读取选择的文件"));
    reader.readAsDataURL(file);
  });
}
function ImportPage({ notify }: { notify: (s: string) => void }) {
  const [files, setFiles] = useState<File[]>([]);
  const [kind, setKind] = useState("other");
  const [series, setSeries] = useState("");
  const [preview, setPreview] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<any>(null);
  const inspect = async () => {
    if (!files.length) return;
    setBusy(true);
    setError("");
    setPreview(null);
    setResult(null);
    try {
      const payload = await Promise.all(
        files.map(async (file) => ({
          name: file.name,
          content_base64: await readBase64(file),
        })),
      );
      setPreview(
        await rpc("preview_import", {
          files: payload,
          source_kind: kind,
          series: series || undefined,
        }),
      );
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  };
  const commit = async () => {
    if (!preview) return;
    setBusy(true);
    setError("");
    try {
      const answer = await rpc("commit_import", { preview_id: preview.id });
      setResult(answer);
      setPreview(null);
      notify("导入已提交，请核对结果");
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <PageHead
        eyebrow="导入 · 先检查再入库"
        title="把资料带进来"
        description="支持 Markdown、TXT、JSON 和 ZIP。预览只做检查，确认后才写入。"
      />
      <section className="form-paper">
        <label className="field">
          选择文件
          <input
            type="file"
            multiple
            accept=".md,.markdown,.txt,.json,.zip"
            onChange={(e) => {
              setFiles(Array.from(e.target.files || []));
              setPreview(null);
            }}
          />
        </label>
        <div className="form-row">
          <label className="field">
            资料类型
            <select value={kind} onChange={(e) => setKind(e.target.value)}>
              <option value="other">其他／不确定</option>
              <option value="cleaned_transcript">清洗稿</option>
              <option value="transcript">转写稿</option>
              <option value="peer_summary">同修整理</option>
              <option value="original_book">原书</option>
            </select>
          </label>
          <label className="field">
            所属系列（可留空）
            <input
              value={series}
              onChange={(e) => setSeries(e.target.value)}
              placeholder="例如《问道》"
            />
          </label>
        </div>
        <button
          className="primary"
          disabled={!files.length || busy}
          onClick={inspect}
        >
          {busy ? "处理中…" : "预览导入"}
        </button>
      </section>
      {error && <ErrorBox error={error} retry={preview ? commit : inspect} />}{" "}
      {preview && (
        <section className="form-paper">
          <span className="eyebrow">导入预览</span>
          <h2>先核对这批资料</h2>
          <div className="count-grid">
            {Object.entries(preview.counts || {}).map(([name, count]) => (
              <div key={name}>
                <strong>{String(count)}</strong>
                <span>
                  {(
                    {
                      sources: "来源",
                      courses: "课程",
                      cards: "卡片",
                      cases: "案例",
                      duplicates: "重复",
                      unsupported: "不支持",
                    } as any
                  )[name] || name}
                </span>
              </div>
            ))}
          </div>
          {preview.warnings?.map((w: string, i: number) => (
            <div className="warning" key={i}>
              {w}
            </div>
          ))}
          <div className="import-items">
            {preview.items?.map((item: any, i: number) => (
              <div key={i}>
                <strong>{item.name}</strong>
                <span>
                  {humanLabel(item.type)} · {humanLabel(item.status)}
                </span>
                {item.warnings?.map((w: string, j: number) => (
                  <small key={j}>{w}</small>
                ))}
              </div>
            ))}
          </div>
          <div className="review-actions">
            <button className="primary" disabled={busy} onClick={commit}>
              确认导入
            </button>
            <button className="secondary" onClick={() => setPreview(null)}>
              取消
            </button>
          </div>
        </section>
      )}
      {result && (
        <section className="form-paper">
          <h2>本次导入结果</h2>
          <pre className="result-pre">{JSON.stringify(result, null, 2)}</pre>
          <button className="secondary" onClick={() => go("drafts")}>
            查看待审草稿
          </button>
        </section>
      )}
    </>
  );
}

const permissionLabels: Record<
  keyof Omit<Permissions, "read_note_ids">,
  string
> = {
  read_library: "读取课程、卡片和来源原文",
  append_notes: "新增个人记录",
  save_reviews: "保存外部复盘结果",
  submit_courses: "提交课程整理草稿",
  submit_knowledge: "提交知识卡草稿",
  propose_relations: "提议资料关联",
};
function Settings({
  status,
  refresh,
  notify,
}: {
  status: Status | null;
  refresh: () => void;
  notify: (s: string) => void;
}) {
  const [permissions, setPermissions] = useState<Permissions | null>(null);
  const [noteIds, setNoteIds] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const noteOptions = useRemote<{ items: Note[]; next_cursor: string | null }>(
    "list_notes",
    { limit: 100 },
    [],
  );
  const [scope, setScope] = useState<"all" | "course" | "knowledge" | "notes">(
    "all",
  );
  const [ids, setIds] = useState("");
  const [share, setShare] = useState(false);
  const [redactions, setRedactions] = useState("");
  const [exportResult, setExportResult] = useState<any>(null);
  const [backup, setBackup] = useState<any>(null);
  const [restore, setRestore] = useState<any>(null);
  const [restoreFile, setRestoreFile] = useState<File | null>(null);
  const [confirmation, setConfirmation] = useState("");
  const courseOptions = useRemote<{ items: Course[] }>(
    "list_courses",
    {},
    [],
    scope === "course",
  );
  const cardOptions = useRemote<{ items: Card[] }>(
    "list_knowledge",
    {},
    [],
    scope === "knowledge",
  );
  useEffect(() => {
    if (status) {
      setPermissions(status.permissions);
      setNoteIds(status.permissions.read_note_ids.join("\n"));
    }
  }, [status]);
  const run = async (name: string, action: () => Promise<void>) => {
    setBusy(name);
    setError("");
    try {
      await action();
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy("");
    }
  };
  const savePermissions = () =>
    run("permissions", async () => {
      if (!permissions) return;
      await rpc("set_permissions", {
        permissions: {
          ...permissions,
          read_note_ids: noteIds
            .split(/[\n,，]/)
            .map((s) => s.trim())
            .filter(Boolean),
        },
      });
      refresh();
      notify("MCP 权限已保存");
    });
  const toggleNotePermission = (id: string, checked: boolean) => {
    const values = new Set(
      noteIds
        .split(/[\n,，]/)
        .map((s) => s.trim())
        .filter(Boolean),
    );
    if (checked) values.add(id);
    else values.delete(id);
    setNoteIds([...values].join("\n"));
  };
  const toggleExportId = (id: string, checked: boolean) => {
    const values = new Set(
      ids
        .split(/[\n,，]/)
        .map((s) => s.trim())
        .filter(Boolean),
    );
    if (checked) values.add(id);
    else values.delete(id);
    setIds([...values].join("\n"));
    setExportResult(null);
  };
  const rotate = () =>
    run("rotate", async () => {
      await rpc("rotate_mcp_token");
      notify("连接凭证已轮换，旧凭证已失效。");
    });
  const exportNow = () =>
    run("export", async () => {
      const selectedIds = ids
        .split(/[\n,，]/)
        .map((s) => s.trim())
        .filter(Boolean);
      if (scope !== "all" && !selectedIds.length)
        throw new Error("请先勾选至少一个条目。");
      setExportResult(
        await rpc("export_data", {
          scope,
          ids: selectedIds,
          share,
          redactions: redactions
            .split("\n")
            .map((s) => s.trim())
            .filter(Boolean),
        }),
      );
    });
  const backupNow = () =>
    run("backup", async () => {
      setBackup(await rpc("create_backup", {}));
      notify("备份文件已生成");
    });
  const previewRestore = () =>
    run("restore-preview", async () => {
      if (!restoreFile) return;
      setRestore(
        await rpc("preview_restore", {
          content_base64: await readBase64(restoreFile),
        }),
      );
    });
  const commitRestore = () =>
    run("restore-commit", async () => {
      const result = await rpc<any>("commit_restore", {
        preview_id: restore.id,
        confirmation,
      });
      if (result?.restored) {
        notify("恢复完成，已保留恢复前备份");
        setRestore(null);
        refresh();
      }
    });
  return (
    <>
      <PageHead
        eyebrow="设置 · 本地与边界"
        title="让资料留在自己的掌握中"
        description="查看当前库的位置，管理对外权限，并准备可核对的导出与备份。"
      />
      {error && <ErrorBox error={error} />}
      <section className="settings-section">
        <span className="eyebrow">当前资料库</span>
        <h2>本地状态</h2>
        <dl className="facts">
          <div>
            <dt>数据目录</dt>
            <dd className="path-value">{status?.data_dir || "读取中…"}</dd>
          </div>
          <div>
            <dt>运行模式</dt>
            <dd>
              {status?.mode === "demo" ? "演示资料" : "私人资料"} ·{" "}
              {status?.read_only ? "只读" : "可写"}
            </dd>
          </div>
          <div>
            <dt>对象数量</dt>
            <dd>
              {status
                ? `${status.counts.courses} 门课程 · ${status.counts.cards} 张卡 · ${status.counts.notes} 条记录`
                : "读取中…"}
            </dd>
          </div>
        </dl>
      </section>
      <section className="settings-section">
        <span className="eyebrow">外部 Agent</span>
        <h2>MCP 访问权限</h2>
        <p className="muted">
          仅勾选的能力可用于外部连接。私人记录按条勾选；未勾选的记录不提供外部读取。
        </p>
        {permissions && (
          <div className="permission-list">
            {(
              Object.keys(permissionLabels) as (keyof typeof permissionLabels)[]
            ).map((key) => (
              <label key={key}>
                <input
                  type="checkbox"
                  checked={permissions[key]}
                  onChange={(e) =>
                    setPermissions({ ...permissions, [key]: e.target.checked })
                  }
                />
                <span>{permissionLabels[key]}</span>
              </label>
            ))}
          </div>
        )}
        <div className="note-permissions">
          <span className="eyebrow">允许读取的记录</span>
          {noteOptions.error && (
            <ErrorBox error={noteOptions.error} retry={noteOptions.refresh} />
          )}
          <div className="permission-list">
            {noteOptions.data?.items.map((note) => (
              <label key={note.id}>
                <input
                  type="checkbox"
                  checked={noteIds
                    .split(/[\n,，]/)
                    .map((s) => s.trim())
                    .includes(note.id)}
                  onChange={(e) =>
                    toggleNotePermission(note.id, e.target.checked)
                  }
                />
                <span>
                  {note.original_text.slice(0, 68)}{" "}
                  <small>{dateLabel(note.created_at)}</small>
                </span>
              </label>
            ))}
          </div>
          {noteOptions.data?.next_cursor && (
            <p className="small-muted">
              此处显示最近 100 条。较早记录可在下方输入 ID。
            </p>
          )}
        </div>
        <label className="field">
          允许读取的记录 ID（每行一个，可用于较早记录）
          <textarea
            rows={3}
            value={noteIds}
            onChange={(e) => setNoteIds(e.target.value)}
            placeholder="默认留空"
          />
        </label>
        <div className="review-actions">
          <button
            className="primary"
            disabled={!!busy || !permissions}
            onClick={savePermissions}
          >
            保存权限
          </button>
          <button className="secondary" disabled={!!busy} onClick={rotate}>
            轮换连接凭证
          </button>
        </div>
        <p className="small-muted">轮换后旧凭证失效。网页不会显示原始密钥。</p>
      </section>
      <section className="settings-section">
        <span className="eyebrow">可迁移</span>
        <h2>导出资料</h2>
        <p className="muted">
          课程导出不附带个人记录；选定范围和分享脱敏后，先看预览再下载。
        </p>
        <label className="field">
          导出范围
          <select
            value={scope}
            onChange={(e) => {
              setScope(e.target.value as typeof scope);
              setIds("");
              setExportResult(null);
            }}
          >
            <option value="all">全部资料</option>
            <option value="course">指定课程</option>
            <option value="knowledge">指定知识卡</option>
            <option value="notes">指定个人记录</option>
          </select>
        </label>
        {scope !== "all" && (
          <div className="export-pick">
            <span className="eyebrow">选择要导出的条目</span>
            <div className="export-pick-list">
              {(scope === "course"
                ? courseOptions.data?.items
                : scope === "knowledge"
                  ? cardOptions.data?.items
                  : noteOptions.data?.items
              )?.map((item) => (
                <label key={item.id}>
                  <input
                    type="checkbox"
                    checked={ids
                      .split(/[\n,，]/)
                      .map((s) => s.trim())
                      .includes(item.id)}
                    onChange={(e) => toggleExportId(item.id, e.target.checked)}
                  />
                  <span>
                    {"original_text" in item
                      ? item.original_text.slice(0, 70)
                      : item.title}
                  </span>
                </label>
              ))}
            </div>
            {scope === "notes" && noteOptions.data?.next_cursor && (
              <p className="small-muted">
                此处显示最近 100 条记录。较早记录可以用下方的 ID 添加。
              </p>
            )}
            <details>
              <summary>高级：按 ID 指定较早或未列出的条目</summary>
              <textarea
                rows={3}
                value={ids}
                onChange={(e) => {
                  setIds(e.target.value);
                  setExportResult(null);
                }}
                aria-label="导出对象 ID，每行一个"
              />
            </details>
          </div>
        )}
        <label className="check-row">
          <input
            type="checkbox"
            checked={share}
            onChange={(e) => setShare(e.target.checked)}
          />
          生成分享版本并先检查脱敏预览
        </label>
        {share && (
          <label className="field">
            需要替换的敏感字词（每行一个）
            <textarea
              rows={3}
              value={redactions}
              onChange={(e) => setRedactions(e.target.value)}
              placeholder="例如姓名、账号或地点"
            />
          </label>
        )}
        <button className="primary" disabled={!!busy} onClick={exportNow}>
          生成导出预览
        </button>
        {exportResult && (
          <div className="preview-box">
            <span className="eyebrow">
              {share ? "分享脱敏预览" : "导出预览"}
            </span>
            <pre>
              {typeof exportResult.preview === "string"
                ? exportResult.preview
                : JSON.stringify(exportResult.preview, null, 2)}
            </pre>
            {exportResult.warnings?.map((w: string, i: number) => (
              <p className="warning" key={i}>
                {w}
              </p>
            ))}
            {downloadUrl(exportResult.download_url) && (
              <a
                className="primary download-link"
                href={downloadUrl(exportResult.download_url)}
                download={exportResult.filename}
              >
                核对后下载 {exportResult.filename}
              </a>
            )}
          </div>
        )}
      </section>
      <section className="settings-section">
        <span className="eyebrow">可恢复</span>
        <h2>完整备份</h2>
        <p className="muted">
          备份含资料库与来源文件。恢复前先校验，提交时会自动保留当前状态的备份。
        </p>
        <button className="secondary" disabled={!!busy} onClick={backupNow}>
          生成备份
        </button>
        {backup && (
          <div className="preview-box">
            备份已生成 · {backup.filename}
            {downloadUrl(backup.download_url) && (
              <a
                className="download-link secondary"
                href={downloadUrl(backup.download_url)}
                download={backup.filename}
              >
                下载备份
              </a>
            )}
          </div>
        )}
        <div className="restore-box">
          <h3>从备份恢复</h3>
          <label className="field">
            选择备份文件
            <input
              type="file"
              accept=".zip,.json"
              onChange={(e) => {
                setRestoreFile(e.target.files?.[0] || null);
                setRestore(null);
                setConfirmation("");
              }}
            />
          </label>
          <button
            className="secondary"
            disabled={!restoreFile || !!busy}
            onClick={previewRestore}
          >
            校验备份并预览
          </button>
          {restore && (
            <div className="preview-box">
              <span className="eyebrow">
                恢复预览 · {restore.valid ? "校验通过" : "校验未通过"}
              </span>
              <pre>{JSON.stringify(restore.counts, null, 2)}</pre>
              {restore.warnings?.map((w: string, i: number) => (
                <p className="warning" key={i}>
                  {w}
                </p>
              ))}
              <label className="field">
                确认恢复：输入“恢复此备份”
                <input
                  value={confirmation}
                  onChange={(e) => setConfirmation(e.target.value)}
                  placeholder="恢复此备份"
                />
              </label>
              <button
                className="danger"
                disabled={
                  !restore.valid || confirmation !== "恢复此备份" || !!busy
                }
                onClick={commitRestore}
              >
                确认恢复到此备份
              </button>
            </div>
          )}
        </div>
      </section>
    </>
  );
}
