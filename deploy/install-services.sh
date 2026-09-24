#!/usr/bin/env bash
# deploy/install-services.sh
#
# Installs and enables all ByTrader systemd services.
# Run once on the VPS after cloning the repo.
#
# Usage:
#   chmod +x deploy/install-services.sh
#   sudo ./deploy/install-services.sh

set -euo pipefail

DEPLOY_DIR="$(cd "$(dirname "$0")" && pwd)"
SYSTEMD_DIR="/etc/systemd/system"

echo "[ByTrader] Installing systemd service units..."

cp "$DEPLOY_DIR/mt5-xvfb.service"           "$SYSTEMD_DIR/"
cp "$DEPLOY_DIR/bytrader-worker.service"    "$SYSTEMD_DIR/"
cp "$DEPLOY_DIR/bytrader-autotrader.service" "$SYSTEMD_DIR/"

systemctl daemon-reload

systemctl enable mt5-xvfb.service
systemctl enable bytrader-worker.service
systemctl enable bytrader-autotrader.service

echo "[ByTrader] Services installed and enabled."
echo ""
echo "Start with:"
echo "  sudo systemctl start mt5-xvfb"
echo "  sudo systemctl start bytrader-worker      # Telegram forwarder"
echo "  sudo systemctl start bytrader-autotrader  # MT5 execution"
echo ""
echo "Check status:"
echo "  sudo journalctl -u bytrader-worker -f"
echo "  sudo journalctl -u bytrader-autotrader -f"
echo "  sudo journalctl -u mt5-xvfb -f"
