# YuruPager

YuruPager is a runnable Alpha for supervising local Codex sessions from a
desktop console, installable mobile PWA, or native SwiftUI iPhone app. A macOS Connector keeps source code,
tool output, and the durable Codex conversation on the workstation. Authorized
browsers and the native iOS client can view user/assistant text and explicitly
returned images through an ephemeral WebSocket relay; the server does not
persist those conversation frames or image bytes.

## Alpha capabilities

- Local Alpha authentication with HttpOnly sessions and multi-workspace scope.
- PostgreSQL shared schema with `workspace_id`, composite foreign keys, RLS,
  explicit workstation grants, and a separate Connector database role.
- REST snapshots plus user and Connector WebSockets.
- Ten-minute, single-use workstation pairing with explicit Web confirmation,
  per-workstation credentials, and dynamic WSS routing.
- Atomic, idempotent approval decisions with collaborator conflict handling.
- SQLite Connector Outbox/Inbox, ACK replay, heartbeat, reconnect, and durable
  `sent_unknown` handling that never automatically resends to Codex.
- Global, paginated Codex `thread/list` discovery across the workstation. The
  official bounded `thread.name` is relayed only through authorized live
  memory; preview, rollout, Git, environment, source, Diff, terminal output,
  and conversation fields are discarded locally and never persisted.
- Temporary Codex conversation viewing rebuilt from local `thread/read` after
  each browser or Connector reconnect, with live message deltas and sanitized
  tool-activity status rows; history is unavailable while the workstation is
  offline. Raw commands, arguments, output, Diff, paths, and hidden reasoning
  remain on the workstation.
- Assistant messages are rendered as safe CommonMark/GFM (headings, lists,
  emphasis, links, quotes, code blocks, and tables) in Web/PWA and iOS. Raw
  HTML, unsafe link schemes, and remote Markdown images are inert; validated
  image frames continue through the separate image channel.
- End-to-end session images for Web/PWA and iOS: select or paste up to four
  PNG/JPEG/WebP images, preview and remove them locally, then upload only after
  an explicit send. Codex image inputs and structured returned images use
  authenticated 48 KiB WSS chunks with size, signature, sequence, and SHA-256
  validation. Image bytes never enter PostgreSQL, reliable queues, audit logs,
  Service Worker caches, browser storage, or iOS `UserDefaults`.
- Versioned estimated Token pricing over de-duplicated cumulative snapshots.
- Responsive desktop console and focused mobile PWA with an offline shell.
- Native iOS client with workspace switching, consequential decision sheets,
  ephemeral Codex conversation viewing, active messages, usage, members, and audit.

The Alpha does not provide a remote terminal, code editor, Diff, Git/PR flow,
billing, or a native Android client. APNs background push and App Store
distribution remain separate signed deployment work.

## Requirements

- Node.js 22 or newer
- Docker with Compose
- macOS or Linux and a signed-in `codex` CLI for the Connector

## Repository guide

YuruPager is an npm workspaces monorepo. The root package is itself the
Connector daemon; the workspaces hold the server, the web console, and shared
code.

```text
.
├── src/                  # Connector daemon (the root package, published as `yurupager`)
│   ├── connector/        # CLI entry, runtime, setup, version gate
│   ├── codex/            # Codex app-server protocol adapter (JSON-RPC, conversation, images)
│   ├── preview/          # Local development preview CLI and loopback tunnel
│   ├── reliability/      # SQLite journals/ledger, decision gate, token accumulator
│   ├── transport/        # Connector cloud transport (WSS client, message store)
│   └── spike/            # Re-runnable live-verification scripts (kept as evidence)
├── apps/
│   ├── server/           # Fastify 5 REST/WSS API, PostgreSQL (RLS) with versioned SQL migrations in db/migrations/
│   ├── web/              # React 19 + Vite 7 desktop console / mobile PWA, Playwright e2e
│   └── ios/              # SwiftUI client (Xcode project) + YuruPagerCore Swift package
├── packages/shared/      # Shared protocol types (@yurupager/shared)
├── test/                 # Connector tests (node --test, run against dist/)
├── scripts/              # Connector packaging and verification scripts
├── deploy/nginx/         # Reverse-proxy configuration examples
├── docs/                 # Product requirements, ADRs, interaction contract, reports
└── vendor/marked/        # Vendored dependency referenced via file: protocol
```

Common commands (run from the repository root unless noted):

```bash
npm install              # install all workspaces
npm run db:up            # start the local PostgreSQL container
npm run dev              # run API server and Vite web console together
npm run lint             # lint all workspaces
npm run typecheck        # build + typecheck all workspaces
npm run test:all         # connector + server + web test suites
npm run build:all        # build shared, connector, server, and web
npm run e2e              # Playwright end-to-end tests (apps/web)
npm run connector:start  # run the Connector against the local Codex app-server
npm run connector:preview  # expose a local dev port through the Connector
cd apps/ios && swift run yurupager-core-checks  # iOS core sanity checks (macOS)
```

Connector spike commands (`npm run spike:*`) remain available; see
[Technical spike commands](#technical-spike-commands). Reference documents live
under [Documents](#documents).

## Connect another Codex workstation

1. Sign in to YuruPager and open **Workstations**.
2. Choose **Add**, select the owning workspace, and generate a pairing command.
3. Run the copied command once on the machine where Codex is installed.
4. Compare the device fingerprint in the terminal and Web, then choose
   **Confirm connection** in YuruPager.

The command downloads the Connector package from the same YuruPager origin,
verifies its SHA-256 checksum, generates a local Ed25519 identity, and waits for
explicit Web approval. After approval it stores the independent device
credential under `~/.yurupager` with mode `0600` and installs a macOS
LaunchAgent or Linux user-level systemd service. The server stores only hashes
of pairing codes and device credentials. No long-lived credential appears in
the Web command or terminal output.

The target machine only needs outbound HTTPS/WSS access to the public
YuruPager URL. It does not need a public IP, inbound port, VPN, or LAN access.

## Manage workspaces and access

The desktop **Members** view is the management surface for the current
workspace. Owners and admins can create a one-time invite for a `member` or
`admin`, copy the token to the collaborator through a private channel, and
have the collaborator join it while signed in. A role change is submitted by
the member-row selector; removing a member requires a second explicit
confirmation. The server applies each change atomically and records the real
operator in the audit history. Ordinary members can inspect the table but do
not see management submissions.

In **Workstations**, owners and admins can expand **Edit access** and toggle
view, respond, high-risk approval, management, and preview permissions for an
individual member. **Revoke workstation** is a separate destructive action:
it requires confirmation, immediately closes the Connector credential, and
does not revoke unrelated workstations. A revoked member's next snapshot and
live connection lose access; no browser-side optimistic success is shown.

The currently selected workspace remains visible in the top bar and every
management row. Creating a workspace is available from the workspace action
menu; the creator becomes its owner. Joining an invite is also available from
that menu and requires the full token before the server changes membership.

Deployment does not require an UCloud account. An existing SSH account with
permission to manage the YuruPager release directory, its environment file,
database connection, and Supervisor service is sufficient. UCloud access is
only needed for cloud-resource operations such as security-group changes,
public-IP changes, instance restart/snapshot, or billing. If a required port
is blocked at the cloud firewall, the instance owner or UCloud administrator
must open it; YuruPager itself does not need that login.

## Share a local development preview

The paired Connector can temporarily expose one loopback HTTP development
port through YuruPager. This is intended for checking a Vite, Next.js, or
similar local Web app from another authorized desktop or phone without putting
the workstation itself on the public Internet.

Prerequisites:

- Install Node.js 22 or newer and complete the workstation pairing flow above.
- Make sure `~/.local/bin` is on `PATH`; the Connector installer places the
  `yurupager` command there. Run `~/.local/bin/yurupager --help` directly if it
  is not yet on `PATH`.
- Start the local development server on loopback. For example, configure Vite
  to listen on `127.0.0.1:5173`; do not bind it publicly for YuruPager.

Open the port from a foreground terminal on the workstation:

```bash
yurupager preview 5173 --name "Vite" --duration 60
```

The command uses the paired workstation configuration at `~/.yurupager/config.json`.
If this machine has more than one Connector profile, point the command at the
actual dynamic pairing file used by the background Connector, for example:

```bash
YURUPAGER_CONFIG_FILE="$HOME/.yurupager/config.json" \
  yurupager preview 5173 --name "Vite" --duration 60
```

Do not pass the server's static Alpha token to `preview`; preview accepts only
the dynamic credential created by pairing.

The port must be an integer from `1024` through `65535`. `--name` is the
bounded label shown in the workstation detail, and `--duration` is 15 through
240 minutes with a 60-minute default. Keep the command running, then open the
paired workstation in YuruPager and choose its active preview. Stop it with
`Ctrl+C`, the Web stop action, or by allowing it to expire. Each command owns
one route and one independent preview WSS; up to eight active routes may be
registered for one workstation.

The command reads only the dynamic credential created by pairing. The legacy
`YURUPAGER_CONNECTOR_TOKEN` Alpha fallback is deliberately not accepted for
preview. The Connector pins the destination to `127.0.0.1` or `::1` and the
numeric port, generates the local HTTP `Host` and `Origin`, strips authority,
forwarding, proxy-authentication, and Service Worker headers, and rejects
`CONNECT`, absolute-form URLs, CRLF headers, oversized or out-of-order chunks,
and more than 32 concurrent Connector streams. The preview gateway also
rejects Service Worker registration. WebSocket upgrades keep the generated
loopback `Host` but omit `Origin`, because Vite rejects a synthesized loopback
Origin while the browser's public Origin must never reach the workstation.
Preview supports HTTP and WebSocket
development traffic only, not local HTTPS, raw TCP, SSH, Unix sockets, port
scanning, or LAN forwarding.

Preview request URLs, headers, bodies, responses, and WebSocket frames remain
in memory and do not enter Connector SQLite, PostgreSQL, audit text, or the
reliable Outbox/Inbox. The preview WSS is separate from approvals and Codex
messages. A disconnect closes in-flight streams; it may re-advertise the same
route after reconnect, but it never replays a request. Treat an exposed local
development server as sensitive: anyone granted `can_preview` for that
workstation may exercise the local app for the lifetime of the route.

For access from outside the LAN, the workstation still needs only outbound
HTTPS/WSS. The public YuruPager deployment must enable its preview gateway and
publish a separate HTTPS origin, for example:

```text
PREVIEW_ENABLED=true
PREVIEW_GATEWAY_HOST=0.0.0.0
PREVIEW_GATEWAY_PORT=4301
PREVIEW_PUBLIC_ORIGIN=https://preview.example.com
PREVIEW_MAX_DURATION_MINUTES=240
```

Route `preview.example.com` through the reverse proxy to the preview gateway
port with WebSocket upgrades and a valid TLS certificate. It must not share
the main YuruPager origin or its cookies. The main Web console authenticates
the user, checks the workstation's `can_preview` grant, and issues a short,
single-use launch ticket for that isolated origin; no public bearer URL or
workstation inbound port is created.

On a production deployment, the isolated origin is the configured preview
origin, for example `https://<preview-origin>:<port>/` (see
[Deployment configuration](#deployment-configuration)). A protocol-aware
Nginx listener can share an already published port: plaintext traffic
continues to an existing service, while TLS traffic is routed to the YuruPager
preview gateway. The workstation still needs only outbound HTTPS/WSS; it does
not need a public IP, an inbound firewall rule, or a port-forwarding command.
Maintaining the server-side listener does not require access to the cloud
console; only the server owner can change cloud security-group rules, public
IPs, reboots, snapshots, or billing settings.

1. On the machine running the Web app, start it on loopback and run
   `yurupager preview <port>`.
2. Sign in at your YuruPager origin, open the paired workstation, and select
   **开发预览 -> 打开**.
3. The browser redeems a one-time ticket and opens the app at the isolated
   preview origin. Do not copy or share a URL containing a ticket.

For example, a Vite app on port `5173` is opened with:

```bash
yurupager preview 5173 --name "本地 Web" --duration 60
```

Keep that terminal running while the preview is needed. `Ctrl+C`, the Web
**停止** action, or expiry closes the route; a disconnected HTTP request is
never replayed automatically.

## Local development

Install dependencies and start PostgreSQL:

```bash
npm install
npm run db:up
```

Start the API and Vite console:

```bash
npm run dev
```

Open <http://127.0.0.1:4173> and sign in with either Alpha account:

```text
alice@yurupager.local / alpha-demo
bob@yurupager.local   / alpha-demo
```

这里的 `alpha-demo` 仅用于本地 Alpha 数据库的默认种子账号。公网部署的密码由部署环境中的 `ALPHA_PASSWORD` 配置，不写入仓库或安装包。

The preferred setup path is the **Add workstation** flow above. The following
environment-based launch remains only for migrating the original Alpha
workstation. `YURUPAGER_PROJECT_PATH` and `YURUPAGER_PROJECT_NAME` are fallback
metadata for older app-server responses; they do not limit project discovery:

```bash
YURUPAGER_CONNECTOR_TOKEN=alpha-connector-token \
YURUPAGER_PROJECT_NAME=YuruPager \
YURUPAGER_PROJECT_PATH=/absolute/path/to/YuruPager \
YURUPAGER_INITIATOR_EMAIL=alice@yurupager.local \
npm run connector:start
```

Connector SQLite data defaults to `~/.yurupager`; set
`YURUPAGER_DATA_DIR` to use an isolated directory. The local WebSocket URL
defaults to `ws://127.0.0.1:4300/connector/v1/ws` and production deployments
must use WSS.

Build the server-hosted Connector archive independently with:

```bash
npm run build
npm run build:connector-package
```

## Deployment configuration

No real deployment hosts, IP addresses, or credentials are committed to this
repository. Everything environment-specific is injected per deployment from
the following places, and the documentation uses `<deployment-origin>` /
`<preview-origin>` style placeholders:

- Service secrets and database URLs: `SESSION_SECRET`, `CONNECTOR_TOKEN`,
  `ALPHA_PASSWORD`, `ADMIN_DATABASE_URL`, `DATABASE_URL`,
  `CONNECTOR_DATABASE_URL`, and the rest of the template in
  [.env.example](./.env.example). Keep the real `.env` out of the repository
  and rotate leaked values immediately.
- Preview origin: `PREVIEW_PUBLIC_ORIGIN` together with `PREVIEW_ENABLED` and
  `PREVIEW_GATEWAY_*` (see [.env.example](./.env.example)).
- Reverse proxy: `deploy/nginx/*.conf` are examples; set `server_name`,
  certificate paths, and published ports per environment.
- iOS default server address: the `YURUPAGER_DEFAULT_SERVER_ADDRESS` build
  setting expands into the app's Info.plist; see
  [the iOS runbook](./apps/ios/README.md).

## Single-service Alpha deployment

The production server serves the built Web/PWA and API from one origin. Set a
real session secret and Connector token before starting the Compose profile:

```bash
SESSION_SECRET="$(openssl rand -hex 32)" \
CONNECTOR_TOKEN="$(openssl rand -hex 32)" \
docker compose --profile alpha up --build
```

Then open <http://127.0.0.1:4300>. This local profile uses seeded Alpha users;
external deployment still requires TLS, OIDC wiring, secret management,
backups, and PostgreSQL migration orchestration.

The current server deployment uses Supervisor and an external PostgreSQL
instance rather than Docker. It keeps releases under
`/srv/yurupager/releases/`, switches `/srv/yurupager/current` atomically, and
loads `/etc/yurupager/yurupager.env`. Existing SSH access is enough to perform
that release procedure; do not replace the host-wide Supervisor configuration
or other services.

## Native iOS app

Open `apps/ios/YuruPager.xcodeproj` with Xcode 16 or newer, select a signing
Team, and run the shared `YuruPager` Scheme on an iOS 17 Simulator or iPhone.
The login screen defaults to the address injected at build time through the
`YURUPAGER_DEFAULT_SERVER_ADDRESS` build setting (see
[the iOS runbook](./apps/ios/README.md)); without injection it falls back to
the `https://yurupager.example.com/` example origin. Its server disclosure
accepts another HTTPS deployment or localhost HTTP for Simulator
development.

The App uses Keychain for BFF session Cookie recovery and does not persist
passwords, REST snapshots, request answers, or Codex conversation text. See
[the iOS runbook](./apps/ios/README.md) for build and current APNs boundaries.

## Verification

```bash
npm run lint
npm run typecheck
npm run test:all
npm run build:all
npm run e2e
npm audit --omit=dev
cd apps/ios && swift run yurupager-core-checks
```

The Connector tests cover protocol adaptation, at-least-once transport,
offline startup, lost ACK recovery, process restart, SQLite decision safety,
listener interruption, `sent_unknown`, cumulative Token behavior, private
credential and image files, image chunk recovery and validation, and setup URL
validation. They also exercise Preview CLI bounds, dynamic WSS authentication,
stable reconnect identity, fixed-loopback HTTP/WebSocket forwarding, header
isolation, flow control, chunk ordering, concurrency, and timeout failure.
Server tests additionally cover
pair-code hashing, expiry, single-device claims, dynamic WSS identity, RLS,
atomic collaborator races, idempotency, high-risk authorization, secret
answers, Token pricing, final calibration, image authorization, and zero image
byte persistence.

## Technical spike commands

The original live Codex verification remains available through:

```bash
npm run spike:handshake
npm run spike:approval
npm run spike:question
npm run spike:shared-session
npm run spike:decision-race
npm run spike:listener-restart
npm run spike:approval-boundaries
npm run spike:protocol-contract
npm run spike:crash-window
npm run spike:token-lifecycle
```

Some spikes start real model turns and consume Token usage. Remote TUI checks
must run from an interactive macOS terminal.

## Documents

- [Product requirements](./docs/product-requirements.md)
- [Technology decisions](./docs/technology-decisions.md)
- [Interaction contract](./docs/interaction-contract.md)
- [Codex Connector Spike report](./docs/codex-connector-spike.md)

Licensed under the [Apache License 2.0](./LICENSE).
