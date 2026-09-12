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
| `nexv cert <domain>` | request a Let's Encrypt certificate |
| `nexv reset-password [pw]` | reset the admin password |
| `nexv reset-username <name>` | change the admin username |
| `nexv firewall` | open the panel ports in ufw or firewalld |
| `nexv bbr` | enable BBR congestion control |
| `nexv geo` | update geoip.dat and geosite.dat |
| `nexv uninstall` | remove the panel |

## Panel sections

- **Dashboard** — CPU, memory, disk, live network speed, Xray state, totals.
- **Inbounds** — one port and protocol per inbound, with transport and security.
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

## Subscriptions

Every client gets a subscription id. The subscription endpoint is served on its
own port (2096 by default) and returns the base64 list clients expect, along
with the usage and expiry headers:

```
http://your-server:2096/sub/<subId>
```

Append `?plain=1` to read the raw links instead.

## Traffic and limits

Usage counters are pulled from the Xray stats API every 30 seconds. A client
that runs past its quota or expiry date is disabled automatically and the Xray
config is rewritten without it.

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

- The panel speaks plain HTTP. Put it behind a reverse proxy with TLS, or reach
  it over the secret path only, and keep the port closed to the public where you
  can.
- Sessions are signed cookies, stored server-side and pruned on expiry. Changing
  a password invalidates every other session of that admin.
- Clients cannot reach the server's own LAN: RFC1918 and loopback ranges are
  routed to the blackhole outbound by a rule the panel always writes.
- Keep backups: `nexv backup` writes a single JSON file you can restore later.

## License

MIT
