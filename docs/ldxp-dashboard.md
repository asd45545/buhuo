# LDXP monitoring dashboard

The dashboard is a separate, read-only Node.js service. It never calls the shop
API. The stock monitor atomically writes a sanitized snapshot after every poll,
and the dashboard only reads that local snapshot.

## Data and authentication boundary

The snapshot contains monitor health, bounded poll history, recent restocks, and
sanitized product data. It excludes proxy credentials, Telegram configuration,
GitHub credentials, visitor IDs, environment variables, and raw logs. Product
links are accepted only for `https://pay.ldxp.cn/item/...`.

Authentication uses a server-side scrypt password hash and a server-side
persistent opaque session. A successful login creates a random session value;
only its SHA-256 digest and expiry metadata are persisted in
`/var/lib/ldxp-dashboard/auth-state.json`. The browser receives the opaque value
in the `__Secure-ldxp_session` cookie with `Path=/stock-monitor/`, `Secure`,
`HttpOnly`, and `SameSite=Strict`. Neither the password nor a bearer token is
stored in browser storage or a URL.

Sessions last for up to 30 days and survive ordinary dashboard restarts because
the session records are persisted with mode `0600`. No signing key or
session-secret environment variable is configured or required. Changing the
password hash invalidates sessions created for the previous hash.

Three incorrect passwords from one source IP within 30 minutes cause a 24-hour
IP ban. Failure, ban, and session state share the same atomically replaced state
file. Nginx must overwrite `X-Real-IP`; the application trusts that header only
when the TCP peer is loopback.

Authentication endpoints:

- `POST /api/v1/auth/login`
- `GET /api/v1/auth/session`
- `POST /api/v1/auth/logout`

Authenticated read-only endpoints:

- `GET /api/v1/dashboard/overview`
- `GET /api/v1/dashboard/products`
- `GET /api/v1/dashboard/polls`
- `GET /api/v1/dashboard/restocks`

## Inventory integration API

Other services can read the current active inventory without a dashboard login:

```http
GET /stock-monitor/api/v1/inventory HTTP/1.1
Host: 103.193.172.111.sslip.io
Authorization: Bearer <inventory-api-key>
```

The API reads only the sanitized monitor snapshot. It never reads the raw stock
state, proxy configuration, Telegram configuration, visitor ID, or shop token.
It returns active `in_stock` and `out_of_stock` products; historical `missing`
products are deliberately excluded. The stable v1 response shape is:

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-07-16T00:00:00.000Z",
  "snapshotAt": "2026-07-15T23:59:00.000Z",
  "source": {
    "status": "healthy",
    "lastSuccessAt": "2026-07-15T23:59:00.000Z",
    "ageMs": 60000
  },
  "summary": { "total": 121, "inStock": 89, "outOfStock": 32 },
  "items": [
    {
      "id": "example",
      "name": "Example product",
      "url": "https://pay.ldxp.cn/item/example",
      "category": { "id": 1, "name": "GPT PLUS" },
      "price": 9.9,
      "stock": 12,
      "status": "in_stock",
      "lastChangedAt": "2026-07-15T23:50:00.000Z"
    }
  ]
}
```

If the monitor snapshot is stale enough to be considered `down`, the endpoint
returns `503 snapshot_stale` with `Retry-After: 30` instead of presenting old
stock as current. A `degraded` snapshot remains readable and is identified by
`source.status` and `source.ageMs`.

Generate a 32-byte base64url key, save the raw value only for the caller, and
put only its SHA-256 digest in `/etc/ldxp-dashboard.env`:

```bash
API_KEY="$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n')"
printf '%s\n' "$API_KEY" | sudo install -o root -g root -m 0600 /dev/stdin \
  /root/ldxp-inventory-api-key.txt
printf '%s' "$API_KEY" | sha256sum
unset API_KEY
```

Use the API key only in the other website's backend, serverless function, or
secret environment variable. Do not embed it in browser JavaScript: browser
bundles, DevTools, and network logs expose it, and CORS does not make a secret
safe. Server-to-server calls work when `LDXP_INVENTORY_API_ALLOWED_ORIGINS` is
empty. For browser calls, configure a comma-separated list of exact HTTPS
origins. Wildcard `*` is supported but discouraged.

Example server-side request:

```bash
curl --fail --silent \
  -H "Authorization: Bearer $LDXP_INVENTORY_API_KEY" \
  https://103.193.172.111.sslip.io/stock-monitor/api/v1/inventory
```

`GET /healthz` is available only on the internal loopback listener. The public
`/stock-monitor/healthz` route deliberately returns `404`.

## Initial installation

The examples assume Ubuntu/Debian, Node.js 22, a committed and tested release,
and `/opt/buhuo` as a symlink to a directory below `/opt/buhuo-releases`.

Create the service account and install the environment and unit on the first
deployment. Do not overwrite an existing environment file during an upgrade.

```bash
sudo useradd --system --home /nonexistent --shell /usr/sbin/nologin ldxp-dashboard || true
sudo install -d -o root -g root -m 0755 /opt/buhuo-releases
sudo install -o root -g root -m 0600 deploy/ldxp-dashboard.env.example /etc/ldxp-dashboard.env
sudo install -o root -g root -m 0644 deploy/ldxp-dashboard.service /etc/systemd/system/ldxp-dashboard.service
```

Generate a strong password without placing it in shell history, then hash it:

```bash
read -rsp 'Dashboard password: ' DASHBOARD_PASSWORD; echo
export LDXP_DASHBOARD_PASSWORD="$DASHBOARD_PASSWORD"
node dashboard/password-hash.mjs
unset LDXP_DASHBOARD_PASSWORD DASHBOARD_PASSWORD
```

Put only the generated scrypt hash in `LDXP_DASHBOARD_PASSWORD_HASH`. Set
`LDXP_DASHBOARD_PUBLIC_ORIGIN` to the exact HTTPS origin, without a path, for
example `https://monitor.example.com`. Keep these production values:

```dotenv
LDXP_DASHBOARD_HOST=127.0.0.1
LDXP_DASHBOARD_PORT=8788
LDXP_DASHBOARD_TRUST_PROXY=true
LDXP_DASHBOARD_SECURE_COOKIE=true
LDXP_DASHBOARD_COOKIE_NAME=__Secure-ldxp_session
LDXP_DASHBOARD_COOKIE_PATH=/stock-monitor/
LDXP_INVENTORY_API_KEY_HASH=<sha256-hex-digest>
LDXP_INVENTORY_API_ALLOWED_ORIGINS=
LDXP_INVENTORY_API_RATE_LIMIT=120
```

Install the Nginx snippets in their expected locations:

```bash
sudo install -o root -g root -m 0644 deploy/nginx-ldxp-dashboard-rate.conf /etc/nginx/conf.d/ldxp-dashboard-rate.conf
sudo install -o root -g root -m 0644 deploy/nginx-ldxp-dashboard-proxy-headers.conf /etc/nginx/snippets/ldxp-dashboard-proxy-headers.conf
sudo install -o root -g root -m 0644 deploy/nginx-ldxp-dashboard-locations.conf /etc/nginx/snippets/ldxp-dashboard-locations.conf
```

Include `ldxp-dashboard-locations.conf` from the exact HTTPS `server` block. The
rate file must be loaded in Nginx's `http` context. The main location uses `^~`,
all upstream requests go to `127.0.0.1:8788`, and the exact public health route
returns `404`. The inventory endpoint has a separate Nginx limit of 120 requests
per minute per source IP, plus the application-level limit.

Never expose port 8788 directly. Only HTTPS port 443 and the SSH management port
should be reachable from the internet.

## Atomic deployment

Build each release completely before switching traffic. Keep configuration in
`/etc` and mutable monitor/authentication data in `/var/lib`; never place them in
a release directory.

From a clean, committed checkout:

```bash
npm test
RELEASE_ID="$(date -u +%Y%m%dT%H%M%SZ)-$(git rev-parse --short HEAD)"
RELEASE_DIR="/opt/buhuo-releases/$RELEASE_ID"
sudo install -d -o root -g root -m 0755 "$RELEASE_DIR"
git archive --format=tar HEAD | sudo tar -xf - -C "$RELEASE_DIR"
sudo npm --prefix "$RELEASE_DIR" ci --omit=dev
sudo chown -R root:root "$RELEASE_DIR"
```

Before the cutover:

1. Record `readlink -f /opt/buhuo` as the rollback release.
2. Back up the current systemd unit, Nginx snippets, and
   `/etc/ldxp-dashboard.env` into a root-only rollback directory.
3. Back up `/var/lib/ldxp-monitor/ldxp-stock-state.json`, but use that copy only
   for corruption recovery, not routine code rollback.
4. Confirm the stock-state JSON is parseable and its owner and mode are unchanged.
5. Wait for `ldxp-monitor` to log a complete `OK checked ...` or
   `RESTOCK_ALERT ...` result. Those lines occur after the stock state is saved.
6. Stop both services during the following polling interval and verify they are
   inactive:

```bash
sudo systemctl stop ldxp-dashboard ldxp-monitor
sudo systemctl is-active ldxp-dashboard ldxp-monitor
```

Stopping the monitor while it is sending Telegram messages can repeat a message
if Telegram accepted it before the new stock state was saved. Waiting for a
completed poll and stopping during the idle interval avoids that deployment
window.

For the first migration from a real `/opt/buhuo` directory, move that directory
into `/opt/buhuo-releases` while both services are stopped, then create the
`/opt/buhuo` symlink. On later deployments, atomically replace the symlink on the
same filesystem:

```bash
NEXT_LINK="/opt/.buhuo-next-$RELEASE_ID"
sudo ln -s "$RELEASE_DIR" "$NEXT_LINK"
sudo mv -Tf "$NEXT_LINK" /opt/buhuo
```

Install the version-matched unit and Nginx snippets from the new release. Keep
the existing `/etc/ldxp-dashboard.env`; apply reviewed variable changes by hand
instead of copying the example over it. Then validate and start in this order:

```bash
sudo systemctl daemon-reload
sudo nginx -t
sudo systemctl enable ldxp-monitor ldxp-dashboard
sudo systemctl start ldxp-monitor
sudo systemctl start ldxp-dashboard
curl --fail --silent --show-error http://127.0.0.1:8788/healthz
sudo systemctl reload nginx
```

Do not regard `active` or the internal `/healthz` response as proof that the
snapshot is readable. Complete all of these checks:

- `sudo -u ldxp-dashboard test -r /var/lib/ldxp-monitor/ldxp-monitor-status.json`
- the authenticated overview API returns `200` and a current snapshot timestamp
- an unauthenticated dashboard API request returns `401`
- the public `/stock-monitor/healthz` returns `404`
- the inventory API returns `401` without its API key and `200` with the key
- configured browser origins receive the expected CORS preflight response
- `ss -ltnp` shows the dashboard only on `127.0.0.1:8788`, never on a wildcard
- the login response sets `__Secure-ldxp_session` with
  `Path=/stock-monitor/`, `Secure`, `HttpOnly`, and `SameSite=Strict`
- the next unchanged monitor poll reports zero restocks and Telegram receives no
  duplicate notification

## Rollback

Rollback is another atomic release switch, not an in-place file copy:

1. If the monitor has completed a successful poll, stop it during its idle
   interval; also stop the dashboard.
2. Atomically replace `/opt/buhuo` with a temporary symlink to the recorded
   previous release using the same `ln -s` plus `mv -Tf` pattern.
3. Restore the unit, Nginx snippets, and environment file that belong to that
   release. Run `systemctl daemon-reload` and `nginx -t` before starting anything.
4. Start `ldxp-monitor`, then `ldxp-dashboard`, verify the internal API, and only
   then reload Nginx.
5. Repeat the deployment health, permission, listener, and notification checks.

Keep the latest `/var/lib/ldxp-monitor/ldxp-stock-state.json` during a normal
rollback. Restoring an older stock snapshot after a notification was sent can
make the same restock look new and send it again. Restore the backup only if the
current state is corrupt and reconcile possible notifications manually.

Keep `/var/lib/ldxp-dashboard/auth-state.json` across compatible releases so
opaque sessions survive. If rolling back across an incompatible authentication
state schema, restore its version-matched backup while the dashboard is stopped;
this intentionally logs out sessions created after that backup.

## Unban an IP

There is no HTTP bypass. Stop the dashboard before editing the persistent state
so the service and CLI cannot race while atomically replacing the same file:

```bash
sudo systemctl stop ldxp-dashboard
sudo systemctl is-active ldxp-dashboard
sudo -u ldxp-dashboard /usr/bin/node /opt/buhuo/dashboard/security-cli.mjs \
  unban 203.0.113.10 --file /var/lib/ldxp-dashboard/auth-state.json
sudo systemctl start ldxp-dashboard
sudo systemctl is-active ldxp-dashboard
```

The first `is-active` result should be `inactive`; the second should be `active`.
Start the service again even if the CLI reports `NO_BAN_FOUND` or exits with an
error, then inspect its journal before retrying login. Users behind the same NAT
share one public IP, so three wrong passwords from any of those devices will
temporarily block all of them.

## Health interpretation

- `healthy`: a successful snapshot is fresh and there are no consecutive failures.
- `degraded`: at least one poll failed, or the last success is over 1.5 intervals old.
- `down`: the daemon stopped, or the snapshot is over three intervals old.
- `starting`: the daemon has not completed its first poll yet.

The page refreshes the local snapshot every 15 seconds. This does not increase
shop traffic; shop polling remains controlled by `LDXP_DAEMON_INTERVAL_MS`.
