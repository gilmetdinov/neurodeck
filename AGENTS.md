# AGENTS.md — neurodeck-agent

> **Рабочий контекст и план финализации — в [`docs/ROADMAP.md`](./docs/ROADMAP.md)**
> (локальный, в git не входит). Этот файл — технический контекст проекта.

AI-агент для управления операционной деятельностью разработки neurodeck.
**Две среды:** (1) продуктовая — **OpenClaw + LLM** (оркестратор Kimi-K2.5, аналитик/ревьюер
DeepSeek-V4-Pro), интеграция с Redmine/GitLab/Obsidian; (2) разработческая — **opencode + Zen**
(DeepSeek V4 Pro, Kimi K2.5/K2.7, MiniMax M2.5/M3, Qwen3.6, GLM 5.2) — этот файл читают агент-рантаймы (Claude Code / opencode / Codex)
как проектный контекст.

> **СТАТУС (2026-07-20):** мультиагент = Worker Pool (ADR-0028, v0.1.0) + release-manager v0.1.0
> + git-egress v0.1.0 + redmine-аналитик v0.5.0 + Figma MCP v0.1.0 + code-review + redmine-write +
> gitlab-write. Хранилище прозрачности: `workspace/state/`. Гардрейлы сжаты.
> **Память включена** (llm/bge-m3). **RAG-хук** готов (rag_query).
> ⚠ Оркестратор идёт через worker-bridge (вместо executor-engine). Worker Pool — файловая event-шина.

> **Проектирование и решения — в [`docs/`](./docs/).** Читать с `docs/architecture.md`.
> Принятые решения — ADR'ы в `docs/adr/` (легенда статусов — `docs/adr/_filename-legend.md`).

---

## Архитектура

```
Telegram Bot → OpenClaw Gateway → LLM API (Kimi-K2.5 / orchestration)
    ├── MCP: worker-bridge (оркестратор↔worker pool, pool_approve за гейтом)
    ├── MCP: redmine (read+аналитика v0.5.0 + compile_task)
    ├── MCP: gitlab (read — gitlab-mr-mcp)
    ├── MCP: reviewer (review_mr: диф + контекст + LLM)
    ├── MCP: redmine-write (add_note/update_status/create_issue, за гейтом)
    ├── MCP: gitlab-write (merge_mr/set_reviewers/post_mr_comment, за гейтом)
    ├── MCP: git-egress (push #NNNNN → MR → Redmine статус 13)
    ├── MCP: release-manager (rc-скан, ревью-назначение, версии, git-статистика)
    └── MCP: figma (макеты → TaskSpec v0.1.0)

    Worker Pool (отдельные процессы, файловая event-шина):
      task-poller (поллинг статуса 20) → task-queue/
      agent-worker (claim → analyze → approve → execute)
      notifier (события → Telegram групповой чат)
      supervisor (heartbeat мониторинг)
```

Все МУТИРУЮЩИЕ действия требуют явного подтверждения через Telegram (нативный OpenClaw-апрув +
наш preview/кнопки, ADR-0007).

---

## Структура проекта

```
neurodeck-agent/
├── AGENTS.md                    ← этот файл
├── .env.example                 ← шаблон переменных окружения
│
├── config/
│   ├── openclaw.json5           ← шаблон конфига (→ ~/.openclaw/openclaw.json)
│   ├── agents.json5             ← реестр флота (ADR-0024)
│   ├── projects.json5           ← реестр проектов/вариантов (ADR-0006)
│   ├── team.json                ← реестр команды: разработчики, роли, статусы
│   ├── redmine-write.json5      ← whitelist статусов Redmine
│   └── gitlab-write.json5       ← конфиг gitlab-write (pollProjects, mergeTargets)
│
├── scripts/
│   ├── deploy-config.sh         ← рендер шаблона в ~/.openclaw/ (npm run deploy:config)
│   ├── run-gateway.sh           ← запуск gateway с автоочисткой зомби-MCP
│   └── openclaw-cleanup.sh      ← ротация ~/.openclaw
│
├── mcp-servers/                 ← кастомные MCP (TypeScript, src/ → dist/)
│   ├── redmine/                 ← read + аналитика + compile_task
│   ├── redmine-write/           ← add_note/update_status/create_issue (за гейтом)
│   ├── reviewer/                ← review_mr (LLM, изолированно)
│   ├── gitlab-write/            ← merge_mr/set_reviewers/post_mr_comment (за гейтом)
│   ├── git-egress/              ← push #NNNNN → MR → Redmine статус 13
│   ├── release-manager/         ← rc-скан, ревью-назначение, версии, git-стат
│   ├── harness/                 ← async-MCP мост для не-Redmine задач
│   ├── figma/                   ← макеты → frontend TaskSpec
│   ├── worker-bridge/           ← тонкий MCP-мост оркестратор↔worker pool
│   ├── task-poller/             ← автономный поллинг статуса 20 + compile
│   ├── agent-worker/            ← claim → analyze → approve → execute
│   ├── notifier/                ← события → Telegram групповой чат
│   ├── xwiki/                   ← read корпоративной wiki
│   └── obsidian/                ← read/write Obsidian vault
│
├── prompts/
│   ├── system.md                ← системный промпт оркестратора (routing, правила)
│   ├── _base.md                 ← общая база: проект/статусы/команда (shared)
│   ├── task-compiler.md         ← промпт компилятора issue→TaskSpec
│   └── code-review.md           ← промпт ревью (10 категорий безопасности)
│
├── harness/                     ← harness loop (ADR-0008)
│   ├── src/run.ts               ← движок: TaskSpec → opencode/Claude Code → git
│   ├── tasks/                   ← гардрейлы
│   │   └── guardrails-product.md  ← СИСТЕМНЫЙ ПРОМПТ для продуктовых задач
│   ├── docs/                    ← d.harness-mcp-design.md + archive/
│   ├── reports/ / sources/ / queue/  ← runtime (gitignored)
│
├── workspace/state/             ← зеркала ~/.openclaw/* для отладки
└── docs/
    ├── architecture.md / corrections.md
    ├── adr/                     ← 27 ADR (0001–0027)
    └── tasks/total-finalize/    ← 11 спеков по переработке архитектуры
```

---

## Переменные окружения (.env)

```env
# LLM — основной провайдер
LLM_API_KEY=
LLM_BASE_URL=https://api.openai.com/v1
LLM_MODEL=moonshotai/Kimi-K2.5

# Telegram Bot
TELEGRAM_BOT_TOKEN=
TELEGRAM_ALLOWED_USER_IDS=  # формат: telegram:<id>,...

# Redmine Cloud
REDMINE_BASE_URL=https://your-redmine.example.com
REDMINE_API_KEY=
REDMINE_LOGIN=               # для write-операций
REDMINE_PASSWORD=

# GitLab Cloud
GITLAB_BASE_URL=https://gitlab.com
GITLAB_TOKEN=                # read_api scope
GITLAB_WRITE_TOKEN=          # api scope (для gitlab-write / git-egress)

# Прокси
PROXY_URL=http://127.0.0.1:7897

# Executor-engine
EXECUTOR_POLL_INTERVAL_MS=1800000
EXECUTOR_REWORK_POLL_INTERVAL_MS=900000
COMPILER_TIMEOUT_MS=120000
EXECUTOR_ANNOUNCE_COOLDOWN_MS=300000
HARNESS_RUN_ENABLED=1

# opencode binary
OPENCODE_BIN=/opt/homebrew/bin/opencode-proxy

# Опционально (этапы 6-7)
OBSIDIAN_VAULT_PATH=/path/to/your/obsidian/vault
FIGMA_TOKEN=
XWIKI_BASE_URL=
```

---

## Роадмап (сжато)

| Этап | Статус |
|------|--------|
| 0 — Скелет (Telegram↔OpenClaw↔LLM) | ✅ |
| 1 — Redmine MCP read+аналитика | ✅ |
| 2 — GitLab MCP read | ✅ |
| 3 — Code Review (dry-run) | ✅ |
| 4 — Redmine write (add_note/update_status/create_issue) | ✅ построено, нужна активация |
| 5 — GitLab write (push/MR/comment) | ✅ построено, нужен GITLAB_WRITE_TOKEN |
| 6 — Obsidian Vault интеграция | 🔜 спроектировано (спек 10) |
| 7 — Голосовые сообщения (Whisper) | 🔜 |
| 8 — Планировщик (cron) | 🟡 разовые джобы работают, регулярные не тестированы |

**Текущий фокус:** стабилизация Worker Pool (ADR-0028) + полишинг нотификаций + сквозной прогон #60030.

---

## Правила безопасности

- **DRY_RUN**: при `true` агент только показывает что сделал бы, не пишет в prod
- **APPROVAL GATE**: write-операции требуют подтверждения через Telegram-кнопки
- **NO PUSH в харнесе**: коммиты только локально; push/MR делает git-egress агент
- **Статусы Redmine (whitelist)**: агент меняет только разрешённые переходы (`config/redmine-write.json5`)
- **Токен-лимиты**: оркестратор max 4096 токенов; ревью max 8192 на дифф

---

## Модели — продуктовая среда (OpenClaw + LLM)

| Задача | Модель | Обоснование |
|---|---|---|
| Оркестрация | **Kimi-K2.5** | tool-calling + instruction adherence |
| Аналитик `team_digest` | **DeepSeek-V4-Pro** | сильный reasoning, изолирован |
| Code Review `review_mr` | **DeepSeek-V4-Pro** | `REVIEW_MODEL`, свопаемый |
| Компилятор `compile_task` | **DeepSeek-V4-Pro** | single-shot JSON |
| Голос → текст | Whisper Large V3 (LLM API) | этап 7 |

**Экономика LLM ($ за 1M токенов):**

| Модель | Input | Output | Роль |
|---|---|---|---|
| **Kimi-K2.5** | $0.45 | $2.25 | Оркестратор, write-агенты |
| **DeepSeek-V4-Pro** | $1.30 | $2.60 | Аналитик, Review, Compiler |
| **Qwen3-Coder-480B** | $0.30 | $1.00 | Analyst, Review (дешёвая альтернатива) |

---

## Модели — разработческая среда (opencode + Zen)

| Модель (Zen) | Класс | Для каких задач |
|---|---|---|
| **deepseek-v4-pro** | Тяжёлый | Архитектура, системный дизайн, harness H2 |
| **deepseek-v4-flash-free** | Лёгкий | Быстрые вопросы, чтение кода (бесплатный) |
| **kimi-k2.7-code** | Тяжёлый | Генерация кода (PHP/Go/TS) |
| **kimi-k2.5** | Средний | Многокомпонентные задачи |
| **minimax-m3** | Средний | Рабочая лошадка для стандартных задач |
| **qwen3.6-plus** | Средний | Альтернатива для стандартных задач |
| **glm-5.2** | Тяжёлый | Длинные контексты, большие репо |

**Правило выбора:** простые вопросы → flash-free; стандартные → k2.5/m3; код/рефакторинг → k2.7-code/v4-pro;
архитектура → v4-pro/glm-5.2. Модель задаётся в TaskSpec (поле `model`) или флагом `-m`.
Сменить можно в любой момент (`opencode set-model <model>`).

- **opencode binary:** `OPENCODE_BIN` в `.env`. Если нужен прокси — `opencode-proxy`.
  Проверить: `which opencode-proxy`. Если нет — `brew install opencode` (Go-версия).

---

## Известные ограничения

- **Redmine:** multi-status в одном запросе → 500. `analyze_team_load` без `updated_within_days` медленный.
- **Telegram-стрим:** режим должен быть `progress` (не `partial` — вызывает 429).
- **LLM idle-timeout:** `timeoutSeconds≥300`, короткие ответы, мало tool-call'ов за ход.
- **DeepSeek недетерминирован:** резать триггеры структурно, не надеяться на промпт.
- **Native-субагенты НЕ получают MCP** — специалисты реализованы как agent-as-MCP.
- Крупные диффы (>500 строк) — фильтровать по расширению (PHP/Go/TS/JS).
- AGENTS.md (склейка _base+_fleet+system) не должен превышать 12K символов.
