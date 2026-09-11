#!/usr/bin/env python3
"""
review-probe.py — сквозная проба ревью-флоу (этап 3) ДО оборачивания в MCP.

Пайплайн: GitLab MR diff (через /changes — рабочий эндпоинт на GitLab 15.1.4, в отличие
от /diffs, который 404) + контекст Redmine-задачи + прогон через DeepInfra → печать ревью.

ЗАЧЕМ ОТДЕЛЬНЫМ СКРИПТОМ: ассистент через прокси до <YOUR_GITLAB_HOST>/DeepInfra не достучится.
Гоняешь ты, отдаёшь вывод. Только GET к GitLab/Redmine (read), один POST к DeepInfra.

СЕТЬ: GitLab/Redmine (<YOUR_HOST>, внутренние) — НАПРЯМУЮ. DeepInfra (api.deepinfra.com,
внешний) — ЧЕРЕЗ ПРОКСИ (PROXY_URL/TELEGRAM_PROXY из .env), иначе на этой сети виснет.

Запуск:
    python3 scripts/review-probe.py <group>/<variant-a>!3508
    REVIEW_MODEL=deepseek-ai/DeepSeek-V4-Pro python3 scripts/review-probe.py <proj>!<iid>
"""

import os
import re
import sys
import json
import base64
import urllib.request
import urllib.parse
from pathlib import Path
from urllib.error import HTTPError, URLError

# ── .env ────────────────────────────────────────────────────────────────────────

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

GL_BASE = os.environ.get("GITLAB_BASE_URL", "").rstrip("/")
GL_TOKEN = os.environ.get("GITLAB_TOKEN", "")
RM_BASE = os.environ.get("REDMINE_BASE_URL", "").rstrip("/")
RM_LOGIN = os.environ.get("REDMINE_LOGIN", "")
RM_PASS = os.environ.get("REDMINE_PASSWORD", "")
DI_BASE = os.environ.get("DEEPINFRA_BASE_URL", "https://api.deepinfra.com/v1/openai").rstrip("/")
DI_KEY = os.environ.get("DEEPINFRA_API_KEY", "")
MODEL = os.environ.get("REVIEW_MODEL") or os.environ.get("DEEPINFRA_MODEL", "")
PROXY = os.environ.get("PROXY_URL") or os.environ.get("TELEGRAM_PROXY", "")

for name, val in [("GITLAB_BASE_URL", GL_BASE), ("GITLAB_TOKEN", GL_TOKEN),
                  ("DEEPINFRA_API_KEY", DI_KEY), ("DEEPINFRA_MODEL/REVIEW_MODEL", MODEL)]:
    if not val:
        sys.exit(f"✗ нет {name} в .env")

# Фильтр файлов для ревью (ADR-0006 reviewExtensions + отсев шума).
REVIEW_EXT = {"php", "go", "ts", "tsx", "js", "jsx", "vue"}
SKIP_SUBSTR = ("/migrations/", ".min.", "package-lock.json", "composer.lock", "yarn.lock", ".lock")
MAX_DIFF_CHARS = 120_000   # ~30K токенов; выше — режем и помечаем

# ── HTTP: direct (внутренние) и proxy (DeepInfra) ────────────────────────────────

_direct = urllib.request.build_opener(urllib.request.ProxyHandler({}))
_proxied = (urllib.request.build_opener(urllib.request.ProxyHandler({"https": PROXY, "http": PROXY}))
            if PROXY else _direct)

def gl_get(path: str, params: dict = None):
    qs = ("?" + urllib.parse.urlencode(params)) if params else ""
    req = urllib.request.Request(f"{GL_BASE}/api/v4{path}{qs}",
                                 headers={"PRIVATE-TOKEN": GL_TOKEN, "Accept": "application/json"})
    try:
        with _direct.open(req, timeout=30) as r:
            return r.status, json.loads(r.read().decode())
    except HTTPError as e:
        return e.code, e.read().decode()[:300]
    except URLError as e:
        return None, f"network: {e.reason}"

def rm_get(path: str, params: dict = None):
    if not (RM_BASE and RM_LOGIN and RM_PASS):
        return None, "redmine creds не заданы"
    qs = ("?" + urllib.parse.urlencode(params)) if params else ""
    tok = base64.b64encode(f"{RM_LOGIN}:{RM_PASS}".encode()).decode()
    req = urllib.request.Request(f"{RM_BASE}{path}{qs}",
                                 headers={"Authorization": f"Basic {tok}", "Accept": "application/json"})
    try:
        with _direct.open(req, timeout=20) as r:
            return r.status, json.loads(r.read().decode())
    except HTTPError as e:
        return e.code, e.read().decode()[:200]
    except URLError as e:
        return None, f"network: {e.reason}"

def deepinfra_review(system_prompt: str, user_msg: str) -> str:
    body = json.dumps({
        "model": MODEL,
        "messages": [{"role": "system", "content": system_prompt},
                     {"role": "user", "content": user_msg}],
        "max_tokens": 2000,
        "temperature": 0.2,
    }).encode()
    req = urllib.request.Request(f"{DI_BASE}/chat/completions", data=body,
                                 headers={"Authorization": f"Bearer {DI_KEY}",
                                          "Content-Type": "application/json"})
    try:
        with _proxied.open(req, timeout=180) as r:
            data = json.loads(r.read().decode())
            return data["choices"][0]["message"]["content"]
    except HTTPError as e:
        return f"[DeepInfra HTTP {e.code}] {e.read().decode()[:400]}"
    except URLError as e:
        return f"[DeepInfra network] {e.reason}  (прокси? PROXY_URL={PROXY or '<нет>'})"

# ── Helpers ──────────────────────────────────────────────────────────────────────

def header(t): print(f"\n{'='*66}\n  {t}\n{'='*66}")

def annotate(diff: str) -> str:
    """Префиксует строки диффа номером строки в НОВОМ файле (из @@-заголовка) —
    чтобы модель цитировала точные `путь:строка`. Удалённые строки без номера."""
    out, newln = [], 0
    for line in diff.split("\n"):
        if line.startswith("@@"):
            mm = re.search(r"\+(\d+)", line)
            newln = int(mm.group(1)) if mm else 0
            out.append(line)
        elif line.startswith("\\"):
            out.append(line)
        elif line.startswith("-"):
            out.append(f"      {line}")            # removed: нет новой строки
        else:                                       # added (+) или context
            out.append(f"{newln:>5} {line}")
            newln += 1
    return "\n".join(out)

def keep_file(ch: dict) -> bool:
    if ch.get("deleted_file"):
        return False
    path = ch.get("new_path") or ch.get("old_path") or ""
    if any(s in path for s in SKIP_SUBSTR):
        return False
    ext = path.rsplit(".", 1)[-1].lower() if "." in path else ""
    if ext not in REVIEW_EXT:
        return False
    return bool((ch.get("diff") or "").strip())

# ── Main ─────────────────────────────────────────────────────────────────────────

def main():
    args = [a for a in sys.argv[1:] if not a.startswith("-")]
    if not args or "!" not in args[0]:
        sys.exit("Использование: python3 scripts/review-probe.py <group>/<variant-a>!3508")
    proj, _, iid = args[0].partition("!")

    print(f"GitLab: {GL_BASE}   Redmine: {RM_BASE}")
    print(f"Модель ревью: {MODEL}   Прокси для DeepInfra: {PROXY or '<нет — может зависнуть>'}")

    # 1) MR details
    pcode, pdata = gl_get(f"/projects/{urllib.parse.quote(proj, safe='')}")
    if pcode != 200:
        sys.exit(f"✗ проект {proj}: HTTP {pcode}: {pdata}")
    pid = pdata["id"]
    mcode, mr = gl_get(f"/projects/{pid}/merge_requests/{iid}")
    if mcode != 200 or not isinstance(mr, dict):
        sys.exit(f"✗ MR !{iid}: HTTP {mcode}: {mr}")
    header("MR")
    print(f"  {proj}!{iid}: {mr.get('title')}")
    print(f"  [{mr.get('source_branch')} → {mr.get('target_branch')}]  state={mr.get('state')}  автор={(mr.get('author') or {}).get('username')}")

    # 2) diff через /changes (рабочий на 15.1.4)
    ccode, ch = gl_get(f"/projects/{pid}/merge_requests/{iid}/changes")
    if ccode != 200 or not isinstance(ch, dict):
        sys.exit(f"✗ /changes: HTTP {ccode}: {ch}")
    changes = ch.get("changes", []) or []
    kept = [c for c in changes if keep_file(c)]
    skipped = len(changes) - len(kept)
    header("DIFF")
    print(f"  файлов всего: {len(changes)}, на ревью: {len(kept)}, отсеяно (не код/шум/удалено): {skipped}")
    for c in kept:
        print(f"    + {c.get('new_path')}  ({len(c.get('diff') or '')} б)")
    if not kept:
        sys.exit("  нет файлов под ревью (всё отсеяно) — нечего ревьюить")

    proj_web = (mr.get("web_url") or "").split("/-/merge_requests")[0]
    branch = mr.get("source_branch") or ""
    links, diff_text, truncated = [], "", False
    for c in kept:
        p = c.get("new_path")
        if proj_web and branch:
            links.append(f"- {p} → {proj_web}/-/blob/{branch}/{p}")
        block = f"\n--- {p} ---\n{annotate(c.get('diff') or '')}"
        if len(diff_text) + len(block) > MAX_DIFF_CHARS:
            truncated = True
            break
        diff_text += block

    # 3) контекст Redmine-задачи (номер из ветки #NNNNN)
    task_ctx = "(Redmine-задачу определить не удалось)"
    m = re.search(r"(\d{4,})", mr.get("source_branch") or "")
    if m:
        nnn = m.group(1)
        rc, issue = rm_get(f"/issues/{nnn}.json", {"include": "journals"})
        if rc == 200 and isinstance(issue, dict):
            it = issue.get("issue", {})
            notes = [j.get("notes", "") for j in it.get("journals", []) if j.get("notes")]
            last_notes = "\n".join(f"  • {n[:300]}" for n in notes[-3:])
            task_ctx = (f"#{nnn} {it.get('subject','')}\n"
                        f"Статус: {(it.get('status') or {}).get('name')}  "
                        f"Готовность: {it.get('done_ratio')}%\n"
                        f"Описание: {(it.get('description') or '')[:1500]}\n"
                        f"Последние примечания:\n{last_notes or '  (нет)'}")
            print(f"\n  Redmine #{nnn}: {it.get('subject','')[:70]}")
        else:
            task_ctx = f"#{nnn} (Redmine вернул HTTP {rc})"

    # 4) ревью
    system_prompt = (ROOT / "prompts" / "code-review.md").read_text(encoding="utf-8")
    links_block = ("# ССЫЛКИ (для замечаний: <ссылка>#L<строка>)\n" + "\n".join(links) + "\n\n") if links else ""
    user_msg = (f"# КОНТЕКСТ ЗАДАЧИ (Redmine)\n{task_ctx}\n\n"
                f"# MERGE REQUEST\n{proj}!{iid}: {mr.get('title')}  "
                f"[{mr.get('source_branch')} → {mr.get('target_branch')}]\n\n"
                f"{links_block}"
                f"# ДИФФ (число слева = номер строки в новом файле)"
                + ("  ⚠ ОБРЕЗАН по лимиту — отзыв по видимой части\n" if truncated else "\n")
                + f"```diff\n{diff_text}\n```")

    header("РЕВЬЮ (DeepInfra)")
    print(deepinfra_review(system_prompt, user_msg))
    print()

if __name__ == "__main__":
    main()
