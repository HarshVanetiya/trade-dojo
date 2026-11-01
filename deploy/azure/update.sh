#!/usr/bin/env bash
# Pull the latest code, rebuild the backend and restart it.
# Run on the VM as the tradedojo user:  sudo -H -u tradedojo /opt/trade-dojo/deploy/azure/update.sh
set -euo pipefail

cd /opt/trade-dojo
git pull --ff-only
cd backend
npm ci
npm run build
# Restarting needs root; the tradedojo user is allowed exactly this command (see the guide).
sudo /usr/bin/systemctl restart tradedojo
echo "Updated to $(git rev-parse --short HEAD)."
