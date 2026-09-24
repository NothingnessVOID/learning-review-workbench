export type ApiError = Error & { code?: string; details?: unknown };
let csrf: string | null = null;
let sessionPromise: Promise<string> | null = null;

async function sessionToken() {
  if (csrf) return csrf;
  if (!sessionPromise)
    sessionPromise = fetch("/api/session", { credentials: "same-origin" })
      .then(async (response) => {
        if (!response.ok)
          throw new Error("无法建立本地会话，请确认服务仍在运行。");
        const session = (await response.json()) as { csrf: string };
        csrf = session.csrf;
        return csrf;
      })
      .finally(() => {
        sessionPromise = null;
      });
  return sessionPromise;
}

export async function rpc<T = any>(
  tool: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  const body = JSON.stringify({ tool, args });
  const send = async (token: string) => {
    try {
      return await fetch("/api/rpc", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": token },
        body,
      });
    } catch {
      throw new Error("本地服务暂时无法连接。输入已保留，可以稍后重试。");
    }
  };
  let token = await sessionToken();
  let response = await send(token);
  if (response.status === 403) {
    if (csrf === token) csrf = null;
    token = await sessionToken();
    response = await send(token);
  }
  const result = (await response.json().catch(() => null)) as {
    ok: boolean;
    data?: T;
    error?: { code: string; message: string; details?: unknown };
  } | null;
  if (!result?.ok) {
    const err = new Error(
      result?.error?.message || `请求失败（${response.status}）`,
    ) as ApiError;
    err.code = result?.error?.code;
    err.details = result?.error?.details;
    throw err;
  }
  return result.data as T;
}

/** Best-effort unload write; the local reader bookmark remains the recovery copy. */
export function rpcKeepalive(tool: string, args: Record<string, unknown>) {
  if (!csrf) return;
  void fetch("/api/rpc", {
    method: "POST",
    credentials: "same-origin",
    keepalive: true,
    headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
    body: JSON.stringify({ tool, args }),
  }).catch(() => {});
}

export function requestId() {
  return crypto.randomUUID();
}
export function messageOf(error: unknown) {
  return error instanceof Error ? error.message : "操作失败，请稍后重试。";
}
export function localDraft<T>(key: string, fallback: T): T {
  try {
    return JSON.parse(localStorage.getItem(key) || "") as T;
  } catch {
    return fallback;
  }
}
export function downloadUrl(path: string) {
  const url = new URL(path, window.location.origin);
  return url.origin === window.location.origin &&
    url.pathname.startsWith("/api/download/")
    ? url.pathname
    : "";
}
