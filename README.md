# NexV Panel

A complete Xray-core management panel: a modern web UI, per-client traffic and
quota accounting, subscription links, and a `nexv` management menu on the
server. No database server and no build step — Node.js and a JSON store.

## Install

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/git-nexv/nexv-panel/main/install.sh)
```

The installer sets up Node.js 20, Xray-core, the panel itself and a systemd
service, then prints the panel URL, username and password. Supported on Ubuntu,
Debian, CentOS, Rocky and AlmaLinux.

To install a branch other than `main`:

```bash
NEXV_BRANCH=my-branch bash <(curl -fsSL https://raw.githubusercontent.com/git-nexv/nexv-panel/my-branch/install.sh)
```

## The secret web path

On first boot the panel generates a random path, for example
`http://your-server:2087/kZ8fQ2r1xVaP/`. Requests outside it get a plain 404, so
a port scan cannot tell the panel is there. If you lose the path:

```bash
nexv url
```

## Management menu

Run `nexv` on the server for the full menu:

```
  ┌──────────────────────────────────────────┐
  │  NexV Panel Management Script            │
  │   0. Exit                                │
  ├──────────────────────────────────────────┤
  │   1. Update panel                        │
  │   2. Uninstall                           │
  ├──────────────────────────────────────────┤
  │   3. Reset admin password                │
  │   4. Reset admin username                │
  │   5. Reset web base path                 │
  │   6. Change panel port                   │
  │   7. Show current settings               │
  │   8. Show panel URL                      │
  └──────────────────────────────────────────┘
```

Every entry is also a direct command:

| Command | What it does |
| --- | --- |
| `nexv status` | panel and Xray service status |
| `nexv start` / `stop` / `restart` | control the panel service |
| `nexv logs [n]` | follow the panel log |
| `nexv xray-logs [n]` | follow the Xray log |
| `nexv update` | update from the repository |
| `nexv url` | print the full panel URL |
| `nexv path <p\|random\|none>` | change the secret web path |
| `nexv port <number>` | change the panel port |
| `nexv settings` | print the current settings |
| `nexv backup [file]` / `restore <file>` | back up or restore the data file |
| `nexv cert <domain>` | issue a certificate and turn on HTTPS |
| `nexv reset-password [pw]` | reset the admin password |
| `nexv reset-username <name>` | change the admin username |
| `nexv firewall` | firewall menu: install, enable, open or close ports |
| `nexv bbr` | enable BBR congestion control |
| `nexv geo` | update geoip.dat and geosite.dat |
| `nexv doctor` | diagnose why the panel is not answering |
| `nexv xray-fix` | explain why Xray will not start, and start it |
| `nexv cert-fix` | make the certificate readable by the Xray user |
| `nexv fix [port]` | move the panel to a reachable port and verify it |
| `nexv uninstall` | remove the panel |

## Panel sections

- **Dashboard** — CPU, memory, disk, live network speed, Xray state, totals.
- **Inbounds** — a tabbed editor (Basics, Protocol, Stream, Security, Sniffing)
  covering transport options, TLS and REALITY, certificates and sniffing.
- **Clients** — accounts per inbound, with quota, expiry, QR codes and links.
- **Outbounds** — where traffic leaves: direct, blocked, or your own proxies.
- **Routing** — ordered rules that pick an outbound per domain, IP, port or user.
- **Settings** — domain, ports, secret path, TLS files, backup and restore.
- **Logs** — panel events.
- **Account** — change your own username and password.

## Protocols

**Inbounds:** VLESS, VMess, Trojan, Shadowsocks, SOCKS5, HTTP, Dokodemo-door,
WireGuard.

**Outbounds:** Freedom, Blackhole, DNS, VLESS, VMess, Trojan, Shadowsocks,
SOCKS5, HTTP, WireGuard.

**Transports:** TCP, WebSocket, gRPC, HTTPUpgrade, XHTTP, mKCP — with TLS or
REALITY where the protocol supports it.

Share links are generated for VLESS, VMess, Trojan, Shadowsocks and SOCKS5.

Fields that need a generated value - REALITY key pairs and short IDs,
Shadowsocks keys sized to the cipher, WireGuard keys, client UUIDs and
passwords - have a Generate button beside them. Nothing is filled in silently:
an empty field stays empty, and saving without one is an error that names the
field.

TLS exposes SNI, cipher suites, min and max version, uTLS fingerprint, ALPN,
curve preferences, reject-unknown-SNI, OCSP stapling, usage, one-time loading,
a master key log, and a certificate given either as file paths or pasted
inline. XHTTP exposes mode, max upload size, max buffered upload, minimum
upload interval and the server header limit. Sniffing exposes its targets plus
metadata-only and route-only. ECH, pinned peer certificates and XMUX are not
implemented.

## HTTPS

The panel serves itself over TLS as soon as it has a certificate. On a domain,
one command does everything — request the certificate, install unattended
renewal, write the paths into the settings and restart the panel:

```bash
nexv cert panel.example.com
```

Point the domain's DNS at the server first, and leave port 80 free while the
command runs. Afterwards `nexv url` prints an `https://` address.

A panel sitting on port 80 is moved to 443, because a TLS listener on port 80
is unreachable either way: plain HTTP hits a socket that only speaks TLS, and
HTTPS goes to 443 where nothing is listening. Once TLS is on, port 80 serves a
redirect to the panel, so an old `http://` bookmark keeps working.

To use a certificate you already have, set **Panel TLS certificate** and
**Panel TLS private key** under Settings and run `nexv restart`. Leaving them
empty reuses the certificate configured for Xray inbounds. If the files cannot
be read the panel logs a warning and stays on HTTP rather than refusing to
start, so a wrong path never locks you out.

## Subscriptions

Every client gets a subscription id. The subscription endpoint is served on its
own port (2096 by default) and returns the base64 list clients expect, along
with the usage and expiry headers:

```
http://your-server:2096/sub/<subId>
```

Append `?plain=1` to read the raw links instead.

## Page weight

HTML, CSS and JS are gzipped, and the script and stylesheet are served from a
pre-compressed in-memory copy under versioned URLs cached for a year. A first
load is about 25 KB over the wire; a repeat visit re-fetches only the pages.

## Traffic and limits

Usage counters are pulled from the Xray stats API every 30 seconds. A client
that runs past its quota or expiry date is disabled automatically and the Xray
config is rewritten without it.

## When the panel does not answer

```bash
nexv doctor
```

It reports the service state, the port and which process holds it, whether the
firewall allows that port, the certificate and its expiry, whether the panel
answers on its own URL, and whether port 80 redirects — and prints the last 20
log lines when it does not answer. It also warns when 3x-ui is installed
alongside, because both panels write the same Xray config and restart the same
service, so each undoes the other.

`nexv logs 50` shows more; requests slower than a second are logged there too.

## "It is running but it will not open"

Almost always the panel is healthy and its port is filtered somewhere between
the browser and the server. Mobile carriers, office networks and captive
portals routinely drop everything except 80 and 443, so a panel on 2053 or
2087 can be unreachable while the process is perfectly fine.

```bash
nexv fix [port]
```

It moves the panel, opens the port in the firewall, restarts, checks that the
panel really answers there, and prints the URL. With no port it keeps the
current one, unless the panel is sitting on 80 or 443 — those belong to your
inbounds, where an inbound on 443 is indistinguishable from ordinary HTTPS —
in which case it picks a free high port instead.

While the panel has TLS and no inbound uses port 80, it also answers on 80
with a redirect to itself, so it stays reachable on a network that filters
high ports. Configure an inbound on 80 and the panel stands aside.

## Certificates and the Xray user

Let's Encrypt keeps `/etc/letsencrypt/live` and `/etc/letsencrypt/archive`
root-only, and the official Xray unit runs the service as `nobody`. Pointing an
inbound straight at `fullchain.pem` therefore produces a config that
`xray -test` accepts as root and that the service then dies on with
`permission denied`.

```bash
nexv cert-fix
```

copies the certificate to `/usr/local/etc/xray/certs/<domain>/` owned
`root:<xray group>` with the key at mode 640, repoints the inbounds at the
copy, and installs a renewal hook that refreshes it. The panel keeps reading
the original files, since it runs as root. `nexv xray-fix` detects this case
and offers to run it.

The panel validates a new config by loading it **as the service user**, so a
certificate Xray cannot read is rejected before it is written.

## Firewall

```bash
nexv firewall
```

Installs ufw, enables it, opens or closes ports, and shows the rules. Enabling
the firewall always allows SSH and the panel ports first, so turning it on
cannot lock you out. Changing the panel port or issuing a certificate opens the
new port automatically.

## Paths

| What | Where |
| --- | --- |
| Panel code | `/opt/nexv-panel` |
| Data (admins, inbounds, clients) | `/etc/nexv/data/db.json` |
| Xray config | `/usr/local/etc/xray/config.json` |
| systemd units | `nexv` and `xray` |

## Updating

```bash
nexv update
```

This pulls the latest code, reinstalls dependencies, refreshes the `nexv`
command and restarts the service. Your data file is untouched.

## Security notes

- Enable HTTPS (`nexv cert <domain>`). Without it the session cookie travels in
  clear text and browsers mark the panel "Not Secure"; some of them also refuse
  browser storage on insecure origins.
- Sessions are signed cookies, stored server-side and pruned on expiry. Changing
  a password invalidates every other session of that admin.
- Clients cannot reach the server's own LAN: RFC1918 and loopback ranges are
  routed to the blackhole outbound by a rule the panel always writes.
- Keep backups: `nexv backup` writes a single JSON file you can restore later.

## License

MIT
