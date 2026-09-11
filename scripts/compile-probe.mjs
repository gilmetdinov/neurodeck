// compile-probe.mjs — проба compile_task (ADR-0015) на РЕАЛЬНОМ redmine MCP, мимо gateway/Telegram.
// Спавнит mcp-servers/redmine/dist/index.js по stdio (как OpenClaw), берёт настоящую открытую
// Redmine-задачу и компилирует её в черновик TaskSpec. Проверяет весь живой путь: Redmine (напрямую) +
// DeepInfra (через прокси) + парс JSON + запись файлов. Деньги: один вызов компилятора (~центы).
//
// Запуск:  node scripts/compile-probe.mjs [<redmine_id>] [<compiler_model>]
//   без аргументов — возьмёт первую открытую задачу проекта и модель DeepSeek-V4-Pro.
import { readFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// .env → объект (без печати значений).
function loadEnv() {
  const out = {};
  try {
    for (const line of readFileSync(join(ROOT, ".env"), "utf8").split("\n")) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "").trim();
    }
  } catch {}
  return out;
}

const argId = process.argv[2] ? Number(process.argv[2]) : null;
const compilerModel = process.argv[3] || process.env.COMPILER_MODEL || "deepseek-ai/DeepSeek-V4-Pro";

const dot = loadEnv();
const proxy = dot.TELEGRAM_PROXY || dot.PROXY_URL || "";
// Среда дочернего MCP — как в openclaw.json5 redmine-блоке (+ compile_task-переменные).
const childEnv = {
  ...process.env,
  ...dot,
  AGENT_REPO_ROOT: ROOT,
  REDMINE_TEAM_CONFIG: join(ROOT, "config", "team.json"),
  PROJECTS_REGISTRY: join(ROOT, "config", "projects.json5"),
  COMPILER_PROMPT_PATH: join(ROOT, "prompts", "task-compiler.md"),
  BASE_PROMPT_PATH: join(ROOT, "prompts", "_base.md"),
  ANALYST_PROMPT_PATH: join(ROOT, "prompts", "redmine-analyst.md"),
  DEEPINFRA_PROXY: proxy,
  COMPILER_MODEL: compilerModel,
};

const transport = new StdioClientTransport({
  command: "node",
  args: [join(ROOT, "mcp-servers", "redmine", "dist", "index.js")],
  env: childEnv,
  stderr: "inherit",
});
const client = new Client({ name: "compile-probe", version: "0.0.0" }, { capabilities: {} });

const textOf = (r) => (r?.content ?? []).map((c) => c.text ?? "").join("\n");

console.log(`[probe] compiler model = ${compilerModel}; proxy = ${proxy ? "on" : "OFF"}`);
await client.connect(transport);

const tools = (await client.listTools()).tools.map((t) => t.name);
console.log(`[probe] tools: ${tools.join(", ")}`);
if (!tools.includes("compile_task")) { console.error("✗ compile_task НЕ зарегистрирован — пересобери redmine MCP"); process.exit(1); }

// Берём реальный #NNNNN: аргумент или первая открытая задача проекта.
let redmineId = argId;
if (!redmineId) {
  const li = await client.callTool({ name: "list_issues", arguments: { status_id: "open", limit: 1, sort: "updated_on:desc" } });
  const data = JSON.parse(textOf(li));
  redmineId = data?.issues?.[0]?.id;
  console.log(`[probe] выбрана открытая задача #${redmineId}: ${data?.issues?.[0]?.subject ?? "?"}`);
}
if (!redmineId) { console.error("✗ не нашёл открытую задачу — передай id аргументом"); process.exit(1); }

console.log(`[probe] → compile_task(redmine_id=${redmineId}) …`);
const t0 = Date.now();
const res = await client.callTool({ name: "compile_task", arguments: { redmine_id: redmineId } });
console.log(`[probe] компиляция заняла ${((Date.now() - t0) / 1000).toFixed(1)}с\n`);
console.log(textOf(res));

await client.close();
process.exit(0);
