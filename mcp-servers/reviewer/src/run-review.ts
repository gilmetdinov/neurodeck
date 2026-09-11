#!/usr/bin/env node
/**
 * run-review.ts — фоновый CLI-воркер одного ревью.
 * Запускается detached из MCP-сервера, не блокирует gateway.
 *
 * Использование:
 *   node dist/run-review.js --id <review_id> --mr <mr_ref>
 *
 * Пишет результат в ${REVIEW_STATE_DIR}/<review_id>.json
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  checkConfig, resolveMr, assembleReview, llmReview,
  ID_TO_NAME,
} from "./review-core.js";

const args = process.argv.slice(2);
let reviewId = "";
let mrRef = "";

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--id" && args[i + 1]) { reviewId = args[++i]; continue; }
  if (args[i] === "--mr" && args[i + 1]) { mrRef = args[++i]; continue; }
}

if (!reviewId || !mrRef) {
  console.error("usage: node run-review.js --id <review_id> --mr <mr_ref>");
  process.exit(1);
}

const configErr = checkConfig();
if (configErr) {
  console.error(`[run-review] config error: ${configErr}`);
  process.exit(1);
}

const clean = (v?: string): string => {
  const s = (v ?? "").trim();
  return /^\$\{.*\}$/.test(s) ? "" : s;
};

const AGENT_ROOT = clean(process.env.AGENT_REPO_ROOT) || process.cwd();
const STATE_DIR = join(AGENT_ROOT, "workspace", "state", "reviews");
mkdirSync(STATE_DIR, { recursive: true });

function writeState(status: string, extra: Record<string, any> = {}) {
  writeFileSync(join(STATE_DIR, `${reviewId}.json`), JSON.stringify({
    review_id: reviewId,
    mr: mrRef,
    status,
    updated_at: new Date().toISOString(),
    ...extra,
  }, null, 2));
}

async function main() {
  console.error(`[run-review] starting ${reviewId} for MR "${mrRef}"`);

  // 1) Resolve MR
  const resolved = await resolveMr(mrRef);
  if ("error" in resolved) {
    writeState("error", { error: resolved.error });
    console.error(`[run-review] ${reviewId}: ${resolved.error}`);
    process.exit(0);
  }

  // 2) Assemble review
  const assembled = await assembleReview(resolved.project, resolved.iid, resolved.info);
  if ("skip" in assembled) {
    writeState("skipped", { reason: assembled.skip, project: resolved.project, iid: resolved.iid });
    console.error(`[run-review] ${reviewId}: ${assembled.skip}`);
    process.exit(0);
  }

  writeState("reviewing", { project: resolved.project, iid: resolved.iid, title: assembled.title, kept: assembled.kept });

  // 3) LLM review
  let review: string;
  try {
    review = await llmReview(assembled.userMsg);
  } catch (e) {
    writeState("error", { error: `модель недоступна: ${(e as Error).message}`, project: resolved.project, iid: resolved.iid });
    console.error(`[run-review] ${reviewId}: model error: ${(e as Error).message}`);
    process.exit(0);
  }

  const repo = ID_TO_NAME.get(resolved.project) || resolved.project;
  const result = `🔎 Ревью ${repo}!${resolved.iid} «${assembled.title}» — файлов на ревью: ${assembled.kept}` +
                 (assembled.truncated ? " (диф обрезан)" : "") + "\n\n" + review;

  writeState("done", {
    project: resolved.project,
    iid: resolved.iid,
    title: assembled.title,
    kept: assembled.kept,
    truncated: assembled.truncated,
    result,
  });

  console.error(`[run-review] ${reviewId}: done (${assembled.kept} files)`);
}

main().catch((e) => {
  writeState("error", { error: `unexpected: ${e?.message ?? e}` });
  console.error(`[run-review] ${reviewId}: fatal: ${e?.message ?? e}`);
  process.exit(1);
});
