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

# ---------------------------------------------------------------------------
# Nothing downloads without a deadline
#
# Every hang this installer has ever produced has been the same shape: a route
# that accepts the connection and then goes quiet. curl waits on that forever
# unless it is told not to, so this is the only way anything is fetched here.
#
#   $1  how long the whole transfer may take, in seconds
#
# The low-speed floor matters as much as the ceiling: a transfer that has
# crawled under 2 KB/s for three quarters of a minute is a transfer that has
# died, and waiting out the full deadline on it helps nobody.
# ---------------------------------------------------------------------------
curl_get() {
  local max="$1"; shift
  curl --fail --location --show-error --silent \
       --connect-timeout 15 --max-time "$max" \
       --speed-limit 2048 --speed-time 45 \
       --retry 2 --retry-delay 3 --retry-connrefused \
       "$@"
}

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
  for c in curl git tar openssl unzip; do
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
    curl_get 120 https://deb.nodesource.com/setup_20.x 2>/dev/null | bash - >/dev/null 2>&1 || true
    apt_do install -y -qq nodejs >/dev/null
  else
    curl_get 120 https://rpm.nodesource.com/setup_20.x 2>/dev/null | bash - >/dev/null 2>&1 || true
    $PKG install -y -q nodejs >/dev/null
  fi
  command -v node >/dev/null || fail "Node.js could not be installed. Install Node 18 or newer and run this again."
  ok "Node.js $(node -v) installed"
}

# ---------------------------------------------------------------------------
# Installing Xray-core
#
# This step used to be one line: fetch the official XTLS installer with a bare
# `curl -fsSL` and pipe it into bash, with every byte of output sent to
# /dev/null. On a good link that works. On a filtered or throttled one it does
# not fail - it waits. A blocked route does not refuse the connection, it
# accepts it and then says nothing, and curl without a deadline will sit on
# that for as long as anybody lets it. With the output discarded there was
# nothing on screen either, so half an hour of hanging and half a second of
# working looked exactly the same.
#
# So the archive is fetched here instead, where the deadlines can be set: the
# release zip carries the binary AND both geo files, which is everything the
# official script installs, and it is checked against the SHA-256 the project
# publishes beside it before anything is written to /usr/local.
# ---------------------------------------------------------------------------

XRAY_RELEASE="https://github.com/XTLS/Xray-core/releases/latest/download"

xray_asset() {
  case "$(uname -m)" in
    x86_64 | amd64)    echo "Xray-linux-64" ;;
    aarch64 | arm64)   echo "Xray-linux-arm64-v8a" ;;
    armv7l | armv7)    echo "Xray-linux-arm32-v7a" ;;
    i686 | i386)       echo "Xray-linux-32" ;;
    s390x)             echo "Xray-linux-s390x" ;;
    *)                 return 1 ;;
  esac
}

# Public GitHub front-ends, tried in order after github.com itself. They only
# ever serve the archive; see below for why the checksum never comes from one.
xray_sources() {
  echo "$XRAY_RELEASE"
  echo "https://ghproxy.net/$XRAY_RELEASE"
  echo "https://gh-proxy.com/$XRAY_RELEASE"
}

# unzip is on nearly every image, and Node is guaranteed by this point because
# install_node runs first and gives up loudly if it cannot. Either will do.
unpack_zip() {
  local zip="$1" dest="$2"
  if command -v unzip >/dev/null 2>&1; then
    unzip -o -q "$zip" -d "$dest"
    return $?
  fi
  ZIP="$zip" DEST="$dest" node -e '
    const fs = require("fs");
    const path = require("path");
    const zlib = require("zlib");
    const buf = fs.readFileSync(process.env.ZIP);
    // the end-of-central-directory record, found by scanning back from the end
    let eocd = -1;
    for (let i = buf.length - 22; i >= 0; i--) {
      if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error("not a zip file");
    const count = buf.readUInt16LE(eocd + 10);
    let off = buf.readUInt32LE(eocd + 16);
    for (let n = 0; n < count; n++) {
      const method = buf.readUInt16LE(off + 10);
      const csize = buf.readUInt32LE(off + 20);
      const nameLen = buf.readUInt16LE(off + 28);
      const extraLen = buf.readUInt16LE(off + 30);
      const commentLen = buf.readUInt16LE(off + 32);
      const local = buf.readUInt32LE(off + 42);
      const name = buf.toString("utf8", off + 46, off + 46 + nameLen);
      // the local header repeats the name and extra field at its own lengths
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      const raw = buf.subarray(start, start + csize);
      if (!name.endsWith("/")) {
        const out = path.join(process.env.DEST, name);
        fs.mkdirSync(path.dirname(out), { recursive: true });
        fs.writeFileSync(out, method === 0 ? raw : zlib.inflateRawSync(raw));
      }
      off += 46 + nameLen + extraLen + commentLen;
    }
  '
}

# The unit the official installer writes, so a panel cannot tell which of the
# two put Xray there. The panel reads this User back out of systemd and makes
# the config and any certificate readable to it.
write_xray_unit() {
  cat >/etc/systemd/system/xray.service <<'UNIT'
[Unit]
Description=Xray Service
Documentation=https://github.com/xtls
After=network.target nss-lookup.target

[Service]
User=nobody
CapabilityBoundingSet=CAP_NET_ADMIN CAP_NET_BIND_SERVICE
AmbientCapabilities=CAP_NET_ADMIN CAP_NET_BIND_SERVICE
NoNewPrivileges=true
ExecStart=/usr/local/bin/xray run -config /usr/local/etc/xray/config.json
Restart=on-failure
RestartPreventExitStatus=23
LimitNPROC=10000
LimitNOFILE=1000000

[Install]
WantedBy=multi-user.target
UNIT
  systemctl daemon-reload
  # the official installer enables it, so this must too, or Xray would come
  # back from a reboot switched off and every client would be down until
  # somebody noticed. Not started: there is no config yet, and the panel
  # starts it the moment it writes one.
  systemctl enable xray >/dev/null 2>&1 || warn "  could not enable the xray service at boot"
}

install_xray_release() {
  local asset tmp want got src shown
  asset="$(xray_asset)" || { warn "No Xray build is published for $(uname -m)"; return 1; }

  tmp="$(mktemp -d)"

  # ---- the checksum first, and never from the same place as the archive ----
  #
  # This binary is about to be run as a service, so it is not installed on a
  # mirror's word alone. The digest is three hundred bytes and github.com will
  # usually serve it even when the release CDN is throttled to nothing, which
  # is the common shape of this: the small request goes through, the twenty
  # megabyte one does not.
  #
  # If github.com is blocked outright the digest may come from a mirror, but
  # then the archive is taken from a DIFFERENT one, so two unrelated parties
  # would have to be lying in the same direction for a bad binary to land.
  local from=""
  info "  reading the published checksum..."
  for src in $(xray_sources); do
    shown="${src#*://}"; shown="${shown%%/*}"
    if curl_get 30 --retry 1 -o "$tmp/dgst" "$src/$asset.zip.dgst"; then
      want="$(awk -F'= *' '/^SHA2-256/ { print $2; exit }' "$tmp/dgst" | tr -d '[:space:]')"
      if [[ ${#want} -eq 64 ]]; then from="$src"; break; fi
    fi
    warn "  no checksum from $shown"
  done

  if [[ -z $from ]]; then
    warn "  the published checksum could not be read from anywhere"
    rm -rf "$tmp"
    return 1
  fi
  if [[ $from != "$XRAY_RELEASE" ]]; then
    warn "  the checksum came from a mirror; the archive will be taken from a different one"
  fi

  # ---- the archive, from whichever source answers ----
  got=""
  for src in $(xray_sources); do
    # never both from the same party
    if [[ $from != "$XRAY_RELEASE" && $src == "$from" ]]; then continue; fi
    shown="${src#*://}"; shown="${shown%%/*}"
    info "  downloading $asset.zip from $shown..."
    local meter=()
    if [[ -t 2 ]]; then meter=(--no-silent --progress-bar); fi
    if ! curl_get 420 ${meter[@]+"${meter[@]}"} -o "$tmp/xray.zip" "$src/$asset.zip"; then
      warn "  $shown did not send it"
      continue
    fi
    got="$(sha256sum "$tmp/xray.zip" | cut -d' ' -f1)"
    if [[ $got == "$want" ]]; then break; fi
    warn "  that copy does not match the published checksum - ignoring it"
    got=""
  done

  if [[ -z $got ]]; then
    warn "  no source produced an archive matching the checksum"
    rm -rf "$tmp"
    return 1
  fi
  ok "  archive verified against the published SHA-256"

  # ---- writing it out ----
  if ! unpack_zip "$tmp/xray.zip" "$tmp/out"; then
    warn "  the archive could not be unpacked"
    rm -rf "$tmp"
    return 1
  fi
  [[ -f $tmp/out/xray ]] || { warn "  no xray binary inside the archive"; rm -rf "$tmp"; return 1; }

  mkdir -p /usr/local/bin /usr/local/etc/xray /usr/local/share/xray
  # written beside it and renamed over: replacing a binary in place fails with
  # "Text file busy" if anything is still running it, and a rename does not
  install -m 755 "$tmp/out/xray" /usr/local/bin/xray.new
  mv -f /usr/local/bin/xray.new /usr/local/bin/xray
  # the geo files ride along in the same archive the binary came from, so they
  # are always the pair that release was built against
  local dat
  for dat in geoip.dat geosite.dat; do
    if [[ -f $tmp/out/$dat ]]; then install -m 644 "$tmp/out/$dat" "/usr/local/share/xray/$dat"; fi
  done
  rm -rf "$tmp"

  write_xray_unit
  hash -r 2>/dev/null || true
  [[ -x /usr/local/bin/xray ]]
}

install_xray() {
  # not just "a file called xray exists": an install interrupted part-way -
  # which is exactly how somebody arrives here after killing a hung one -
  # leaves a truncated binary behind, and that must not count as done
  if command -v xray >/dev/null && xray version >/dev/null 2>&1; then
    ok "Xray-core is already installed ($(xray version | head -1))"
    return
  fi
  if command -v xray >/dev/null; then
    warn "The installed xray binary does not run - replacing it"
  fi

  info "Installing Xray-core..."
  if install_xray_release; then
    ok "Xray-core installed ($(/usr/local/bin/xray version | head -1))"
    return
  fi

  # The official installer as the fallback, but on a leash this time: if it has
  # not finished in ten minutes it is not going to, and saying so beats leaving
  # somebody watching a line that will never change.
  warn "Falling back to the official XTLS installer..."
  local script
  script="$(mktemp)"
  if ! curl_get 60 -o "$script" "https://raw.githubusercontent.com/XTLS/Xray-install/main/install-release.sh"; then
    rm -f "$script"
    fail "Could not reach GitHub to install Xray-core. Check the server's connection, or install Xray yourself and run this again."
  fi
  local rc=0
  timeout 600 bash "$script" install || rc=$?
  rm -f "$script"
  if [[ $rc -eq 124 ]]; then
    fail "The official Xray installer did not finish within ten minutes - the connection to GitHub is too slow or blocked."
  elif [[ $rc -ne 0 ]]; then
    fail "Xray-core installation failed (the official installer exited $rc)"
  fi
  hash -r 2>/dev/null || true
  command -v xray >/dev/null || fail "Xray-core installation finished but no xray binary was produced"
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
  # the same leash the updater wears: git will otherwise sit on a stalled
  # transfer indefinitely, which is the hang this installer is named for
  local git_guards=(-c http.lowSpeedLimit=1000 -c http.lowSpeedTime=60)
  local rc
  if [[ -d $INSTALL_DIR/.git ]]; then
    git -C "$INSTALL_DIR" remote set-url origin "$REPO_URL"
    rc=0
    timeout 600 git "${git_guards[@]}" -C "$INSTALL_DIR" fetch --depth 1 origin "$BRANCH" -q || rc=$?
    if [[ $rc -eq 124 ]]; then fail "The repository did not answer within ten minutes."; fi
    if [[ $rc -ne 0 ]]; then fail "Could not fetch $BRANCH from the repository (git exited $rc)"; fi
    git -C "$INSTALL_DIR" reset --hard "origin/$BRANCH" -q
  else
    rm -rf "$INSTALL_DIR"
    rc=0
    timeout 600 git "${git_guards[@]}" clone --depth 1 -b "$BRANCH" "$REPO_URL" "$INSTALL_DIR" -q || rc=$?
    if [[ $rc -eq 124 ]]; then fail "The repository did not answer within ten minutes."; fi
    if [[ $rc -ne 0 ]]; then fail "Could not clone the repository (git exited $rc)"; fi
  fi
  info "Installing dependencies..."
  rc=0
  ( cd "$INSTALL_DIR" && timeout 900 npm install --omit=dev --no-audit --no-fund \
      --no-progress --fetch-timeout=120000 --fetch-retries=2 --loglevel=error ) || rc=$?
  if [[ $rc -eq 124 ]]; then fail "npm gave up after fifteen minutes - the registry is not answering."; fi
  if [[ $rc -ne 0 ]]; then fail "npm dependencies failed to install (npm exited $rc)"; fi
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
# Belt and braces for a stop that hangs: the default is ninety seconds, and a
# minute and a half of nothing happening is indistinguishable from a freeze.
TimeoutStopSec=15

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
