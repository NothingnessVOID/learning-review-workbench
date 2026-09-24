import express from "express";
import { homedir } from "node:os";
import { resolve, join } from "node:path";
import { randomBytes, timingSafeEqual, createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Service } from "../domain/service.js";
const here = fileURLToPath(new URL(".", import.meta.url));
const projectDir = existsSync(join(here, "../package.json"))
  ? resolve(here, "..")
  : resolve(here, "../..");
const dataDir =
  process.env.LEARNING_WORKBENCH_DATA_DIR ??
  join(homedir(), "Library", "Application Support", "LearningWorkbench");
const port = Number(process.env.LEARNING_WORKBENCH_PORT ?? 47831);
const service = new Service(dataDir, projectDir);
const buildPath = join(projectDir, "dist", "build-info.json");
const build = existsSync(buildPath)
  ? JSON.parse(readFileSync(buildPath, "utf8"))
  : { version: "1.1.0", fingerprint: "development", commit: "unbuilt" };
const instance = createHash("sha256")
  .update(resolve(dataDir) + ":" + port)
  .digest("hex")
  .slice(0, 16);
const cookieName = `workbench_session_${instance}`;
const app = express();
app.disable("x-powered-by");
const sessions = new Map<string, { csrf: string; expires: number }>();
const equal = (a: string, b: string) => {
  const left = Buffer.from(a),
    right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};
app.use((req, res, next) => {
  const host = req.headers.host ?? "";
  const expected = `127.0.0.1:${port}`;
  if (host !== expected) {
    res.status(403).json({
      ok: false,
      error: {
        code: "PERMISSION_DENIED",
        message: "仅允许本地回环地址访问。",
      },
    });
    return;
  }
  const origin = req.headers.origin;
  if (origin && origin !== `http://${expected}`) {
    res.status(403).json({
      ok: false,
      error: { code: "PERMISSION_DENIED", message: "拒绝跨站来源。" },
    });
    return;
  }
  if (req.headers["sec-fetch-site"] === "cross-site") {
    res.sendStatus(403);
    return;
  }
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  );
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cache-Control", "no-store");
  next();
});
app.use(express.json({ limit: "96mb" }));
app.get("/health", (_req, res) =>
  res.json({
    ok: true,
    app: "learning-workbench",
    version: build.version,
    build,
    instance,
  }),
);
app.get("/api/session", (req, res) => {
  const existingToken = (req.headers.cookie ?? "")
    .split(";")
    .map((v) => v.trim())
    .find((v) => v.startsWith(cookieName + "="))
    ?.slice(cookieName.length + 1);
  const existing = existingToken ? sessions.get(existingToken) : undefined;
  if (existing && existing.expires > Date.now()) {
    res.json({ csrf: existing.csrf });
    return;
  }
  const token = randomBytes(32).toString("hex"),
    csrf = randomBytes(32).toString("hex");
  for (const [k, v] of sessions) if (v.expires < Date.now()) sessions.delete(k);
  sessions.set(token, { csrf, expires: Date.now() + 24 * 3600 * 1000 });
  res.cookie(cookieName, token, {
    httpOnly: true,
    sameSite: "strict",
    path: "/",
    maxAge: 24 * 3600 * 1000,
  });
  res.json({ csrf });
});
const auth: express.RequestHandler = (req, res, next) => {
  const token = (req.headers.cookie ?? "")
    .split(";")
    .map((v) => v.trim())
    .find((v) => v.startsWith(cookieName + "="))
    ?.slice(cookieName.length + 1);
  const session = token ? sessions.get(token) : null;
  if (
    !session ||
    session.expires < Date.now() ||
    (req.method === "POST" &&
      !equal(String(req.headers["x-csrf-token"] ?? ""), session.csrf))
  ) {
    res.status(403).json({
      ok: false,
      error: {
        code: "PERMISSION_DENIED",
        message:
          "本地会话已过期，请刷新页面；未保存的文字仍保留在浏览器草稿中。",
      },
    });
    return;
  }
  next();
};
app.post("/api/rpc", auth, async (req, res) =>
  res.json(
    await service.invoke(req.body?.tool, req.body?.args ?? {}, "local_user"),
  ),
);
app.post("/api/mcp", async (req, res) => {
  const token = String(req.headers.authorization ?? "").replace(/^Bearer /, "");
  if (!equal(token, service.store.token())) {
    res.status(403).json({
      ok: false,
      error: { code: "PERMISSION_DENIED", message: "MCP 凭据无效或已撤销。" },
      warnings: [],
    });
    return;
  }
  res.json(
    await service.invoke(
      req.body?.tool,
      req.body?.args ?? {},
      "external_agent",
    ),
  );
});
app.get("/api/download/:id", auth, (req, res) => {
  const id = String(req.params.id);
  if (!/^(backup|export)_[\w]+$/.test(id)) {
    res.sendStatus(404);
    return;
  }
  const item = service.store.setting(`download:${id}`);
  const expectedFile = join(
    dataDir,
    id.startsWith("backup_") ? "backups" : "exports",
    id + ".zip",
  );
  if (!item || item.file !== expectedFile || !existsSync(expectedFile)) {
    res.sendStatus(404);
    return;
  }
  res.download(expectedFile, item.filename);
});
const webDir = join(projectDir, "dist", "web");
app.use(express.static(webDir));
app.get("/", (_req, res) => {
  if (existsSync(join(webDir, "index.html")))
    res.sendFile(join(webDir, "index.html"));
  else res.status(503).send("前端尚未构建，请在项目目录运行 npm run build。");
});
app.use(
  (
    err: any,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => {
    res.status(err.status === 413 ? 413 : 400).json({
      ok: false,
      error: {
        code: err.status === 413 ? "PAYLOAD_TOO_LARGE" : "VALIDATION_ERROR",
        message: err.status === 413 ? "请求体积过大。" : "请求不是有效 JSON。",
      },
      warnings: [],
    });
  },
);
const server = app.listen(port, "127.0.0.1", () => {
  writeFileSync(join(dataDir, "server.pid"), String(process.pid), {
    mode: 0o600,
  });
  console.log(
    `学习工作台已启动：http://127.0.0.1:${port}\n数据目录：${dataDir}\n按 Ctrl+C 停止。`,
  );
});
server.on("error", (err: NodeJS.ErrnoException) => {
  console.error(
    err.code === "EADDRINUSE"
      ? `端口 ${port} 已被占用。如工作台已启动，请直接打开浏览器；否则停止占用该端口的程序。`
      : "本地服务启动失败，请检查数据目录和端口。",
  );
  service.store.close();
  process.exitCode = 1;
});
function stop() {
  server.close(() => {
    service.store.close();
    try {
      const f = join(dataDir, "server.pid");
      if (readFileSync(f, "utf8") === String(process.pid)) unlinkSync(f);
    } catch {}
    process.exit(0);
  });
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
