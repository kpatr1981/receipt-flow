#!/bin/sh
# Build web/dist and install it on a host as the receiptflow systemd service (port 8095).
# Usage: web/deploy/deploy.sh user@host   (needs root on the host for systemd)
set -eu
HOST="${1:?usage: web/deploy/deploy.sh user@host}"
cd "$(dirname "$0")/.."
node tools/build.mjs
ssh "$HOST" 'mkdir -p /opt/receiptflow/www'
rsync -a --delete dist/ "$HOST:/opt/receiptflow/www/"
scp -q deploy/server.py "$HOST:/opt/receiptflow/server.py"
scp -q deploy/receiptflow.service "$HOST:/etc/systemd/system/receiptflow.service"
ssh "$HOST" 'chmod -R a+rX /opt/receiptflow && systemctl daemon-reload && systemctl enable --now receiptflow && systemctl restart receiptflow && sleep 1 && systemctl --no-pager --lines=3 status receiptflow'
