#!/usr/bin/env bash
# Run on the machine, from the unpacked source at ~/proven, after .env is in place. It does not open the site.
set -euo pipefail
cd "$HOME/proven"
test -f .env || { echo "Copy the short .env first (deploy/boxd/make-env.mjs)."; exit 1; }
chmod 600 .env
mkdir -p runs/private
chmod 700 runs runs/private
(cd relay && npm ci --no-audit --no-fund)
(cd agent && npm ci --no-audit --no-fund)
(cd web && npm ci --no-audit --no-fund && npm run build)
sudo cp deploy/boxd/proven-relay.service deploy/boxd/proven-web.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now proven-relay proven-web
sudo systemctl restart proven-relay proven-web
systemctl --no-pager --lines=0 status proven-relay proven-web | grep -E "●|Active:"
