set -euo pipefail
source /tmp/claude-0/insttest/lib.sh >/dev/null 2>&1
INTERACTIVE=0; INSTALL_DIR=/home/user/nexv-panel
PANEL_PORT=2087
settle_panel_port
echo "chosen: $PANEL_PORT"
PANEL_PORT=9999
settle_panel_port
echo "free port kept: $PANEL_PORT"
