# LDXP monitoring dashboard

The dashboard is a separate, read-only Node.js service. It never calls the shop
API. The stock monitor atomically writes a sanitized snapshot after every poll,
and the dashboard only reads that local snapshot.

## Data boundary

The snapshot contains monitor health, bounded poll history, recent restocks, and
sanitized product data. It deliberately excludes proxy credentials, Telegram
configuration, GitHub credentials, visitor IDs, environment variables, and raw
logs. Product links are accepted only for `https://pay.ldxp.cn/item/...`.

API endpoints:

- `GET /api/v1/dashboard/overview`
- `GET /api/v1/dashboard/products`
- `GET /api/v1/dashboard/polls`
- `GET /api/v1/dashboard/restocks`
- `GET /healthz` (dashboard process health only)

All `/api/` endpoints require `Authorization: Bearer <dashboard-token>`. The
browser stores the token in `sessionStorage`, so closing the tab clears it.

## Install

The examples assume `/opt/buhuo`, Node.js 22, and the existing monitor user.

```bash
sudo useradd --system --home /nonexistent --shell /usr/sbin/nologin ldxp-dashboard || true
sudo install -m 600 deploy/ldxp-dashboard.env.example /etc/ldxp-dashboard.env
sudo install -m 644 deploy/ldxp-dashboard.service /etc/systemd/system/ldxp-dashboard.service
sudo systemctl daemon-reload
```

Generate a token and place it in `/etc/ldxp-dashboard.env`:

```bash
openssl rand -hex 32
```

Restart the monitor once after deploying the health snapshot code, then enable
the dashboard:

```bash
sudo systemctl restart ldxp-monitor
sudo systemctl enable --now ldxp-dashboard
sudo systemctl status ldxp-monitor ldxp-dashboard
```

## Secure access without a domain

The default listener is `127.0.0.1:8787`. Keep it private and open an SSH tunnel
from the computer that will view the dashboard:

```bash
ssh -N -L 8787:127.0.0.1:8787 -p 48403 root@SERVER_IP
```

Then open `http://127.0.0.1:8787` and enter the dashboard token. The monitor and
notifications continue running if this tunnel or the viewing computer closes.

For direct internet access, put the loopback listener behind an HTTPS reverse
proxy on a user-owned domain. Do not expose the dashboard over plain HTTP with a
bearer token.

## Health interpretation

- `healthy`: a successful snapshot is fresh and there are no consecutive failures.
- `degraded`: at least one poll failed, or the last success is over 1.5 intervals old.
- `down`: the daemon stopped, or the snapshot is over three intervals old.
- `starting`: the daemon has not completed its first poll yet.

The page refreshes the local snapshot every 15 seconds. This does not increase
shop traffic; shop polling remains controlled by `LDXP_DAEMON_INTERVAL_MS`.
