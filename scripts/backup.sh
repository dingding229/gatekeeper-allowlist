#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
install_dir=${GATEKEEPER_INSTALL_DIR:-$(dirname "$script_dir")}
backup_dir=${GATEKEEPER_BACKUP_DIR:-/var/backups/gatekeeper}
retention_days=${GATEKEEPER_BACKUP_RETENTION_DAYS:-30}

case "$retention_days" in
  *[!0-9]* | "") echo "invalid backup retention" >&2; exit 1 ;;
esac

mkdir -p "$backup_dir"
chmod 700 "$backup_dir"
mkdir -p /run/lock
exec 9>/run/lock/gatekeeper-backup.lock
flock -n 9 || { echo "Gatekeeper backup is already running" >&2; exit 1; }
cd "$install_dir"

container_id=$(docker compose ps -q gatekeeper)
[ -n "$container_id" ] || { echo "Gatekeeper container is not running" >&2; exit 1; }

stamp=$(date -u +%Y%m%dT%H%M%SZ)
container_backup="/app/data/.gatekeeper-backup-${stamp}-$$.db"
temporary=$(mktemp "$backup_dir/.gatekeeper-${stamp}.XXXXXX.db")
trap 'rm -f "$temporary"; docker compose exec -T gatekeeper rm -f "$container_backup" >/dev/null 2>&1 || true' EXIT INT TERM

docker compose exec -T -e BACKUP_PATH="$container_backup" gatekeeper \
  node --input-type=module -e '
    import { DatabaseSync } from "node:sqlite";
    const db = new DatabaseSync("/app/data/allowlist.db");
    const path = process.env.BACKUP_PATH;
    if (!/^\/app\/data\/[A-Za-z0-9._-]+\.db$/.test(path)) throw new Error("invalid backup path");
    db.exec(`VACUUM INTO '${path}'`);
    const check = new DatabaseSync(path, { readOnly: true }).prepare("PRAGMA quick_check").get();
    if (check.quick_check !== "ok") throw new Error("backup quick_check failed");
    db.close();
  '

docker cp "$container_id:$container_backup" "$temporary" >/dev/null
gzip -c "$temporary" >"$backup_dir/gatekeeper-${stamp}.db.gz"
sha256sum "$backup_dir/gatekeeper-${stamp}.db.gz" >"$backup_dir/gatekeeper-${stamp}.db.gz.sha256"
chmod 600 "$backup_dir/gatekeeper-${stamp}.db.gz" "$backup_dir/gatekeeper-${stamp}.db.gz.sha256"
find "$backup_dir" -type f -name 'gatekeeper-*.db.gz' -mtime "+$retention_days" -delete
find "$backup_dir" -type f -name 'gatekeeper-*.db.gz.sha256' -mtime "+$retention_days" -delete

docker compose exec -T gatekeeper node src/cli.js cleanup >/dev/null 2>&1 || true
echo "$backup_dir/gatekeeper-${stamp}.db.gz"
