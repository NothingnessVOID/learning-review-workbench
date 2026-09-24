import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { downloadUrl, messageOf, requestId, rpc } from "./api";
import { normalizeExportParams, usePersistentDraft } from "./drafts";
import { readableChanges } from "./diff";
import {
  captureReaderPosition,
  chooseReaderPosition,
  restoreReaderPosition,
  saveReaderOnPageHide,
  saveReaderPosition,
} from "./reading";
import type {
  Card,
  Course,
  Draft,
  LearningState,
  Note,
  Permissions,
  Relation,
  Review,
  SourceRef,
  Status,
  Topic,
} from "./types";

type Route = { page: string; id?: string; query?: string; blockId?: string };
type ComposerDraft = {
  text: string;
  type: string;
  relationId: string;
  relationLabel: string;
  relationDismissed: boolean;
  requestId: string;
};
const emptyComposer = (): ComposerDraft => ({
  text: "",
  type: "quick",
  relationId: "",
  relationLabel: "",
  relationDismissed: false,
  requestId: requestId(),
});
const ROUTE_RE = /^#(course|topic|card|note|draft|case|review)\/([^/?#]+)/;
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
        source_quote: "原文引用",
        source_locatable: "可定位原文",
        original_quote: "原文引用",
        direct_quote: "直接引述",
        ai_paraphrase: "AI 转述",
        ai_inference: "AI 推断",
        demo: "演示未核验",
        paraphrase: "转述整理",
        summary: "摘要整理",
        ai_example: "AI 示例",
        inferred: "推论",
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

function usePagedRpc<T>(
  tool: string,
  args: Record<string, unknown>,
  enabled = true,
) {
  const [items, setItems] = useState<T[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [meta, setMeta] = useState<Record<string, unknown>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [version, setVersion] = useState(0);
  const key = JSON.stringify(args);
  const generation = useRef(0);
  useEffect(() => {
    setItems([]);
    setCursor(null);
    setTotal(null);
    setMeta({});
    generation.current++;
  }, [tool, key]);
  const load = useCallback(
    async (next?: string | null) => {
      if (!enabled) return;
      const current = generation.current;
      setLoading(true);
      setError("");
      try {
        const result = await rpc<{
          items: T[];
          next_cursor: string | null;
          total?: number;
          [key: string]: unknown;
        }>(tool, { ...args, cursor: next || undefined });
        if (current !== generation.current) return;
        setItems((previous) =>
          next
            ? [
                ...previous,
                ...result.items.filter(
                  (item) =>
                    !previous.some(
                      (old) => (old as any).id === (item as any).id,
                    ),
                ),
              ]
            : result.items,
        );
        setCursor(result.next_cursor);
        setTotal(result.total ?? null);
        setMeta(result);
      } catch (e) {
        if (current === generation.current) setError(messageOf(e));
      } finally {
        if (current === generation.current) setLoading(false);
      }
    },
    [tool, key, enabled, loading, version],
  );
  useEffect(() => {
    if (enabled) void load(null);
  }, [tool, key, enabled, version]);
  return {
    items,
    cursor,
    total,
    meta,
    loading,
    error,
    more: () => {
      if (!loading && cursor) void load(cursor);
    },
    refresh: () => setVersion((v) => v + 1),
  };
}

function useDialogFocus(open: boolean, onClose: () => void) {
  const dialogRef = useRef<HTMLElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (!open || !dialogRef.current) return;
    const dialog = dialogRef.current;
    const previous = document.activeElement as HTMLElement | null;
    const changed: { element: HTMLElement; inert: boolean }[] = [];
    let node: HTMLElement | null = dialog.parentElement;
    while (node?.parentElement) {
      for (const child of Array.from(node.parentElement.children))
        if (child instanceof HTMLElement && child !== node) {
          changed.push({ element: child, inert: child.inert });
          child.inert = true;
        }
      node = node.parentElement;
      if (node === document.body) break;
    }
    const focusable = () =>
      Array.from(
        dialog.querySelectorAll<HTMLElement>(
          'a[href],button:not([disabled]),input:not([disabled]),textarea:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])',
        ),
      ).filter((el) => !el.inert && el.getClientRects().length > 0);
    (focusable()[0] || dialog).focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const elements = focusable();
      if (!elements.length) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = elements[0],
        last = elements[elements.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", keydown);
    return () => {
      document.removeEventListener("keydown", keydown);
      for (const { element, inert } of changed) element.inert = inert;
      previous?.focus();
    };
  }, [open]);
  return dialogRef;
}

export default function App() {
  const [route, setRoute] = useState<Route>(routeFromHash);
  const [drawer, setDrawer] = useState(false);
  const [narrow, setNarrow] = useState(
    () => matchMedia("(max-width: 800px)").matches,
  );
  const menuRef = useRef<HTMLButtonElement>(null);
  const sidebarRef = useRef<HTMLElement>(null);
  const [composerOpen, setComposerOpen] = useState(false);
  const composerDialogRef = useDialogFocus(composerOpen, () =>
    setComposerOpen(false),
  );
  const {
    draft: composer,
    update: setComposer,
    current: composerRef,
    clearSubmitted: clearComposer,
  } = usePersistentDraft<ComposerDraft>("workbench.quick-draft", emptyComposer);
  const quickSaving = useRef(false);
  const [quickBusy, setQuickBusy] = useState(false);
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
    const media = matchMedia("(max-width: 800px)");
    const update = () => setNarrow(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  useEffect(() => {
    if (drawer && narrow)
      sidebarRef.current?.querySelector<HTMLElement>("a,button")?.focus();
    else if (
      narrow &&
      document.activeElement &&
      sidebarRef.current?.contains(document.activeElement)
    )
      menuRef.current?.focus();
  }, [drawer, narrow]);
  useEffect(() => {
    const handler = () => {
      const reader = document.querySelector<HTMLElement>(
        "[data-course-reader][data-topic-reader]",
      );
      if (reader?.dataset.courseReader && reader.dataset.topicReader)
        void saveReaderPosition(
          reader.dataset.courseReader,
          captureReaderPosition(reader.dataset.topicReader),
        ).catch(() => {});
      setRoute(routeFromHash());
      setDrawer(false);
    };
    addEventListener("hashchange", handler);
    return () => removeEventListener("hashchange", handler);
  }, []);
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [route.page, route.id]);
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
    localStorage.setItem("workbench.font-size", String(fontSize));
    document.documentElement.style.setProperty(
      "--reader-size",
      `${fontSize}px`,
    );
  }, [fontSize]);
  const openQuick = () => {
    const current = composerRef.current;
    if (!current.text && !current.relationDismissed) {
      const related =
        ["topic", "card", "course"].includes(route.page) && route.id;
      const title = related
        ? document.querySelector("#main h1")?.textContent?.trim() ||
          pageLabel(route.page)
        : "";
      setComposer({
        ...current,
        relationId: related ? route.id! : "",
        relationLabel: title,
        relationDismissed: false,
        requestId: requestId(),
      });
    }
    setComposerOpen(true);
  };
  const notify = (message: string) => {
    setNotice(message);
    setTimeout(() => setNotice(""), 4500);
  };
  const refreshed = () => setChange((n) => n + 1);
  const saveQuick = async () => {
    const submitted = composerRef.current;
    if (!submitted.text.trim() || quickSaving.current) return;
    quickSaving.current = true;
    setQuickBusy(true);
    setComposerState("saving");
    setComposerError("");
    try {
      await rpc("create_note", {
        original_text: submitted.text.trim(),
        type: submitted.type,
        relation_ids: submitted.relationId ? [submitted.relationId] : [],
        client_request_id: submitted.requestId,
      });
      const cleared = clearComposer(submitted);
      setComposerState(cleared ? "saved" : "idle");
      if (cleared) setComposerOpen(false);
      refreshed();
      notify(cleared ? "记录已保存" : "上一版已保存，新输入仍留在草稿中");
    } catch (e) {
      setComposerState("failed");
      setComposerError(messageOf(e));
    } finally {
      quickSaving.current = false;
      setQuickBusy(false);
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
      <aside
        ref={sidebarRef}
        inert={narrow && !drawer}
        className={`sidebar ${drawer ? "is-open" : ""}`}
      >
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
      <div className="workspace" inert={narrow && drawer}>
        <header className="topbar">
          <button
            ref={menuRef}
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
          <button className="top-action" onClick={openQuick}>
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
              openComposer={openQuick}
            />
          )}
          {route.page === "knowledge" && <Knowledge key={change} />}
          {route.page === "card" && route.id && (
            <CardPage
              key={`${route.id}-${change}`}
              id={route.id}
              notify={notify}
              openComposer={openQuick}
            />
          )}
          {route.page === "notes" && <Notes key={change} />}
          {route.page === "note" && route.id && (
            <NotePage key={route.id} id={route.id} notify={notify} />
          )}
          {route.page === "case" && route.id && (
            <CasePage key={route.id} id={route.id} />
          )}
          {route.page === "review" && route.id && (
            <ReviewPage key={route.id} id={route.id} />
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
            ref={composerDialogRef}
            className="modal compose-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="compose-title"
            tabIndex={-1}
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
                      relationLabel: "",
                      relationDismissed: true,
                      requestId: requestId(),
                    })
                  }
                  title="移除自动关联"
                >
                  关联：{composer.relationLabel || "当前内容"} ×
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
                  disabled={!composer.text.trim() || quickBusy}
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
  const { items, cursor, total, meta, error, loading, refresh, more } =
    usePagedRpc<Course>("list_courses", { query, series, limit: 30 });
  const recent = useMemo(() => {
    const loaded = items
      .filter(
        (c) =>
          chooseReaderPosition(c.id, c.learning_state)?.topic_id ||
          c.learning_state?.status === "reading",
      )
      .sort((a, b) => {
        const last = (course: Course) => {
          let local = 0;
          try {
            local =
              JSON.parse(
                localStorage.getItem(`workbench.reader.${course.id}`) || "null",
              )?.saved_at || 0;
          } catch {}
          return Math.max(
            local,
            Date.parse(course.learning_state?.updated_at || "") || 0,
          );
        };
        return last(b) - last(a);
      })[0];
    let last: {
      id: string;
      title: string;
      series: string;
      course_date?: string | null;
      topic_id: string;
      updated_at: number;
    } | null = null;
    try {
      last = JSON.parse(
        localStorage.getItem("workbench.last-course") || "null",
      );
    } catch {}
    const loadedAt = Math.max(
      0,
      Date.parse(loaded?.learning_state?.updated_at || "") || 0,
    );
    return last?.topic_id && last.updated_at > loadedAt
      ? ({
          id: last.id,
          title: last.title,
          series: last.series,
          course_date: last.course_date || null,
          learning_state: {
            position: { topic_id: last.topic_id },
            updated_at: new Date(last.updated_at).toISOString(),
          },
        } as Course)
      : loaded;
  }, [items]);
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
                chooseReaderPosition(recent.id, recent.learning_state)?.topic_id
                  ? `topic/${chooseReaderPosition(recent.id, recent.learning_state)!.topic_id}`
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
        <span>
          {total === null
            ? `${items.length} 门`
            : `已显示 ${items.length} / ${total} 门`}
        </span>
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
          {((meta.series || []) as string[]).map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </div>
      {error && <ErrorBox error={error} retry={refresh} />}{" "}
      {loading && <p className="muted">正在读取课程…</p>}
      {!loading && !error && !items.length && (
        <Empty>这里还没有符合条件的课程。可以从“导入资料”加入来源。</Empty>
      )}
      <div className="course-list">
        {items.map((course) => (
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
      {cursor && (
        <button className="secondary" disabled={loading} onClick={more}>
          {loading ? "正在读取…" : "加载更多课程"}
        </button>
      )}
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
  const resume = chooseReaderPosition(course.id, course.learning_state);
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
      {resume?.topic_id &&
        topics.some((topic) => topic.id === resume.topic_id) && (
          <div className="continue">
            <div>
              <span className="eyebrow">上次读到</span>
              <h2>
                {topics.find((topic) => topic.id === resume.topic_id)?.title}
              </h2>
            </div>
            <button
              className="primary"
              onClick={() => go(`topic/${resume.topic_id}`)}
            >
              继续阅读 →
            </button>
          </div>
        )}
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
  const courseOutline = useRemote<Course>(
    "get_course",
    { course_id: topic?.course_id || "" },
    [topic?.course_id],
    !!topic?.course_id,
  );
  const [activeRef, setActiveRef] = useState<SourceRef | null>(null);
  const [busy, setBusy] = useState(false);
  const [scrollState, setScrollState] = useState<LearningState | null>(null);
  useEffect(() => {
    if (topic) setScrollState(topic.learning_state || null);
  }, [topic]);
  useEffect(() => {
    if (topic?.course)
      localStorage.setItem(
        "workbench.last-course",
        JSON.stringify({
          id: topic.course_id,
          title: topic.course.title,
          series: topic.course.series,
          course_date: topic.course.course_date,
          topic_id: topic.id,
          updated_at: Date.now(),
        }),
      );
  }, [topic?.id]);
  useEffect(() => {
    if (!topic) return;
    let restored = false;
    let debounce: ReturnType<typeof setTimeout> | undefined;
    const persist = () =>
      saveReaderPosition(
        topic.course_id,
        captureReaderPosition(topic.id),
      ).catch(() => {});
    const restore = setTimeout(() => {
      restoreReaderPosition(
        chooseReaderPosition(topic.course_id, topic.course?.learning_state),
        topic.id,
      );
      restored = true;
      persist(); // Even a short topic is now the last reading position.
    }, 80);
    const onScroll = () => {
      if (!restored) return;
      clearTimeout(debounce);
      debounce = setTimeout(persist, 400);
    };
    const onHidden = () => {
      if (document.visibilityState === "hidden") persist();
    };
    const onPageHide = () =>
      saveReaderOnPageHide(topic.course_id, captureReaderPosition(topic.id));
    addEventListener("scroll", onScroll, { passive: true });
    addEventListener("pagehide", onPageHide);
    document.addEventListener("visibilitychange", onHidden);
    return () => {
      removeEventListener("scroll", onScroll);
      removeEventListener("pagehide", onPageHide);
      document.removeEventListener("visibilitychange", onHidden);
      clearTimeout(restore);
      clearTimeout(debounce);
      // hashchange already captured the pre-navigation scroll. A parent scroll-to-top
      // may run before this cleanup, so never recapture after leaving this route.
      if (location.hash === `#topic/${topic.id}`) {
        if (restored) persist();
        else
          saveReaderPosition(topic.course_id, {
            topic_id: topic.id,
            scroll: 0,
          }).catch(() => {});
      }
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
  const orderedTopics = (courseOutline.data?.topics || [])
    .slice()
    .sort((a, b) => a.order - b.order);
  const currentIndex = orderedTopics.findIndex((item) => item.id === topic.id);
  const previousTopic =
    currentIndex > 0 ? orderedTopics[currentIndex - 1] : null;
  const nextTopic = currentIndex >= 0 ? orderedTopics[currentIndex + 1] : null;
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
      <details className="inline-topic-map">
        <summary>
          本课主题目录 ·{" "}
          {currentIndex >= 0
            ? `${currentIndex + 1} / ${orderedTopics.length}`
            : "当前位置"}
        </summary>
        {courseOutline.error && (
          <ErrorBox error={courseOutline.error} retry={courseOutline.refresh} />
        )}
        <ol>
          {orderedTopics.map((item) => (
            <li key={item.id}>
              <button
                className={item.id === topic.id ? "current" : ""}
                aria-current={item.id === topic.id ? "page" : undefined}
                onClick={() => go(`topic/${item.id}`)}
              >
                {item.parent_id ? "↳ " : ""}
                {item.title}
              </button>
            </li>
          ))}
        </ol>
      </details>
      <div className="reading-layout">
        <article
          className="reading-paper"
          data-course-reader={topic.course_id}
          data-topic-reader={topic.id}
        >
          <div className="reading-meta">
            <Pill>{topic.content_kind}</Pill>
            <span>资料整理层</span>
          </div>
          {topic.blocks.length ? (
            topic.blocks.map((block) => (
              <section
                className="teaching-block"
                key={block.id}
                data-reader-block={block.id}
              >
                <div className="block-label">{blockType(block.type)}</div>
                <div
                  className="content-provenance"
                  aria-label="内容出处和核验状态"
                >
                  <Pill>{`来源：${humanLabel(block.origin_kind || "整理内容")}`}</Pill>
                  <Pill>{`加工：${humanLabel(block.transformation || "未说明加工方式")}`}</Pill>
                  <Pill>{`核验：${humanLabel(block.verification_status || "needs_review")}`}</Pill>
                </div>
                <Markdown>{block.body_md}</Markdown>
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
      <nav className="reader-neighbors" aria-label="相邻主题">
        {previousTopic ? (
          <button onClick={() => go(`topic/${previousTopic.id}`)}>
            ← 上一主题 <strong>{previousTopic.title}</strong>
          </button>
        ) : (
          <span />
        )}
        {nextTopic ? (
          <button onClick={() => go(`topic/${nextTopic.id}`)}>
            下一主题 → <strong>{nextTopic.title}</strong>
          </button>
        ) : (
          <button onClick={() => go(`course/${topic.course_id}`)}>
            已到本课末尾 · 返回课程地图 ↗
          </button>
        )}
      </nav>
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
  const dialogRef = useDialogFocus(true, close);
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <section
        ref={dialogRef}
        className="modal source-modal"
        role="dialog"
        aria-modal="true"
        aria-label="来源原文"
        tabIndex={-1}
      >
        <div className="modal-top">
          <span className="eyebrow">原文核对 · 固定来源版本</span>
          <button className="icon-button" onClick={close} aria-label="关闭原文">
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
  const { items, cursor, total, error, loading, refresh, more } =
    usePagedRpc<Card>("list_knowledge", { query, type, limit: 30 });
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
      {!loading && !error && !items.length && <Empty>尚无匹配的知识卡。</Empty>}
      <div className="card-grid">
        {items.map((card) => (
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
      {total !== null && (
        <p className="small-muted">
          已显示 {items.length} / {total} 张知识卡
        </p>
      )}
      {cursor && (
        <button className="secondary" disabled={loading} onClick={more}>
          {loading ? "正在读取…" : "加载更多知识卡"}
        </button>
      )}
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
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const { items, cursor, total, error, loading, refresh, more } =
    usePagedRpc<Note>("list_notes", {
      type: type || undefined,
      from: from || undefined,
      to: to || undefined,
      limit: 40,
      include_archived: includeArchived,
    });
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
        <label>
          开始日期{" "}
          <input
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
          />
        </label>
        <label>
          结束日期{" "}
          <input
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
          />
        </label>
      </div>
      {error && <ErrorBox error={error} retry={refresh} />}{" "}
      {loading && <p className="muted">正在读取记录…</p>}
      {!loading && !error && !items.length && (
        <Empty>目前还没有记录。随时点右上角“记一句”开始。</Empty>
      )}
      <div className="timeline">
        {items.map((note) => (
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
                {note.content_truncated ? " · 摘录，点开看全文" : ""}
              </small>
              <strong>{note.original_text}</strong>
              <span>查看原话与后续 ↗</span>
            </span>
          </button>
        ))}
      </div>
      {total !== null && (
        <p className="small-muted">
          已显示 {items.length} / {total} 条记录
        </p>
      )}
      {cursor && (
        <button className="secondary" disabled={loading} onClick={more}>
          {loading ? "正在读取…" : "加载更早记录"}
        </button>
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
  const {
    draft: feedback,
    update: setFeedback,
    current: feedbackRef,
    clearSubmitted: clearFeedback,
  } = usePersistentDraft(`workbench.feedback.${id}`, () => ({
    text: "",
    requestId: requestId(),
  }));
  const {
    draft: review,
    update: setReview,
    current: reviewRef,
    clearSubmitted: clearReview,
  } = usePersistentDraft(`workbench.review.${id}`, () => ({
    text: "",
    method: "",
    version: "",
    gaps: "",
    requestId: requestId(),
  }));
  const [busy, setBusy] = useState("");
  const busyRef = useRef(false);
  const [writeError, setWriteError] = useState("");
  const [failedAction, setFailedAction] = useState<
    "feedback" | "review" | null
  >(null);
  const [selectedRelated, setSelectedRelated] = useState<string[]>([]);
  const [relatedQuery, setRelatedQuery] = useState("");
  const relatedList = usePagedRpc<Note>("list_notes", { limit: 30 });
  const relatedSearch = usePagedRpc<{
    id: string;
    title: string;
    snippet: string;
  }>(
    "search_library",
    { query: relatedQuery, types: ["note"], limit: 30 },
    !!relatedQuery.trim(),
  );
  const relatedOptions = relatedQuery.trim() ? relatedSearch : relatedList;
  const [includeSources, setIncludeSources] = useState(false);
  const [handoff, setHandoff] = useState<any>(null);
  const [handoffBusy, setHandoffBusy] = useState(false);
  const [handoffError, setHandoffError] = useState("");
  const makeHandoff = async () => {
    setHandoffBusy(true);
    setHandoffError("");
    setHandoff(null);
    try {
      setHandoff(
        await rpc("get_review_handoff", {
          note_id: id,
          related_note_ids: selectedRelated,
          include_sources: includeSources,
        }),
      );
    } catch (e) {
      setHandoffError(messageOf(e));
    } finally {
      setHandoffBusy(false);
    }
  };
  const handoffText = handoff
    ? [
        "# 个人复盘交接（请先阅读边界）",
        "以下是用户选定的原始记录。请保留原话，不假设缺失的方法或个人动机；不具备完整方法资料时只作一般整理。复盘结果请由用户检查后独立归档。",
        `\n## 当前记录 ${handoff.note?.id || id}\n${handoff.note?.original_text || ""}`,
        ...(handoff.related_notes || []).map(
          (item: Note) => `\n## 选定相关记录 ${item.id}\n${item.original_text}`,
        ),
        ...(handoff.source_excerpts || []).map(
          (item: any) =>
            `\n## 来源 ${item.source_name || "原文"} ${item.title_path || ""}\n${item.text || ""}`,
        ),
        `\n## 资料缺口\n${(handoff.gaps || []).length ? handoff.gaps.map((gap: string) => `- ${gap}`).join("\n") : "- 无额外缺口说明"}`,
        `\n方法资料可用：${handoff.capabilities?.method_context_available ? "是" : "否。请勿声称完整使用该方法。"}`,
      ].join("\n")
    : "";
  const saveFeedback = async () => {
    const submitted = feedbackRef.current;
    if (!submitted.text.trim() || busyRef.current) return;
    busyRef.current = true;
    setBusy("feedback");
    setWriteError("");
    try {
      await rpc("create_note", {
        original_text: submitted.text.trim(),
        type: "feedback",
        parent_note_id: id,
        client_request_id: submitted.requestId,
      });
      const cleared = clearFeedback(submitted);
      refresh();
      notify(
        cleared ? "后续反馈已保存" : "上一版反馈已保存，新输入仍留在草稿中",
      );
    } catch (e) {
      setFailedAction("feedback");
      setWriteError(messageOf(e));
    } finally {
      busyRef.current = false;
      setBusy("");
    }
  };
  const saveReview = async () => {
    const submitted = reviewRef.current;
    if (!submitted.text.trim() || busyRef.current) return;
    busyRef.current = true;
    setBusy("review");
    setWriteError("");
    try {
      await rpc("save_review_result", {
        note_ids: [id],
        body_md: submitted.text.trim(),
        method_name: submitted.method.trim() || undefined,
        method_version: submitted.version?.trim() || undefined,
        gaps:
          submitted.gaps
            ?.split(/\n/)
            .map((s: string) => s.trim())
            .filter(Boolean) || [],
        client_request_id: submitted.requestId,
      });
      const cleared = clearReview(submitted);
      refresh();
      notify(
        cleared
          ? "外部复盘结果已归档，原始记录仍保留"
          : "上一版复盘已归档，新输入仍留在草稿中",
      );
    } catch (e) {
      setFailedAction("review");
      setWriteError(messageOf(e));
    } finally {
      busyRef.current = false;
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
        {note.resolved_relations?.length || note.relations?.length ? (
          <section className="paper-block">
            <h2>关联资料</h2>
            <div className="relation-list">
              {note.resolved_relations?.map((relation) => (
                <button
                  className="aside-link"
                  key={relation.id}
                  onClick={() => go(relation.web_path.replace(/^\/#/, ""))}
                >
                  <span>
                    {humanLabel(relation.type)} · {relation.title}
                  </span>
                  <span>打开 ↗</span>
                </button>
              ))}
              {note.relations
                ?.filter((r) => r.status === "pending")
                .map((r) => (
                  <div key={r.id}>
                    <span>
                      {r.kind || "关联"}：{r.to_id || r.from_id}
                    </span>
                    <span>待确认</span>
                  </div>
                ))}
            </div>
          </section>
        ) : null}
        <div className="section-heading">
          <h2>后续时间线</h2>
          <span>保留变化，不覆盖当时的自己</span>
        </div>
        <section className="entry-panel handoff-panel">
          <h2>把这条记录交给我的 Agent</h2>
          <p className="muted">
            先选上下文并预览，再复制给您实际使用的
            Agent。工作台不会自动发送，也不会替代 Agent 的方法资料。
          </p>
          <fieldset>
            <legend>选择相关记录（最多 10 条，可留空）</legend>
            <input
              aria-label="查找相关记录"
              value={relatedQuery}
              onChange={(e) => setRelatedQuery(e.target.value)}
              placeholder="搜索原话，或从最近记录中选择"
            />
            <div className="handoff-options">
              {relatedOptions.items
                .filter((item) => item.id !== id)
                .map((item) => (
                  <label className="check-row" key={item.id}>
                    <input
                      type="checkbox"
                      checked={selectedRelated.includes(item.id)}
                      disabled={
                        !selectedRelated.includes(item.id) &&
                        selectedRelated.length >= 10
                      }
                      onChange={(e) => {
                        setHandoff(null);
                        setSelectedRelated((current) =>
                          e.target.checked
                            ? [...current, item.id]
                            : current.filter((value) => value !== item.id),
                        );
                      }}
                    />
                    {("original_text" in item
                      ? item.original_text
                      : item.title
                    ).slice(0, 120)}
                  </label>
                ))}
            </div>
            {relatedOptions.cursor && (
              <button
                className="text-button"
                disabled={relatedOptions.loading}
                onClick={relatedOptions.more}
              >
                加载更早记录
              </button>
            )}
            {relatedOptions.error && (
              <ErrorBox
                error={relatedOptions.error}
                retry={relatedOptions.refresh}
              />
            )}
            <p className="small-muted">
              已选 {selectedRelated.length} 条；只会附上你勾选的记录。
            </p>
          </fieldset>
          <label className="check-row">
            <input
              type="checkbox"
              checked={includeSources}
              onChange={(e) => {
                setHandoff(null);
                setIncludeSources(e.target.checked);
              }}
            />
            附上可定位的来源原文
          </label>
          <button
            className="secondary"
            disabled={handoffBusy}
            onClick={makeHandoff}
          >
            {handoffBusy ? "正在准备…" : "预览交接内容"}
          </button>
          {handoffError && (
            <ErrorBox error={handoffError} retry={makeHandoff} />
          )}
          {handoff && (
            <div className="preview-box">
              <h3>发送前核对</h3>
              <p className="small-muted">
                当前记录 1 条 · 选定相关记录{" "}
                {handoff.related_notes?.length || 0} 条 · 来源片段{" "}
                {handoff.source_excerpts?.length || 0} 段
              </p>
              <pre className="handoff-preview">{handoffText}</pre>
              <div className="review-actions">
                <button
                  className="primary"
                  onClick={() =>
                    navigator.clipboard.writeText(handoffText).then(
                      () => notify("交接内容已复制，请在 Agent 中粘贴并核对"),
                      () => notify("复制未成功，可下载交接文件"),
                    )
                  }
                >
                  复制交接内容
                </button>
                <button
                  className="secondary"
                  onClick={() => {
                    const url = URL.createObjectURL(
                      new Blob([handoffText], {
                        type: "text/markdown;charset=utf-8",
                      }),
                    );
                    const a = document.createElement("a");
                    a.href = url;
                    a.download = `复盘交接-${id}.md`;
                    a.click();
                    setTimeout(() => URL.revokeObjectURL(url), 1000);
                  }}
                >
                  下载交接文件
                </button>
              </div>
            </div>
          )}
        </section>
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
          <h2>保存这次复盘</h2>
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
          <input
            value={review.version || ""}
            onChange={(e) => {
              setReview({
                ...review,
                version: e.target.value,
                requestId: requestId(),
              });
              setWriteError("");
            }}
            placeholder="方法版本（可留空）"
            aria-label="复盘方法版本"
          />
          <label className="field">
            从 Agent 返回文件载入文字（可选）
            <input
              type="file"
              accept=".md,.txt,text/plain,text/markdown"
              onChange={async (e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                if (file.size > 1024 * 1024) {
                  setWriteError("文件超过 1 MB，请改为粘贴需要归档的文字。");
                  return;
                }
                const text = await file.text();
                setReview((current) => ({
                  ...current,
                  text,
                  requestId: requestId(),
                }));
              }}
            />
          </label>
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
          <textarea
            rows={3}
            value={review.gaps || ""}
            onChange={(e) => {
              setReview({
                ...review,
                gaps: e.target.value,
                requestId: requestId(),
              });
              setWriteError("");
            }}
            placeholder="资料缺口或待核问题，每行一项（可留空）"
            aria-label="资料缺口或待核问题"
          />
          <div className="entry-action">
            <button
              className="primary"
              disabled={busy !== "" || !review.text.trim()}
              onClick={saveReview}
            >
              保存这次复盘
            </button>
          </div>
        </section>
        {writeError && (
          <ErrorBox
            error={`保存失败，内容已留在本机。${writeError}`}
            retry={
              busy
                ? undefined
                : failedAction === "feedback"
                  ? saveFeedback
                  : failedAction === "review"
                    ? saveReview
                    : undefined
            }
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
  const { items, cursor, total, error, loading, refresh, more } =
    usePagedRpc<Draft>("list_drafts", { limit: 30 });
  const relations = usePagedRpc<Relation>("list_relations", { limit: 30 });
  const [busy, setBusy] = useState("");
  const pending = relations.items.filter((r) => r.status === "pending");
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
      {!loading && !error && !items.length && (
        <Empty>目前没有课程或知识卡草稿。</Empty>
      )}
      <div className="draft-list">
        {items.map((d) => (
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
      {total !== null && (
        <p className="small-muted">
          已显示 {items.length} / {total} 份草稿
        </p>
      )}
      {cursor && (
        <button className="secondary" disabled={loading} onClick={more}>
          加载更多草稿
        </button>
      )}
      <section className="relations-review">
        <div className="section-heading">
          <h2>待确认关联</h2>
          <span>
            {pending.length} 条{relations.cursor ? " · 后续页面可能还有" : ""}
          </span>
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
        {relations.cursor && (
          <button
            className="secondary"
            disabled={relations.loading}
            onClick={relations.more}
          >
            加载更多关联
          </button>
        )}
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
  const changes = readableChanges(current, proposed, draft.entity_type);
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
      <section
        className="paper-block change-summary"
        aria-label="这次拟改变的内容"
      >
        <div className="section-heading">
          <h2>这次拟改变什么</h2>
          <span>{changes.length} 处</span>
        </div>
        {changes.length ? (
          <ol>
            {changes.map((change, i) => (
              <li
                key={`${change.area}-${change.title}-${i}`}
                className={`change-${change.kind}`}
              >
                <span className="eyebrow">
                  {change.kind === "added"
                    ? "新增"
                    : change.kind === "removed"
                      ? "移除"
                      : "修改"}{" "}
                  · {change.area}
                </span>
                <strong>{change.title}</strong>
                <ul>
                  {change.details.map((detail, j) => (
                    <li key={j}>{detail}</li>
                  ))}
                </ul>
              </li>
            ))}
          </ol>
        ) : (
          <p className="muted">
            可读字段没有发现变化，请继续核对完整内容与原文出处。
          </p>
        )}
        <p className="small-muted">
          此摘要只定位变化。采用前请核对下方两份完整正文，尤其是来源、条件、遗漏与新增案例。
        </p>
      </section>
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
  const [type, setType] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const { items, cursor, total, error, loading, refresh, more } = usePagedRpc<{
    id: string;
    type: string;
    title: string;
    snippet: string;
    source: string;
    web_path: string;
  }>(
    "search_library",
    {
      query,
      types: type ? [type] : undefined,
      from: from || undefined,
      to: to || undefined,
      limit: 40,
    },
    !!query.trim(),
  );
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
      <div className="filters">
        <select
          aria-label="搜索类型"
          value={type}
          onChange={(e) => setType(e.target.value)}
        >
          <option value="">全部类型</option>
          {[
            ["course", "课程"],
            ["topic", "主题"],
            ["card", "知识卡"],
            ["case", "案例"],
            ["note", "我的记录"],
            ["review", "复盘"],
          ].map(([key, label]) => (
            <option value={key} key={key}>
              {label}
            </option>
          ))}
        </select>
        <label>
          开始日期{" "}
          <input
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
          />
        </label>
        <label>
          结束日期{" "}
          <input
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
          />
        </label>
      </div>
      {query && (
        <p className="small-muted">
          “{query}”的结果 ·{" "}
          {total === null ? "本地资料" : `已显示 ${items.length} / ${total} 条`}
        </p>
      )}
      {error && <ErrorBox error={error} retry={refresh} />}{" "}
      {loading && query && <p className="muted">正在检索…</p>}
      {!loading && !error && !items.length && (
        <Empty>
          {query
            ? "没有找到匹配结果。可换一个词或缩短查询。"
            : "输入关键词开始搜索。"}
        </Empty>
      )}
      <div className="search-results">
        {items.map((item, i) => (
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
      {cursor && (
        <button className="secondary" disabled={loading} onClick={more}>
          {loading ? "正在读取…" : "加载更多结果"}
        </button>
      )}
    </>
  );
}

function CasePage({ id }: { id: string }) {
  const { data, error, loading, refresh } = useRemote<any>(
    "get_case",
    { case_id: id },
    [],
  );
  if (error) return <ErrorBox error={error} retry={refresh} />;
  if (loading || !data) return <p className="muted">正在读取案例…</p>;
  return (
    <>
      <button className="back" onClick={() => history.back()}>
        ← 返回上一页
      </button>
      <PageHead
        eyebrow="案例 · 原有资料"
        title={data.title || "案例"}
        description={data.description || "保留案例内容与出处"}
      />
      <article className="reading-paper">
        <Markdown>
          {data.body_md || data.text || data.description || "尚无正文"}
        </Markdown>
        {data.source_refs?.map((ref: SourceRef, i: number) => (
          <button
            className="text-button"
            key={i}
            onClick={() =>
              go(`source/${ref.source_version_id}/${ref.source_block_id}`)
            }
          >
            查看出处 {i + 1} ↗
          </button>
        ))}
      </article>
    </>
  );
}
function ReviewPage({ id }: { id: string }) {
  const { data, error, loading, refresh } = useRemote<Review>(
    "get_review_result",
    { review_id: id },
    [],
  );
  if (error) return <ErrorBox error={error} retry={refresh} />;
  if (loading || !data) return <p className="muted">正在读取复盘…</p>;
  return (
    <>
      <button className="back" onClick={() => history.back()}>
        ← 返回上一页
      </button>
      <PageHead
        eyebrow={`复盘 · ${dateLabel(data.created_at)}`}
        title="一次独立保存的复盘"
        description={
          data.method_name ? `方法：${data.method_name}` : "原始记录仍单独保留"
        }
      />
      <article className="reading-paper">
        <Markdown>{data.body_md}</Markdown>
        <div className="aside-title">对应原始记录</div>
        {data.note_ids.map((noteId) => (
          <button
            className="aside-link"
            key={noteId}
            onClick={() => go(`note/${noteId}`)}
          >
            打开原始记录 ↗
          </button>
        ))}
        {data.gaps?.length ? (
          <p className="small-muted">
            待核：{data.gaps.map(String).join("、")}
          </p>
        ) : null}
      </article>
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
    const previousPreview = preview;
    setPreview(null);
    setResult(null);
    try {
      if (previousPreview?.id)
        await rpc("cancel_import_preview", { preview_id: previousPreview.id });
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
  const cancelPreview = async () => {
    if (!preview) return;
    setBusy(true);
    setError("");
    try {
      await rpc("cancel_import_preview", { preview_id: preview.id });
      setPreview(null);
      notify("导入预览已取消");
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
              const previous = preview;
              setFiles(Array.from(e.target.files || []));
              setPreview(null);
              if (previous?.id)
                void rpc("cancel_import_preview", {
                  preview_id: previous.id,
                }).catch((err) => setError(messageOf(err)));
            }}
          />
        </label>
        <div className="form-row">
          <label className="field">
            资料类型
            <select
              value={kind}
              onChange={(e) => {
                const previous = preview;
                setKind(e.target.value);
                setPreview(null);
                if (previous?.id)
                  void rpc("cancel_import_preview", {
                    preview_id: previous.id,
                  }).catch((err) => setError(messageOf(err)));
              }}
            >
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
              onChange={(e) => {
                const previous = preview;
                setSeries(e.target.value);
                setPreview(null);
                if (previous?.id)
                  void rpc("cancel_import_preview", {
                    preview_id: previous.id,
                  }).catch((err) => setError(messageOf(err)));
              }}
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
            <button
              className="secondary"
              disabled={busy}
              onClick={cancelPreview}
            >
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
  const [noteFind, setNoteFind] = useState("");
  const [noteFrom, setNoteFrom] = useState("");
  const [noteTo, setNoteTo] = useState("");
  const noteOptions = usePagedRpc<Note>("list_notes", {
    limit: 40,
    from: noteFrom || undefined,
    to: noteTo || undefined,
  });
  const searchedNotes = usePagedRpc<{
    id: string;
    title: string;
    snippet: string;
    web_path: string;
  }>(
    "search_library",
    {
      query: noteFind,
      types: ["note"],
      from: noteFrom || undefined,
      to: noteTo || undefined,
      limit: 40,
    },
    !!noteFind.trim(),
  );
  const visibleNotes = noteFind.trim() ? searchedNotes : noteOptions;
  const [scope, setScope] = useState<"all" | "course" | "knowledge" | "notes">(
    "all",
  );
  const [ids, setIds] = useState("");
  const [share, setShare] = useState(false);
  const [redactions, setRedactions] = useState("");
  const [exportResult, setExportResult] = useState<any>(null);
  const [exportParamsAtResult, setExportParamsAtResult] = useState<ReturnType<
    typeof normalizeExportParams
  > | null>(null);
  const exportGeneration = useRef(0);
  const [backup, setBackup] = useState<any>(null);
  const [includeContext, setIncludeContext] = useState(false);
  const [restore, setRestore] = useState<any>(null);
  const [restoreFile, setRestoreFile] = useState<File | null>(null);
  const [confirmation, setConfirmation] = useState("");
  const [buildInfo, setBuildInfo] = useState<{
    version?: string;
    commit?: string;
    fingerprint?: string;
    built_at?: string;
  } | null>(null);
  useEffect(() => {
    let alive = true;
    fetch("/health")
      .then((r) => r.json())
      .then((result) => {
        if (alive) setBuildInfo(result.build || null);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  const courseOptions = usePagedRpc<Course>(
    "list_courses",
    { limit: 30 },
    scope === "course",
  );
  const cardOptions = usePagedRpc<Card>(
    "list_knowledge",
    { limit: 30 },
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
    invalidateExport();
  };
  const invalidateExport = () => {
    exportGeneration.current++;
    setExportResult(null);
    setExportParamsAtResult(null);
  };
  const rotate = () =>
    run("rotate", async () => {
      await rpc("rotate_mcp_token");
      notify("连接凭证已轮换，旧凭证已失效。");
    });
  const exportNow = () =>
    run("export", async () => {
      const params = normalizeExportParams(scope, ids, share, redactions);
      if (params.scope !== "all" && !params.ids.length)
        throw new Error("请先勾选至少一个条目。");
      invalidateExport();
      const generation = exportGeneration.current;
      const generated = await rpc("export_data", params);
      if (generation === exportGeneration.current) {
        if (
          !generated?.parameters ||
          JSON.stringify(generated.parameters) !== JSON.stringify(params)
        )
          throw new Error("生成文件参数与本次选择不一致，已停止下载，请重试。");
        setExportResult(generated);
        setExportParamsAtResult(params);
      }
    });
  const backupNow = () =>
    run("backup", async () => {
      setBackup(
        await rpc("create_backup", { include_context: includeContext }),
      );
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
            <dt>运行版本</dt>
            <dd>
              {buildInfo
                ? `${buildInfo.version || status?.app_version || "未知"} · ${buildInfo.commit?.slice(0, 8) || "本地构建"}`
                : status?.app_version || "读取中…"}
              {buildInfo?.fingerprint && (
                <small className="small-muted">
                  {" "}
                  · 构建 {buildInfo.fingerprint.slice(0, 12)}
                </small>
              )}
            </dd>
          </div>
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
        <p className="warning">
          这里的 MCP
          权限只约束工作台接口，不限制客户端使用其他本机能力。授权返回的内容可能进入外部模型上下文，请只勾选要提供的记录。
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
          <div className="filters">
            <label>
              查找记录{" "}
              <input
                value={noteFind}
                onChange={(e) => setNoteFind(e.target.value)}
                placeholder="输入原话关键词"
              />
            </label>
            <label>
              开始日期{" "}
              <input
                type="date"
                value={noteFrom}
                onChange={(e) => setNoteFrom(e.target.value)}
              />
            </label>
            <label>
              结束日期{" "}
              <input
                type="date"
                value={noteTo}
                onChange={(e) => setNoteTo(e.target.value)}
              />
            </label>
          </div>
          {visibleNotes.error && (
            <ErrorBox error={visibleNotes.error} retry={visibleNotes.refresh} />
          )}
          <div className="permission-list">
            {visibleNotes.items.map((note) => (
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
                  {("original_text" in note
                    ? String(note.original_text)
                    : note.title
                  ).slice(0, 68)}{" "}
                  {"created_at" in note && (
                    <small>{dateLabel(String(note.created_at))}</small>
                  )}
                </span>
              </label>
            ))}
          </div>
          {visibleNotes.cursor && (
            <button
              className="secondary"
              disabled={visibleNotes.loading}
              onClick={visibleNotes.more}
            >
              加载更多记录
            </button>
          )}
        </div>
        <details>
          <summary>高级：按 ID 设置允许读取的记录</summary>
          <label className="field">
            记录 ID（每行一个）
            <textarea
              rows={3}
              value={noteIds}
              onChange={(e) => setNoteIds(e.target.value)}
            />
          </label>
        </details>
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
              invalidateExport();
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
                ? courseOptions.items
                : scope === "knowledge"
                  ? cardOptions.items
                  : visibleNotes.items
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
            {scope === "notes" && visibleNotes.cursor && (
              <button
                className="secondary"
                disabled={visibleNotes.loading}
                onClick={visibleNotes.more}
              >
                加载更多记录
              </button>
            )}
            {scope === "course" && courseOptions.cursor && (
              <button
                className="secondary"
                disabled={courseOptions.loading}
                onClick={courseOptions.more}
              >
                加载更多课程
              </button>
            )}
            {scope === "knowledge" && cardOptions.cursor && (
              <button
                className="secondary"
                disabled={cardOptions.loading}
                onClick={cardOptions.more}
              >
                加载更多知识卡
              </button>
            )}
            <details>
              <summary>高级：按 ID 指定较早或未列出的条目</summary>
              <textarea
                rows={3}
                value={ids}
                onChange={(e) => {
                  setIds(e.target.value);
                  invalidateExport();
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
            onChange={(e) => {
              setShare(e.target.checked);
              invalidateExport();
            }}
          />
          生成分享版本并先检查脱敏预览
        </label>
        {share && (
          <label className="field">
            需要替换的敏感字词（每行一个）
            <textarea
              rows={3}
              value={redactions}
              onChange={(e) => {
                setRedactions(e.target.value);
                invalidateExport();
              }}
              placeholder="例如姓名、账号或地点"
            />
          </label>
        )}
        <button className="primary" disabled={!!busy} onClick={exportNow}>
          生成导出预览
        </button>
        {exportResult && exportParamsAtResult && (
          <div className="preview-box">
            <span className="eyebrow">
              {exportParamsAtResult.share ? "分享脱敏预览" : "私人导出预览"}
            </span>
            <p className="small-muted">
              这份文件的实际范围：
              {
                (
                  {
                    all: "全部资料",
                    course: "所选课程",
                    knowledge: "所选知识卡",
                    notes: "所选个人记录",
                  } as Record<string, string>
                )[exportParamsAtResult.scope]
              }
              {exportParamsAtResult.scope !== "all"
                ? ` · ${exportParamsAtResult.ids.length} 项`
                : ""}{" "}
              ·{" "}
              {exportParamsAtResult.share
                ? `分享版，替换 ${exportParamsAtResult.redactions.length} 个指定字词`
                : "私人版，未脱敏"}
            </p>
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
        <label className="check-row">
          <input
            type="checkbox"
            checked={includeContext}
            onChange={(e) => {
              setIncludeContext(e.target.checked);
              setBackup(null);
            }}
          />
          额外包含本机运行上下文（默认不包含，备份始终排除连接凭证）
        </label>
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
