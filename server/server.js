import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { json, notFound } from "./lib/http.js";
import { publicDir } from "./lib/paths.js";
import { stopAllHandlerRuntimes, syncHandlerRuntimes } from "./lib/runtime.js";
import { loadStore } from "./lib/store.js";
import { handleApi } from "./routes/api.js";

const port = Number(process.env.PORT || 4111);
const host = process.env.HOST || "127.0.0.1";

async function serveStatic(req, res, pathname) {
  const relativePath = pathname === "/" ? "index.html" : pathname.slice(1);
  const safePath = path.normalize(relativePath).replace(/^(\.\.(\/|\\|$))+/, "");
  const filePath = path.join(publicDir, safePath);
  if (!filePath.startsWith(publicDir)) return notFound(res);

  try {
    const body = await fs.readFile(filePath);
    const ext = path.extname(filePath);
    const contentType = {
      ".html": "text/html; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
    }[ext] || "application/octet-stream";
    res.writeHead(200, { "content-type": contentType });
    res.end(body);
  } catch (error) {
    if (error?.code === "ENOENT") return notFound(res);
    throw error;
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    if (url.pathname.startsWith("/api/")) {
      await handleApi(req, res, url.pathname);
      return;
    }
    await serveStatic(req, res, url.pathname);
  } catch (error) {
    console.error(error);
    const status = error?.code === "cwd_not_found" ? 400 : 500;
    json(res, status, {
      error: status === 400 ? "bad_request" : "internal_error",
      detail: error instanceof Error ? error.message : String(error),
    });
  }
});

server.listen(port, host, async () => {
  const store = await loadStore();
  syncHandlerRuntimes(store);
  console.log(`Pager is running at http://${host}:${port}`);
});

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Received ${signal}, stopping handlers...`);
  stopAllHandlerRuntimes();
  const forceExit = setTimeout(() => process.exit(0), 3000);
  forceExit.unref();
  server.close(() => process.exit(0));
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
