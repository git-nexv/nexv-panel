#!/usr/bin/env bash
#
# NexV Panel installer — Xray-core management panel
#   bash <(curl -fsSL https://raw.githubusercontent.com/git-nexv/nexv-panel/main/install.sh)
#
set -euo pipefail

REPO_URL="${NEXV_REPO:-https://github.com/git-nexv/nexv-panel.git}"
BRANCH="${NEXV_BRANCH:-main}"
INSTALL_DIR="/opt/nexv-panel"
LEGACY_DIR="/opt/nexv-vpanel"
DATA_DIR="/etc/nexv/data"
SERVICE="nexv"

RED=$'\e[31m'; GREEN=$'\e[32m'; YELLOW=$'\e[33m'; BLUE=$'\e[36m'; BOLD=$'\e[1m'; RESET=$'\e[0m'

info()  { echo "${BLUE}[*]${RESET} $*"; }
ok()    { echo "${GREEN}[+]${RESET} $*"; }
warn()  { echo "${YELLOW}[!]${RESET} $*"; }
fail()  { echo "${RED}[x]${RESET} $*" >&2; exit 1; }

banner() {
  cat <<'ART'
   _  _         __   __  ___                _
  | \| |___ __ _\ \ / / | _ \__ _ _ _  ___ | |
  | .` / -_) _` |\ V /  |  _/ _` | ' \/ -_)| |
  |_|\_\___\__,_| \_/   |_| \__,_|_||_\___||_|
        Xray-core management panel
ART
}

[[ $EUID -eq 0 ]] || fail "This script must run as root (use: sudo -i)"

# An install with nobody watching - `curl | bash`, cloud-init, a CI runner -
# must never stop on a question it cannot ask.
if [[ "${NEXV_NONINTERACTIVE:-0}" == "1" || ! -t 0 ]]; then INTERACTIVE=0; else INTERACTIVE=1; fi

detect_os() {
  [[ -f /etc/os-release ]] || fail "Could not identify the Linux distribution"
  . /etc/os-release
  OS_ID="${ID:-unknown}"
  case "$OS_ID" in
    ubuntu|debian) PKG="apt" ;;
    centos|rhel|almalinux|rocky|fedora) PKG="dnf"; command -v dnf >/dev/null || PKG="yum" ;;
    *) fail "$OS_ID is not supported (need Ubuntu, Debian, CentOS, Rocky or Alma)" ;;
  esac
  ok "Operating system: ${PRETTY_NAME:-$OS_ID}"
}

# A fresh cloud server runs cloud-init and unattended-upgrades on first boot,
# and they hold the dpkg lock for a minute or two. Waiting is the whole fix:
# failing here used to leave a half-installed machine and an apt error nobody
# outside Debian recognises.
APT_OPTS=(-o DPkg::Lock::Timeout=300 -o Dpkg::Use-Pty=0)

apt_busy() {
  # no extra packages: the lock holder is whoever has the file open
  if command -v fuser >/dev/null 2>&1; then
    fuser /var/lib/dpkg/lock-frontend /var/lib/dpkg/lock /var/lib/apt/lists/lock >/dev/null 2>&1
    return $?
  fi
  command -v lsof >/dev/null 2>&1 && lsof /var/lib/dpkg/lock-frontend >/dev/null 2>&1
}

wait_for_apt() {
  local waited=0
  while apt_busy; do
    if [[ $waited -eq 0 ]]; then
      info "Another package manager is running (a fresh server updates itself on first boot)."
      info "Waiting for it to finish - this usually takes a minute..."
    fi
    sleep 5
    waited=$((waited + 5))
    if [[ $waited -ge 300 ]]; then
      warn "apt is still busy after five minutes; trying anyway"
      return 0
    fi
  done
  [[ $waited -gt 0 ]] && ok "apt is free again (waited ${waited}s)"
  return 0
}

# apt, but patient: it waits for the lock and gives the reason when it cannot
apt_do() {
  local tries=0
  wait_for_apt
  until apt-get "${APT_OPTS[@]}" "$@"; do
    tries=$((tries + 1))
    if [[ $tries -ge 4 ]]; then
      fail "apt could not run: $*
    Something else is holding the package manager. Check it with:
      ps aux | grep -E 'apt|dpkg|unattended' | grep -v grep
    then run the installer again."
    fi
    warn "apt did not go through, retrying in 15s (${tries}/4)..."
    sleep 15
    wait_for_apt
  done
}

# Nearly every cloud image already has these. Working out what is genuinely
# missing means a normal install never calls the package manager at all, which
# is the surest way not to trip over its lock.
missing_tools() {
  local want=() c
  for c in curl git tar openssl; do
    command -v "$c" >/dev/null 2>&1 || want+=("$c")
  done
  # the CA bundle answers to no command of its own
  [[ -s /etc/ssl/certs/ca-certificates.crt || -d /etc/pki/tls/certs ]] || want+=(ca-certificates)
  printf '%s\n' ${want[@]+"${want[@]}"}
}

install_packages() {
  local missing=()
  while IFS= read -r line; do [[ -n $line ]] && missing+=("$line"); done < <(missing_tools)

  if [[ ${#missing[@]} -eq 0 ]]; then
    ok "Prerequisites are already present - nothing to install"
    return 0
  fi

  info "Installing prerequisites: ${missing[*]}"
  if [[ $PKG == apt ]]; then
    export DEBIAN_FRONTEND=noninteractive
    apt_do update -qq
    apt_do install -y -qq "${missing[@]}" >/dev/null
  else
    $PKG install -y -q "${missing[@]}" >/dev/null
  fi
  ok "Prerequisites installed"
}

node_arch() {
  case "$(uname -m)" in
    x86_64 | amd64)      echo x64 ;;
    aarch64 | arm64)     echo arm64 ;;
    armv7l)              echo armv7l ;;
    ppc64le)             echo ppc64le ;;
    s390x)               echo s390x ;;
    *)                   return 1 ;;
  esac
}

# The official build, straight from nodejs.org: curl and tar are all it needs,
# so no repository has to be added and no package lock has to be waited on.
# The checksum comes from the same file that names the tarball.
install_node_tarball() {
  local arch base sums file want tmp
  arch="$(node_arch)" || return 1
  base="https://nodejs.org/dist/latest-v20.x"

  sums="$(curl -fsSL --max-time 30 "$base/SHASUMS256.txt" 2>/dev/null)" || return 1
  file="$(awk -v suffix="linux-$arch.tar.gz" '$2 ~ suffix"$" { print $2; exit }' <<<"$sums")"
  [[ -n $file ]] || return 1
  want="$(awk -v f="$file" '$2 == f { print $1 }' <<<"$sums")"
  [[ -n $want ]] || return 1

  tmp="$(mktemp -d)"
  curl -fsSL --max-time 600 -o "$tmp/$file" "$base/$file" || { rm -rf "$tmp"; return 1; }
  if command -v sha256sum >/dev/null 2>&1; then
    echo "$want  $tmp/$file" | sha256sum -c --status || { rm -rf "$tmp"; return 1; }
  fi

  rm -rf /usr/local/lib/nodejs
  mkdir -p /usr/local/lib/nodejs
  tar -xzf "$tmp/$file" -C /usr/local/lib/nodejs --strip-components=1 || { rm -rf "$tmp"; return 1; }
  rm -rf "$tmp"

  local binary
  for binary in node npm npx; do
    [[ -e /usr/local/lib/nodejs/bin/$binary ]] && ln -sf "/usr/local/lib/nodejs/bin/$binary" "/usr/local/bin/$binary"
  done
  command -v node >/dev/null 2>&1
}

install_node() {
  if command -v node >/dev/null && [[ "$(node -p 'process.versions.node.split(".")[0]')" -ge 18 ]]; then
    ok "Node.js $(node -v) is already installed"
    return
  fi
  info "Installing Node.js 20 LTS..."

  if install_node_tarball; then
    ok "Node.js $(node -v) installed from nodejs.org"
    return
  fi

  warn "Could not fetch the official build; falling back to the package manager"
  if [[ $PKG == apt ]]; then
    wait_for_apt
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null 2>&1 || true
    apt_do install -y -qq nodejs >/dev/null
  else
    curl -fsSL https://rpm.nodesource.com/setup_20.x | bash - >/dev/null 2>&1 || true
    $PKG install -y -q nodejs >/dev/null
  fi
  command -v node >/dev/null || fail "Node.js could not be installed. Install Node 18 or newer and run this again."
  ok "Node.js $(node -v) installed"
}

install_xray() {
  if command -v xray >/dev/null; then
    ok "Xray-core is already installed ($(xray version | head -1))"
    return
  fi
  info "Installing Xray-core (official XTLS installer)..."
  bash -c "$(curl -fsSL https://github.com/XTLS/Xray-install/raw/main/install-release.sh)" @ install >/dev/null 2>&1 \
    || fail "Xray-core installation failed"
  ok "Xray-core installed ($(xray version | head -1))"
}

# Installs before v2 lived in /opt/nexv-vpanel. Move the checkout so an update
# does not leave two copies of the panel behind; the data directory never moved.
migrate_legacy_dir() {
  [[ -d $LEGACY_DIR && ! -d $INSTALL_DIR ]] || return 0
  info "Moving the panel from $LEGACY_DIR to $INSTALL_DIR..."
  systemctl stop "$SERVICE" 2>/dev/null || true
  mv "$LEGACY_DIR" "$INSTALL_DIR"
  ok "Existing installation moved"
}

fetch_panel() {
  info "Downloading the panel..."
  if [[ -d $INSTALL_DIR/.git ]]; then
    git -C "$INSTALL_DIR" remote set-url origin "$REPO_URL"
    git -C "$INSTALL_DIR" fetch --depth 1 origin "$BRANCH" -q || fail "Could not fetch $BRANCH from the repository"
    git -C "$INSTALL_DIR" reset --hard "origin/$BRANCH" -q
  else
    rm -rf "$INSTALL_DIR"
    git clone --depth 1 -b "$BRANCH" "$REPO_URL" "$INSTALL_DIR" -q || fail "Could not clone the repository"
  fi
  ( cd "$INSTALL_DIR" && npm install --omit=dev --no-audit --no-fund --loglevel=error ) \
    || fail "npm dependencies failed to install"
  mkdir -p "$DATA_DIR"
  chmod 750 /etc/nexv "$DATA_DIR"
  ok "Panel installed in $INSTALL_DIR"
}

ask_config() {
  PANEL_PORT="${NEXV_PORT:-}"
  ADMIN_USER="${NEXV_USER:-}"
  ADMIN_PASS="${NEXV_PASS:-}"
  DOMAIN="${NEXV_DOMAIN:-}"
  WANT_SSL="${NEXV_SSL:-}"

  # Piped into bash, or run by cloud-init, there is nobody to answer: every
  # question falls back to its environment variable or its default instead of
  # reading EOF from the pipe and pretending that was an answer.
  if [[ $INTERACTIVE -eq 1 ]]; then
    echo
    echo "${BOLD}-- Panel configuration --${RESET}"
    [[ -n $PANEL_PORT ]] || { read -rp "Panel port [2087]: " PANEL_PORT; }
    [[ -n $ADMIN_USER ]] || { read -rp "Admin username [admin]: " ADMIN_USER; }
    [[ -n $ADMIN_PASS ]] || { read -rsp "Admin password (empty = generate one): " ADMIN_PASS; echo; }
    [[ -n $DOMAIN ]] || { read -rp "Panel domain (optional, e.g. panel.example.com): " DOMAIN; }
    if [[ -n $DOMAIN && -z $WANT_SSL ]]; then
      read -rp "Request a free Let's Encrypt certificate for it? [Y/n]: " WANT_SSL
    fi
  else
    info "No terminal to ask on - using defaults (set NEXV_PORT, NEXV_USER, NEXV_PASS, NEXV_DOMAIN to choose)"
  fi

  PANEL_PORT="${PANEL_PORT:-2087}"
  ADMIN_USER="${ADMIN_USER:-admin}"
  [[ -n $ADMIN_PASS ]] || ADMIN_PASS="$(openssl rand -base64 12 | tr -d '/+=' | cut -c1-14)"
  [[ -z $DOMAIN ]] || WANT_SSL="${WANT_SSL:-Y}"
}

setup_ssl() {
  [[ -n ${DOMAIN:-} && ${WANT_SSL:-N} =~ ^[Yy]$ ]] || return 0

  info "Installing certbot and requesting a certificate for $DOMAIN..."
  # cron only matters here, for the renewal job, so it is not everyone's problem
  if [[ $PKG == apt ]]; then
    apt_do install -y -qq certbot cron >/dev/null
  else
    $PKG install -y -q certbot cronie >/dev/null
  fi

  local resolved
  resolved="$(getent hosts "$DOMAIN" | awk '{print $1}' | head -1 || true)"
  if [[ -z $resolved ]]; then
    warn "$DOMAIN does not resolve to this server yet; skipping the certificate."
    warn "Point the DNS record here, then run: nexv cert $DOMAIN"
    return 0
  fi

  # port 80 must be free for the standalone challenge
  systemctl stop nginx 2>/dev/null || true
  if certbot certonly --standalone --non-interactive --agree-tos \
       --register-unsafely-without-email -d "$DOMAIN" >/dev/null 2>&1; then
    CERT_FILE="/etc/letsencrypt/live/$DOMAIN/fullchain.pem"
    KEY_FILE="/etc/letsencrypt/live/$DOMAIN/privkey.pem"
    ok "TLS certificate issued"
    # renewal keeps xray/panel picking up the new cert
    cat > /etc/cron.d/nexv-cert-renew <<EOF
0 3 * * * root certbot renew --quiet --deploy-hook "systemctl restart xray nexv"
EOF
  else
    warn "The certificate could not be issued; you can retry later with: nexv cert $DOMAIN"
  fi
}

seed_settings() {
  info "Writing initial settings..."
  DATA_DIR="$DATA_DIR" \
  PANEL_PORT="$PANEL_PORT" DOMAIN="${DOMAIN:-}" \
  CERT_FILE="${CERT_FILE:-}" KEY_FILE="${KEY_FILE:-}" \
  node -e '
    const fs = require("fs"), path = require("path");
    const dir = process.env.DATA_DIR;
    const file = path.join(dir, "db.json");
    fs.mkdirSync(dir, { recursive: true });
    const db = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
    db.settings = Object.assign({ subPort: 2096, subPath: "/sub/", lang: "en" }, db.settings, {
      panelPort: Number(process.env.PANEL_PORT),
      domain: process.env.DOMAIN,
      certFile: process.env.CERT_FILE,
      keyFile: process.env.KEY_FILE,
      // the panel serves itself over HTTPS with the same certificate
      panelCertFile: process.env.CERT_FILE,
      panelKeyFile: process.env.KEY_FILE
    });
    for (const key of ["users","inbounds","clients","outbounds","routing","sessions","traffic","logs"]) {
      if (!Array.isArray(db[key])) db[key] = [];
    }
    fs.writeFileSync(file, JSON.stringify(db, null, 2), { mode: 0o600 });
  '
  ok "Settings saved"
}

install_service() {
  info "Creating the systemd service..."
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
    fail "The panel service did not start"
  }
  ok "Service $SERVICE is running"
}

open_firewall() {
  local ports=("$PANEL_PORT" 80 443 2096)
  if command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then
    for port in "${ports[@]}"; do ufw allow "$port"/tcp >/dev/null 2>&1 || true; done
    ok "Ports opened in ufw"
  elif command -v firewall-cmd >/dev/null && systemctl is-active --quiet firewalld; then
    for port in "${ports[@]}"; do firewall-cmd --permanent --add-port="$port"/tcp >/dev/null 2>&1 || true; done
    firewall-cmd --reload >/dev/null 2>&1 || true
    ok "Ports opened in firewalld"
  fi
}

summary() {
  local ip host scheme
  ip="$(curl -4 -s --max-time 4 https://api.ipify.org || hostname -I | awk '{print $1}')"
  host="${DOMAIN:-$ip}"
  scheme="http"
  [[ -n ${CERT_FILE:-} ]] && scheme="https"

  # the panel generates a secret path on first boot; read it back for the summary
  local web_path=""
  web_path="$(node -e '
    try {
      const db = require("'"$DATA_DIR"'/db.json");
      process.stdout.write((db.settings && db.settings.webBasePath) || "");
    } catch (e) { process.stdout.write(""); }
  ' 2>/dev/null || true)"

  echo
  echo "${GREEN}${BOLD}=============== Installation complete ===============${RESET}"
  echo "  Panel URL : ${BOLD}${scheme}://${host}:${PANEL_PORT}${web_path}/${RESET}"
  echo "  Username  : ${BOLD}${ADMIN_USER}${RESET}"
  echo "  Password  : ${BOLD}${ADMIN_PASS}${RESET}"
  echo "  Data dir  : $DATA_DIR"
  echo
  echo "${YELLOW}  The panel only answers on the secret path above."
  echo "  Run 'nexv url' any time to print it again.${RESET}"
  [[ $scheme == http ]] && echo "${YELLOW}  Served over plain HTTP. Enable HTTPS with: nexv cert <domain>${RESET}"
  echo
  echo "  Type ${BOLD}nexv${RESET} for the management menu."
  echo "${GREEN}${BOLD}=====================================================${RESET}"
  echo
  warn "Store the password somewhere safe."
}

main() {
  banner
  detect_os
  install_packages
  install_node
  install_xray
  migrate_legacy_dir
  fetch_panel
  ask_config
  setup_ssl
  seed_settings
  install_service
  open_firewall
  summary
}

main "$@"
