<div align="center">

![RelayClient](docs/banner.png)

[繁體中文](README.md) · **English**

Turn any SOCKS / HTTP upstream into **multiple local ports · multi-hop chains · per-app tunnels**, with a real fail-closed kill-switch.

[![CI](https://github.com/guan4tou2/relay-client/actions/workflows/ci.yml/badge.svg)](https://github.com/guan4tou2/relay-client/actions/workflows/ci.yml)
![Platform](https://img.shields.io/badge/platform-Windows%2010%20%2F%2011-0078D6)
![Electron](https://img.shields.io/badge/Electron-32-47848F)
![Engine](https://img.shields.io/badge/TUN-sing--box-4470c4)
![Tests](https://img.shields.io/badge/tests-154%20passing-2f9e78)
[![Release](https://img.shields.io/github/v/release/guan4tou2/relay-client?color=8cb0ef)](https://github.com/guan4tou2/relay-client/releases)
![License](https://img.shields.io/badge/license-MIT-blue)

</div>

---

## Why RelayClient?

Most tools pick **one** model: either they **intercept per-app traffic** (Proxifier, ProxyCap, WideCap) or they run a **rule-based tunnel** (Clash / Mihomo — YAML-driven, for the Shadowsocks/VMess/Trojan ecosystem).

**RelayClient does both**, deliberately scoped to plain **SOCKS5 / SOCKS4 / HTTP / HTTPS** upstreams — no YAML, no exotic protocols, open-source and free. You get simultaneous local relay ports *and* per-app TUN interception in one small native app.

## Features

- **Multi-port routes**: every local port binds to its own upstream or chain, running independently and concurrently. Point Chrome at `:10810`, a scraper at `:10811`, each exiting through a different proxy.
- **Multi-hop chaining**: `your app → A → B → C → target`, proxychains-style, configured per route.
- **Per-app split routing (TUN)**: force programs by name or full path through a chosen route while everything else stays direct — like Proxifier, but on a modern TUN engine ([sing-box](https://github.com/SagerNet/sing-box), gVisor stack) rather than legacy LSP hooks. Works even for apps that have no proxy setting of their own.
- **Kill-switch (fail-closed)**: if the split engine dies unexpectedly, protected apps are blocked rather than quietly falling back to your real IP.
- **Also included**: one-click system proxy, latency test, per-route traffic stats, live multi-hop view, dark / light / system theme, tray, boot auto-start, import/export, auto-update.
- **Hardened**: `contextIsolation` + `sandbox`, strict CSP, fully offline (no remote fonts/CDN), navigation locked to local pages.

## Overview

![overview](docs/overview.png)

| Dashboard (multi-route) | Per-app split |
|---|---|
| ![dashboard](docs/screenshot-dashboard.png) | ![split](docs/screenshot-split.png) |
| **Servers (upstreams)** | **Settings** |
| ![servers](docs/screenshot-servers.png) | ![settings](docs/screenshot-settings.png) |

## How it works

RelayClient is built around **two independent routing planes** that can run at the same time.

### Plane A — local relay ports

Each *route* opens a local listener (`127.0.0.1:<port>`) that speaks SOCKS5 or HTTP to your apps and forwards through the upstream (single hop or a chain). Routes are isolated — many run at once, each with its own exit.

```mermaid
flowchart LR
  B[Browser] -->|"127.0.0.1:10810"| R1["Route 1 · SOCKS5"]
  C[Scraper] -->|"127.0.0.1:10811"| R2["Route 2 · chain"]
  R1 --> U1[Upstream A]
  R2 --> H1[Hop B] --> H2[Hop C] --> T((Internet))
  U1 --> T
```

### Plane B — per-app split via TUN

For apps that can't set a proxy, the engine raises a TUN adapter and routes by process. A rule sends `chrome.exe` into a route; unmatched traffic goes direct. The app and the engine always **bypass themselves** so the relay→upstream connection can't be re-captured (loop-safe by construction).

```mermaid
flowchart LR
  A1["chrome.exe (rule → Route 1)"] --> TUN{{TUN engine}}
  A2["other apps (default)"] --> TUN
  TUN -->|matched| RP["127.0.0.1:10810 → upstream"]
  TUN -->|default direct| D[Direct]
  RP --> Net((Internet))
  D --> Net
```

### Kill-switch

If the engine crashes (vs. you stopping it), RelayClient immediately re-establishes the TUN in **block mode** — protected apps are dropped (`reject`), others keep working — and shows a red alert with **Reconnect / Disable**. It touches **no firewall rules**; it reuses the same TUN mechanism, so it adds no new footprint an endpoint monitor would flag.

## Compared to Proxifier · WideCap · Clash · ProxyCap

> ✅ yes · ➖ partial / limited · ❌ no. Written to be fair, not to win rows.

| | **RelayClient** | Proxifier | WideCap | Clash / Mihomo | ProxyCap |
|---|:---:|:---:|:---:|:---:|:---:|
| License / price | **MIT · free** | Commercial | Freeware, closed | Open-source | Commercial |
| Open source | ✅ | ❌ | ❌ | ✅ | ❌ |
| Upstream types | SOCKS5/4 · HTTP(S) | SOCKS4/5 · HTTP(S) | SOCKS · HTTP | SS · VMess · Trojan · SOCKS · HTTP … | SOCKS4/5 · HTTP(S) · SSH |
| Per-app routing | ✅ TUN | ✅ LSP/kernel | ✅ | ✅ TUN + process rule | ✅ driver |
| **Many local ports, each → own upstream/chain** | ✅ **core** | ➖ one active ruleset | ➖ | ➖ one mixed port | ➖ |
| Multi-hop chaining | ✅ per route | ✅ | ➖ | ✅ relay groups | ✅ |
| Per-app **kill-switch** (fail-closed) | ✅ | ➖ | ❌ | ➖ global TUN only | ➖ |
| Domain / GeoIP rule engine | ❌ (by app / by port) | ✅ | app only | ✅ **powerful** | ✅ |
| Config style | GUI | GUI | GUI | YAML (+ GUIs) | GUI |
| Platform | Windows 10/11 | Win · macOS | Windows | cross-platform | Win · macOS |

- **vs Proxifier / ProxyCap** — mature *commercial* per-app proxifiers with rich host/port/app rule engines. RelayClient is free & open, adds the multiple-local-ports-each-with-its-own-chain model and a per-app kill-switch, but intentionally has **no** domain/host rule engine.
- **vs Clash / Mihomo** — a powerful rule-based tunnel for the SS/VMess/Trojan world with domain & GeoIP rules, configured in YAML. RelayClient stays simple: plain SOCKS/HTTP upstreams, routing by app or by port, zero YAML.
- **vs WideCap** — an older, largely unmaintained Windows proxifier; RelayClient is a modern, open alternative with chaining and a kill-switch.

## Install

Grab the latest from **[Releases](../../releases)**:

| File | Notes |
|---|---|
| `RelayClient-Setup-x.y.z.exe` | Installer — **auto-updates** itself |
| `RelayClient-Portable-x.y.z.exe` | Single portable exe — no self-update |

> Unsigned build → Windows SmartScreen may warn on first run: **More info → Run anyway**. The split engine asks for UAC once to create the TUN adapter; everything else runs unprivileged.

## Build from source

```bash
npm install
# Provide the TUN engine binary (compiled with the with_gvisor tag) at:
#   engine/sing-box.exe        ← not included in this repo
npm test          # 154 unit tests
npm run dist      # → dist/RelayClient-Setup-*.exe + Portable
```

The split engine uses [sing-box](https://github.com/SagerNet/sing-box); place a `sing-box.exe` built with the `with_gvisor` build tag at `engine/sing-box.exe` before packaging. See **[ROUTES.md](ROUTES.md)** for the route config schema.

## Auto-update & releasing

The installer auto-updates via GitHub Releases (compares versions from `latest.yml`). To **cut a release**:

```bash
# 1) bump "version" in package.json (e.g. 1.1.1)
# 2) tag and push — GitHub Actions tests, fetches the engine, builds, and publishes the Release
git tag v1.1.1 && git push origin v1.1.1
```

`.github/workflows/release.yml` runs tests → downloads the sing-box engine → builds → publishes to Releases (with `latest.yml` for auto-update).

## Security

- `contextIsolation: true` · `nodeIntegration: false` · `sandbox: true`
- Strict **Content-Security-Policy** (`default-src 'self'`) — no remote resources; fully offline
- Navigation guards deny external window opens / navigation
- Loop-safe engine config: the app and `sing-box` always bypass themselves
- Proxy passwords stored via `electron-store` (OS user profile)

## License

MIT © guantou
