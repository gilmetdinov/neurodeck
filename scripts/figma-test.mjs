#!/usr/bin/env node
/**
 * figma-test.mjs — смоук-тест нашей Figma MCP (mcp-servers/figma/).
 *
 * Что проверяет:
 *   1) API: GET /v1/me (токен валиден)
 *   2) API: GET /v1/files/<key> (читаем реальный макет)
 *   3) MCP: поднимаем нашу figma-mcp по stdio → tools/list → figma_file_info
 *   4) MCP: вызываем figma_design_to_spec и смотрим сгенерированное ТЗ
 *
 * Запуск:
 *   node scripts/figma-test.mjs "<figma-url-или-fileKey>"
 *   node scripts/figma-test.mjs "https://www.figma.com/design/abc123/MyDesign"
 *   node scripts/figma-test.mjs "abc123"
 *
 * Токен: из .env (FIGMA_TOKEN). Прокси: PROXY_URL/HTTPS_PROXY.
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setGlobalDispatcher, ProxyAgent } from 'undici';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Загружаем .env
function loadEnv() {
  const out = {};
  const f = join(ROOT, '.env');
  try {
    for (const line of readFileSync(f, 'utf8').split('\n')) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '').trim();
    }
  } catch { /* */ }
  return out;
}
const env = loadEnv();
const TOKEN = process.env.FIGMA_TOKEN || env.FIGMA_TOKEN || '';
const PROXY = process.env.FIGMA_PROXY || process.env.PROXY_URL || env.PROXY_URL || env.HTTPS_PROXY || '';

const target = process.argv[2];
function die(msg) { console.error(`\n✖ ${msg}`); process.exit(1); }
if (!TOKEN) die('нет FIGMA_TOKEN в .env/env');
if (!target) die('не передан Figma URL / fileKey. Запуск: node scripts/figma-test.mjs "<url>"');

// Парсим URL → fileKey
function parseKey(t) {
  const m = t.match(/figma\.com\/(?:design|file|proto)\/([A-Za-z0-9_-]+)/);
  if (m) return m[1];
  if (/^[A-Za-z0-9_-]{10,}$/.test(t)) return t;
  return '';
}
const fileKey = parseKey(target);

if (PROXY) setGlobalDispatcher(new ProxyAgent(PROXY));

const FIGMA_HEADERS = { 'X-Figma-Token': TOKEN, Accept: 'application/json' };
async function figmaGet(path) {
  const r = await fetch(`https://api.figma.com/v1${path}`, { headers: FIGMA_HEADERS });
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch { json = null; }
  return { status: r.status, json, text };
}

console.log('═══ Figma MCP Diagnostic ═══');
console.log(`токен  : ${TOKEN ? 'figd_...' + TOKEN.slice(-6) : 'НЕТ'}`);
console.log(`прокси : ${PROXY || '(нет)'}`);
console.log(`fileKey: ${fileKey}`);
console.log();

// ── Шаг 1: AUTH ───────────────────────────────────────────────────────────
console.log('── [1/4] AUTH: проверка токена ──');
{
  const { status, json } = await figmaGet('/me');
  if (status === 200) {
    console.log(`  ✓ токен валиден (${json?.email ?? json?.handle ?? '?'})`);
  } else {
    console.log(`  ✖ HTTP ${status} — проверь токен`);
  }
}

// ── Шаг 2: READ ───────────────────────────────────────────────────────────
console.log(`\n── [2/4] READ: чтение файла ${fileKey} ──`);
{
  const { status, json } = await figmaGet(`/files/${fileKey}?depth=2`);
  if (status === 200) {
    const doc = json?.document;
    const pages = (doc?.children ?? []).filter((c) => c.type === 'CANVAS');
    const frames = countFrames(doc);
    console.log(`  ✓ файл: "${json?.name}"`);
    console.log(`    страниц: ${pages.length}, фреймов: ${frames}, lastModified: ${json?.lastModified ?? '?'}`);
  } else {
    console.log(`  ✖ HTTP ${status} — ${(json?.err || '')}`.slice(0, 100));
  }
}

// ── Шаг 3: MCP ────────────────────────────────────────────────────────────
console.log(`\n── [3/4] MCP: tools/list ──`);
const mcpPath = join(ROOT, 'mcp-servers', 'figma', 'dist', 'index.js');
let mcpOk = false;
try {
  const child = spawn('node', [mcpPath], {
    env: { ...process.env, FIGMA_TOKEN: TOKEN, FIGMA_PROXY: PROXY },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (d) => {
    const s = String(d).trim();
    if (s) console.log(`  [mcp] ${s}`);
  });

  // MCP initialize handshake
  const initMsg = JSON.stringify({ jsonrpc: '2.0', method: 'initialize', params: { protocolVersion: '1.0', capabilities: {}, clientInfo: { name: 'figma-test', version: '1.0' } }, id: 1 });
  child.stdin.write(initMsg + '\n');

  let buffer = '';
  const waitForResponse = (id, timeout = 10000) => new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), timeout);
    const onData = (d) => {
      buffer += String(d);
      const lines = buffer.split('\n');
      buffer = lines.pop(); // последний может быть неполным
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id === id) { clearTimeout(t); child.stdout.off('data', onData); resolve(msg); }
          else if (msg.method === 'notifications/initialized') { /* ok */ }
        } catch { /* */ }
      }
    };
    child.stdout.on('data', onData);
  });

  const initResp = await waitForResponse(1).catch(() => null);
  if (initResp) {
    // Послать initialized notification
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

    // tools/list
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', id: 2 }) + '\n');
    const toolsResp = await waitForResponse(2).catch(() => null);
    if (toolsResp?.result?.tools) {
      console.log(`  ✓ MCP поднялся, тулзов: ${toolsResp.result.tools.length}`);
      for (const t of toolsResp.result.tools) console.log(`    • ${t.name}: ${t.description?.slice(0, 80)}`);
      mcpOk = true;
    } else {
      console.log(`  ✖ tools/list: ${JSON.stringify(toolsResp).slice(0, 150)}`);
    }
  } else {
    console.log('  ✖ initialize не ответил');
  }

  // ── Шаг 4: DESIGN TO SPEC ────────────────────────────────────
  if (mcpOk && fileKey) {
    console.log(`\n── [4/4] figma_design_to_spec ──`);
    child.stdin.write(JSON.stringify({
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { name: 'figma_design_to_spec', arguments: { key: fileKey } },
      id: 3,
    }) + '\n');
    const specResp = await waitForResponse(3, 60000).catch((e) => { console.log(`  ✖ timeout: ${e?.message}`); return null; });
    if (specResp?.result?.content?.[0]?.text) {
      const data = JSON.parse(specResp.result.content[0].text);
      console.log(`  ✓ файл: ${data.file_name}, страниц: ${data.pages}`);
      console.log(`    queue_path: ${data.queue_path || '(не сохранён)'}`);
      console.log(`\n── Сгенерированное ТЗ (первые 1500 символов) ──`);
      console.log((data.task_spec || '').slice(0, 1500));
      if ((data.task_spec || '').length > 1500) console.log(`\n  ... (всего ${(data.task_spec || '').length.toLocaleString()} символов)`);
    } else {
      console.log(`  ✖ ${JSON.stringify(specResp).slice(0, 300)}`);
    }
  }

  child.kill();
} catch (e) {
  console.log(`  ✖ MCP spawn: ${e?.message}`);
}

function countFrames(node, depth = 0) {
  if (!node || depth > 2) return 0;
  let n = (['FRAME', 'COMPONENT', 'SECTION'].includes(node.type) && depth <= 1) ? 1 : 0;
  for (const c of (node.children ?? [])) n += countFrames(c, depth + 1);
  return n;
}
