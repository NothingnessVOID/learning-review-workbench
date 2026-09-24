import { spawn } from "node:child_process";
import { join } from "node:path";
import { startTestServer, project } from "./test-server.mjs";
const server = await startTestServer();
try {
  for (const script of ["ui-test.mjs", "ui-regression.mjs"]) {
    const child = spawn(process.execPath, [join(project, "scripts", script)], {
      cwd: project,
      env: { ...process.env, UI_TEST_URL: server.base },
      stdio: "inherit",
    });
    const code = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", resolve);
    });
    if (code !== 0) throw Error(`${script} exited ${code}`);
  }
} finally {
  await server.stop();
}
