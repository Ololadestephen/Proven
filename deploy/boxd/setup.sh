#!/usr/bin/env bash
# Run on the machine, as an admin, from the unpacked source at ~/proven-source, with the three short env
# files beside it. Each service gets its own user, and can read only its own key. It does not open the site.
set -euo pipefail
SRC="$HOME/proven-source"
for name in proven-relay proven-web proven-hosted; do id "$name" >/dev/null 2>&1 || sudo useradd --system --no-create-home --shell /usr/sbin/nologin "$name"; done
getent group proven-sock >/dev/null || sudo groupadd --system proven-sock
sudo usermod -aG proven-sock proven-web
sudo usermod -aG proven-sock proven-hosted
# Nothing here needs Docker, and being able to reach it would mean root.
sudo systemctl disable --now docker docker.socket 2>/dev/null || true
sudo mkdir -p /opt/proven /etc/proven /var/lib/proven/relay /var/lib/proven/hosted
sudo systemctl stop proven-relay proven-web proven-hosted 2>/dev/null || true
sudo rsync -a --delete --exclude runs --exclude .env --exclude node_modules --exclude dist "$SRC"/ /opt/proven/
sudo chown -R root:root /opt/proven
cd /opt/proven
for dir in relay agent web; do (cd "$dir" && sudo npm ci --no-audit --no-fund --silent); done
(cd web && sudo npm run --silent build)
sudo mkdir -p /opt/proven/runs
sudo install -m 640 -o root -g proven-web "$SRC/.env" /opt/proven/.env
sudo install -m 640 -o root -g proven-relay "$SRC/.relay.env" /etc/proven/relay.env
sudo install -m 640 -o root -g proven-hosted "$SRC/.hosted.env" /etc/proven/hosted.env
[ -f "$SRC/.web-flags" ] && sudo install -m 640 -o root -g proven-web "$SRC/.web-flags" /etc/proven/web-flags
shred -u "$SRC/.env" "$SRC/.relay.env" "$SRC/.hosted.env" 2>/dev/null || rm -f "$SRC/.env" "$SRC/.relay.env" "$SRC/.hosted.env"
sudo chown -R proven-web:proven-web /opt/proven/runs
sudo chmod 700 /opt/proven/runs
sudo chown proven-relay:proven-relay /var/lib/proven/relay
sudo chown proven-hosted:proven-hosted /var/lib/proven/hosted
sudo chmod 700 /var/lib/proven/relay /var/lib/proven/hosted
sudo cp deploy/boxd/proven-relay.service deploy/boxd/proven-web.service deploy/boxd/proven-hosted.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable proven-relay proven-web proven-hosted
sudo systemctl restart proven-relay
sleep 3
sudo systemctl restart proven-web proven-hosted
systemctl --no-pager --lines=0 status proven-relay proven-web proven-hosted | grep -E "●|Active:"
