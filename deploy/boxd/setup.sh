#!/usr/bin/env bash
# Run on the machine, from the unpacked source at ~/proven, after both env files are in place. It does not open the site.
set -euo pipefail
cd "$HOME/proven"
test -f .env && test -f .relay.env && test -f .hosted.env || { echo "Copy both short env files first (deploy/boxd/make-env.mjs)."; exit 1; }
chmod 600 .env .relay.env .hosted.env
mkdir -p runs/private
chmod 700 runs runs/private
(cd relay && npm ci --no-audit --no-fund)
(cd agent && npm ci --no-audit --no-fund)
(cd web && npm ci --no-audit --no-fund && npm run build)
sudo cp deploy/boxd/proven-relay.service deploy/boxd/proven-web.service deploy/boxd/proven-hosted.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable proven-relay proven-web proven-hosted
sudo systemctl restart proven-relay proven-web proven-hosted
systemctl --no-pager --lines=0 status proven-relay proven-web proven-hosted | grep -E "●|Active:"
