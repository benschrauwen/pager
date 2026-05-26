import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.join(__dirname, "..");

export const publicDir = path.join(serverDir, "public");
export const dataDir = path.join(serverDir, ".pager-data");
export const storePath = path.join(dataDir, "store.json");
export const sessionsDir = path.join(dataDir, "sessions");

export function sessionFilePath(sessionId) {
  return path.join(sessionsDir, `${sessionId}.json`);
}
