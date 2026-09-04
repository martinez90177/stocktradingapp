import { readFile } from "node:fs/promises";
import type { RuleBook } from "./types.ts";

/**
 * Loads the trading rules from rules.json.
 *
 * The file is the author, not this module: whatever is in it renders, in the
 * order written. Nothing is merged in from a default set, because a rule you
 * did not write is a rule you will not follow -- and a rule silently added back
 * after you deleted it is worse than none.
 *
 * A missing or malformed file means the popup is simply not offered.
 */
export async function loadRules(path: string): Promise<RuleBook | null> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return null;
  }

  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`rules.json is not valid JSON (${(e as Error).message})`);
  }

  const groups = (Array.isArray(parsed?.groups) ? parsed.groups : [])
    .map((g: any) => ({
      name: typeof g?.name === "string" ? g.name : "",
      rules: (Array.isArray(g?.rules) ? g.rules : [])
        .map((r: any) => ({
          rule: typeof r?.rule === "string" ? r.rule : typeof r === "string" ? r : "",
          why: typeof r?.why === "string" ? r.why : "",
        }))
        .filter((r: { rule: string }) => r.rule.length > 0),
    }))
    .filter((g: { name: string; rules: unknown[] }) => g.name && g.rules.length > 0);

  if (groups.length === 0) return null;

  return {
    title: typeof parsed?.title === "string" && parsed.title ? parsed.title : "Trading rules",
    subtitle: typeof parsed?.subtitle === "string" ? parsed.subtitle : "",
    groups,
    count: groups.reduce((n: number, g: { rules: unknown[] }) => n + g.rules.length, 0),
  };
}
