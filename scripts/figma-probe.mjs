#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────
// figma-probe.mjs — смоук-тест работоспособности Figma через MCP.
//
// Зачем: до интеграции в OpenClaw (config/openclaw.json5) проверить ВСЮ цепочку
// «дизайн из Figma → структурированные данные для кодогенерации» вне gateway,
// как review-probe.py / compile-probe.mjs делают для ревью/компиляции.
//
// Что проверяет (по нарастанию):
//   1) AUTH  — GET /v1/me  (PAT валиден + egress до api.figma.com через прокси)
//   2) READ  — GET /v1/files/<key>  (реально читаем макет: имя, фреймы)
//   3) MCP   — поднимает Framelink (figma-developer-mcp) по stdio, делает
//              MCP-хендшейк, tools/list, вызывает get_figma_data по фрейму
//              и печатает trimmed-сводку ответа. Это и есть «работает ли MCP».
//
// Egress: Figma — ВНЕШНИЙ хост. Прокси берём из FIGMA_PROXY||HTTPS_PROXY||
//   HTTP_PROXY (на этой машине = http://127.0.0.1:7897). Для raw-fetch ставим
//   undici ProxyAgent; дочернему MCP пробрасываем HTTPS_PROXY в env (Framelink
//   на axios — он уважает HTTP(S)_PROXY env). Шаг 3 это и подтвердит.
//
// Запуск:
//   FIGMA_API_KEY=figd_xxx node scripts/figma-probe.mjs "<figma-url-или-fileKey>"
//   # node-id берётся из URL (?node-id=1-23) либо из --node 1:23
//
// PAT: Figma → Settings → Security → Personal access tokens, scope: File content (read).
// ─────────────────────────────────────────────────────────────────────────

import { spawn } from 'node:child_process';
import { setGlobalDispatcher, ProxyAgent } from 'undici';

const TOKEN = process.env.FIGMA_API_KEY || process.env.FIGMA_TOKEN || '';
const PROXY = process.env.FIGMA_PROXY || process.env.HTTPS_PROXY || process.env.HTTP_PROXY || '';

const args = process.argv.slice(2);
let target = '';
let nodeFlag = '';
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--node') nodeFlag = args[++i];
  else if (!target) target = args[i];
}

function die(msg) { console.error(`\n✖ ${msg}`); process.exit(1); }
if (!TOKEN) die('нет FIGMA_API_KEY в env. Запуск: FIGMA_API_KEY=figd_… node scripts/figma-probe.mjs "<url>"');
if (!target) die('не передан Figma URL / fileKey. Пример: node scripts/figma-probe.mjs "https://www.figma.com/design/<key>/Name?node-id=1-23"');

// Прокси для raw-fetch (undici не читает HTTPS_PROXY сам).
if (PROXY) setGlobalDispatcher(new ProxyAgent(PROXY));

// ── Разбор Figma-URL → fileKey + nodeId ──────────────────────────────────
// Форматы: /design/<key>/Name?node-id=1-23  |  /file/<key>/...  |  голый <key>
function parseTarget(t) {
  let fileKey = t, nodeId = '';
  const m = t.match(/figma\.com\/(?:design|file|proto)\/([A-Za-z0-9]+)/);
  if (m) fileKey = m[1];
  const n = t.match(/[?&]node-id=([^&]+)/);
  if (n) nodeId = decodeURIComponent(n[1]);
  if (nodeFlag) nodeId = nodeFlag;
  // В URL node-id с дефисом (1-23), в REST API — двоеточие (1:23).
  if (nodeId) nodeId = nodeId.replace(/-/g, ':');
  return { fileKey, nodeId };
}
const { fileKey, nodeId } = parseTarget(target);

const FIGMA_HEADERS = { 'X-Figma-Token': TOKEN };
async function figmaGet(path) {
  const r = await fetch(`https://api.figma.com${path}`, { headers: FIGMA_HEADERS });
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch { json = null; }
  return { status: r.status, json, text };
}

console.log('═══ Figma MCP probe ═══');
console.log(`proxy   : ${PROXY || '(нет — напрямую)'}`);
console.log(`fileKey : ${fileKey}`);
console.log(`nodeId  : ${nodeId || '(весь файл, depth=1)'}`);

// ── Шаг 1: AUTH ───────────────────────────────────────────────────────────
console.log('\n── [1/3] AUTH  GET /v1/me');
{
  const { status, json, text } = await figmaGet('/v1/me');
  if (status !== 200) die(`/v1/me → ${status}. ${text.slice(0, 300)}`);
  console.log(`  ✓ 200 — токен валиден: ${json.email || json.handle || json.id}`);
}

// ── Шаг 2: READ ─────────────────────────────────────────────────────────────
console.log('\n── [2/3] READ  GET /v1/files');
{
  const path = nodeId
    ? `/v1/files/${fileKey}/nodes?ids=${encodeURIComponent(nodeId)}`
    : `/v1/files/${fileKey}?depth=1`;
  const { status, json, text } = await figmaGet(path);
  if (status !== 200) die(`${path} → ${status}. ${text.slice(0, 300)}`);
  if (nodeId) {
    const node = json.nodes?.[nodeId]?.document;
    if (!node) die(`нода ${nodeId} не найдена в ответе (проверь node-id)`);
    console.log(`  ✓ 200 — файл "${json.name}", нода: "${node.name}" [${node.type}]`);
  } else {
    const frames = (json.document?.children?.[0]?.children || []).slice(0, 8)
      .map(c => `${c.name}[${c.type}]`);
    console.log(`  ✓ 200 — файл "${json.name}", изменён ${json.lastModified}`);
    console.log(`    верхние ноды: ${frames.join(', ') || '(пусто)'}`);
  }
}

// ── Шаг 3: MCP end-to-end (Framelink figma-developer-mcp по stdio) ──────────
console.log('\n── [3/3] MCP  figma-developer-mcp (stdio)');
const mcpResult = await runMcpSmoke();
if (mcpResult.ok) {
  console.log('\n✅ Цепочка Figma→MCP работает: AUTH + READ + MCP-вызов get_figma_data прошли.');
  process.exit(0);
} else {
  console.log(`\n⚠ Шаги 1–2 (REST) прошли, но MCP-шаг не доехал: ${mcpResult.reason}`);
  console.log('  (REST-цепочка/токен/egress — ок. Разбираем именно MCP-слой.)');
  process.exit(2);
}

// ── helpers: минимальный MCP-клиент по stdio (newline-delimited JSON-RPC) ────
function runMcpSmoke() {
  return new Promise((resolve) => {
    const child = spawn('npx', ['-y', 'figma-developer-mcp', `--figma-api-key=${TOKEN}`, '--stdio'], {
      env: { ...process.env, HTTPS_PROXY: PROXY, HTTP_PROXY: PROXY, FIGMA_API_KEY: TOKEN },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let buf = '';
    const pending = new Map();
    let tools = null;
    const timer = setTimeout(() => finish(false, 'таймаут 90с (npx-загрузка/хендшейк/вызов)'), 90_000);

    function send(obj) { child.stdin.write(JSON.stringify(obj) + '\n'); }
    function finish(ok, reason) {
      clearTimeout(timer);
      try { child.kill('SIGTERM'); } catch {}
      resolve({ ok, reason });
    }

    child.stdout.on('data', (d) => {
      buf += d.toString();
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg; try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
      }
    });
    child.stderr.on('data', (d) => {
      const s = d.toString();
      // Framelink логирует в stderr — показываем только заметное (ошибки/прокси/порт).
      if (/error|proxy|warn|figma|listen/i.test(s)) process.stdout.write(`    [mcp] ${s.trim().slice(0, 200)}\n`);
    });
    child.on('error', (e) => finish(false, `spawn: ${e.message}`));
    child.on('exit', (code) => { if (code && code !== 0) finish(false, `процесс вышел с кодом ${code}`); });

    const call = (method, params, id) => new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error(`нет ответа на ${method}`)), 60_000);
      pending.set(id, (m) => { clearTimeout(t); res(m); });
      send({ jsonrpc: '2.0', id, method, params });
    });

    (async () => {
      try {
        // 1) initialize
        const init = await call('initialize', {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'figma-probe', version: '0.0.1' },
        }, 1);
        const si = init.result?.serverInfo;
        console.log(`  ✓ initialize — server: ${si?.name || '?'} v${si?.version || '?'}`);
        send({ jsonrpc: '2.0', method: 'notifications/initialized' });

        // 2) tools/list
        const list = await call('tools/list', {}, 2);
        tools = list.result?.tools || [];
        console.log(`  ✓ tools/list — ${tools.length} тулз: ${tools.map(t => t.name).join(', ')}`);

        // 3) tools/call get_figma_data (или похожий)
        const tool = tools.find(t => /get[_-]?figma[_-]?data|get_figma|figma_data/i.test(t.name)) || tools[0];
        if (!tool) return finish(false, 'MCP не отдал ни одного тула');
        const callArgs = { fileKey };
        if (nodeId) callArgs.nodeId = nodeId;
        // частый параметр Framelink — глубина обхода; держим маленькой для смоука
        callArgs.depth = 2;
        console.log(`  → tools/call ${tool.name}(${JSON.stringify(callArgs)})`);
        const out = await call('tools/call', { name: tool.name, arguments: callArgs }, 3);
        if (out.error) return finish(false, `${tool.name} → ошибка: ${JSON.stringify(out.error).slice(0, 300)}`);
        const content = out.result?.content || [];
        const textPart = content.find(c => c.type === 'text');
        const payload = textPart?.text || JSON.stringify(out.result);
        console.log(`  ✓ ответ get_figma_data: ${payload.length} символов структуры дизайна`);
        console.log('    ── превью (первые 600 символов) ──');
        console.log(payload.slice(0, 600).split('\n').map(l => '    ' + l).join('\n'));
        finish(true, 'ok');
      } catch (e) {
        finish(false, e.message);
      }
    })();
  });
}
