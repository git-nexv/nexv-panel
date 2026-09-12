#!/usr/bin/env bash
#
# NexV Panel installer — Xray-core management panel
#   bash <(curl -fsSL https://raw.githubusercontent.com/git-nexv/nexv-panel/main/install.sh)
#
set -euo pipefail

REPO_URL="${NEXV_REPO:-https://github.com/git-nexv/nexv-panel.git}"
BRANCH="${NEXV_BRANCH:-main}"
INSTALL_DIR="/opt/nexv-vpanel"
DATA_DIR="/etc/nexv/data"
SERVICE="nexv"

RED=$'\e[31m'; GREEN=$'\e[32m'; YELLOW=$'\e[33m'; BLUE=$'\e[36m'; BOLD=$'\e[1m'; RESET=$'\e[0m'

info()  { echo "${BLUE}[*]${RESET} $*"; }
ok()    { echo "${GREEN}[✓]${RESET} $*"; }
warn()  { echo "${YELLOW}[!]${RESET} $*"; }
fail()  { echo "${RED}[✗]${RESET} $*" >&2; exit 1; }

banner() {
  cat <<'ART'
   _  _         __   __  ___                _
  | \| |___ __ _\ \ / / | _ \__ _ _ _  ___ | |
  | .` / -_) _` |\ V /  |  _/ _` | ' \/ -_)| |
  |_|\_\___\__,_| \_/   |_| \__,_|_||_\___||_|
        Xray-core management panel
ART
}

[[ $EUID -eq 0 ]] || fail "این اسکریپت باید با کاربر root اجرا شود (sudo -i)"

detect_os() {
  [[ -f /etc/os-release ]] || fail "توزیع لینوکس شناسایی نشد"
  . /etc/os-release
  OS_ID="${ID:-unknown}"
  case "$OS_ID" in
    ubuntu|debian) PKG="apt" ;;
    centos|rhel|almalinux|rocky|fedora) PKG="dnf"; command -v dnf >/dev/null || PKG="yum" ;;
    *) fail "توزیع $OS_ID پشتیبانی نمی‌شود (Ubuntu/Debian/CentOS/Rocky/Alma)" ;;
  esac
  ok "سیستم‌عامل: ${PRETTY_NAME:-$OS_ID}"
}

install_packages() {
  info "نصب پیش‌نیازها…"
  if [[ $PKG == apt ]]; then
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq
    apt-get install -y -qq curl wget git tar unzip ca-certificates openssl cron >/dev/null
  else
    $PKG install -y -q curl wget git tar unzip ca-certificates openssl cronie >/dev/null
  fi
  ok "پیش‌نیازها نصب شد"
}

install_node() {
  if command -v node >/dev/null && [[ "$(node -p 'process.versions.node.split(".")[0]')" -ge 18 ]]; then
    ok "Node.js $(node -v) از قبل نصب است"
    return
  fi
  info "نصب Node.js 20 LTS…"
  if [[ $PKG == apt ]]; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null 2>&1
    apt-get install -y -qq nodejs >/dev/null
  else
    curl -fsSL https://rpm.nodesource.com/setup_20.x | bash - >/dev/null 2>&1
    $PKG install -y -q nodejs >/dev/null
  fi
  command -v node >/dev/null || fail "نصب Node.js ناموفق بود"
  ok "Node.js $(node -v) نصب شد"
}

install_xray() {
  if command -v xray >/dev/null; then
    ok "Xray-core از قبل نصب است ($(xray version | head -1))"
    return
  fi
  info "نصب Xray-core (اسکریپت رسمی XTLS)…"
  bash -c "$(curl -fsSL https://github.com/XTLS/Xray-install/raw/main/install-release.sh)" @ install >/dev/null 2>&1 \
    || fail "نصب Xray-core ناموفق بود"
  ok "Xray-core نصب شد ($(xray version | head -1))"
}

fetch_panel() {
  info "دریافت کد پنل…"
  if [[ -d $INSTALL_DIR/.git ]]; then
    git -C "$INSTALL_DIR" fetch --depth 1 origin "$BRANCH" -q
    git -C "$INSTALL_DIR" reset --hard "origin/$BRANCH" -q
  else
    rm -rf "$INSTALL_DIR"
    git clone --depth 1 -b "$BRANCH" "$REPO_URL" "$INSTALL_DIR" -q || fail "دریافت مخزن ناموفق بود"
  fi
  ( cd "$INSTALL_DIR" && npm install --omit=dev --no-audit --no-fund --loglevel=error ) \
    || fail "نصب وابستگی‌های npm ناموفق بود"
  mkdir -p "$DATA_DIR"
  chmod 750 /etc/nexv "$DATA_DIR"
  ok "پنل در $INSTALL_DIR نصب شد"
}

ask_config() {
  echo
  echo "${BOLD}— پیکربندی پنل —${RESET}"
  read -rp "پورت پنل [2087]: " PANEL_PORT;  PANEL_PORT="${PANEL_PORT:-2087}"
  read -rp "نام کاربری مدیر [admin]: " ADMIN_USER; ADMIN_USER="${ADMIN_USER:-admin}"
  read -rsp "رمز عبور مدیر (خالی = ساخت خودکار): " ADMIN_PASS; echo
  [[ -n $ADMIN_PASS ]] || ADMIN_PASS="$(openssl rand -base64 12 | tr -d '/+=' | cut -c1-14)"
  read -rp "دامنه پنل (اختیاری، مثال panel.example.com): " DOMAIN
  if [[ -n $DOMAIN ]]; then
    read -rp "برای دامنه گواهی رایگان Let's Encrypt گرفته شود؟ [Y/n]: " WANT_SSL
    WANT_SSL="${WANT_SSL:-Y}"
  fi
}

setup_ssl() {
  [[ -n ${DOMAIN:-} && ${WANT_SSL:-N} =~ ^[Yy]$ ]] || return 0

  info "نصب certbot و صدور گواهی برای $DOMAIN…"
  if [[ $PKG == apt ]]; then
    apt-get install -y -qq certbot >/dev/null
  else
    $PKG install -y -q certbot >/dev/null
  fi

  local resolved
  resolved="$(getent hosts "$DOMAIN" | awk '{print $1}' | head -1 || true)"
  if [[ -z $resolved ]]; then
    warn "دامنه $DOMAIN به IP سرور اشاره نمی‌کند؛ صدور گواهی رد شد."
    warn "پس از تنظیم DNS، دستور زیر را اجرا کنید: nexv cert $DOMAIN"
    return 0
  fi

  # port 80 must be free for the standalone challenge
  systemctl stop nginx 2>/dev/null || true
  if certbot certonly --standalone --non-interactive --agree-tos \
       --register-unsafely-without-email -d "$DOMAIN" >/dev/null 2>&1; then
    CERT_FILE="/etc/letsencrypt/live/$DOMAIN/fullchain.pem"
    KEY_FILE="/etc/letsencrypt/live/$DOMAIN/privkey.pem"
    ok "گواهی TLS صادر شد"
    # renewal keeps xray/panel picking up the new cert
    cat > /etc/cron.d/nexv-cert-renew <<EOF
0 3 * * * root certbot renew --quiet --deploy-hook "systemctl restart xray nexv"
EOF
  else
    warn "صدور گواهی ناموفق بود؛ می‌توانید بعداً «nexv cert $DOMAIN» را اجرا کنید."
  fi
}

seed_settings() {
  info "ثبت تنظیمات اولیه…"
  DATA_DIR="$DATA_DIR" \
  PANEL_PORT="$PANEL_PORT" DOMAIN="${DOMAIN:-}" \
  CERT_FILE="${CERT_FILE:-}" KEY_FILE="${KEY_FILE:-}" \
  node -e '
    const fs = require("fs"), path = require("path");
    const dir = process.env.DATA_DIR;
    const file = path.join(dir, "db.json");
    fs.mkdirSync(dir, { recursive: true });
    const db = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
    db.settings = Object.assign({ subPort: 2096, subPath: "/sub/" }, db.settings, {
      panelPort: Number(process.env.PANEL_PORT),
      domain: process.env.DOMAIN,
      certFile: process.env.CERT_FILE,
      keyFile: process.env.KEY_FILE
    });
    for (const key of ["users","inbounds","clients","sessions","traffic","logs"]) {
      if (!Array.isArray(db[key])) db[key] = [];
    }
    fs.writeFileSync(file, JSON.stringify(db, null, 2), { mode: 0o600 });
  '
  ok "تنظیمات ذخیره شد"
}

install_service() {
  info "ساخت سرویس systemd…"
  cat > /etc/systemd/system/${SERVICE}.service <<EOF
[Unit]
Description=NexV Panel - Xray management panel
After=network.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$INSTALL_DIR
ExecStart=$(command -v node) $INSTALL_DIR/src/server.js
Environment=NODE_ENV=production
Environment=NEXV_DATA_DIR=$DATA_DIR
Environment=NEXV_ADMIN_USER=$ADMIN_USER
Environment=NEXV_ADMIN_PASS=$ADMIN_PASS
Restart=always
RestartSec=3
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
EOF
  chmod 600 /etc/systemd/system/${SERVICE}.service

  install -m 755 "$INSTALL_DIR/scripts/nexv" /usr/local/bin/nexv
  systemctl daemon-reload
  systemctl enable --now ${SERVICE} >/dev/null 2>&1
  sleep 2
  systemctl is-active --quiet ${SERVICE} || {
    journalctl -u ${SERVICE} -n 30 --no-pager
    fail "سرویس پنل بالا نیامد"
  }
  ok "سرویس $SERVICE فعال شد"
}

open_firewall() {
  local ports=("$PANEL_PORT" 80 443 2096)
  if command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then
    for port in "${ports[@]}"; do ufw allow "$port"/tcp >/dev/null 2>&1 || true; done
    ok "پورت‌ها در ufw باز شد"
  elif command -v firewall-cmd >/dev/null && systemctl is-active --quiet firewalld; then
    for port in "${ports[@]}"; do firewall-cmd --permanent --add-port="$port"/tcp >/dev/null 2>&1 || true; done
    firewall-cmd --reload >/dev/null 2>&1 || true
    ok "پورت‌ها در firewalld باز شد"
  fi
}

summary() {
  local ip host scheme
  ip="$(curl -4 -s --max-time 4 https://api.ipify.org || hostname -I | awk '{print $1}')"
  host="${DOMAIN:-$ip}"
  scheme="http"
  [[ -n ${CERT_FILE:-} ]] && scheme="http"   # panel itself is served over http; put it behind TLS or use the domain

  # the panel generates a secret path on first boot; read it back for the summary
  local web_path=""
  web_path="$(node -e '
    try {
      const db = require("'"$DATA_DIR"'/db.json");
      process.stdout.write((db.settings && db.settings.webBasePath) || "");
    } catch (e) { process.stdout.write(""); }
  ' 2>/dev/null || true)"

  echo
  echo "${GREEN}${BOLD}══════════ نصب با موفقیت انجام شد ══════════${RESET}"
  echo "  آدرس پنل   : ${BOLD}${scheme}://${host}:${PANEL_PORT}${web_path}/${RESET}"
  echo "  نام کاربری : ${BOLD}${ADMIN_USER}${RESET}"
  echo "  رمز عبور   : ${BOLD}${ADMIN_PASS}${RESET}"
  echo "  مسیر داده  : $DATA_DIR"
  echo
  echo "${YELLOW}  بدون مسیر مخفی بالا، پنل باز نمی‌شود. با «nexv url» همیشه قابل دیدن است.${RESET}"
  echo
  echo "  مدیریت با دستور ${BOLD}nexv${RESET} :"
  echo "    nexv status | restart | logs | update | backup | url | path | cert <domain> | uninstall"
  echo "${GREEN}${BOLD}════════════════════════════════════════════${RESET}"
  echo
  warn "رمز عبور را در جای امن ذخیره کنید."
}

main() {
  banner
  detect_os
  install_packages
  install_node
  install_xray
  fetch_panel
  ask_config
  setup_ssl
  seed_settings
  install_service
  open_firewall
  summary
}

main "$@"
