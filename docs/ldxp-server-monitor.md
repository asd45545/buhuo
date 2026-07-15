# LDXP server monitor

The server monitor keeps one headed Chromium session alive under Xvfb. The same
browser profile, cookies, JavaScript runtime, and network identity are reused
between checks. A normal HTTP request is attempted first; an ESA HTML challenge
switches the request to the persistent browser.

## Why headed Chromium

The shop currently returns JSON to a normal server request but may return a
JavaScript challenge to cloud functions. A real integration probe showed that
Chromium's default `HeadlessChrome` user agent receives `403 Forbidden`, while a
normal Chrome user agent on the same IP receives the expected JSON response.
The transport therefore uses a normal Chrome user agent. The systemd
service also runs headed Chromium under Xvfb for an additional compatibility
margin.

This handles executable JavaScript challenges. It deliberately stops with
`WAF_BROWSER_BLOCKED` or `WAF_INTERACTIVE_CHALLENGE` when ESA requires a manual
verification or rejects the server ASN. In that case the reliable fixes are
shop-side allowlisting, an official API, or an approved fixed egress proxy.

## Install

The examples assume Ubuntu/Debian, Node.js 22, and `/opt/buhuo` as the checkout.

```bash
sudo apt-get update
sudo apt-get install -y chromium xvfb fonts-noto-cjk
cd /opt/buhuo
sudo npm ci --omit=dev

sudo useradd --system --home /var/lib/ldxp-monitor --shell /usr/sbin/nologin ldxp-monitor || true
sudo install -d -o ldxp-monitor -g ldxp-monitor /var/lib/ldxp-monitor
sudo install -m 600 deploy/ldxp-monitor.env.example /etc/ldxp-monitor.env
sudo install -m 644 deploy/ldxp-monitor.service /etc/systemd/system/ldxp-monitor.service
```

Edit `/etc/ldxp-monitor.env` and add the Telegram values. Do not put credentials
in the repository, process arguments, or URLs.

## Read-only probe

Run this before enabling notifications. It does not update state or send a
message:

```bash
sudo systemd-run --wait --pipe --collect --unit=ldxp-monitor-probe \
  --property=User=ldxp-monitor \
  --property=Group=ldxp-monitor \
  --property=WorkingDirectory=/opt/buhuo \
  --property=EnvironmentFile=/etc/ldxp-monitor.env \
  /usr/bin/xvfb-run -a /usr/bin/node scripts/monitor-ldxp-stock.mjs \
    --probe --json --api-transport browser \
    --browser-profile-dir /var/lib/ldxp-monitor/browser-profile
```

Expected output contains `"ok":true` and a positive `totalGoods` value. Useful
failure codes:

- `BROWSER_EXECUTABLE_NOT_FOUND`: fix `LDXP_BROWSER_EXECUTABLE_PATH`.
- `WAF_BROWSER_BLOCKED`: headed Chromium was rejected with HTTP 403.
- `WAF_INTERACTIVE_CHALLENGE`: ESA still requires verification after two tries.
- `BROWSER_REQUEST_FAILED`: Chromium or the page crashed; the daemon recreates it.

## Preserve the existing stock baseline

Copy the current state before the first real run. Otherwise the first run creates
a new baseline and intentionally sends no alerts for already-stocked goods.

```bash
sudo install -o ldxp-monitor -g ldxp-monitor -m 600 \
  data/ldxp-stock-state.json /var/lib/ldxp-monitor/ldxp-stock-state.json
sudo install -o ldxp-monitor -g ldxp-monitor -m 600 \
  data/ldxp-stock-alerts.md /var/lib/ldxp-monitor/ldxp-stock-alerts.md
```

With the old baseline, the first successful server run can send alerts missed
while Vercel was blocked. To discard the backlog, perform one `--probe`, then
replace the state intentionally before enabling the service.

## Enable and observe

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now ldxp-monitor
sudo systemctl status ldxp-monitor
sudo journalctl -u ldxp-monitor -f
```

Healthy runs print `OK` or `RESTOCK_ALERT`. Failures print a stable code and a
`consecutive_failures` count. A later successful run prints `HEALTH_RECOVERED`.

After the service is verified, disable the old GitHub/Vercel trigger to prevent
duplicate checks and duplicate notifications.
