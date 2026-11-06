#!/usr/bin/env bash
# Run on the isolated sandbox machine, from ~/sandbox. Installs gVisor, the two base images and the server.
set -euo pipefail
cd "$HOME/sandbox"
curl -fsSL https://gvisor.dev/archive.key | sudo gpg --dearmor --yes -o /usr/share/keyrings/gvisor-archive-keyring.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/gvisor-archive-keyring.gpg] https://storage.googleapis.com/gvisor/releases release main" | sudo tee /etc/apt/sources.list.d/gvisor.list >/dev/null
sudo apt-get update -qq
sudo apt-get install -y -qq runsc >/dev/null
sudo runsc install
sudo systemctl restart docker
sudo docker pull -q python:3.12-alpine
sudo docker pull -q node:22-alpine
test -s token || (umask 077; openssl rand -hex 32 > token)
chmod 600 token
sudo cp proven-sandbox.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable proven-sandbox
sudo systemctl restart proven-sandbox
sleep 2
systemctl is-active proven-sandbox
sudo docker info 2>/dev/null | grep -E "Runtimes" | cut -c1-80
