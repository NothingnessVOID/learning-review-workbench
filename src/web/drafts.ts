import { useEffect, useRef, useState } from "react";

export type VersionedDraft = { requestId: string };
type StoredDraft<T> = { schema: 1; id: string; revision: string; updatedAt: number; draft: T };
export type RecoverableDraft<T> = { id: string; draft: T; updatedAt: number };
const entryKey = (key: string, id: string) => `${key}.entry.${id}`;
const editorKey = (key: string) => `workbench.editor.${key}`;
// React StrictMode may invoke a lazy initializer twice in one document. Keep
// the chosen editor id stable for that document, while refusing a cloned
// sessionStorage id in a newly opened same-origin tab.
const documentEditorIds = new Map<string, string>();

function editorIdForDocument(key: string, legacyId: string | null) {
  const currentDocumentId = documentEditorIds.get(key);
  if (currentDocumentId) return currentDocumentId;
  const previousId = sessionStorage.getItem(editorKey(key));
  const navigationType = (performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined)?.type;
  const isExistingDocument = navigationType === "reload" || navigationType === "back_forward";
  const id = (isExistingDocument ? previousId : null) || legacyId || crypto.randomUUID();
  sessionStorage.setItem(editorKey(key), id);
  documentEditorIds.set(key, id);
  return id;
}

function readEntry<T>(key: string, id: string): StoredDraft<T> | null {
  try {
    const value = JSON.parse(localStorage.getItem(entryKey(key, id)) || "null");
    return value?.schema === 1 && value?.id === id && value?.draft ? value as StoredDraft<T> : null;
  } catch { return null; }
}

function entries<T>(key: string): StoredDraft<T>[] {
  const prefix = `${key}.entry.`;
  const result: StoredDraft<T>[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const name = localStorage.key(i);
    if (!name?.startsWith(prefix)) continue;
    const entry = readEntry<T>(key, name.slice(prefix.length));
    if (entry) result.push(entry);
  }
  return result.sort((a, b) => b.updatedAt - a.updatedAt);
}

function hasContent<T extends VersionedDraft>(draft: T, empty: () => T) {
  const content = (value: T) => {
    const { requestId: _requestId, ...rest } = value;
    return JSON.stringify(rest);
  };
  return content(draft) !== content(empty());
}

/** Copy the old single-slot value before removing its key. */
export function migrateLegacy<T extends VersionedDraft>(key: string): string | null {
  const raw = localStorage.getItem(key);
  if (!raw) return null;
  try {
    const draft = JSON.parse(raw) as T;
    if (!draft || typeof draft !== "object" || !draft.requestId) return null;
    let id = "legacy";
    const prior = readEntry<T>(key, id);
    if (prior && JSON.stringify(prior.draft) !== JSON.stringify(draft))
      id = crypto.randomUUID();
    if (!readEntry<T>(key, id))
      localStorage.setItem(entryKey(key, id), JSON.stringify({
        schema: 1, id, revision: crypto.randomUUID(), updatedAt: Date.now(), draft,
      }));
    if (localStorage.getItem(key) === raw && readEntry<T>(key, id))
      localStorage.removeItem(key);
    return id;
  } catch { return null; }
}

export function sameSubmittedDraft<T extends VersionedDraft>(current: T, submitted: T) {
  return current.requestId === submitted.requestId && JSON.stringify(current) === JSON.stringify(submitted);
}

/** Separate persistent slot per tab; a version conflict creates another slot. */
export function usePersistentDraft<T extends VersionedDraft>(key: string, empty: () => T) {
  const [initial] = useState(() => {
    const legacyId = migrateLegacy<T>(key);
    const id = editorIdForDocument(key, legacyId);
    const stored = readEntry<T>(key, id);
    return { id, revision: stored?.revision || null, draft: stored?.draft || empty() };
  });
  const [draft, setState] = useState<T>(initial.draft);
  const [recoverable, setRecoverable] = useState<RecoverableDraft<T>[]>(() =>
    entries<T>(key)
      .filter((entry) => entry.id !== initial.id && hasContent(entry.draft, empty))
      .map(({ id, draft, updatedAt }) => ({ id, draft, updatedAt })),
  );
  const [conflict, setConflict] = useState(false);
  const current = useRef(initial.draft);
  const identity = useRef({ id: initial.id, revision: initial.revision });
  const recoveredFrom = useRef<{ id: string; revision: string } | null>(null);
  const mounted = useRef(false);
  const refreshRecovery = () => setRecoverable(
    entries<T>(key)
      .filter((entry) => entry.id !== identity.current.id && hasContent(entry.draft, empty))
      .map(({ id, draft, updatedAt }) => ({ id, draft, updatedAt })),
  );
  useEffect(() => {
    mounted.current = true;
    refreshRecovery();
    const onStorage = (event: StorageEvent) => {
      if (event.key?.startsWith(`${key}.entry.`)) refreshRecovery();
    };
    addEventListener("storage", onStorage);
    return () => { mounted.current = false; removeEventListener("storage", onStorage); };
  }, [key]);

  const update = (value: T | ((previous: T) => T)) => {
    const next = typeof value === "function" ? (value as (previous: T) => T)(current.current) : value;
    let { id, revision } = identity.current;
    const stored = readEntry<T>(key, id);
    if ((stored?.revision ?? null) !== revision) {
      id = crypto.randomUUID();
      identity.current = { id, revision: null };
      sessionStorage.setItem(editorKey(key), id);
      documentEditorIds.set(key, id);
      setConflict(true);
    }
    const nextRevision = crypto.randomUUID();
    localStorage.setItem(entryKey(key, id), JSON.stringify({
      schema: 1, id, revision: nextRevision, updatedAt: Date.now(), draft: next,
    } satisfies StoredDraft<T>));
    identity.current.revision = nextRevision;
    current.current = next;
    setState(next);
    refreshRecovery();
  };
  const clearSubmitted = (submitted: T) => {
    if (!mounted.current || !sameSubmittedDraft(current.current, submitted)) return false;
    const { id, revision } = identity.current;
    const stored = readEntry<T>(key, id);
    if (!stored || stored.revision !== revision || !sameSubmittedDraft(stored.draft, submitted)) return false;
    localStorage.removeItem(entryKey(key, id));
    const source = recoveredFrom.current;
    recoveredFrom.current = null;
    // Recovery copies the old slot so a failed save never loses its source.
    // Remove that source only after a successful submit and only if nobody has
    // changed its revision since recovery (including another open tab).
    if (source) {
      const latestSource = readEntry<T>(key, source.id);
      if (latestSource?.revision === source.revision)
        localStorage.removeItem(entryKey(key, source.id));
    }
    identity.current.revision = null;
    current.current = empty();
    setState(current.current);
    refreshRecovery();
    return true;
  };
  const recover = (id: string) => {
    const source = readEntry<T>(key, id);
    if (!source || !hasContent(source.draft, empty) || hasContent(current.current, empty)) return false;
    update({ ...source.draft, requestId: crypto.randomUUID() });
    recoveredFrom.current = { id: source.id, revision: source.revision };
    return true;
  };
  return { draft, update, current, clearSubmitted, recoverable, recover, conflict };
}

export type ExportParams = {
  scope: "all" | "course" | "knowledge" | "notes";
  ids: string[];
  share: boolean;
  redactions: string[];
};
export function normalizeExportParams(
  scope: ExportParams["scope"],
  rawIds: string,
  share: boolean,
  rawRedactions: string,
): ExportParams {
  const split = (value: string) => [
    ...new Set(
      value
        .split(/[\n,，]/)
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ];
  return {
    scope,
    ids: scope === "all" ? [] : split(rawIds),
    share,
    redactions: share ? split(rawRedactions) : [],
  };
}
