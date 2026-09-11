#!/usr/bin/env python3
"""
Диагностика офисного Qwen-endpoint (vllm + полиглот-коннектор).

Проверяет:
  1. TCP-коннект к 192.168.30.217:3456
  2. OpenAI-совместимый API: /v1/models, /v1/chat/completions
  3. Anthropic-совместимый API: /v1/messages (если полиглот)

Запуск: python scripts/qwen-probe.py
Зависимости: requests (pip install requests)
"""

import os, sys, json, socket, time

BASE_URL = os.environ.get("ANTHROPIC_BASE_URL", "http://192.168.30.217:3456")
AUTH     = os.environ.get("ANTHROPIC_AUTH_TOKEN", "neurodeck-local-2026")
MODEL    = os.environ.get("ANTHROPIC_MODEL", "qwen")

HEADERS = {
    "Content-Type": "application/json",
    "Authorization": f"Bearer {AUTH}",
}
# Некоторые vllm-коннекторы юзают x-api-key вместо Bearer
HEADERS_ALT = {
    "Content-Type": "application/json",
    "x-api-key": AUTH,
}

def r(method: str, path: str, body: dict | None = None, headers: dict | None = None):
    """HTTP-запрос с таймаутом."""
    import requests
    url = f"{BASE_URL.rstrip('/')}{path}"
    h = headers or HEADERS
    try:
        if method == "GET":
            resp = requests.get(url, headers=h, timeout=10)
        else:
            resp = requests.post(url, headers=h, json=body, timeout=30)
        return resp.status_code, resp.text[:2000]
    except requests.exceptions.ConnectionError as e:
        return None, f"CONNECTION ERROR: {e}"
    except requests.exceptions.Timeout:
        return None, "TIMEOUT (10-30s)"
    except Exception as e:
        return None, f"ERROR: {e}"

def ok(s): print(f"\033[32m  ✓ {s}\033[0m")
def fail(s): print(f"\033[31m  ✖ {s}\033[0m")
def info(s): print(f"\033[36m  → {s}\033[0m")

print(f"""
═══════════════════════════════════════════
 Qwen Diagnostic Probe
═══════════════════════════════════════════
 target:  {BASE_URL}
 model:   {MODEL}
 auth:    neurodeck-local-2026 (Bearer + x-api-key)
 
 Протоколы (vllm полиглот):
   OpenAI:    {BASE_URL}/v1/chat/completions
   Models:    {BASE_URL}/v1/models
   Anthropic: {BASE_URL}/v1/messages
═══════════════════════════════════════════
""")

# ── 1. TCP ────────────────────────────────────────────────────────────
print("1. TCP-коннект ...")
try:
    host = BASE_URL.split("://")[1].split(":")[0] if "://" in BASE_URL else BASE_URL.split(":")[0]
    port = int(BASE_URL.split(":")[-1]) if ":" in BASE_URL.split("://")[1] else 80
except:
    host, port = "192.168.30.217", 3456

try:
    s = socket.create_connection((host, port), timeout=5)
    s.close()
    ok(f"TCP {host}:{port} — открыт")
except Exception as e:
    fail(f"TCP {host}:{port} — {e}")
    print("\n  ⚠️  Нет прямого доступа к офисной сети. Нужно:")
    print("  • Clash Verge → Settings → Bypass → добавить 192.168.30.0/24")
    print("  • Или Settings → TUN Mode (виртуальный сетевой интерфейс)")
    print("  • Или Settings → Proxy → добавить DIRECT-правило для 192.168.30.217")
    print()
    # Продолжаем — может быть прокси в env
    info("Попробую через HTTP_PROXY если задан...")

# ── 2. OpenAI /v1/models ─────────────────────────────────────────────
print("\n2. OpenAI /v1/models (Bearer auth) ...")
code, text = r("GET", "/v1/models")
if code and code < 400:
    ok(f"HTTP {code} — models endpoint работает")
    try:
        data = json.loads(text)
        models = data.get("data", data) if isinstance(data, dict) else data
        if isinstance(models, list):
            info(f"Найдено моделей: {len(models)}")
            for m in models[:10]:
                mn = m.get("id", str(m))
                print(f"    • {mn}")
    except: pass
else:
    fail(f"HTTP {code} /v1/models — {text[:150]}")
    info("Пробую x-api-key вместо Bearer...")
    code2, text2 = r("GET", "/v1/models", headers=HEADERS_ALT)
    if code2 and code2 < 400:
        ok(f"HTTP {code2} — с x-api-key работает!")
    else:
        fail(f"HTTP {code2} — {text2[:150] if text2 else 'N/A'}")

# ── 3. OpenAI /v1/chat/completions ───────────────────────────────────
print("\n3. OpenAI /v1/chat/completions (echo-тест) ...")
code, text = r("POST", "/v1/chat/completions", {
    "model": MODEL,
    "messages": [{"role": "user", "content": "Ответь одним словом: столица России?"}],
    "max_tokens": 16,
    "temperature": 0.0,
})
if code and code < 400:
    ok(f"HTTP {code} — chat/completions работает")
    try:
        j = json.loads(text)
        reply = j.get("choices", [{}])[0].get("message", {}).get("content", "")
        info(f'Ответ модели: "{reply}"')
        usage = j.get("usage", {})
        if usage:
            info(f'Токены: {usage.get("prompt_tokens")} in / {usage.get("completion_tokens")} out')
    except: pass
elif code == 404:
    fail(f"HTTP {code} — эндпоинт не найден (возможно Anthropic-only?)")
else:
    fail(f"HTTP {code} — {text[:200]}")
    info("Пробую x-api-key...")
    code2, text2 = r("POST", "/v1/chat/completions", {
        "model": MODEL,
        "messages": [{"role": "user", "content": "Столица России?"}],
        "max_tokens": 16,
    }, headers=HEADERS_ALT)
    if code2 and code2 < 400:
        ok(f"HTTP {code2} — с x-api-key работает!")
        try: print(f'  Ответ: "{json.loads(text2).get("choices",[{}])[0].get("message",{}).get("content","")}"')
        except: pass
    else:
        fail(f"HTTP {code2} — {text2[:150] if text2 else 'N/A'}")

# ── 4. Anthropic /v1/messages ────────────────────────────────────────
print("\n4. Anthropic /v1/messages (echo-тест) ...")
code, text = r("POST", "/v1/messages", {
    "model": MODEL,
    "max_tokens": 16,
    "messages": [{"role": "user", "content": "Ответь одним словом: столица России?"}],
}, headers={
    **HEADERS,
    "anthropic-version": "2023-06-01",
    # Некоторые коннекторы хотят x-api-key вместо Bearer
})
if code and code < 400:
    ok(f"HTTP {code} — Anthropic /v1/messages работает")
    try:
        j = json.loads(text)
        reply = ""
        for b in j.get("content", []):
            if b.get("type") == "text": reply = b.get("text", "")
        info(f'Ответ: "{reply}"')
    except: pass
else:
    fail(f"HTTP {code} — {text[:200]}")
    info("Пробую x-api-key...")
    code2, text2 = r("POST", "/v1/messages", {
        "model": MODEL,
        "max_tokens": 16,
        "messages": [{"role": "user", "content": "Столица России?"}],
    }, headers={
        **HEADERS_ALT,
        "anthropic-version": "2023-06-01",
    })
    if code2 and code2 < 400:
        ok(f"HTTP {code2} — с x-api-key работает!")
    else:
        fail(f"HTTP {code2} — {text2[:150] if text2 else 'N/A'}")

# ── 5. Claude Code (ANTHROPIC_* env) — пояснение ──────────────────────
print(f"""
═══════════════════════════════════════════
 РЕЗЮМЕ ДЛЯ ИНТЕГРАЦИИ
═══════════════════════════════════════════
 
 1. OpenClaw (провайдер):
    • Если OpenAI /v1/chat/completions работает → добавляем как
      openai-completions провайдер в openclaw.json5.
    • baseUrl: {BASE_URL}/v1
    • apiKey: {AUTH}
    • model: {MODEL}

 2. Harness LocalModelDriver:
    • Прямые fetch-запросы к /v1/chat/completions
    • function-calling петля по образцу team_digest

 3. Claude Code (ANTHROPIC_* env):
    • export ANTHROPIC_BASE_URL="{BASE_URL}"
    • export ANTHROPIC_AUTH_TOKEN="{AUTH}"
    • export ANTHROPIC_MODEL="{MODEL}"
    • export CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
    • claude -p "..." будет ходить в офисный Qwen
    (проверить: работает ли это напрямую, без нашего harness?)

 4. Clash Verge (если TCP-коннект не прошёл):
    • Settings → Bypass → добавить 192.168.30.0/24
    • ИЛИ TUN Mode (виртуальный интерфейс)
    • ИЛИ Settings → Proxy → + DIRECT-правило:
      Process Name: любое / DOMAIN-SUFFIX / IP-CIDR 192.168.30.0/24
""")
