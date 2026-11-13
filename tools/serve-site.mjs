/**
 * Serves the built site/ folder on http://localhost:8100 so pages that fetch
 * their data (the futures practice page) work locally. Opening them straight
 * from disk can't, because browsers block file:// fetches.
 *
 *   node publish-site.mjs && node tools/serve-site.mjs [port]
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, join, normalize, extname } from "node:path";
import { fileURLToPath } from "node:url";

const SITE = join(dirname(fileURLToPath(import.meta.url)), "..", "site");
const PORT = Number(process.argv[2]) || 8100;
const TYPES = { ".html": "text/html; charset=utf-8", ".json": "application/json", ".css": "text/css", ".js": "text/javascript", ".woff2": "font/woff2" };

createServer(async (req, res) => {
  let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (p.endsWith("/")) p += "index.html";
  const file = normalize(join(SITE, p));
  if (!file.startsWith(SITE)) { res.writeHead(403).end(); return; }
  try {
    const body = await readFile(file);
    res.writeHead(200, { "Content-Type": TYPES[extname(file)] ?? "application/octet-stream", "Cache-Control": "no-cache" });
    res.end(body);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" }).end("Not found");
  }
}).listen(PORT, () => console.log(`Serving ${SITE} at http://localhost:${PORT}/  (futures page: /futures.html)`));
