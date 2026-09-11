# approval-gate — нативный approval-гейт OpenClaw

OpenClaw-плагин, который вешает **несбиваемый нативный апрув** на чувствительные тулзы
(`harness.run_task`/`run_batch`; позже — write-тулзы Redmine/GitLab). Закрывает self-approval-хол
из **ADR-0007 §открытый вопрос B**: раньше «сначала preview, потом run» было лишь промпт-
договорённостью (LLM сама себя апрувила) + грубым env-предохранителем `HARNESS_RUN_ENABLED`.

## Как работает (механизм OpenClaw)

Хук `before_tool_call` (plugin-sdk) срабатывает **после выбора тула моделью и ДО исполнения**.
Плагин возвращает `requireApproval` → OpenClaw:
1. ставит прогон на паузу;
2. шлёт тимлиду апрув-запрос в Telegram (**нативные кнопки** + команда `/approve <id> allow-once|deny`);
3. на `deny` / `timeout` / отсутствие маршрута — **БЛОКИРУЕТ** вызов (`timeoutBehavior:"deny"`);
4. зовёт наш `onResolution(decision)` (аудит-след в лог gateway).

Гейт нативный, между выбором и исполнением → **LLM физически не может само-апрувнуть**. Это и
есть гибрид ADR-0007 (несбиваемый гейт + богатый предпросмотр: title/description/severity) в ОДНОМ
механизме — без реверса сырого `callback_query` и без доверия к модели.

Источник истины по API — `docs/plugins/hooks.md` (§Tool call policy) + `docs/plugins/plugin-permission-requests.md`
в установленном пакете openclaw.

## Сборка

```bash
cd plugins/approval-gate
npm install        # только typescript (dev) — сам openclaw не тянем, импорт резолвится у хоста
npm run build      # tsc → dist/index.js  (на него указывает package.json → openclaw.extensions)
```

## Установка — БЕЗ `openclaw` CLI, через конфиг (наш deploy-флоу)

`~/.openclaw/openclaw.json` рендерится из шаблона `config/openclaw.json5` (его `deploy-config.sh`
ПЕРЕЗАТИРАЕТ), поэтому `openclaw plugins install --link` тут не годится — пережил бы deploy частично
и шёл бы мимо версионирования. Вместо этого плагин **объявлен прямо в `config/openclaw.json5`**
(`plugins.load.paths` грузит локальную папку; workspace-плагины OFF по умолчанию → `entries.enabled:true`):

```json5
plugins: {
  enabled: true,
  load: { paths: ["${AGENT_REPO_ROOT}/plugins/approval-gate"] },
  entries: { "approval-gate": { enabled: true } },
},
approvals: {
  // mode "session" = апрув в чат-источник (твой Telegram); "targets" = форвард в явные чаты.
  plugin: { enabled: true, mode: "session", agentFilter: ["orchestrator"] },
},
```

Применение — обычный флоу проекта (env пробрасывает `run-gateway.sh`, бара `openclaw` не нужна):

```bash
npm run deploy:config     # config/openclaw.json5 → ~/.openclaw/openclaw.json
# рестарт gateway твоим скриптом (run-gateway.sh) — он грузит .env + прокси
```

Проверка, что плагин поднялся: в логе старта gateway — регистрация `approval-gate`; либо при
первом гейте строка `[approval-gate] … → allow-once|deny`.

## Проверка живьём

1. Из Telegram попроси оркестратора запустить прогон (он зовёт `run_task`).
2. Должен прийти апрув-запрос с кнопками. Нажми **deny** → прогон НЕ стартует (вызов заблокирован).
3. Повтори → **allow-once** → прогон стартует. В логе gateway — строка `[approval-gate] … → allow-once`.
4. После того как гейт подтверждён живьём — **`HARNESS_RUN_ENABLED=1` безопасен** (run_task теперь
   нативно гейтится; env-предохранитель можно оставить дублёром или снять).

## ⚠ Один параметр уточнить при первом запуске

Точное `event.toolName` для тулзы harness-MCP внутри bundle-mcp (`run_task` vs `harness__run_task`
vs `mcp__harness__run_task`). Матчер плагина (`matchesSensitive`) ловит и голое имя, и суффиксы
`__name`/`.name`/`_name`, поэтому скорее всего поймает в любом виде — но подтверди по
`onResolution`-логу или `openclaw plugins inspect`, и при необходимости добавь точное имя в
`config.sensitiveTools`.

## Связано
- ADR-0007 (роли + гибрид-апрув), ADR-0016 (write-половина), `skills/approval-flow.ts` (старый набросок
  preview — теперь предпросмотр строит этот плагин нативно).
- `mcp-servers/harness/` (тулзы `run_task`/`run_batch`, которые гейтим).
