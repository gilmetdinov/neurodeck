#!/usr/bin/env python3
"""
gitlab-discover.py — контролируемая разведка GitLab (<YOUR_GITLAB_HOST>) для этапа 2.

ЗАЧЕМ: ассистент запущен через прокси и до <YOUR_GITLAB_HOST> (за фаерволлом) не достучится.
Поэтому скрипт гоняешь ТЫ со своей машины, вывод отдаёшь ассистенту. Только GET-запросы,
ничего не пишет (да и токен read-only).

Читает из .env: GITLAB_BASE_URL, GITLAB_TOKEN. Стандартная библиотека, без зависимостей
(тот же стиль, что scripts/redmine-discover.py).

Закрывает:
  - валиден ли токен и какие у него scopes (read_api / read_repository?)  → WHOAMI / SCOPES
  - числовые projectId вариантов (для config/projects.json5)                → PROJECTS
  - есть ли открытые MR, как выглядят                                    → OPEN MRS
  - размер дифа реального MR (бюджет токенов на ревью)                    → DIFF PROBE

Запуск:
    python3 scripts/gitlab-discover.py
    python3 scripts/gitlab-discover.py --mr <group>/<main-project>!123   # конкретный MR
"""

import os
import sys
import json
import urllib.request
import urllib.parse
from pathlib import Path
from urllib.error import HTTPError, URLError

# ── .env loader ────────────────────────────────────────────────────────────────

def load_env(path: Path) -> None:
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, _, v = line.partition("=")
        os.environ.setdefault(k.strip(), v.strip())

ROOT = Path(__file__).resolve().parent.parent
load_env(ROOT / ".env")

BASE = os.environ.get("GITLAB_BASE_URL", "").rstrip("/")
TOKEN = os.environ.get("GITLAB_TOKEN", "")
API = f"{BASE}/api/v4"

if not BASE:
    sys.exit("✗ GITLAB_BASE_URL не задан в .env")
if not TOKEN:
    sys.exit("✗ GITLAB_TOKEN не задан в .env")

# Управляемые варианты (зеркалит config/projects.json5 → projects[].gitlabProjectId).
# path-with-namespace; числовой id резолвим этим скриптом.
PROJECT_PATHS = [
    "<group>/<main-project>",
    "<group>/<variant-a>",
    "<group>/<variant-b>",
    "<group>/<variant-c>",
    "<user>/<dev-stack>",
]
# ── HTTP ───────────────────────────────────────────────────────────────────────

def get(path: str, params: dict = None):
    """GET /api/v4{path} → (status, json|text, resp_headers)."""
    qs = ("?" + urllib.parse.urlencode(params)) if params else ""
    url = f"{API}{path}{qs}"
    req = urllib.request.Request(url, headers={"PRIVATE-TOKEN": TOKEN, "Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=25) as r:
            body = r.read().decode()
            try:
                return r.status, json.loads(body), dict(r.headers)
            except json.JSONDecodeError:
                return r.status, body, dict(r.headers)
    except HTTPError as e:
        return e.code, e.read().decode()[:300], dict(e.headers or {})
    except URLError as e:
        return None, f"network: {e.reason}", {}

def enc(path_with_namespace: str) -> str:
    """<group>/<main-project> → <group>%2F<main-project> (id для API)."""
    return urllib.parse.quote(path_with_namespace, safe="")

def header(t: str):
    print(f"\n{'='*66}\n  {t}\n{'='*66}")

# ── Sections ────────────────────────────────────────────────────────────────────

def whoami():
    header("WHOAMI — валиден ли токен")
    code, data, _ = get("/user")
    if code != 200:
        print(f"  ✗ HTTP {code}: {data}")
        print("  (401 = токен битый/протух; 403 = нет доступа)")
        return False
    print(f"  ✓ HTTP 200 — токен валиден")
    print(f"    user: {data.get('username')} (id {data.get('id')}, {data.get('name')})")
    return True

def scopes():
    header("SCOPES — какие права у токена")
    code, data, _ = get("/personal_access_tokens/self")
    if code != 200:
        print(f"  ⚠ HTTP {code}: {data}")
        print("  (эндпоинт может быть недоступен — не критично; scopes увидим по факту работы)")
        return
    print(f"  scopes: {data.get('scopes')}")
    print(f"  name:   {data.get('name')}   revoked={data.get('revoked')}   expires={data.get('expires_at')}")

def projects():
    header("PROJECTS — резолв вариантов в числовые projectId (для config/projects.json5)")
    print(f"\n  {'projectId':>9}  {'default':<10} path")
    print(f"  {'---------':>9}  {'-------':<10} ----")
    resolved = {}
    for p in PROJECT_PATHS:
        code, data, _ = get(f"/projects/{enc(p)}")
        if code != 200:
            print(f"  {'ERR':>9}  {'':<10} {p}  → HTTP {code}: {str(data)[:80]}")
            continue
        pid = data.get("id")
        resolved[p] = pid
        print(f"  {pid:>9}  {str(data.get('default_branch')):<10} {p}")
    return resolved

def open_mrs(resolved: dict):
    header("OPEN MRS — открытые merge requests по вариантам")
    target = None
    for p, pid in resolved.items():
        if not pid:
            continue
        code, data, _ = get(f"/projects/{pid}/merge_requests",
                            {"state": "opened", "order_by": "updated_at", "per_page": 10})
        if code != 200 or not isinstance(data, list):
            print(f"\n  {p}: HTTP {code}: {str(data)[:100]}")
            continue
        print(f"\n  {p} (id {pid}) — открытых MR: {len(data)}")
        for mr in data[:10]:
            print(f"    !{mr.get('iid'):<5} [{mr.get('source_branch')} → {mr.get('target_branch')}] "
                  f"{(mr.get('title') or '')[:60]}  ({(mr.get('author') or {}).get('username')})")
        if target is None and data:
            target = (pid, data[0].get("iid"), p)
    return target

def diff_probe(target):
    header("DIFF PROBE — размер дифа реального MR (бюджет токенов на ревью)")
    if not target:
        print("  (нет открытых MR для пробы — пропуск)")
        return
    pid, iid, p = target
    print(f"  MR: {p}!{iid}  (project {pid})")
    code, data, _ = get(f"/projects/{pid}/merge_requests/{iid}/changes")
    if code != 200 or not isinstance(data, dict):
        print(f"  ⚠ HTTP {code}: {str(data)[:120]}")
        return
    changes = data.get("changes", []) or []
    total = 0
    print(f"\n  файлов изменено: {len(changes)}")
    print(f"  {'байт diff':>10}  файл")
    print(f"  {'---------':>10}  ----")
    for ch in changes:
        d = ch.get("diff", "") or ""
        total += len(d)
        print(f"  {len(d):>10}  {ch.get('new_path')}")
    # грубая оценка: ~4 байта/токен
    print(f"\n  ИТОГО diff: {total} байт  (~{total // 4} токенов грубо)")
    print(f"  Порог ревью-чанка по AGENTS.md — 8192 токенов; если выше — бить по файлам/расширениям.")

def diff_endpoints(ref: str):
    """Различить причину 404 на дифах: эндпоинт /diffs (нужен GitLab 15.7+, его зовёт
    gitlab-mr-mcp) vs старый /changes. ref = '<group>/<variant-a>!3508'."""
    header("DIFFCHECK — почему 404 на дифах (changes vs diffs + версия GitLab)")
    proj, _, iid = ref.partition("!")
    if not iid:
        sys.exit("✗ формат: --diffcheck <group>/<variant-a>!3508")

    vcode, vdata, _ = get("/version")
    print(f"  GitLab version: HTTP {vcode} → {vdata if vcode==200 else str(vdata)[:120]}")
    print(f"  (эндпоинт /merge_requests/:iid/diffs появился в GitLab 15.7; gitlab-mr-mcp зовёт ИМЕННО его)")

    pcode, pdata, _ = get(f"/projects/{enc(proj)}")
    if pcode != 200:
        sys.exit(f"✗ проект {proj}: HTTP {pcode}")
    pid = pdata["id"]
    print(f"\n  проект {proj} → id {pid}")

    # MR существует?
    mcode, mdata, _ = get(f"/projects/{pid}/merge_requests/{iid}")
    if mcode == 200 and isinstance(mdata, dict):
        print(f"  MR !{iid}: HTTP 200 ✓  state={mdata.get('state')}  "
              f"[{mdata.get('source_branch')} → {mdata.get('target_branch')}]  {(mdata.get('title') or '')[:50]}")
    else:
        print(f"  MR !{iid}: HTTP {mcode} → {str(mdata)[:120]}")
        print("  (если тут 404 — MR с таким iid в этом проекте НЕТ; проблема не в эндпоинте, а в номере)")

    # старый эндпоинт (моя проба, работает на старых GitLab)
    ccode, cdata, _ = get(f"/projects/{pid}/merge_requests/{iid}/changes")
    cfiles = len(cdata.get("changes", [])) if (ccode == 200 and isinstance(cdata, dict)) else "-"
    print(f"\n  /changes : HTTP {ccode}  (файлов: {cfiles})   ← старый эндпоинт")

    # новый эндпоинт (его зовёт gitlab-mr-mcp через allDiffs)
    dcode, ddata, _ = get(f"/projects/{pid}/merge_requests/{iid}/diffs")
    dn = len(ddata) if (dcode == 200 and isinstance(ddata, list)) else "-"
    print(f"  /diffs   : HTTP {dcode}  (файлов: {dn})   ← gitlab-mr-mcp (allDiffs), нужен 15.7+")

    header("ВЕРДИКТ")
    if dcode == 404 and ccode == 200:
        print("  ⇒ ВЕРСИЯ. GitLab старше 15.7: /diffs нет, /changes жив. gitlab-mr-mcp.get_merge_request_diff")
        print("    работать НЕ будет. Решение: reviewer MCP тянет диф сам через /changes (не через пакет).")
    elif mcode == 404:
        print("  ⇒ НОМЕР. MR с таким iid в проекте нет — агент подсунул кривой iid (как 1421). Эндпоинт ни при чём.")
    elif dcode == 200:
        print("  ⇒ /diffs ЖИВ. 404 у агента был из-за неверных project_id/iid, а не эндпоинта.")
    else:
        print(f"  ⇒ иное: changes={ccode}, diffs={dcode}, mr={mcode}. Скинь вывод — разберём.")
    print()

def main():
    print(f"GitLab: {BASE}")
    print(f"Token:  {'*' * 4}{TOKEN[-4:]} (хвост)")
    if not whoami():
        sys.exit(1)
    scopes()
    # диагностика 404 на дифах: какой эндпоинт жив (changes vs diffs) + версия GitLab
    if "--diffcheck" in sys.argv:
        ref = sys.argv[sys.argv.index("--diffcheck") + 1]
        diff_endpoints(ref)
        return
    # одиночный MR по аргументу
    if "--mr" in sys.argv:
        ref = sys.argv[sys.argv.index("--mr") + 1]
        proj, _, iid = ref.partition("!")
        code, data, _ = get(f"/projects/{enc(proj)}")
        if code != 200:
            sys.exit(f"✗ проект {proj}: HTTP {code}")
        diff_probe((data["id"], int(iid), proj))
        return
    resolved = projects()
    target = open_mrs(resolved)
    diff_probe(target)
    header("ИТОГ")
    print("  1. Числовые projectId из раздела PROJECTS → впиши в config/projects.json5")
    print("  2. Отдай весь этот вывод ассистенту — он раскомментит gitlab-блок и соберёт ревью-флоу")
    print()

if __name__ == "__main__":
    main()
