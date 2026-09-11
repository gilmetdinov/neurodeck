#!/usr/bin/env python3
"""
redmine-discover.py — контролируемая разведка Redmine для рефакторинга MCP.

Читает креды из .env проекта (REDMINE_BASE_URL / REDMINE_LOGIN / REDMINE_PASSWORD
или REDMINE_API_KEY). Только GET-запросы. Ничего не пишет в Redmine.

Закрывает тудушки из docs/tasks/redmine-mcp-rework.md:
  - найти slug супер-проекта neurodeck            → раздел PROJECTS
  - реальные ID статусов (Code Review/Исполнено) → раздел STATUSES
  - ID трекеров и приоритетов                    → разделы TRACKERS / PRIORITIES
  - ID участников команды                        → раздел MEMBERS
  - 401 на фильтре assigned_to_id?               → раздел PROBES
  - 401 на глобальном запросе без project_id?    → раздел PROBES

Запуск:
    python3 scripts/redmine-discover.py
    python3 scripts/redmine-discover.py --project neurodeck   # форс проекта для MEMBERS

Inspired by a stdlib-only Redmine analytics script.
"""

import os
import sys
import json
import base64
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.parse import urlencode
from urllib.error import HTTPError, URLError

# ── .env loader (без зависимостей) ─────────────────────────────────────────────

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

BASE_URL = os.environ.get("REDMINE_BASE_URL", "").rstrip("/")
LOGIN    = os.environ.get("REDMINE_LOGIN", "")
PASSWORD = os.environ.get("REDMINE_PASSWORD", "")
API_KEY  = os.environ.get("REDMINE_API_KEY", "")

if not BASE_URL:
    sys.exit("✗ REDMINE_BASE_URL не задан в .env")
if not (LOGIN and PASSWORD) and not API_KEY:
    sys.exit("✗ нужен REDMINE_LOGIN+REDMINE_PASSWORD или REDMINE_API_KEY в .env")

# Слаги-кандидаты для супер-проекта (подсветим в выводе)
PROJECT_HINTS = ["neurodeck", "<project-hint-1>", "<project-hint-2>"]

# Команда из analytics.py (git-логин → кириллический фрагмент имени в Redmine)
DEV_TEAM = {
    "<git-login-1>": "<name-fragment-1>",
    "<git-login-2>": "<name-fragment-2>",
    "<git-login-3>": "<name-fragment-3>",
    "<git-login-4>": "<name-fragment-4>",
}

# ── HTTP ────────────────────────────────────────────────────────────────────

def _headers() -> dict:
    h = {"Accept": "application/json"}
    if LOGIN and PASSWORD:
        token = base64.b64encode(f"{LOGIN}:{PASSWORD}".encode()).decode()
        h["Authorization"] = f"Basic {token}"
    if API_KEY:
        h["X-Redmine-API-Key"] = API_KEY
    return h


def get(path: str, params: dict = None):
    """GET → (status_code, parsed_json | error_text)."""
    qs = ("?" + urlencode(params)) if params else ""
    url = f"{BASE_URL}{path}{qs}"
    req = Request(url, headers=_headers())
    try:
        with urlopen(req, timeout=20) as r:
            return r.status, json.loads(r.read().decode())
    except HTTPError as e:
        return e.code, e.read().decode()[:200]
    except URLError as e:
        return None, f"network: {e.reason}"


def fetch_all(path: str, key: str, params: dict = None) -> list:
    p = dict(params or {})
    p["limit"], p["offset"] = 100, 0
    out = []
    while True:
        code, data = get(path, p)
        if code != 200 or not isinstance(data, dict):
            print(f"  ⚠ {path} → HTTP {code}: {data}")
            break
        items = data.get(key, [])
        out.extend(items)
        total = data.get("total_count", len(items))
        p["offset"] += len(items)
        if p["offset"] >= total or not items:
            break
    return out

# ── Pretty ──────────────────────────────────────────────────────────────────

def header(t: str):
    print(f"\n{'='*64}\n  {t}\n{'='*64}")

# ── Sections ──────────────────────────────────────────────────────────────────

def discover_projects() -> list:
    header("PROJECTS — ищем супер-проект neurodeck")
    projects = fetch_all("/projects.json", "projects")
    if not projects:
        print("  (пусто или ошибка доступа)")
        return projects

    print(f"\n  Всего проектов: {len(projects)}\n")
    print(f"  {'id':>5}  {'parent':>6}  {'slug':<26} name")
    print(f"  {'--':>5}  {'------':>6}  {'-'*26} ----")
    for p in sorted(projects, key=lambda x: x["id"]):
        slug = p.get("identifier", "")
        parent = p.get("parent", {}).get("id", "")
        mark = ""
        if any(h in slug.lower() for h in PROJECT_HINTS):
            mark = "  ← кандидат"
        if not parent:
            mark += "  [root]"
        print(f"  {p['id']:>5}  {str(parent):>6}  {slug:<26} {p.get('name','')}{mark}")
    return projects


def discover_statuses():
    header("STATUSES — ID статусов (для пайплайна и фильтров)")
    code, data = get("/issue_statuses.json")
    if code != 200:
        print(f"  ⚠ HTTP {code}: {data}")
        return
    for s in data.get("issue_statuses", []):
        flags = " [CLOSED]" if s.get("is_closed") else ""
        name_l = s["name"].lower()
        if "review" in name_l or "ревью" in name_l or "ревю" in name_l:
            flags += " ← возможно CODE REVIEW"
        if "исполн" in name_l:
            flags += " ← возможно ИСПОЛНЕНО"
        if "достав" in name_l or "препрод" in name_l or "прод" in name_l:
            flags += " ← возможно ДОСТАВКА"
        print(f"  {s['id']:>3}  {s['name']}{flags}")


def discover_trackers():
    header("TRACKERS — типы задач")
    code, data = get("/trackers.json")
    if code != 200:
        print(f"  ⚠ HTTP {code}: {data}")
        return
    for t in data.get("trackers", []):
        print(f"  {t['id']:>3}  {t['name']}")


def discover_priorities():
    header("PRIORITIES — приоритеты (enumerations)")
    code, data = get("/enumerations/issue_priorities.json")
    if code != 200:
        print(f"  ⚠ HTTP {code}: {data} (эндпоинт может быть закрыт — не критично)")
        return
    for pr in data.get("issue_priorities", []):
        default = " [default]" if pr.get("is_default") else ""
        print(f"  {pr['id']:>3}  {pr['name']}{default}")


def discover_members(project_slug: str):
    header(f"MEMBERS — участники проекта '{project_slug}' (id для assigned_to_id)")
    code, data = get(f"/projects/{project_slug}/memberships.json", {"limit": 100})
    if code != 200:
        print(f"  ⚠ HTTP {code}: {data}")
        print("  (если 403/401 — у memberships может быть ограничен доступ; "
              "тогда ID собираем из задач)")
        return
    members = data.get("memberships", [])
    if not members:
        print("  (пусто)")
        return
    print(f"\n  {'user_id':>7}  {'роли':<28} имя")
    print(f"  {'-------':>7}  {'-'*28} ----")
    for m in members:
        user = m.get("user")
        if not user:
            continue  # группа, не юзер
        roles = ", ".join(r["name"] for r in m.get("roles", []))
        name_l = user["name"].lower()
        tag = ""
        for login, frag in DEV_TEAM.items():
            if frag in name_l:
                tag = f"  ← {login}"
        print(f"  {user['id']:>7}  {roles[:28]:<28} {user['name']}{tag}")


def probes(project_slug: str):
    header("PROBES — проверка гипотез про 401")

    # 1) глобальный запрос задач без project_id
    code, _ = get("/issues.json", {"limit": 1})
    print(f"  [1] GET /issues без project_id           → HTTP {code}"
          + ("  (глобальный доступ ЕСТЬ)" if code == 200 else "  (нужен project_id / admin)"))

    # 2) задачи в рамках проекта
    if project_slug:
        code, data = get("/issues.json", {"project_id": project_slug, "limit": 1})
        total = data.get("total_count", "?") if isinstance(data, dict) else "?"
        print(f"  [2] GET /issues?project_id={project_slug:<14} → HTTP {code}  (total={total})")

        # 3) фильтр по исполнителю (известный id)
        code, data = get("/issues.json", {"project_id": project_slug, "assigned_to_id": "60", "status_id": "*", "limit": 1})
        total = data.get("total_count", "?") if isinstance(data, dict) else "?"
        print(f"  [3] +assigned_to_id=<ID>        → HTTP {code}  (total={total})")

        # 4) фильтр assigned_to_id=me
        code, data = get("/issues.json", {"project_id": project_slug, "assigned_to_id": "me", "status_id": "*", "limit": 1})
        total = data.get("total_count", "?") if isinstance(data, dict) else "?"
        print(f"  [4] +assigned_to_id=me                   → HTTP {code}  (total={total})")
    else:
        print("  [2-4] пропущены — не задан проект (см. --project или REDMINE_PROJECT)")

    # 5) include_subprojects по умолчанию: проект с детьми vs без
    print("  [5] subprojects — сравни total в [2] с задачами одного подпроекта вручную")


def pick_project(projects: list, forced: str | None) -> str:
    if forced:
        return forced
    if os.environ.get("REDMINE_PROJECT"):
        return os.environ["REDMINE_PROJECT"]
    # авто-кандидат: root-проект, чей slug содержит подсказку
    for p in projects:
        slug = p.get("identifier", "")
        if not p.get("parent") and any(h in slug.lower() for h in PROJECT_HINTS):
            return slug
    # иначе первый root
    for p in projects:
        if not p.get("parent"):
            return p.get("identifier", "")
    return ""


def cmd_load():
    """Нагрузка по core_developers из config/team.json — зеркало MCP analyze_team_load.
    Позволяет проверить аналитику до запуска gateway."""
    import json as _json
    team_path = ROOT / "config" / "team.json"
    if not team_path.exists():
        sys.exit("✗ нет config/team.json")
    team = _json.loads(team_path.read_text(encoding="utf-8"))
    devs = team.get("core_developers", [])
    proj = team.get("project", {}).get("slug", os.environ.get("REDMINE_PROJECT", ""))
    st = team.get("statuses", {})
    def ids(group, fb):
        return ",".join(str(x) for x in st.get(group, {}).get("ids", fb))
    in_prog, paused = ids("in_progress", [2]), ids("paused", [10])
    review, executed = ids("code_review", [13]), ids("executed_dev", [27])
    # Просрочку считаем только по статусам в активных руках разраба (см. overdue_scope в team.json),
    # а не по всем open — иначе в счёт попадают Исполнено/ревью/тестирование, где due_date про доставку.
    overdue_ids = ",".join(str(x) for x in team.get("overdue_scope", {}).get("status_ids", [2, 20, 8, 10, 26]))
    today = __import__("datetime").date.today().isoformat()

    header(f"LOAD — нагрузка core_developers (проект {proj})")
    print(f"\n  {'разработчик':<22} {'откр':>4} {'вработе':>7} {'пауза':>5} {'ревью':>5} {'исполн':>6} {'проср':>5}  флаги")
    print(f"  {'-'*22} {'----':>4} {'-------':>7} {'-----':>5} {'-----':>5} {'------':>6} {'-----':>5}")

    def count(**params):
        params.update({"project_id": proj, "limit": 1})
        code, data = get("/issues.json", params)
        return data.get("total_count", 0) if (code == 200 and isinstance(data, dict)) else f"E{code}"

    def count_statuses(status_csv, **params):
        """Сумма по статусам: <YOUR_REDMINE_HOST> 500-ит на status_id=a,b,c — шлём по одному.
        Зеркалит countByStatuses в MCP. Любая под-ошибка → E<code>."""
        ids = [s for s in str(status_csv).split(",") if s]
        if len(ids) <= 1:
            return count(status_id=status_csv, **params)
        total = 0
        for sid in ids:
            c = count(status_id=sid, **params)
            if not isinstance(c, int):
                return c  # пробрасываем ошибку как есть
            total += c
        return total

    for d in devs:
        a = d["id"]
        total = count(assigned_to_id=a, status_id="open")
        ip    = count_statuses(in_prog,  assigned_to_id=a)
        pa    = count_statuses(paused,   assigned_to_id=a)
        rv    = count_statuses(review,   assigned_to_id=a)
        ex    = count_statuses(executed, assigned_to_id=a)
        ov    = count_statuses(overdue_ids, assigned_to_id=a, due_date=f"<={today}")
        flags = []
        if ip == 0: flags.append("🔴 0 в работе")
        elif isinstance(ip, int) and ip > 3: flags.append(f"⚠ {ip} в работе")
        if isinstance(pa, int) and pa > 1: flags.append(f"⚠ {pa} на паузе")
        if isinstance(ov, int) and ov > 0: flags.append(f"⏰ {ov} проср.")
        name = d["name"][:22]
        print(f"  {name:<22} {str(total):>4} {str(ip):>7} {str(pa):>5} {str(rv):>5} {str(ex):>6} {str(ov):>5}  {' '.join(flags)}")
    print()


def main():
    # Подкоманда: load — только нагрузка. Иначе — полная разведка.
    if len(sys.argv) > 1 and sys.argv[1] == "load":
        print(f"Redmine: {BASE_URL}  (login={LOGIN})")
        cmd_load()
        return

    forced = None
    if "--project" in sys.argv:
        i = sys.argv.index("--project")
        forced = sys.argv[i + 1] if i + 1 < len(sys.argv) else None

    print(f"Redmine: {BASE_URL}")
    print(f"Auth:    {'basic' if (LOGIN and PASSWORD) else 'api-key'}"
          + (f" (login={LOGIN})" if LOGIN else ""))

    projects = discover_projects()
    project_slug = pick_project(projects, forced)
    print(f"\n  → Для разведки участников/проб выбран проект: '{project_slug}'"
          + ("  (форсирован)" if forced else "  (авто; форсируй через --project)"))

    discover_statuses()
    discover_trackers()
    discover_priorities()
    discover_members(project_slug)
    probes(project_slug)

    header("ИТОГ — что внести в конфиг")
    print(f"  1. В .env:  REDMINE_PROJECT={project_slug}")
    print(f"  2. ID статусов Code Review / Исполнено / Доставка — взять из раздела STATUSES")
    print(f"  3. ID участников команды — из раздела MEMBERS → в prompts/system.md")
    print(f"  4. Если PROBE [1]=200 — глобальный доступ есть, project_id не обязателен")
    print(f"     Если PROBE [3]=200 — фильтр assigned_to_id работает (не нужен admin)")
    print()


if __name__ == "__main__":
    main()
