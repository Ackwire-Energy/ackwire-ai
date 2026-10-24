# Self-hosting agentes.chat

agentes.chat runs as two containers: Postgres 18 with the pgvector extension, and the app, one Bun
process that serves the web app, the API and the WebSockets and runs the background workers.
Migrations run when the app starts. Everything it keeps is in Postgres, except uploaded files, which
the compose file stores in a volume.

`PUBLIC_URL` must be the exact address people open, scheme, host and port included
(`https://chat.example.com`, or `http://localhost:3000` on your own machine). Sign-in cookies, the
only browser origin allowed to change anything, and every link the app sends come from it. Opened at
any other address, sign-in fails with "Invalid origin" and saving fails with `bad_origin`.

The server needs no model key of its own. Each organization adds its Anthropic or OpenAI keys in
**Settings → API keys**. Keys are stored encrypted with a key derived from `AGENTES_SECRET` and are
never sent to browsers.

**Requirements**

- A 64-bit Linux server (amd64 or arm64) with Docker Engine and the Compose v2 plugin
  (`docker compose`). Docker Desktop works for trying it on a laptop.
- Sizing has not been measured yet. As a starting point for a small team: 2 vCPUs, 4 GB of RAM and
  20 GB of disk. The image is large (about 2 GB of dependencies), and the database and the files
  volume grow with use.
- For HTTPS: a domain whose DNS points at the server, and ports 80 and 443 open.
- Outbound HTTPS to the model providers your organizations use, and to any service you turn on below.

<details open>
<summary><b>Quickstart</b></summary>

In an empty directory:

```sh
curl -fsSLO https://raw.githubusercontent.com/agentes-chat/agentes-chat/main/docker-compose.yml
(umask 077 && printf 'AGENTES_SECRET=%s\nPOSTGRES_PASSWORD=%s\nPUBLIC_URL=http://localhost:3000\n' "$(openssl rand -base64 48)" "$(openssl rand -hex 24)" > .env)
docker compose up -d
```

The `umask` in parentheses makes `.env` readable by you alone without changing your shell's.

Open http://localhost:3000 and create an account. The first account is always allowed and becomes
the owner; after it, sign-up is closed and people join by invitation. Onboarding then creates your
organization and asks for its model key. On a server, create this account through the SSH tunnel
below before you turn on HTTPS or point a proxy at the app: until the owner exists, whoever opens
the sign-up page first takes the instance.

`.env` holds three values:

- `AGENTES_SECRET` signs sessions and encrypts every key organizations store (model providers,
  connectors, mailboxes, databases). Back it up apart from the database: a database restored without
  it has all of those keys unreadable.
- `POSTGRES_PASSWORD` goes into the database URL the compose file builds, so it stays hex.
- `PUBLIC_URL`, as above.

The app is published on `127.0.0.1:3000` only; `HOST_PORT` changes the port. To use it from other
machines, put it behind HTTPS (the next two sections), or try it through an SSH tunnel first:
`ssh -L 3000:localhost:3000 your-server`. Don't serve it over plain http to other machines
(`BIND_ADDRESS=0.0.0.0`), not even on a LAN. Browsers treat http as a secure context only on
localhost, and parts of the web app need one. With no proxy in front, nothing sets
`X-Forwarded-For`, so the sign-in rate limits can't tell clients apart. And Docker opens a published
port past the host's firewall.

`docker compose ps` shows the app as `healthy` once it answers `/api/health`, and
`docker compose logs -f agentes` shows what it is doing.

</details>

<details>
<summary><b>HTTPS with the built-in Caddy</b></summary>

Create the owner account first, over localhost or the SSH tunnel (Quickstart): the first sign-up
becomes the owner, so it has to happen before the domain answers. Then point a DNS record at the
server, open ports 80 and 443, and add to `.env`:

```sh
DOMAIN=chat.example.com
PUBLIC_URL=https://chat.example.com
COMPOSE_PROFILES=https
```

and run `docker compose up -d`. The `caddy` service gets a Let's Encrypt certificate for `DOMAIN` and
renews it, redirects http to https, and passes everything to the app, WebSockets included. Its
certificates are kept in the `caddy-data` volume. Caddy sends the client's address as the only value
of `X-Forwarded-For`, which the app trusts as is, so leave `TRUSTED_PROXIES` empty.

</details>

<details>
<summary><b>Behind your own reverse proxy (nginx)</b></summary>

Create the owner account first, as for Caddy above. Keep the app on loopback (the default) and
point the proxy at `127.0.0.1:3000`. The proxy must:

- upgrade WebSockets on `/api/ws` (browsers) and `/api/machines/connect` (connected computers);
- accept uploads up to 50 MB, the Drive's limit per file;
- keep sockets open: the app and its clients exchange a ping at least every 30 s, so a read timeout
  of 60 s (nginx's default) or more works;
- send the client's address in `X-Forwarded-For`.

`/etc/nginx/conf.d/agentes.conf`:

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    ""      close;
}

server {
    listen 80;
    server_name chat.example.com;

    client_max_body_size 60m;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_read_timeout 300s;
    }
}
```

TLS and the http → https redirect in one line:

```sh
sudo certbot --nginx --redirect -d chat.example.com
```

Then set `PUBLIC_URL=https://chat.example.com` in `.env` and run `docker compose up -d`.

Sign-in rate limits count per client address, read from `X-Forwarded-For`. A single value, as above,
is trusted as is, and the client can't forge it (nginx replaces whatever the client sent). With
another proxy or a CDN in front of nginx, send the chain instead (`$proxy_add_x_forwarded_for`) and
list those proxies' addresses or ranges in `TRUSTED_PROXIES`, comma-separated: the chain is read from
the right past every trusted hop, and the first other address is the client.

</details>

<details>
<summary><b>Configuration</b></summary>

Settings are environment variables in `.env`; the compose file hands the whole file to the app. After
a change, `docker compose up -d` recreates the app with it. Every variable is documented in
[`.env.example`](https://github.com/agentes-chat/agentes-chat/blob/main/.env.example). These are the
ones a self-hosted instance usually touches:

| Variable | Default | What it does |
| --- | --- | --- |
| `PUBLIC_URL` | `http://localhost:3000` | The exact address people open. |
| `AGENTES_SECRET` | required | Master secret, at least 32 characters. Never change it on an instance in use. |
| `POSTGRES_PASSWORD` | required | Database password. Read by the compose file only. |
| `AGENTES_IMAGE` | `ghcr.io/agentes-chat/agentes:latest` | The image to run. A version tag or a digest holds a version. |
| `BIND_ADDRESS`, `HOST_PORT` | `127.0.0.1`, `3000` | Where the compose file publishes the app. |
| `DOMAIN`, `COMPOSE_PROFILES` | | `COMPOSE_PROFILES=https` runs Caddy for `DOMAIN`. |
| `ALLOW_SIGNUP` | `false` | `true` lets anyone create an account. |
| `TRUSTED_PROXIES` | | Proxies in front of your proxy (see nginx above). |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | | "Sign in with Google", redirect URI `{PUBLIC_URL}/api/auth/callback/google`. `GITHUB_*` and `APPLE_*` work the same way. |
| `TERMS_URL`, `PRIVACY_URL` | | Your terms and privacy policy, linked on the sign-in and sign-up screens when both are set. |
| `LANDING_PAGE` | `false` | The agentes.chat marketing page at `/`, with its waiting list and analytics. Leave it off. |
| `SMTP_URL` | | Email through your SMTP server: `smtps://user:password@smtp.example.com:465`, or `smtp://` for STARTTLS on 587, which is then required (`?requireTLS=false` at the end allows a relay without TLS on a trusted network). |
| `MILLIONSEND_API_KEY`, `MILLIONSEND_API_URL` | `https://api.millionsend.com` for the URL | Email through a Resend-compatible API instead: MillionSend, your own MillionSend, or Resend (`https://api.resend.com`). |
| `EMAIL_FROM`, `EMAIL_REPLY_TO` | `agentes <ola@HOST>`, HOST being the host of `PUBLIC_URL` | Sender of the app's emails. Its domain must be verified with your email provider. |
| `FILES_DIR` | `/data/files`, set by the compose file | Folder for uploaded files, on the `files` volume. |
| `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | | Files in an S3-compatible bucket instead, when all four are set. `S3_REGION` (default `auto`); `S3_PATH_STYLE=true` for MinIO and Garage. |
| `RUN_MIGRATIONS_ON_BOOT` | `true` | `false` only if you run `docker compose run --rm agentes migrate` yourself before each start. |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn` or `error`. |

**Model keys.** Each organization adds its own Anthropic or OpenAI keys in **Settings → API keys**,
and each agent uses one of them. Usage and cost are recorded per agent.

**Sign-up.** The first account is always allowed. After it, with `ALLOW_SIGNUP=false` (the default),
only invited people get in: invited by email from **Settings → Members and invitations**, or through
an invite link, which works without email. Keep sign-up closed on an instance reachable from the
internet.

**Email.** Without `SMTP_URL` or `MILLIONSEND_API_KEY`, the app writes each email to its log instead
of sending it (`docker compose logs agentes | grep 'email (not sent'`), so an invitation link can
still be copied from there; email verification and password reset stay off. With either set, it
sends invitations, email verification, password reset links, and budget and approval alerts.
`MILLIONSEND_API_KEY` wins when both are set.

**Password reset** needs email, so it shows only with `SMTP_URL` or `MILLIONSEND_API_KEY` set: "Forgot
my password" on the sign-in page emails a link to the web app's reset page (`/reset-password`).

**Files.** The compose file stores uploaded files (Drive files, attachments, photos) in the `files`
volume. With all four `S3_*` variables set they go to that bucket instead, and with neither, into
Postgres. Choose before the first upload: a file stays in the store it was written to. An
organization can also keep its files in a bucket of its own (**Settings → Storage**).

</details>

<details>
<summary><b>Optional services and what they receive</b></summary>

Nothing on the instance contacts agentes.chat on its own. Besides the model providers each
organization chooses, it talks to a third party only when you turn that service on:

| Service | Turned on by | What it receives |
| --- | --- | --- |
| Anthropic, OpenAI | An organization's key | What an agent reads to answer: its instructions, the organization's context, recent messages, and the files and tool results it opens. Summaries and memory upkeep use the same key. |
| TypeSafe Jev | `TYPESAFE_API_KEY` | To pick which agent answers a message nobody @mentioned: the channel's name and topic, the message (up to 4,000 characters), recent messages (up to 800 each), and the name, role and description of the channel's agents. Also the messages and memory items it is asked to judge (a request to stop, a hand-off, a permission change, whether to archive a memory). Without it, the organization's own model does this. |
| Voyage AI | `EMBEDDINGS_PROVIDER=voyage` and `VOYAGE_API_KEY` | The text of messages and memory items as they are indexed (up to 8,000 characters each), and search queries. Without it, search is full-text only. |
| Composio | `COMPOSIO_API_KEY` | Gmail and Outlook for agents: Composio holds the mailbox connection, and the mail agents read or send passes through it. IMAP mailboxes connect directly. |
| Daytona | `DAYTONA_API_KEY` | Cloud computers for agents: the commands and code agents run, the files they put there and the output, on Daytona's cloud (or your own Daytona, `DAYTONA_API_URL`). |
| MillionSend or Resend | `MILLIONSEND_API_KEY` | Each email the app sends: recipients, subject and body, links included. `SMTP_URL` uses your own mail server instead. |
| Expo | A phone app built for this server | For each push to a registered phone: its push token, a title (up to 80 characters) and a line of text (up to 180), through Expo's push service. The store app talks to agentes.chat, so no phone registers unless you ship your own build. |

Connectors (MCP servers, GitHub, Linear and the others) receive what agents send them, within the
scopes you grant each agent.

</details>

<details>
<summary><b>Agent computers</b></summary>

Agents run commands and code, drive a browser, and can think with Claude Code or Codex on a
computer. Connect your own: a server, a VM or a laptop. Cloud computers need `DAYTONA_API_KEY`
(Daytona's cloud, or your own Daytona at `DAYTONA_API_URL`); without it, agents use connected
computers only.

**Settings → Computers → Connect a computer** shows the command for this instance:

```sh
curl -fsSL https://chat.example.com/api/machines/install.sh | sh
```

The computer needs Node.js 22 or newer (or Bun) and must reach `PUBLIC_URL`: it downloads the runner
from there and sends files back through it. The installer prints a code and a link; open it signed
in, confirm, and the computer joins your organization. Then it installs a background service
(a systemd user unit or a launchd agent) where it can; otherwise run
`~/.agentes-runner/bin/agentes-runner start` and keep it running. Options go after `sh -s --`:
`--dir <folder>` (where agents work, default `~/agentes`), `--name <name>`, `--no-exec` (files only,
no commands) and `--no-service`.

That computer runs the commands agents execute, the browser they drive (Chrome for Testing, installed
on first use), and Claude Code or Codex when an agent thinks with a subscription signed in there.
Commands run as the user that runs the runner, so give it a dedicated user or a VM.
`agentes-runner tools disable commands` (or `claude`, or `codex`) turns a capability off on that
computer, and `agentes-runner folders allow <path>` shares a folder besides the agents' own.

Use HTTPS with a certificate from a public authority (the Caddy profile gets one). Over plain http
the computer's token travels unencrypted, and the runner's background service doesn't load extra CA
certificates.

</details>

<details>
<summary><b>Upgrades</b></summary>

Download the compose file again with each release, since a release can change it, then pull and
restart:

```sh
curl -fsSLO https://raw.githubusercontent.com/agentes-chat/agentes-chat/main/docker-compose.yml
docker compose pull
docker compose up -d
```

Keep your settings in `.env` and never edit `docker-compose.yml`, so replacing it loses nothing.
Anything a variable can't set goes in a `docker-compose.override.yml` beside it, which Compose merges
on its own.

Migrations run when the new version starts, so that is the whole upgrade for a small instance. The
compose file runs `ghcr.io/agentes-chat/agentes:latest`, the latest release, for amd64 and arm64;
`:1.2.3` and `:1.2` tags exist alongside it, and `:edge` follows `main`. To hold a version, set
`AGENTES_IMAGE` in `.env` to a version tag or a digest (`ghcr.io/agentes-chat/agentes@sha256:…`),
and download the compose file of that version's tag (`…/agentes-chat/v1.2.3/docker-compose.yml`)
instead of `main`'s. This prints the digest you have:

```sh
docker image inspect --format '{{index .RepoDigests 0}}' ghcr.io/agentes-chat/agentes:latest
```

For a big jump, migrate first from a throwaway container. If a migration fails, the running version
keeps serving instead of a new one that won't start:

```sh
docker compose pull
docker compose run --rm agentes migrate
docker compose up -d
```

Migrations only go forward, and a version refuses to start on a database that a newer one migrated.
Take a dump before a big jump (Backups below): rolling back is the previous pin plus that dump.

The compose file pins the Postgres image too, by version and digest, so the database image changes
only when a release's compose file moves that pin. The new file, `docker compose pull` and
`docker compose up -d` then recreate the `postgres` container on the new image, keeping the `pgdata`
volume. That covers Postgres 18 minor releases and pgvector updates; a new Postgres major version
can't open the old data directory, so moving to one takes a dump and a restore into a new volume.

</details>

<details>
<summary><b>From source</b></summary>

To run your own changes, build the image and point the compose file at it:

```sh
git clone https://github.com/agentes-chat/agentes-chat.git
cd agentes-chat
docker build -t agentes:local .
# create .env as in the quickstart, then:
AGENTES_IMAGE=agentes:local docker compose up -d
```

Add `AGENTES_IMAGE=agentes:local` to `.env` too, so later commands keep using your image. To upgrade,
`git pull`, build again and `docker compose up -d`. Skip `docker compose pull` with a local image: it
looks for `agentes:local` in a registry and fails. `docker compose pull postgres` updates the
database image alone. The build installs every workspace's dependencies and builds the web app, so
it needs more memory than running the image. The image keeps the checkout's file permissions and
runs as an unprivileged user, so on a host whose umask is stricter than 022, clone and pull under
`umask 022` (for example `(umask 022 && git pull)`).

</details>

<details>
<summary><b>Backups and restore</b></summary>

An instance is three things: the database, the `files` volume (uploaded files, with the compose
file's `FILES_DIR`), and `AGENTES_SECRET`. Keep the secret apart from the dumps: a dump restored
without it has every stored key (model providers, connectors, mailboxes, databases) unreadable, and
anyone who holds both can read those keys.

```sh
(
  umask 077
  docker compose exec -T postgres pg_dump -U agentes -Fc agentes > agentes-$(date +%F).dump
  docker compose run --rm --no-deps -T --entrypoint tar agentes czf - -C /data/files . > files-$(date +%F).tar.gz
)
```

The `umask` makes both files readable by you alone: they hold every message and file. The dump is
consistent while the app runs. Schedule both and copy the results off the server (in a crontab,
start the line with `cd /path/to/compose/dir && umask 077;` and write `\%F`). Files kept in an S3
bucket stay there; files kept in Postgres are in the dump.

Restore with the app stopped, so nothing writes in between, into an emptied database: tables that a
newer version added aren't in an older dump and would keep it from replacing the rest.

```sh
docker compose stop agentes
docker compose exec -T postgres dropdb -U agentes --force agentes
docker compose exec -T postgres createdb -U agentes agentes
docker compose exec -T postgres pg_restore -U agentes -d agentes --exit-on-error < agentes-2026-10-20.dump
docker compose run --rm --no-deps -T --entrypoint tar agentes xzf - -C /data/files < files-2026-10-20.tar.gz
```

Only when both restores finish without an error, start the app:

```sh
docker compose start agentes
```

On a new server: the compose file and the old `.env`, `docker compose up -d --wait postgres`, the
restore commands above, then `docker compose up -d`. Restore into the version that took the dump or
a newer one.

</details>

<details>
<summary><b>Troubleshooting</b></summary>

**"Invalid origin" when signing in, or `bad_origin` ("Cross-origin request refused") when saving.**
`PUBLIC_URL` differs from the address in the browser: scheme, host and port must all match. Fix it in
`.env` and run `docker compose up -d`. In production the log warns at every start while `PUBLIC_URL`
is still `http://localhost:3000`.

**Messages don't appear live, and the browser's WebSocket closes with code 1006.** A proxy in front
doesn't pass the upgrade. It needs the `Upgrade` and `Connection` headers for `/api/ws` (and
`/api/machines/connect` for computers), HTTP/1.1 to the app, and a read timeout of at least 60 s (see
the nginx section). A 403 "Cross-origin WebSocket refused" is the `PUBLIC_URL` mismatch above.

**`extension "vector" is not available` at the first start.** The database is a Postgres without
pgvector. Use the compose file's `pgvector/pgvector` image; on a database of your own, install
pgvector for its Postgres version (15 or newer).

**`refusing to migrate: the database's migrations don't match this build`, then the app exits.** The
`reason` in that log line says which case. "It was migrated by a newer version": the image is older
than the database, after a rollback; run that version or a newer one, or restore the dump taken
before the upgrade. "Migration … was changed after it was applied": the image was built from edited
migrations, and committed migrations never change.

**`Invalid configuration`, then restarts.** A required value is missing or malformed in `.env`; the
log lists each one.

**Emails don't arrive.** At every start the log line `transactional email` names the sender in use.
`log` means none is configured, and each email is only written to the log. With `smtp` or
`millionsend`, check that the domain of `EMAIL_FROM` is verified with your provider.

**"This address points to an internal network".** Connectors, databases, mailboxes and an
organization's own bucket must be reachable at public addresses: private, loopback and link-local
addresses are refused, so nobody can turn the server against its own network. Reach internal services
through a connected computer instead.

</details>

<details>
<summary><b>Desktop and phone apps</b></summary>

Everyone can use a self-hosted instance from a browser. The apps don't support a self-hosted server
yet:

- The desktop app connects only to agentes.chat: the address is built in. Connect computers with the
  terminal runner instead (Agent computers above).
- The phone app talks to the server it was built for (`EXPO_PUBLIC_API_URL`), and the store version
  talks to agentes.chat. A self-hosted instance needs its own build of `apps/mobile` with
  `EXPO_PUBLIC_API_URL` set to its `PUBLIC_URL`, published under your own Expo project
  (`EAS_PROJECT_ID`). Its push notifications then go through Expo.

</details>
