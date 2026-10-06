#!/bin/sh
# 毎日のバックアップ（cron 例: 0 18 * * *  = 日本時間 午前3時）
#   0 18 * * * cd /srv/app && ./deploy/backup.sh >> /var/log/app-backup.log 2>&1
# バックアップは同じサーバーに置くだけでは、サーバーの故障で一緒に失われる。
# 最後の rclone / rsync の行を有効にして、別の場所（別リージョンのストレージ等）へ必ず複製すること。
set -eu
docker compose exec -T app node --disable-warning=ExperimentalWarning dist-server/cli.js backup /data/backups --keep 14
# docker compose cp app:/data/backups ./backups-copy && rclone sync ./backups-copy remote:bucket/backups
