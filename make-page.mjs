/**
 * Converts a finished report into a body-only fragment.
 *
 * Hosts that wrap page content in their own <html>/<head>/<body> skeleton
 * cannot take a full document. This keeps the <title>, the <style> and
 * everything inside <body>, which is all the report actually needs -- it has no
 * external resources, so the fragment stays as offline-capable as the file.
 *
 *   node make-page.mjs [source.html] [out.html]
 */
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const src = process.argv[2] || join(HERE, "reports", "latest.html");
const out = process.argv[3] || join(HERE, "reports", "page.html");

const html = await readFile(src, "utf8");

const pick = (re) => {
  const m = html.match(re);
  return m ? m[0] : "";
};

// A hosted page keeps one stable identity across republishes, so the date that
// belongs in the report header is dropped from the title.
const title = "<title>Market Prep</title>";
const style = pick(/<style>[\s\S]*?<\/style>/i);

const bodyOpen = html.search(/<body[^>]*>/i);
const bodyClose = html.lastIndexOf("</body>");
if (bodyOpen === -1 || bodyClose === -1) {
  console.error("Could not find <body> in " + src);
  process.exit(1);
}
const body = html.slice(html.indexOf(">", bodyOpen) + 1, bodyClose);

const fragment = `${title}\n${style}\n${body}`;
await writeFile(out, fragment, "utf8");

const kb = (Buffer.byteLength(fragment, "utf8") / 1024).toFixed(0);
console.log(`${out}  (${kb} KB)`);
