#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────
// gen-fleet-prompt.mjs — генерит prompts/_fleet.md (роутинг-роестр флота) из
// config/agents.json5. ADR-0024 §2 (NB тимлида: «роутинг максимально гибкий и
// настраиваемый, так что ГЕНЕРИТЬ из реестра»). Вызывается deploy-config.sh в
// склейке AGENTS.md: _base.md + _fleet.md(авто) + system.md.
//
// Источник правды флота = config/agents.json5. Правишь реестр → роестр в промпте
// оркестратора пересобирается при deploy. Руками _fleet.md не править.
// ─────────────────────────────────────────────────────────────────────────
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const JSON5 = require("json5");

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const reg = JSON5.parse(readFileSync(join(ROOT, "config", "agents.json5"), "utf8"));

const esc = (s) => String(s ?? "").replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ").trim();
const specs = Object.entries(reg.specialists ?? {});
const isAvail = ([, a]) => a.status === "live" || a.status === "gated";
const avail = specs.filter(isAvail);
const planned = specs.filter((e) => !isAvail(e));
const orch = reg.orchestrator ?? {};

const L = [];
L.push("# Флот специалистов (АВТО-генерируется из config/agents.json5 — НЕ править здесь)");
L.push("");
L.push("> Твоя «команда». Источник правды — `config/agents.json5` (правь ТАМ → пересборка при deploy).");
L.push("> Зови ТОЛЬКО специалистов из «Доступны». «Запланированы» — честно «пока не умею» + укажи ADR.");
L.push("> Детальные плейбуки вызова — НИЖЕ в ролевом промпте; здесь — КТО есть, КОГДА звать, нужен ли апрув.");
L.push("");
L.push(`**Дирижёр:** \`${orch.id ?? "orchestrator"}\` (${orch.modelEnv ?? "DEEPINFRA_MODEL"}) — это ТЫ. ${esc(orch.role)}`);
L.push("");
L.push("## Доступны (зови их)");
L.push("");
L.push("| Специалист | Когда звать | Реализация | Апрув | Статус |");
L.push("|---|---|---|---|---|");
for (const [id, a] of avail) {
  const real = [a.realization, a.mcp].filter(Boolean).join(" · ");
  const ap = a.approval === "native-gate" ? "нативный гейт" : "—";
  L.push(`| \`${id}\` | ${esc(a.when)} | ${esc(real)} | ${ap} | ${esc(a.status)} |`);
}
L.push("");
L.push("## Запланированы (пока НЕ умеешь — скажи об этом + укажи ADR из реестра)");
L.push("");
L.push("| Специалист | Что будет | Статус |");
L.push("|---|---|---|");
for (const [id, a] of planned) L.push(`| \`${id}\` | ${esc(a.role)} | ${esc(a.status)} |`);
L.push("");

const out = join(ROOT, "prompts", "_fleet.md");
writeFileSync(out, L.join("\n") + "\n");
console.log(`✓ _fleet.md из agents.json5 (${avail.length} доступных, ${planned.length} запланированных) → ${out}`);
