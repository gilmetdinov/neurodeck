# neurodeck

AI-агент для автоматизации операционки разработки: аналитика, code review,
релиз-менеджмент. Оркестратор на **OpenClaw** + LLM-модели через OpenAI-совместимый API.

> Полное ТЗ и роадмап — в [`AGENTS.md`](./AGENTS.md).

## Что делает

- **Redmine-аналитика** — дайджесты нагрузки по разработчикам, сводки открытых и просроченных задач
- **Code Review AI** — автоматическое ревью MR (PHP/Yii2, Go, TypeScript/React) на соответствие стандартам и безопасность
- **Release Manager** — автоназначение ревьюеров, формирование RC, сводка к релизу
- **Worker Pool** — агенты, которые берут задачи из Redmine, компилируют спецификацию, пишут код и оформляют MR (с approval-гейтом через Telegram)

## Быстрый старт

```bash
# 1. Установка (Node >= 22.19 обязательно)
bash scripts/setup.sh

# Скрипт проверит окружение, создаст .env, соберёт MCP-серверы,
# задеплоит конфиг OpenClaw и покажет что заполнить.

# 2. Отредактируй .env — обязательные переменные:
#    LLM_API_KEY          ключ LLM-провайдера (напр. https://platform.openai.com/api-keys)
#    TELEGRAM_BOT_TOKEN         токен бота (@BotFather)
#    TELEGRAM_ALLOWED_USER_IDS  telegram:<твой_id> (узнать у @userinfobot)

# 3. Повторный запуск setup после заполнения .env
bash scripts/setup.sh

# 4. Запуск
npm run gateway

# 5. В Telegram напиши боту /start
```

### Настройка после клонирования

После первого запуска `setup.sh` скрипт предупредит о незаполненных конфигах. Вот что нужно сделать:

```bash
# 1. config/team.json — данные команды
#    Замени <YOUR_REDMINE_PROJECT_SLUG>, <DEV_NAME_1> и остальные
#    плейсхолдеры на реальные имена, ID и email'ы разработчиков.
#    Пример заполненной структуры — в config/team.example.json.

# 2. config/projects.json5 — пути к проектам
#    Замени <YOUR_WORKSPACE> во всех repoPath на абсолютный путь
#    к твоему workspace (напр. /home/user/Workspace/your-project).

# 3. config/gitlab-repos.txt — список репозиториев для клонирования
#    Укажи список GitLab-репозиториев (git@<host>:<group>/<repo>.git).

# 4. .env — рабочие пути
#    Заполни:
#      AGENT_WORKBENCH_DIR  — корень workspace с проектами
#      CLONES_BASE_DIR      — директория для изолированных клонов worker pool
#      NOTIFIER_CHAT_ID     — ID Telegram-чата для уведомлений (@getidsbot)

# После заполнения перезапусти:
bash scripts/setup.sh
```

> ⚠ Все чувствительные данные (API-ключи, пароли) хранятся **только** в `.env`
> (в `.gitignore`). Конфиг-файлы содержат только бизнес-логику и плейсхолдеры.

## Статус разработки (WIP)

Ядро рабочее (аналитика, code review, релиз-менеджмент, worker pool). Часть модулей — в разной степени готовности:

| Модуль | Статус | Что не хватает |
|---|---|---|
| approval-flow (`skills/approval-flow.ts`) | заглушка | `requestApproval()` (Telegram-кнопки + таймаут 30м) не реализован; сейчас апрув закрывает нативный плагин `approval-gate` |
| Redmine write (`redmine-write`) | частично | write-тулзы за approval-gate собраны, но whitelist'ы (`config/redmine-write.json5`) не заполнены (`todo pre-prod`) |
| GitLab write (`gitlab-write`) | gated | требует `GITLAB_WRITE_TOKEN` + деплой + тест |
| RagFlow (этап 5) | интерфейс | `rag_query` в redmine MCP есть, сам сервис не подключён |
| Local model / vLLM (этап 5) | выключен | driver `"local"` в `harness/src/run.ts` есть, провайдер в конфиге закомментирован |
| Verify-loop (этап 3) | дефолт пустой | команды верификации (`verifyDefault.commands`) надо задать под конкретный проект |
| Whisper (этап 7) | план | голос→текст не начат |
| Нейминг моделей | легаси | в конфигах тир-лейблы `sonnet/opus/haiku`, реально маппятся на `deepseek-v4-pro` / `kimi-k2.7-code` / `deepseek-v4-flash` (см. `harness/src/run.ts`) |

## Структура

```
config/openclaw.json5     — шаблон конфига OpenClaw
config/team.json          — реестр команды (разработчики, роли, статусы, pipeline)
scripts/setup.sh          — первичная установка
scripts/deploy-config.sh  — рендер шаблона → ~/.openclaw/
scripts/run-gateway.sh    — запуск gateway
mcp-servers/              — 12 MCP-серверов (TypeScript)
  redmine/                —   Redmine read + аналитика
  redmine-write/          —   Redmine write (за approval-гейтом)
  reviewer/               —   Code review AI
  release-manager/        —   Релиз-менеджмент
  gitlab-write/           —   GitLab write (MR, ревьюеры)
  git-egress/             —   Git-операции (clone, push)
  xwiki/                  —   XWiki read/write
  obsidian/               —   Obsidian vault read/write
  task-poller/            —   Поллинг задач Redmine
  agent-worker/           —   Исполнитель задач
  notifier/               —   Уведомления в Telegram
  worker-bridge/          —   Мост между worker pool и MCP
plugins/                  — Плагины OpenClaw (approval-gate)
prompts/                  — Системные промпты
docs/                     — Архитектура, ADR, гайды
```

## Требования

- **Node.js >= 22.19** (OpenClaw не работает на 20.x)
- **OpenAI-совместимый API ключ** (OpenAI, OpenRouter, Together и др.)
- **OpenClaw** (устанавливается автоматически скриптом setup)
