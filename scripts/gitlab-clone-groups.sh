#!/usr/bin/env bash
# Клонирует репозитории из config/gitlab-repos.txt по группам:
#   <group-libraries>/*            → ../../workspace/libraries/<repo>
#   <group-platform>/services/* → ../../workspace/services/[subgroup/]<repo>

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG="$SCRIPT_DIR/../config/gitlab-repos.txt"
LIBRARIES_DIR="$(cd "$SCRIPT_DIR/../../../workspace/libraries" && pwd)"
SERVICES_DIR="$(cd "$SCRIPT_DIR/../../../workspace/services" && pwd)"

# ── passphrase ────────────────────────────────────────────────────────────────
read -r -s -p "SSH passphrase (Enter если не нужен): " PASSPHRASE
echo

# ── clone helper ──────────────────────────────────────────────────────────────
clone_repo() {
    local url="$1"
    local dest_dir="$2"
    local repo_name
    repo_name="$(basename "$url" .git)"
    local target="$dest_dir/$repo_name"

    if [[ -d "$target/.git" ]]; then
        echo "⏭  Уже есть:   $target"
        return 0
    fi

    mkdir -p "$dest_dir"
    echo "⬇  Клонирую:   $url"
    echo "    → $target"
    git clone "$url" "$target"
    echo
}

# ── main loop ─────────────────────────────────────────────────────────────────
ok=0; skip=0; fail=0

while IFS= read -r line; do
    # пропускаем комментарии и пустые строки
    [[ "$line" =~ ^[[:space:]]*# ]] && continue
    [[ -z "${line// }"            ]] && continue

    url="$line"
    # путь после двоеточия: "<group-libraries>/repo.git" или "<group-platform>/services/sub/repo.git"
    ns_path="${url#*:}"

    if [[ "$ns_path" == <group-libraries>/* ]]; then
        clone_repo "$url" "$LIBRARIES_DIR" && (( ok++ )) || (( fail++ ))

    elif [[ "$ns_path" == <group-platform>/services/* ]]; then
        sub="${ns_path#<group-platform>/services/}"
        sub_dir="$(dirname "$sub")"

        if [[ "$sub_dir" == "." ]]; then
            clone_repo "$url" "$SERVICES_DIR" && (( ok++ )) || (( fail++ ))
        else
            clone_repo "$url" "$SERVICES_DIR/$sub_dir" && (( ok++ )) || (( fail++ ))
        fi

    else
        echo "⚠️  Неизвестная группа, пропускаю: $url"
        (( skip++ ))
    fi

done < "$CONFIG"

# ── cleanup ───────────────────────────────────────────────────────────────────
if [[ -n "${AGENT_STARTED:-}" && -n "${SSH_AGENT_PID:-}" ]]; then
    ssh-agent -k > /dev/null
fi

echo "──────────────────────────────────────────"
echo "✅ Готово: склонировано=$ok, пропущено=$skip, ошибок=$fail"
