#!/bin/bash
set -Eeuo pipefail

[[ $EUID -eq 0 ]] || { echo "请使用 root 运行恢复脚本" >&2; exit 1; }
[[ $# -eq 1 && -f "$1" ]] || { echo "用法: sudo scripts/restore.sh <gatekeeper-backup.db.gz>" >&2; exit 1; }

SCRIPT_DIR="$(cd -- "$(dirname -- "$0")" && pwd)"
INSTALL_DIR="${GATEKEEPER_INSTALL_DIR:-$(dirname "$SCRIPT_DIR")}"
BACKUP_FILE="$(realpath "$1")"
TEMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TEMP_DIR"' EXIT

if [[ -f "$BACKUP_FILE.sha256" ]]; then
  (cd "$(dirname "$BACKUP_FILE")" && sha256sum -c "$(basename "$BACKUP_FILE").sha256") >/dev/null \
    || { echo "备份校验和不匹配" >&2; exit 1; }
fi
gzip -cd "$BACKUP_FILE" >"$TEMP_DIR/allowlist.db"
[[ "$(sqlite3 "$TEMP_DIR/allowlist.db" 'PRAGMA quick_check;')" == "ok" ]] \
  || { echo "备份数据库校验失败" >&2; exit 1; }

cd "$INSTALL_DIR"
"$SCRIPT_DIR/backup.sh" >/dev/null
docker compose stop gatekeeper
container_id="$(docker compose ps -a -q gatekeeper)"
[[ -n "$container_id" ]] || { echo "找不到 Gatekeeper 容器" >&2; exit 1; }
docker cp "$TEMP_DIR/allowlist.db" "$container_id:/app/data/.gatekeeper-restore.db" >/dev/null
docker compose run --rm --no-deps --user root gatekeeper sh -c \
  'mv /app/data/.gatekeeper-restore.db /app/data/allowlist.db && chown app:app /app/data/allowlist.db && rm -f /app/data/allowlist.db-wal /app/data/allowlist.db-shm'
docker compose up -d gatekeeper

for _ in $(seq 1 30); do
  curl -fsS http://127.0.0.1:8787/health >/dev/null 2>&1 && break
  sleep 2
done
curl -fsS http://127.0.0.1:8787/health >/dev/null
systemctl start gatekeeper-sync.service 2>/dev/null || true
echo "Gatekeeper 数据库恢复完成"
