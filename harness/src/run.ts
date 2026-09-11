#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// neurodeck harness (ADR-0008) — гоняет opencode/claude на TaskSpec в ЛОКАЛЬНОМ
// git: ветка + коммиты + диффы, БЕЗ push/MR. Сырьё-репы read-only (--add-dir у
// Claude / --file у opencode), пишем/коммитим в target. Приземление коммитов —
// руками после ревью.
//
// Запуск:  npm run harness -- harness/tasks/<task>.json
// Требует: Node ≥22.19 (--experimental-strip-types), opencode (Zen PAYG) ИЛИ
//          Claude Code (подписка), поднятый локальный прокси (PROXY_URL из .env).
//
// Драйверы (ADR-0023):
//   opencode (default) — `opencode run --format json --auto -m opencode/<model>`
//   claude-code          — `claude -p --output-format stream-json --permission-mode acceptEdits`
// ─────────────────────────────────────────────────────────────────────────────
import { spawn, spawnSync } from "node:child_process";
import { readFileSync, existsSync, mkdirSync, writeFileSync, copyFileSync, statSync, cpSync, unlinkSync } from "node:fs";
import { resolve, dirname, join, basename } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

// Имя проектного контекст-файла. AGENTS.md — провайдер-независимый стандарт
// (Claude Code / opencode / Codex), CLAUDE.md — легаси. Приоритет: AGENTS.md → CLAUDE.md.
function findContextMd(dir: string): string | null {
  for (const name of ["AGENTS.md", "CLAUDE.md"]) {
    if (existsSync(join(dir, name))) return name;
  }
  return null;
}

type TaskSpec = {
  id: string;
  target: string;                   // git-репо/папка, КУДА пишем и коммитим
  sources?: string[];               // read-only папки (--add-dir): исходники, доки
  scopeMode?: string;               // full | files | docs. "files" → Claude получает ИЗОЛИРОВАННУЮ копию
                                    //   только из paths (IP-изоляция вариантов/монолитов, ADR-0013/0018).
  paths?: string[];                 // при scopeMode:"files" — какие файлы/папки реального репо отдать (writable)
  sourceRef?: string;               // при scopeMode:"files" — git-ref (ветка/коммит), С КОТОРОГО брать paths.
                                    //   ТЗ-задача привязана к конкретной ветке (напр. "#59460"); без sourceRef
                                    //   берётся ТЕКУЩИЙ HEAD реального репо — ловушка: репо мог стоять не на той
                                    //   ветке → Claude получит чужой код и переделает уже сделанное. git archive
                                    //   ЧИТАЕТ ref, НЕ переключает checkout реального репо (безопасно при парал. работе).
  model?: string;                   // opus | sonnet | ...
  driver?: "opencode" | "claude-code" | "local"; // ADR-0023: чем исполнять. opencode (default,
                                    //   `opencode run`, Zen-модели) | claude-code | local (на будущее).
  tier?: "strong" | "weak";         // ADR-0023: класс модели (для тиринга/эскалации; пока информативно).
  executionMode?: boolean;          // ADR-0023 этап 2: разрешить контролируемый запуск тестов/билда
                                    //   (allowlist команд из реестра, в изолированной копии, сеть off).
  maxBudgetUsd?: number;            // бюджет НА ОДНУ попытку claude
  maxAttempts?: number;             // авто-ретрай при обрыве (exit≠0): сеть/таймаут транзиентны,
                                    //   работа коммитится по ходу → ретрай продолжает с места. По умолч. 1.
  promptPath: string;               // файл с ТЗ задачи (относительно корня репо)
  appendSystemPromptPath?: string;  // guardrails (относительно корня репо)
  // ── Verify-loop (ADR-0023 этап 3) — детерминированная проверка ПОСЛЕ агента ──
  verify?: {                        // команды для прогона тестов/typecheck
    commands: string[];             // список команд (напр. "go test ./...", "php vendor/bin/phpstan analyse")
    timeoutSec?: number;            // таймаут НА КОМАНДУ, сек. Дефолт 120.
    maxRetries?: number;            // макс. ретраев верификации (при фейле → даём агенту ошибку и перезапускаем).
                                    //   По умолчанию 1. При исчерпании + tier=weak → эскалация на strong + 1 попытка.
  };
};

// Сводка по одной задаче — для итоговой таблицы очереди.
type Summary = { id: string; branch: string; commits: number; cost: number; code: number; reportPath: string };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function loadEnvFile(): Record<string, string> {
  const out: Record<string, string> = {};
  const f = join(REPO_ROOT, ".env");
  if (!existsSync(f)) return out;
  for (const line of readFileSync(f, "utf8").split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "").trim();
  }
  return out;
}

function git(cwd: string, args: string[]): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} → ${(r.stderr || r.stdout || "").trim()}`);
  return (r.stdout || "").trim();
}
function gitTry(cwd: string, args: string[]): string {
  return (spawnSync("git", args, { cwd, encoding: "utf8" }).stdout || "").trim();
}

// Подготовка target: git-репо + новая ветка. No-push guard: нет remote = push невозможен;
// если remote есть — глушим push-url (плюс claude запускается с --disallowedTools git push/remote).
function prepareTarget(target: string, id: string, env: Record<string, string>): { branch: string; baseSha: string } {
  if (!existsSync(target)) throw new Error(`target не существует: ${target}`);
  if (!existsSync(join(target, ".git"))) {
    console.log(`[harness] ${target} — не git-репо, init…`);
    git(target, ["init", "-q"]);
  }
  // git-identity ЛОКАЛЬНО в target — иначе `git commit` падает "Author identity unknown" (на машине
  // нет global gitconfig). claude в песочнице identity задать НЕ может → ставим её тут, до прогона.
  git(target, ["config", "user.name", env.HARNESS_GIT_NAME || "neurodeck Agent"]);
  git(target, ["config", "user.email", env.HARNESS_GIT_EMAIL || "agent@local"]);
  // baseline-коммит только если репа пустая (нет HEAD) — теперь identity есть, коммит пройдёт
  if (spawnSync("git", ["rev-parse", "HEAD"], { cwd: target }).status !== 0) {
    git(target, ["commit", "-q", "--allow-empty", "-m", "harness: baseline"]);
  }
  const remote = gitTry(target, ["remote"]).split("\n")[0];
  if (remote) {
    git(target, ["config", `remote.${remote}.pushurl`, "DISABLED_BY_HARNESS_NO_PUSH"]);
    console.log(`[harness] remote "${remote}" → push-url отключён (no-push guard)`);
  }
  // Чистый старт: если предыдущий прогон оборвался ГРЯЗНЫМ (наредактировал, но не закоммитил), это
  // дерево иначе утекло бы в новую задачу (checkout -b тащит незакоммиченное). Спасаем его коммитом
  // на ТЕКУЩУЮ ветку (атрибуция верная + не теряется), новая ветка стартует с чистого состояния.
  if (gitTry(target, ["status", "--porcelain"])) {
    git(target, ["add", "-A"]);
    git(target, ["commit", "-q", "-m", "harness: спасение незакоммиченного из предыдущего прогона (обрыв)"]);
    console.log(`[harness] ⚠ найдено грязное дерево на старте → спасено коммитом на текущую ветку (чистый старт)`);
  }
  const baseSha = git(target, ["rev-parse", "HEAD"]);
  // Если executor-engine задал ветку (HARNESS_BRANCH=#NNNNN) — используем её, не создаём новую.
  const branchOverride = env.HARNESS_BRANCH || process.env.HARNESS_BRANCH;
  let branch: string;
  if (branchOverride) {
    branch = branchOverride;
    // Проверить, существует ли уже ветка. Если нет — создать от master.
    const existing = gitTry(target, ["rev-parse", "--verify", branch]);
    if (!existing) {
      git(target, ["checkout", "-q", "-b", branch]);
      console.log(`[harness] ветка ${branch} создана (от master)`);
    } else {
      git(target, ["checkout", "-q", branch]);
      console.log(`[harness] ветка ${branch} (существующая)`);
    }
  } else {
    branch = `harness/${id}-${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 12)}`;
    git(target, ["checkout", "-q", "-b", branch]);
  }
  console.log(`[harness] identity=${git(target, ["config", "user.name"])}; ветка ${branch} (base ${baseSha.slice(0, 8)})`);
  return { branch, baseSha };
}

// Снимок источников БЕЗ .git (read-only): claude НЕ видит исходный git → не путается в контексте и
// физически не может запачкать source-репу (как было: cwd дрейфанул в <variant-a>, git add там).
// Тяжёлые deps (vendor/node_modules) исключаем. Снимок в tmpdir (без родительского .git).
function snapshotSources(sources: string[]): string[] {
  const root = join(tmpdir(), "neurodeck-harness-src");
  mkdirSync(root, { recursive: true });
  const out: string[] = [];
  for (const src of sources) {
    const abs = resolve(src);
    if (!existsSync(abs)) { console.log(`[harness] ⚠ source не найден, пропускаю: ${src}`); continue; }
    const name = basename(abs.replace(/\/+$/, ""));
    // Одиночный ФАЙЛ (напр. брейкдаун-.md по задаче): кладём в выделенную снапшот-папку и --add-dir её
    // (Claude --add-dir принимает каталог; файл сам по себе нельзя). Папка — rsync без .git.
    if (statSync(abs).isFile()) {
      const snap = join(root, "file-" + name);
      mkdirSync(snap, { recursive: true });
      copyFileSync(abs, join(snap, name));
      console.log(`[harness] source snapshot (файл): ${name}`);
      out.push(snap);
      continue;
    }
    const snap = join(root, name);
    mkdirSync(snap, { recursive: true });
    const r = spawnSync("rsync", ["-a", "--delete", "--exclude", ".git", "--exclude", "vendor",
      "--exclude", "node_modules", "--exclude", ".DS_Store", abs + "/", snap + "/"], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(`snapshot ${src}: ${(r.stderr || r.stdout || "").trim()}`);
    console.log(`[harness] source snapshot (.git-less): ${name}`);
    out.push(snap);
  }
  return out;
}

// scopeMode:"files" — собрать ИЗОЛИРОВАННУЮ рабочую копию: ТОЛЬКО файлы/папки из `paths` реального репо
// (writable), БЕЗ остального дерева и без `.git`. Claude монолит/вариант целиком НЕ видит (IP-изоляция,
// ADR-0013/0018). Доп. кладём корневой AGENTS.md/CLAUDE.md (контекст проекта доступен даже при суженном scope, 0013).
// Реальный репо НЕ трогается; патч приземляется руками (инструкция — в отчёте).
function buildScopedTarget(realTarget: string, paths: string[], id: string, sourceRef?: string): { scopedDir: string; realBaseSha: string; copied: string[]; missing: string[]; sourceRef?: string } {
  const stamp = new Date().toISOString().replace(/[-:T.]/g, "").slice(0, 14);
  const scopedDir = join(tmpdir(), "neurodeck-harness-scoped", `${id}-${stamp}`);
  mkdirSync(scopedDir, { recursive: true });
  const copied: string[] = [];
  const missing: string[] = [];
  const noGit = (s: string) => !/(^|\/)\.git(\/|$)/.test(s);

  // sourceRef задан → берём дерево ТОЧНО с указанной ветки/коммита (ТЗ привязано к ветке, напр. "#59460"),
  // НЕЗАВИСИМО от того, на чём реальный репо сейчас стоит. `git archive` ЧИТАЕТ ref — НЕ переключает checkout,
  // НЕ трогает рабочее дерево/индекс реального репо (безопасно, даже если в нём кто-то параллельно работает).
  if (sourceRef) {
    const rp = spawnSync("git", ["rev-parse", "--verify", `${sourceRef}^{commit}`], { cwd: realTarget, encoding: "utf8" });
    if (rp.status !== 0) throw new Error(`[harness] sourceRef "${sourceRef}" не резолвится в ${realTarget}: ${(rp.stderr || "").trim()} — проверь имя ветки в TaskSpec`);
    const realBaseSha = (rp.stdout || "").trim();
    // archive <sha> -- <rel> → tar по repo-относительному пути; tar -x воссоздаёт его в scopedDir (с подпапками).
    // Несуществующий в ref путь → archive exit≠0 → в missing. Без .git, без рабочих правок реального репо.
    const extract = (rel: string): boolean => {
      const ar = spawnSync("git", ["-C", realTarget, "archive", "--format=tar", realBaseSha, "--", rel],
        { encoding: "buffer", maxBuffer: 512 * 1024 * 1024 });
      if (ar.status !== 0 || !ar.stdout || (ar.stdout as Buffer).length === 0) return false;
      return spawnSync("tar", ["-x", "-C", scopedDir], { input: ar.stdout as Buffer }).status === 0;
    };
    for (const rel of paths) (extract(rel) ? copied : missing).push(rel);
    const ctx = findContextMd(realTarget);
    if (ctx && !existsSync(join(scopedDir, ctx))) extract(ctx);   // контекст проекта (ADR-0013), best-effort
    return { scopedDir, realBaseSha, copied, missing, sourceRef };
  }

  // sourceRef НЕ задан → прежнее поведение: снимок ТЕКУЩЕГО рабочего дерева реального репо.
  const realBaseSha = gitTry(realTarget, ["rev-parse", "HEAD"]) || "(no-git)";
  for (const rel of paths) {
    const src = resolve(realTarget, rel);
    if (!existsSync(src)) { missing.push(rel); continue; }
    const dst = join(scopedDir, rel);
    mkdirSync(dirname(dst), { recursive: true });
    if (statSync(src).isFile()) copyFileSync(src, dst);
    else cpSync(src, dst, { recursive: true, filter: noGit });   // папка целиком, без .git
    copied.push(rel);
  }
  // AGENTS.md/CLAUDE.md проекта — контекст доступен и при суженном scope (ADR-0013), если не попал в paths.
  const ctx = findContextMd(realTarget);
  if (ctx && !existsSync(join(scopedDir, ctx))) copyFileSync(join(realTarget, ctx), join(scopedDir, ctx));
  return { scopedDir, realBaseSha, copied, missing, sourceRef };
}

// Событийный push в Telegram «прогон завершился» (ADR-0011 §3 «announce best-effort поверх файлов»).
// Шлём НАПРЯМУЮ в Bot API из detached-процесса (НЕ через gateway — у него нет нашей сессии), поэтому
// уведомление детерминированно и не зависит от того, позовёт ли оркестратор тул (recall: модель
// недетерминирована, верить только tool-call'ам). api.telegram.org гео-блокнут → через прокси
// (TELEGRAM_PROXY/PROXY_URL). ВСЁ обёрнуто — сбой доставки НИКОГДА не роняет прогон (файл-отчёт первичен).
// Отключить: HARNESS_NOTIFY=0. chat_id: HARNESS_NOTIFY_CHAT_ID или первый numeric из TELEGRAM_ALLOWED_USER_IDS.
async function notifyTelegram(text: string, env: Record<string, string>): Promise<void> {
  if ((env.HARNESS_NOTIFY ?? process.env.HARNESS_NOTIFY) === "0") return;
  const token = env.TELEGRAM_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN || "";
  const rawIds = env.HARNESS_NOTIFY_CHAT_ID || env.TELEGRAM_ALLOWED_USER_IDS || process.env.TELEGRAM_ALLOWED_USER_IDS || "";
  const chatId = (rawIds.match(/-?\d{5,}/) || [])[0] || "";   // telegram:123456789 → 123456789 (для DM chat_id == user id)
  const proxy = env.TELEGRAM_PROXY || env.PROXY_URL || process.env.TELEGRAM_PROXY || process.env.PROXY_URL || "";
  if (!token || !chatId) { console.log(`[harness] notify пропущен (нет ${!token ? "TELEGRAM_BOT_TOKEN" : "chat_id"})`); return; }
  try {
    const opts: any = {
      method: "POST",
      headers: { "content-type": "application/json" },
      // plain-text (без parse_mode): имена веток/задач содержат _ и пр. → Markdown бы ломался.
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(12000),   // не виснуть на флапающей проксе при выходе процесса
    };
    if (proxy) { const { ProxyAgent } = await import("undici"); opts.dispatcher = new ProxyAgent(proxy); }
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, opts);
    if (!r.ok) console.log(`[harness] notify: telegram ${r.status} ${(await r.text()).slice(0, 200)}`);
    else console.log(`[harness] ✅ уведомление отправлено в Telegram (chat ${chatId})`);
  } catch (e: any) {
    console.log(`[harness] notify не доставлено (best-effort, прогон не затронут): ${e?.message ?? e}`);
  }
}

// Преамбула для ретрая: предыдущая попытка оборвалась (сеть/таймаут). Часть работы закоммичена —
// claude должен осмотреть состояние и ПРОДОЛЖИТЬ, не повторяя сделанное.
const RETRY_PREAMBLE = [
  "ВНИМАНИЕ: предыдущая попытка этой задачи ПРЕРВАЛАСЬ (обрыв сети/таймаут), не по твоей вине.",
  "Часть работы, возможно, уже закоммичена в этом репозитории. ПОРЯДОК ДЕЙСТВИЙ:",
  "1) Сначала `git log --oneline` — что уже сделано.",
  "2) НЕ ПЕРЕПРОВЕРЯЙ заново уже закоммиченное — оно ПРИНЯТО. Повторное перечитывание всего репозитория",
  "   ради верификации = трата контекста и ПРЯМАЯ причина новых обрывов. Найди по git log / TODO",
  "   КОНКРЕТНУЮ незавершённую часть и доделай ТОЛЬКО её. Если всё сделано — коротко подтверди и заверши.",
  "3) НЕ пересоздавай существующие файлы. Коммить как можно РАНЬШЕ и мельче (единица работы = коммит).",
  "", "--- Ниже исходное ТЗ задачи ---", "",
].join("\n");

// ── Драйверы агента (ADR-0023): абстракция «кто исполняет TaskSpec» — чтобы свопать Claude Code на
// офисную модель БЕЗ переписывания петли. Контракт = бывший runClaude ({result,cost,code,progress}).
type DriverResult = { result: string; cost: number; code: number; progress: string[] };
interface AgentDriver { name: string; run(task: TaskSpec, env: Record<string, string>, attempt: number): Promise<DriverResult>; }

// ClaudeCodeDriver — текущий прогон: spawn CLAUDE_BIN, stream-json, allowlist (поведение БЕЗ изменений).
const claudeCodeDriver: AgentDriver = { name: "claude-code", async run(task, env, attempt = 1): Promise<DriverResult> {
  const CLAUDE_BIN = env.CLAUDE_BIN || process.env.CLAUDE_BIN || "claude";
  const PROXY = env.PROXY_URL || env.TELEGRAM_PROXY || process.env.PROXY_URL || "";
  const verifyErr = env.VERIFY_ERROR || process.env.VERIFY_ERROR || "";
  const prompt = (verifyErr ? VERIFY_RETRY_PREAMBLE + verifyErr + "\n\n" : "")
    + (attempt > 1 ? RETRY_PREAMBLE : "")
    + readFileSync(resolve(REPO_ROOT, task.promptPath), "utf8");

  const args: string[] = ["-p", prompt, "--output-format", "stream-json", "--verbose", "--permission-mode", "acceptEdits"];
  if (task.model) args.push("--model", task.model);
  if (task.maxBudgetUsd) args.push("--max-budget-usd", String(task.maxBudgetUsd));
  if (task.appendSystemPromptPath) args.push("--append-system-prompt", readFileSync(resolve(REPO_ROOT, task.appendSystemPromptPath), "utf8"));
  if (task.sources?.length) args.push("--add-dir", ...snapshotSources(task.sources));  // .git-less снимки
  // Безопасность автономного прогона: ТОЛЬКО локальные file/git-операции (allowlist). БЕЗ сети/клонов
  // (нельзя тащить чужие репы из gitlab), без push/remote. Что НЕ в allowlist → в headless отклоняется.
  args.push("--allowedTools",
    "Read", "Write", "Edit", "Glob", "Grep", "TodoWrite",
    "Bash(git add:*)", "Bash(git commit:*)", "Bash(git status:*)", "Bash(git checkout:*)",
    "Bash(git log:*)", "Bash(git diff:*)", "Bash(git mv:*)", "Bash(git rm:*)", "Bash(git init:*)",
    "Bash(git reset:*)", "Bash(git restore:*)", "Bash(git config:*)",
    // ⚠ БЕЗ `cat` (безлимитный дамп файла → раздувает контекст → обрыв; вместо него самоограничивающийся
    // Read с offset/limit). `wc` разрешён, чтобы «сначала узнай размер файла» было исполнимо. Греп —
    // через инструмент Grep (у него есть count/files-режимы и head_limit), не сырым bash. См. guardrails
    // «Бюджет контекста».
    "Bash(mkdir:*)", "Bash(rm:*)", "Bash(mv:*)", "Bash(cp:*)", "Bash(ls:*)", "Bash(wc:*)",
    "Bash(find:*)", "Bash(touch:*)", "Bash(echo:*)");

  // Стрипаем секреты из env: чтобы claude НЕ мог аутентиться к GitLab/Redmine/др. (его собственный
  // auth — подписка через keychain/OAuth, НЕ env, так что claude от этого не ломается).
  const childEnv: Record<string, string> = { ...process.env } as Record<string, string>;
  for (const k of ["GITLAB_TOKEN", "REDMINE_API_KEY", "REDMINE_PASSWORD", "DEEPINFRA_API_KEY", "TELEGRAM_BOT_TOKEN", "GATEWAY_AUTH_TOKEN", "ANTHROPIC_API_KEY"]) delete childEnv[k];
  // Прокси ТОЛЬКО для api.anthropic.com; <YOUR_HOST> НЕ в NO_PROXY → попытка в офисный gitlab уйдёт
  // через внешний прокси и не доедет (доп. барьер против вытягивания реп).
  if (PROXY) { childEnv.HTTPS_PROXY = PROXY; childEnv.HTTP_PROXY = PROXY; childEnv.NO_PROXY = "localhost,127.0.0.1"; }

  console.log(`[harness] Claude Code (${task.model || "default"}) в ${task.target}, budget≤$${task.maxBudgetUsd ?? "∞"}, proxy=${PROXY ? "on" : "off"}\n`);
  const child = spawn(CLAUDE_BIN, args, { cwd: task.target, env: childEnv });
  let result = "";
  let cost = 0;
  const progress: string[] = [];
  const say = (s: string) => { console.log(s); progress.push(s); };
  createInterface({ input: child.stdout }).on("line", (line) => {
    let ev: any;
    try { ev = JSON.parse(line); } catch { return; }
    if (ev.type === "assistant" && ev.message?.content) {
      for (const b of ev.message.content) {
        if (b.type === "text" && b.text?.trim()) say("  " + b.text.trim().split("\n").join("\n  "));
        else if (b.type === "tool_use") say(`  🔧 ${b.name} ${JSON.stringify(b.input ?? {}).slice(0, 140)}`);
      }
    } else if (ev.type === "result") {
      result = ev.result || result;
      cost = ev.total_cost_usd ?? cost;
    }
  });
  child.stderr.on("data", (d) => process.stderr.write(d));
  const code: number = await new Promise((res) => child.on("close", (c) => res(c ?? 0)));
  return { result, cost, code, progress };
} };

// OpencodeDriver — прогон через `opencode run` (Zen-модели, PAYG). Контракт задокументирован в
// docs/tasks/model-provider-zen-vs-deepinfra.md. Преимущества над Claude Code: --session/--continue
// (настоящий resume, не retry-preamble), структурный tool_output max_lines/max_bytes, модель-агностичный
// (-m provider/model — один драйвер на все модели), проще auth (API-ключ, без OAuth/keychain танца).
const opencodeDriver: AgentDriver = { name: "opencode", async run(task, env, attempt = 1): Promise<DriverResult> {
  const OPENCODE_BIN = env.OPENCODE_BIN || process.env.OPENCODE_BIN || (() => {
    try {
      require('child_process').execSync('which opencode-proxy', { encoding: 'utf8' });
      return 'opencode-proxy';
    } catch {
      return 'opencode';
    }
  })();
  const PROXY = env.PROXY_URL || env.TELEGRAM_PROXY || process.env.PROXY_URL || "";
  const guardrails = task.appendSystemPromptPath
    ? readFileSync(resolve(REPO_ROOT, task.appendSystemPromptPath), "utf8")
    : "";
  const verifyErr = env.VERIFY_ERROR || process.env.VERIFY_ERROR || "";
  const prompt = (guardrails ? guardrails + "\n\n" : "")
    + (verifyErr ? VERIFY_RETRY_PREAMBLE + verifyErr + "\n\n" : "")
    + (attempt > 1 ? RETRY_PREAMBLE : "")
    + readFileSync(resolve(REPO_ROOT, task.promptPath), "utf8");

  // opencode висит с промптами >4000 символов → обрезаем
  const MAX_PROMPT = 3500;
  let finalPrompt = prompt;
  if (prompt.length > MAX_PROMPT) {
    const headroom = MAX_PROMPT - guardrails.length - 100;
    const taskText = prompt.slice(guardrails.length + 2); // пропускаем "\n\n"
    finalPrompt = (guardrails ? guardrails + "\n\n" : "") + taskText.slice(0, headroom) + "\n\n[промпт обрезан до " + MAX_PROMPT + "с]";
    console.log(`[harness] prompt truncated: ${prompt.length} → ${finalPrompt.length} chars`);
  }

  const args: string[] = ["run", "--format", "json", "--dir", task.target, "--auto", "--agent", "harness"];
  if (attempt > 1) { args.push("--continue"); }   // resume предыдущую сессию (вместо RETRY_PREAMBLE)
  else { args.push("-s", `${task.id}-${new Date().toISOString().slice(0, 10)}`); }
  const model = resolveOpenCodeModel(task);
  if (model) args.push("-m", model);
  // Источники (read-only): в opencode нет --add-dir, приаттачиваем корневые AGENTS.md/doc-файлы через --file.
  // Тяжёлые каталоги (DB-интроспекция, PDF) — полагаемся на то, что компилятор включит их в prompt как пути.
  if (task.sources?.length) {
    for (const src of task.sources) {
      const abs = resolve(src);
      if (!existsSync(abs)) continue;
      if (statSync(abs).isFile()) args.push("--file", abs);
      // для каталогов — opencode сам прочитает AGENTS.md/CLAUDE.md проекта; исходные пути вшиты в prompt компилятором
    }
  }

  const childEnv: Record<string, string> = { ...process.env } as Record<string, string>;
  for (const k of ["GITLAB_TOKEN", "REDMINE_API_KEY", "REDMINE_PASSWORD", "DEEPINFRA_API_KEY",
    "TELEGRAM_BOT_TOKEN", "GATEWAY_AUTH_TOKEN"]) delete childEnv[k];
  if (PROXY) { childEnv.HTTPS_PROXY = PROXY; childEnv.HTTP_PROXY = PROXY; childEnv.NO_PROXY = "localhost,127.0.0.1"; }

  console.log(`[harness] opencode (${model || "default"}) в ${task.target}, budget=not enforced (opencode), proxy=${PROXY ? "on" : "off"}\n`);
  const promptFile = join(tmpdir(), `${task.id}-prompt-${Date.now()}.md`);
  writeFileSync(promptFile, finalPrompt);
  args.push("--file", promptFile);
  console.log(`[harness] prompt saved to ${promptFile} (${finalPrompt.length} chars)`);
  const child = spawn(OPENCODE_BIN, [...args, "Выполни задачу из приложенного файла."], { cwd: task.target, env: childEnv });
  let result = ""; let cost = 0;
  const progress: string[] = [];
  const say = (s: string) => { console.log(s); progress.push(s); };
  createInterface({ input: child.stdout }).on("line", (line) => {
    let ev: any;
    try { ev = JSON.parse(line); } catch { return; }
    if (ev.type === "text" && ev.part?.text) {
      say("  " + String(ev.part.text).trim().split("\n").join("\n  "));
    } else if (ev.type === "tool_use" && ev.part) {
      const p = ev.part;
      const inp = JSON.stringify(p.state?.input ?? p.input ?? {}).slice(0, 120);
      const out = typeof p.state?.output === "string" ? p.state.output.slice(0, 80) : "";
      say(`  🔧 ${p.tool} ${inp}${out ? " → " + out : ""}`);
    } else if (ev.type === "step_finish" && ev.part) {
      cost += ev.part.cost ?? 0;
      // result от text-событий перед step_finish (openсode не даёт одного финального сообщения как Claude).
      if (ev.part.reason === "stop") result = (ev.part.finalText ?? result) || result;
    }
  });
  child.stderr.on("data", (d) => process.stderr.write(d));
  const code: number = await new Promise((res) => child.on("close", (c) => res(c ?? 0)));
  return { result: result || "(см. progress)", cost, code, progress };
} };

// ── LocalModelDriver (ADR-0023 этап 5) ─────────────────────────────────────────
// Function-calling петля для офисной Qwen3.5-122B-A10B через Anthropic Messages API.
// vllm-коннектор — полиглот, но /v1/chat/completions отдаёт 404,
// работает ТОЛЬКО /v1/messages (Anthropic-протокол). Auth: x-api-key (не Bearer!).
//
// Модель САМА зовёт инструменты (read_file/write_file/bash/glob/grep) — мы исполняем их
// в НАШЕМ процессе. Anthropic tool-use формат:
//   tools: [{name, description, input_schema: {type:"object", properties, required}}]
//   content: [{type:"tool_use", id, name, input}, {type:"text", text}]
//   tool_result: {role:"user", content:[{type:"tool_result", tool_use_id, content}]}
//
// env: LOCAL_MODEL_BASE_URL (http://<vllm-host>:<port> — БЕЗ /v1!),
//      LOCAL_MODEL_API_KEY (x-api-key), LOCAL_MODEL_NAME (qwen).
//      Endpoint в офисной сети — без прокси.
const localModelDriver: AgentDriver = { name: "local", async run(task, env, attempt = 1): Promise<DriverResult> {
  const baseUrl = (env.LOCAL_MODEL_BASE_URL || process.env.LOCAL_MODEL_BASE_URL || "").replace(/\/+$/, "");
  const apiKey  = env.LOCAL_MODEL_API_KEY  || process.env.LOCAL_MODEL_API_KEY  || "neurodeck-local-2026";
  const model   = env.LOCAL_MODEL_NAME     || process.env.LOCAL_MODEL_NAME     || "qwen";
  const maxSteps = 30;

  const guardrails = task.appendSystemPromptPath
    ? readFileSync(resolve(REPO_ROOT, task.appendSystemPromptPath), "utf8")
    : "";
  const verifyErr = env.VERIFY_ERROR || process.env.VERIFY_ERROR || "";
  const prompt = (guardrails ? guardrails + "\n\n" : "")
    + (verifyErr ? VERIFY_RETRY_PREAMBLE + verifyErr + "\n\n" : "")
    + (attempt > 1 ? RETRY_PREAMBLE : "")
    + readFileSync(resolve(REPO_ROOT, task.promptPath), "utf8");

  const SYSTEM = [
    "Ты — AI-агент-разработчик. Твоя задача — читать, писать и редактировать файлы в целевом репозитории через инструменты.",
    "ПРАВИЛА:",
    "1. Коммить как можно РАНЬШЕ и мельче (единица работы = один git commit). НЕ накапливай изменения.",
    "2. Не выдумывай — если чего-то нет в файлах/контексте, не придумывай.",
    "3. Не перечитывай уже закоммиченное — смотри git log.",
    "4. Формат коммита: #NNNNN type(scope): описание (Conventional Commits).",
    "5. Не пушить, не клонить, не ходить в сеть. Только локальная работа.",
    "6. Отвечай на русском.",
  ].join("\n");

  const messages: any[] = [
    { role: "user", content: [{ type: "text", text: prompt }] },
  ];

  const tools: any[] = [
    { name: "read_file", description: "Прочитать файл из репозитория (с offset/limit для больших файлов).",
      input_schema: { type: "object", properties: { path: { type: "string", description: "Относительный путь к файлу" }, offset: { type: "integer", description: "С какой строки (1-based)" }, limit: { type: "integer", description: "Сколько строк читать" } }, required: ["path"] } },
    { name: "write_file", description: "Записать/перезаписать файл в репозитории.",
      input_schema: { type: "object", properties: { path: { type: "string", description: "Относительный путь" }, content: { type: "string", description: "Содержимое файла" } }, required: ["path", "content"] } },
    { name: "bash", description: "Shell-команда в репозитории. Разрешены: git (add/commit/status/log/diff/checkout/mv/rm/init/reset/restore/config), mkdir, rm, mv, cp, ls, wc, find, touch, echo.",
      input_schema: { type: "object", properties: { command: { type: "string", description: "Команда" } }, required: ["command"] } },
    { name: "glob", description: "Поиск файлов по glob-паттерну.",
      input_schema: { type: "object", properties: { pattern: { type: "string", description: "Glob-паттерн, напр. src/**/*.ts" } }, required: ["pattern"] } },
    { name: "grep", description: "Поиск содержимого в файлах по regex.",
      input_schema: { type: "object", properties: { pattern: { type: "string", description: "Regex-паттерн" }, include: { type: "string", description: "Фильтр файлов, напр. *.ts" } }, required: ["pattern"] } },
  ];

  // Разрешённые bash-префиксы (git + базовые файловые — как у ClaudeCodeDriver):
  const allowedBash = [/^git\s/, /^mkdir\s/, /^rm\s/, /^mv\s/, /^cp\s/, /^ls\b/, /^wc\s/, /^find\s/, /^touch\s/, /^echo\s/];
  const isBashAllowed = (cmd: string) => allowedBash.some((r) => r.test(cmd.trim()));

  let result = ""; let code = 0; let totalTokens = 0;
  const say = (s: string) => { console.log(s); };

  for (let step = 0; step < maxSteps; step++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 120_000);
    let resp: any;
    try {
      const r = await fetch(`${baseUrl}/v1/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model, max_tokens: 4096, system: SYSTEM, messages, tools, temperature: 0.3 }),
        signal: ctrl.signal,
      });
      resp = await r.json();
      if (!r.ok) {
        say(`  ⚠ Qwen HTTP ${r.status}: ${JSON.stringify(resp).slice(0, 300)}`);
        code = 1; break;
      }
    } catch (e: any) {
      say(`  ⚠ Qwen fetch error: ${e?.message ?? e}`);
      code = 1; break;
    } finally { clearTimeout(t); }

    totalTokens += (resp.usage?.input_tokens ?? 0) + (resp.usage?.output_tokens ?? 0);

    const content: any[] = resp.content ?? [];
    let textBlocks: string[] = [];
    const toolCalls: { id: string; name: string; input: any }[] = [];

    for (const block of content) {
      if (block.type === "text" && block.text) textBlocks.push(block.text);
      else if (block.type === "tool_use") toolCalls.push({ id: block.id, name: block.name, input: block.input ?? {} });
    }

    // Если модель ответила текстом — сохраняем в результат
    if (textBlocks.length) result = textBlocks.join("\n");

    if (toolCalls.length) {
      // Сохраняем assistant-сообщение с tool_use блоками
      messages.push({ role: "assistant", content });

      // Исполняем каждый tool_use и собираем tool_result'ы
      const toolResults: any[] = [];
      for (const tc of toolCalls) {
        const args = tc.input ?? {};
        let tr = "";

        try {
          if (tc.name === "read_file") {
            const p = resolve(task.target, String(args.path || ""));
            if (!existsSync(p)) tr = `ОШИБКА: файл не найден: ${args.path}`;
            else {
              const fc = readFileSync(p, "utf8");
              const lines = fc.split("\n");
              const start = Math.max(0, (args.offset ?? 1) - 1);
              const end = args.limit ? start + args.limit : lines.length;
              const chunk = lines.slice(start, end);
              tr = chunk.map((l, i) => `${start + i + 1}: ${l}`).join("\n");
              if (lines.length > end) tr += `\n(… показано строк ${start + 1}-${end} из ${lines.length})`;
              say(`  🔧 read_file ${args.path} [${start + 1}:${end}]`);
            }
          } else if (tc.name === "write_file") {
            const p = resolve(task.target, String(args.path || ""));
            mkdirSync(dirname(p), { recursive: true });
            writeFileSync(p, String(args.content || ""));
            tr = `OK: записано ${Buffer.byteLength(args.content || "").toLocaleString()} байт в ${args.path}`;
            say(`  🔧 write_file ${args.path}`);
          } else if (tc.name === "bash") {
            const cmd = String(args.command || "").trim();
            if (!cmd) { tr = "ОШИБКА: пустая команда"; }
            else if (!isBashAllowed(cmd)) { tr = `ОШИБКА: команда не разрешена: ${cmd}`; }
            else {
              const r = spawnSync("bash", ["-lc", cmd], { cwd: task.target, encoding: "utf8", timeout: 30_000, maxBuffer: 512 * 1024 });
              tr = (r.stdout || "") + (r.stderr ? "\n[stderr]\n" + r.stderr : "");
              if (r.status !== 0) tr += `\n(exit ${r.status})`;
              if (tr.length > 8000) tr = tr.slice(0, 8000) + "\n(обрезано...)";
              say(`  🔧 bash: ${cmd.slice(0, 80)}`);
            }
          } else if (tc.name === "glob") {
            const pat = String(args.pattern || "");
            const r = spawnSync("bash", ["-lc", `find . -type f -path "./${pat}" 2>/dev/null | head -100`],
              { cwd: task.target, encoding: "utf8", timeout: 15_000 });
            tr = (r.stdout || "").trim() || "(ничего не найдено)";
            say(`  🔧 glob: ${pat}`);
          } else if (tc.name === "grep") {
            const pat = String(args.pattern || "").replace(/'/g, "'\\''");
            const inc = args.include ? `--include='${String(args.include).replace(/'/g, "'\\''")}'` : "";
            const r = spawnSync("bash", ["-lc", `grep -rn ${inc} '${pat}' . 2>/dev/null | head -80`],
              { cwd: task.target, encoding: "utf8", timeout: 15_000, maxBuffer: 512 * 1024 });
            tr = (r.stdout || "").trim() || "(ничего не найдено)";
            if (tr.length > 6000) tr = tr.slice(0, 6000) + `\n(обрезано, найдено >80 строк...)`;
            say(`  🔧 grep: ${String(args.pattern).slice(0, 60)}`);
          } else {
            tr = `ОШИБКА: неизвестный инструмент: ${tc.name}`;
          }
        } catch (e: any) {
          tr = `ОШИБКА: ${e?.message ?? e}`;
        }

        toolResults.push({ type: "tool_result", tool_use_id: tc.id, content: tr.slice(0, 12000) });
      }

      messages.push({ role: "user", content: toolResults });
    } else {
      // Нет tool_use — модель закончила (stop_reason: end_turn)
      if (resp.stop_reason === "end_turn") break;
      // stop_reason === "max_tokens" или другое — даём продолжить
      messages.push({ role: "assistant", content });
      messages.push({ role: "user", content: [{ type: "text", text: "Продолжи с того места, где остановился." }] });
    }
  }

  // Офисная модель — фикс. цена (своё железо), стоимость = $0.
  const cost = 0;
  return { result: result || "(модель не дала финального ответа)", cost, code, progress: [] };
} };

// Маппинг TaskSpec.model (Claude-имена) → opencode-модели. Если model уже содержит "/" — используем как есть
// (напр. "opencode-go/deepseek-v4-pro"). Без model — opencode-go/deepseek-v4-pro (go-реализация).
function resolveOpenCodeModel(task: TaskSpec): string {
  const m = (task.model ?? "").trim();
  if (m.includes("/")) return m;                      // уже provider/model
  const byTier: Record<string, string> = {
    "opus":   "opencode-go/deepseek-v4-pro",
    "sonnet": "opencode-go/kimi-k2.7-code",
    "haiku":  "opencode-go/deepseek-v4-flash",
  };
  if (byTier[m]) return byTier[m];
  if (task.tier === "strong") return "opencode-go/deepseek-v4-pro";
  if (task.tier === "weak")   return "opencode-go/deepseek-v4-flash";
  return "opencode-go/deepseek-v4-pro";                   // default
}

// selectDriver — ADR-0023: резолвит драйвер по TaskSpec.driver. По умолчанию opencode (активная миграция).
// claude-code — для обратной совместимости (старые TaskSpec'ы без явного driver).
// local — офисная модель (Qwen3.5-122B-A10B) через LocalModelDriver (этап 5).
function selectDriver(task: TaskSpec): AgentDriver {
  const d = task.driver ?? "opencode";
  if (d === "opencode")    return opencodeDriver;
  if (d === "claude-code") return claudeCodeDriver;
  if (d === "local")       return localModelDriver;
  throw new Error(`driver "${d}" не реализован. Доступны: opencode, claude-code, local.`);
}

// ── Verify-loop (ADR-0023 этап 3) ────────────────────────────────────────────
// Детерминированная проверка ПОСЛЕ работы агента: прогоняет команды (тесты/typecheck/
// линтер) в ИЗОЛИРОВАННОЙ scoped-копии, пишет СТРУКТУРНЫЙ результат (pass/fail + вывод).
// Агент НЕ участвует в верификации — мы САМИ проверяем (модель фабрикует «всё зелёное»).
//
// Команды выполняются последовательно. Сеть — off (в scoped-копии нет сети). Кап по
// output'у и времени на команду. Возвращает сводку: pass/fail + результаты по командам.
type VerifyResult = { pass: boolean; results: { command: string; exit: number; output: string; passed: boolean }[] };
function runVerify(target: string, verify: NonNullable<TaskSpec["verify"]>): VerifyResult {
  const timeoutSec = verify.timeoutSec ?? 120;
  const results: VerifyResult["results"] = [];

  for (const cmd of verify.commands) {
    const startMs = Date.now();
    let exit = -1; let output = "";
    try {
      const r = spawnSync("bash", ["-lc", cmd], {
        cwd: target, encoding: "utf8",
        timeout: Math.max(10_000, timeoutSec * 1000),
        maxBuffer: 1 * 1024 * 1024,  // 1 MB output кап
      });
      exit = r.status ?? -1;
      output = ((r.stdout || "") + (r.stderr || "")).slice(0, 8000);
    } catch (e: any) {
      exit = -1;
      output = `ОШИБКА: ${e?.message ?? e}`;
    }
    const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);
    const passed = exit === 0;
    console.log(`[harness] verify: ${passed ? "✓" : "✖"} ${cmd} (exit ${exit}, ${elapsed}s)${!passed && output ? `\n  ${output.split("\n").slice(0, 5).join("\n  ")}` : ""}`);
    results.push({ command: cmd, exit, output, passed });
  }

  const pass = results.every((r) => r.passed);
  return { pass, results };
}

// Преамбула для verify-ретрая: агент получил зелёный exit, но ТЕСТЫ УПАЛИ.
const VERIFY_RETRY_PREAMBLE = [
  "ВНИМАНИЕ: твоя работа ЗАВЕРШИЛАСЬ (exit 0), но ПРОВЕРКА ТЕСТАМИ/ЛИНТЕРОМ УПАЛА:",
  "Ошибки ниже. НЕ переделывай работающее — исправь ТОЛЬКО то, на что указывают ошибки.",
  "Не трать контекст на перечитывание кода — смотри на конкретные ошибки и точечно правь.",
  "После правок — ОБЯЗАТЕЛЬНО закоммить изменения (git add + git commit).",
  "", "--- Ошибки верификации ---", "",
].join("\n");

// Один прогон задачи: ветка (от текущего HEAD) + попытки + отчёт. Возвращает сводку для очереди.
async function runOneTask(taskFile: string, env: Record<string, string>): Promise<Summary> {
  const task: TaskSpec = JSON.parse(readFileSync(resolve(process.cwd(), taskFile), "utf8"));
  console.log(`[harness] task=${task.id} target=${task.target}`);
  // scopeMode:"files" (варианты/монолиты, IP-изоляция) — агент работает в ИЗОЛИРОВАННОЙ копии только из paths,
  // а не во всём репо. task.target подменяем на копию; реальный репо запоминаем для приземления патча.
  let scopeInfo: { realTarget: string; scopedDir: string; realBaseSha: string; copied: string[]; missing: string[]; sourceRef?: string } | null = null;
  if (task.scopeMode === "files" && Array.isArray(task.paths) && task.paths.length) {
    const realTarget = task.target;
    const s = buildScopedTarget(realTarget, task.paths, task.id, task.sourceRef);
    scopeInfo = { realTarget, ...s };
    task.target = s.scopedDir;                       // весь прогон дальше идёт в изолированной копии
    console.log(`[harness] scopeMode=files → изолированная копия ${s.scopedDir}`);
    console.log(`[harness]   источник: ${task.sourceRef ? `ветка/ref ${task.sourceRef}` : "текущий HEAD реального репо"} @${s.realBaseSha.slice(0, 8)}`);
    console.log(`[harness]   отдано путей: ${s.copied.join(", ") || "(НИ ОДНОГО!)"}${s.missing.length ? `; не найдено: ${s.missing.join(", ")}` : ""}`);
    console.log(`[harness]   реальный репо ${realTarget}@${s.realBaseSha.slice(0, 8)} Claude НЕ отдан (IP-изоляция)`);
    if (s.copied.length === 0) console.error(`[harness] ⚠ ни один scope-путь не найден — Claude получит пустую копию (проверь paths/репо)`);
  }
  const { branch, baseSha } = prepareTarget(task.target, task.id, env);

  // Авто-ретрай: claude exit≠0 на этих прогонах = транзиентный обрыв (сеть/таймаут), не баг задачи.
  // Ветка одна, работа коммитится по ходу → новая попытка продолжает с уже закоммиченного состояния.
  // ── Verify-loop (ADR-0023 этап 3) — детерминированная проверка ПОСЛЕ успешного прогона ──
  // Если verify.commands заданы → после exit 0 гоняем их в scoped-копии. Фейл → даём агенту
  // ошибки + перезапуск (до verifyMaxRetries). При исчерпании + tier=weak → эскалация strong.
  const driver = selectDriver(task);                       // ADR-0023: claude-code (default) | local (этап 5)
  if (driver.name !== "claude-code") console.log(`[harness] драйвер: ${driver.name}`);
  const maxAttempts = Math.max(1, task.maxAttempts ?? 1);
  const verifyConfig = task.verify;
  const verifyMaxRetries = Math.max(0, verifyConfig?.maxRetries ?? 1);
  let result = "", code = 0, cost = 0;
  const progress: string[] = [];
  let verifyFailures = 0;
  const verifyResults: VerifyResult[] = [];
  let lastVerifyError = "";

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const headBefore = gitTry(task.target, ["rev-parse", "HEAD"]);
    if (attempt > 1) console.log(`\n[harness] ↻ попытка ${attempt}/${maxAttempts} (предыдущая оборвалась/верификация не пройдена) после паузы…`);

    // Для verify-ретрая — инжектим ошибки в env, драйвер их предварит к промпту
    const driverEnv = { ...env };
    if (lastVerifyError) driverEnv.VERIFY_ERROR = lastVerifyError;

    const r = await driver.run(task, driverEnv, attempt);
    cost += r.cost;
    if (r.result) result = r.result;
    progress.push(...r.progress);
    code = r.code;
    lastVerifyError = "";  // сброс — ошибка обработана

    if (r.code === 0) {
      // ── Прогон успешен → верификация (если задана) ──
      if (verifyConfig && verifyConfig.commands.length) {
        const vr = runVerify(task.target, verifyConfig);
        verifyResults.push(vr);
        if (vr.pass) {
          if (attempt > 1) console.log(`[harness] ✓ завершено с попытки ${attempt} (верификация зелёная)`);
          break;  // ✅ агент + верификация — OK
        }
        // Верификация упала
        verifyFailures++;
        const errors = vr.results.filter((x) => !x.passed)
          .map((x) => `### ${x.command}\n\`\`\`\n${x.output}\n\`\`\``).join("\n\n");
        lastVerifyError = errors;
        console.error(`[harness] ⚠ верификация НЕ пройдена (${verifyFailures}/${verifyMaxRetries})`);

        if (verifyFailures <= verifyMaxRetries) {
          // Ретрай: скормим ошибки агенту
          console.log(`[harness] ↻ перезапускаю агента с ошибками верификации...`);
          // сбросим attempt counter чтобы дать полный цикл verify retries
          if (verifyFailures > 1 && attempt >= maxAttempts) {
            // даём сверху ещё одну attempt для verify retry
            // (выходим из текущей итерации — продолжится та же attempt с ошибками)
          }
          continue;
        } else if (task.tier === "weak") {
          // Эскалация weak→strong
          console.log(`[harness] 🔺 верификация провалена ${verifyFailures} раз — эскалация weak→strong`);
          task.tier = "strong";
          verifyFailures = 0;
          lastVerifyError = errors;  // сохраняем для strong-попытки
          continue;
        } else {
          // Окончательный провал
          console.error(`[harness] ✖ верификация провалена окончательно (${verifyFailures} попыток, tier=${task.tier})`);
          code = -2;
          break;
        }
      } else {
        if (attempt > 1) console.log(`[harness] ✓ завершено с попытки ${attempt}`);
        break;  // ✅ агент OK, верификации нет
      }
    }

    // ── Прогон упал (сеть/таймаут) — стандартный ретрай ──
    console.error(`[harness] ⚠ claude exit ${r.code} (попытка ${attempt}/${maxAttempts}, $${r.cost.toFixed(2)} за попытку, $${cost.toFixed(2)} суммарно)`);
    const noNewCommit = gitTry(task.target, ["rev-parse", "HEAD"]) === headBefore && headBefore !== baseSha;
    if (noNewCommit && r.cost > 1.0) {
      console.error(`[harness] ⏹ ретрай остановлен: попытка отработала ($${r.cost.toFixed(2)}), но не дала новых коммитов — зацикливание на верификации, не транзиентный обрыв`);
      break;
    }
    if (noNewCommit) console.log(`[harness] ↺ попытка оборвалась дёшево ($${r.cost.toFixed(2)}, без новых коммитов) — похоже на транзиентный обрыв связи, ретраим дальше`);
    if (attempt < maxAttempts) await sleep(Math.min(120000, 20000 * attempt));
  }

  const from = baseSha === "(empty)" ? "" : baseSha;
  const log = gitTry(task.target, from ? ["log", "--oneline", `${from}..HEAD`] : ["log", "--oneline"]);
  const stat = gitTry(task.target, from ? ["diff", "--stat", from] : ["show", "--stat", "--oneline"]);

  // Отчёт в .md (stdout сцепленный прогон затрёт — поэтому каждый прогон пишет свой файл).
  const report = [
    `# Harness отчёт: ${task.id}`, ``,
    `- ветка: \`${branch}\`  ·  target: \`${task.target}\``,
    `- модель: ${task.model || "default"}  ·  стоимость (сумма по попыткам): $${cost.toFixed(4)}  ·  попыток: ${task.maxAttempts ?? 1}  ·  claude exit (последний): ${code}`,
    `- время: ${new Date().toISOString()}`, ``,
    ...(scopeInfo ? [
      `## Scope (изолированная копия, scopeMode=files)`,
      `- реальный репо: \`${scopeInfo.realTarget}\` @ \`${scopeInfo.realBaseSha.slice(0, 8)}\`${scopeInfo.sourceRef ? ` (ветка/ref \`${scopeInfo.sourceRef}\`)` : ` (текущий HEAD — sourceRef не задан!)`}  ·  Claude монолит НЕ видел`,
      `- отдано путей: ${scopeInfo.copied.join(", ") || "(нет)"}${scopeInfo.missing.length ? `  ·  ⚠ не найдено: ${scopeInfo.missing.join(", ")}` : ""}`,
      `- ПРИЗЕМЛЕНИЕ патча в реальный репо (\`diff <base>\` без \`..HEAD\` — ловит и НЕзакоммиченное рабочее дерево копии):`,
      "```bash",
      `git -C "${scopeInfo.scopedDir}" diff ${baseSha.slice(0, 8)} > /tmp/${task.id}.patch`,
      `git -C "${scopeInfo.realTarget}" apply --reject --whitespace=nowarn /tmp/${task.id}.patch   # проверь *.rej`,
      "```", ``,
    ] : []),
    `## Коммиты`, "```", log || "(claude ничего не закоммитил)", "```", ``,
    `## Diffstat`, "```", stat || "(нет изменений)", "```", ``,
    `## Итог`, result || "(пусто)", ``,
    ...(verifyResults.length ? [
      `## Верификация (verify-loop)`,
      ...verifyResults.flatMap((vr) => [
        `- **${vr.pass ? "✅ ПРОЙДЕНА" : "❌ ПРОВАЛЕНА"}**`,
        ...vr.results.map((r) => `  - ${r.passed ? "✅" : "❌"} \`${r.command}\` (exit ${r.exit})`),
        ...vr.results.filter((r) => !r.passed).flatMap((r) => [
          `  <details><summary>Ошибки: ${r.command}</summary>`, "",
          "```", r.output, "```", "", "</details>",
        ]),
        "",
      ]),
    ] : []),
    `## Прогресс (tool-calls)`, "```", progress.join("\n").slice(0, 30000), "```", ``,
  ].join("\n");
  const reportDir = join(REPO_ROOT, "harness", "reports");
  mkdirSync(reportDir, { recursive: true });
  const reportPath = join(reportDir, branch.replace(/\//g, "-") + ".md");
  writeFileSync(reportPath, report);

  console.log("\n═══════════════ ОТЧЁТ ═══════════════");
  console.log(`ветка:   ${branch}   target: ${task.target}`);
  console.log(`коммиты:\n${log || "  (claude ничего не закоммитил)"}`);
  console.log(`diffstat:\n${stat || "  (нет изменений)"}`);
  console.log(`стоимость: $${cost.toFixed(4)}`);

  // scopeMode=files: автоматически приземлить патч в реальный репо (клон)
  let landedCommits = 0;
  if (scopeInfo && code === 0 && log && log.trim()) {
    const patchFile = join(tmpdir(), `${task.id}.patch`);
    try {
      const diffR = spawnSync("git", ["-C", scopeInfo.scopedDir, "diff", baseSha.slice(0, 8)], { encoding: "utf8" });
      if (diffR.status === 0 && diffR.stdout.trim()) {
        writeFileSync(patchFile, diffR.stdout);
        const applyR = spawnSync("git", ["-C", scopeInfo.realTarget, "apply", "--reject", "--whitespace=nowarn", patchFile], { encoding: "utf8" });
        if (applyR.status === 0) {
          // Commit the applied patch in the real clone
          const addR = spawnSync("git", ["-C", scopeInfo.realTarget, "add", "-A"], { encoding: "utf8" });
          const authorName = process.env.HARNESS_GIT_NAME || "neurodeck Agent";
          const authorEmail = process.env.HARNESS_GIT_EMAIL || "agent@local";
          const commitR = spawnSync("git", ["-C", scopeInfo.realTarget, "commit",
            "--author", `${authorName} <${authorEmail}>`,
            "-m", `${branch} feat: auto-landed from scoped copy`], { encoding: "utf8" });
          if (commitR.status === 0) {
            landedCommits = 1;
            console.log(`[harness] 🩹 патч приземлён в ${scopeInfo.realTarget}`);
          } else {
            console.log(`[harness] ⚠ commit failed: ${commitR.stderr}`);
          }
        } else {
          console.log(`[harness] ⚠ apply failed — проверь *.rej в ${scopeInfo.realTarget}`);
        }
        try { unlinkSync(patchFile); } catch {}
      }
    } catch (e: any) {
      console.log(`[harness] ⚠ patch landing error: ${e.message}`);
    }
  }

  if (verifyResults.length) {
    for (const vr of verifyResults) {
      console.log(`\n── верификация: ${vr.pass ? "✅ ПРОЙДЕНА" : "❌ ПРОВАЛЕНА"} ──`);
      for (const r of vr.results) console.log(`  ${r.passed ? "✅" : "❌"} ${r.command} (exit ${r.exit})`);
    }
  }
  console.log(`\n── итог ──\n${result || "(пусто)"}`);
  console.log(`\n[harness] 📄 отчёт сохранён: ${reportPath}`);

  const commits = log ? log.split("\n").filter((l) => l.trim()).length : 0;

  // Событийный push: задача завершилась (per-task — в MCP-флоу один run.ts = одна джоба).
  const verifyStatus = verifyResults.length
    ? (verifyResults.every((vr) => vr.pass) ? " · ✅ verify" : " · ❌ verify FAILED")
    : "";
  await notifyTelegram([
    `${code === 0 ? "✅" : code === -2 ? "❌" : "⚠️"} harness: ${task.id}${verifyStatus}`,
    `ветка: ${branch}`,
    `коммитов: ${commits} · $${cost.toFixed(2)} · exit ${code}`,
    scopeInfo
      ? `🩹 scoped-патч (landing-команда в отчёте): ${basename(reportPath)}`
      : `📄 отчёт: ${basename(reportPath)}`,
  ].join("\n"), env);

  return { id: task.id, branch, commits, cost, code, reportPath };
}

async function main(): Promise<void> {
  // Continuation-режим (очередь): один ИЛИ несколько TaskSpec'ов подряд. Каждая следующая стартует от
  // HEAD предыдущей (prepareTarget ветвится от текущего HEAD одного и того же target) → задачи СТЕКАЮТСЯ,
  // как при ручном последовательном запуске. Харнес сам переходит к следующей по факту завершения текущей.
  // Можно передать список файлов или glob: `npm run harness -- harness/tasks/h2-*.json` (шелл развернёт по порядку).
  const taskFiles = process.argv.slice(2);
  if (taskFiles.length === 0) {
    console.error("usage: npm run harness -- <taskfile.json> [<taskfile2.json> …]   (или glob: harness/tasks/h2-*.json)");
    process.exit(1);
  }
  const env = loadEnvFile();
  console.log(`[harness] очередь из ${taskFiles.length} задач(и): ${taskFiles.map((f) => basename(f)).join(" → ")}\n`);

  const summaries: Summary[] = [];
  let emptyFailStreak = 0;  // подряд «пустые» сбои (0 коммитов + ~$0 + exit≠0) ≈ средовой отказ (прокси/лимит подписки/auth)
  for (let i = 0; i < taskFiles.length; i++) {
    console.log(`\n════════════ [${i + 1}/${taskFiles.length}] ${basename(taskFiles[i])} ════════════`);
    let s: Summary;
    try {
      s = await runOneTask(taskFiles[i], env);
    } catch (e: any) {
      console.error(`[harness] ✖ ${basename(taskFiles[i])} упала на подготовке/исполнении: ${e?.message ?? e}`);
      s = { id: basename(taskFiles[i]), branch: "(не создана)", commits: 0, cost: 0, code: -1, reportPath: "" };
    }
    summaries.push(s);

    // Защита автономного батча: задача ничего не сделала, не потратила и упала — это не «работа», а
    // средовой сбой (прокси упал / лимит подписки / нет auth). Два таких подряд → останавливаем очередь,
    // чтобы не «прокликать» весь батч вхолостую и не наплодить пустых веток до утра.
    emptyFailStreak = (s.code !== 0 && s.commits === 0 && s.cost < 0.01) ? emptyFailStreak + 1 : 0;
    if (emptyFailStreak >= 2 && i < taskFiles.length - 1) {
      console.error(`\n[harness] ⛔ две задачи подряд упали вхолостую (0 коммитов, ~$0) — похоже на средовой сбой (прокси/лимит подписки/auth). Очередь ОСТАНОВЛЕНА на ${i + 1}/${taskFiles.length}. Не запущены: ${taskFiles.slice(i + 1).map((f) => basename(f)).join(", ")}`);
      break;
    }
  }

  console.log(`\n═══════════════ СВОДКА ОЧЕРЕДИ ═══════════════`);
  let total = 0;
  for (const s of summaries) {
    total += s.cost;
    console.log(`  ${s.code === 0 ? "✅" : "⚠️ "} ${s.id.padEnd(26)} коммитов:${String(s.commits).padStart(3)}  $${s.cost.toFixed(2)}  ${s.branch}`);
  }
  console.log(`  ───── Σ $${total.toFixed(2)} по ${summaries.length} задач(е)`);
  console.log(`[harness] локально, без push. Приземление коммитов — руками (cherry-pick/merge/push после ревью).`);

  // Для МАНУАЛЬНОГО батча (glob >1 задачи) — финальная сводка очереди одним сообщением. В MCP-флоу
  // (1 задача = 1 run.ts) не дублируем per-task пинг: шлём только когда задач реально несколько.
  if (summaries.length > 1) {
    const okN = summaries.filter((s) => s.code === 0).length;
    await notifyTelegram([
      `🏁 harness-очередь: ${summaries.length} задач(и), ✅ ${okN}/${summaries.length} · Σ $${total.toFixed(2)}`,
      ...summaries.map((s) => `${s.code === 0 ? "✅" : "⚠️"} ${s.id} · коммитов ${s.commits} · $${s.cost.toFixed(2)}`),
    ].join("\n"), env);
  }
}

main().catch((e) => { console.error("[harness] FAIL:", e?.message ?? e); process.exit(1); });
