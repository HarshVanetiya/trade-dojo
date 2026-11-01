# Deploying TradeDojo on Azure (Azure for Students)

This guide puts the **backend on a small Linux VM**, which runs all the time, and the **frontend on Azure Static Web Apps** (or Cloudflare Pages). The database can stay on **Aiven** or move to **Azure Database for PostgreSQL**.

Why a VM and not App Service or Container Apps: the backend must stay running to keep the Upstox price connection open, run the trigger engine and the replay timers. A VM never sleeps. The free App Service tier can't stay always on, and keeping one Container Apps replica running uses more than its free allowance. See [docs/PROJECT_GUIDE.md](PROJECT_GUIDE.md) for the architecture.

> **Free amounts change.** Azure for Students has included free monthly hours of a B1s Linux VM and of a B1ms PostgreSQL Flexible Server for 12 months, plus a credit. Check **Azure portal → Free services** for what your subscription includes today, and watch **Cost Management** in the first days. A public IP address and disks can use a little credit.

What you'll end up with:

```
Browser ──https──> Static Web Apps / Cloudflare (frontend files)
Browser ──https/wss──> Caddy on the VM :443 ──> Node backend 127.0.0.1:4000 ──> PostgreSQL
                                                          └──wss──> Upstox feed
```

Time needed: about an hour the first time.

---

## Part 1: Create the VM

In the Azure portal: **Virtual machines → Create → Azure virtual machine**.

| Setting | Value |
|---|---|
| Subscription | Azure for Students |
| Resource group | Create new, e.g. `tradedojo-rg` |
| Name | `tradedojo-vm` |
| Region | **Central India** (close to Upstox/MCX servers and your users) |
| Image | **Ubuntu Server 24.04 LTS - x64 Gen2** |
| Size | **B1s** (1 vCPU, 1 GB RAM). Pick the size marked as free-eligible in your portal. |
| Authentication | SSH public key; username `azureuser` |
| Inbound ports | Allow **SSH (22)**, **HTTP (80)**, **HTTPS (443)** |
| OS disk | Standard SSD is fine |

Create it and download the SSH key if Azure generated one.

### Give the VM a DNS name

HTTPS certificates need a name, not just an IP address. Open the VM → **Overview → DNS name → Configure**, set a label such as `tradedojo`, and save. Your backend will be at:

```
tradedojo.centralindia.cloudapp.azure.com
```

(Use your own label and region in the commands below.) A custom domain also works: point an `A` record at the VM's public IP.

### Lock down SSH (recommended)

VM → **Networking → Network settings**: edit the SSH (22) rule so **Source** is **My IP address** instead of Any. Ports 80 and 443 stay open to everyone. Port 4000 must **not** be opened; the backend is only reached through Caddy.

---

## Part 2: Prepare the server

Connect:

```bash
ssh -i ~/Downloads/tradedojo-vm_key.pem azureuser@tradedojo.centralindia.cloudapp.azure.com
```

Update the system and add a 2 GB swap file (1 GB of RAM is tight while `npm ci` runs):

```bash
sudo apt update && sudo apt -y upgrade
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

Set the clock zone (logs are easier to read in IST; the app itself always works in IST internally):

```bash
sudo timedatectl set-timezone Asia/Kolkata
```

Install **Node.js 22** and **git**:

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs git
node -v    # should print v22.x
```

Install **Caddy** (web server with automatic HTTPS), following its official Ubuntu instructions:

```bash
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install -y caddy
```

Create a dedicated user to run the app (it can't log in and has no admin rights):

```bash
sudo useradd --system --create-home --home-dir /opt/trade-dojo-home --shell /usr/sbin/nologin tradedojo
sudo mkdir -p /opt/trade-dojo && sudo chown tradedojo:tradedojo /opt/trade-dojo
```

---

## Part 3: Get the code and build it

If the repository is **public**:

```bash
sudo -H -u tradedojo git clone https://github.com/HarshVanetiya/trade-dojo.git /opt/trade-dojo
```

If it's **private**, give the VM read-only access with a deploy key:

```bash
sudo -H -u tradedojo mkdir -p /opt/trade-dojo-home/.ssh
sudo -H -u tradedojo ssh-keygen -t ed25519 -N "" -f /opt/trade-dojo-home/.ssh/id_ed25519
sudo cat /opt/trade-dojo-home/.ssh/id_ed25519.pub
```

Copy the printed key into GitHub: repository → **Settings → Deploy keys → Add deploy key** (leave "Allow write access" off). Then:

```bash
sudo -H -u tradedojo git clone git@github.com:HarshVanetiya/trade-dojo.git /opt/trade-dojo
```

Build the backend:

```bash
cd /opt/trade-dojo/backend
sudo -H -u tradedojo npm ci
sudo -H -u tradedojo npm run build
```

---

## Part 4: Database

Pick **one**.

### Option A: keep Aiven (simplest)

Nothing to create. You'll use the Aiven Service URI and Aiven's CA certificate in the next part. In the Aiven console, if you restricted allowed IP addresses, add the VM's public IP.

### Option B: Azure Database for PostgreSQL Flexible Server

Portal → **Azure Database for PostgreSQL flexible servers → Create**:

| Setting | Value |
|---|---|
| Resource group | `tradedojo-rg` |
| Server name | e.g. `tradedojo-db` |
| Region | Central India (same as the VM) |
| PostgreSQL version | 16 |
| Workload / Compute | Development; **Burstable B1ms** (the free-eligible size) |
| Storage | 32 GB |
| Authentication | PostgreSQL authentication; choose an admin user and a strong password |
| Networking | Public access; add a firewall rule for the **VM's public IP** only |

After it's created, open the server → **Databases → Add**, name it `tradedojo`.

Your connection string is:

```
postgres://ADMIN_USER:PASSWORD@tradedojo-db.postgres.database.azure.com:5432/tradedojo?sslmode=verify-full
```

`sslmode=verify-full` makes the backend check Azure's certificate using the root certificates built into Node.js, so you don't need a CA file for Azure. If the password has special characters (`@`, `:`, `/`, `#`…), URL-encode them.

---

## Part 5: Configure the backend

Create the settings file:

```bash
sudo -H -u tradedojo cp /opt/trade-dojo/backend/.env.example /opt/trade-dojo/backend/.env
sudo -H -u tradedojo nano /opt/trade-dojo/backend/.env
sudo chmod 600 /opt/trade-dojo/backend/.env
```

Set these values (leave the rest as they are):

```ini
PORT=4000
# Only Caddy on the same machine talks to the backend.
HOST=127.0.0.1
# Your frontend URL (Part 7). Comma-separate several.
CORS_ORIGINS=https://YOUR-FRONTEND-URL
# Long random string, e.g. from: openssl rand -hex 32
JWT_SECRET=...

# Option A (Aiven): URI without ?sslmode=require, plus the CA file
DATABASE_URL=postgres://avnadmin:...@....aivencloud.com:12345/defaultdb
DB_CA_CERT_PATH=/opt/trade-dojo/backend/ca.pem
# Option B (Azure): URI with ?sslmode=verify-full and no CA file
# DATABASE_URL=postgres://...@tradedojo-db.postgres.database.azure.com:5432/tradedojo?sslmode=verify-full
# DB_CA_CERT_PATH=

ADMIN_EMAIL=you@example.com
ADMIN_PASSWORD=...

PRICE_PROVIDER=upstox
UPSTOX_ANALYTICS_TOKEN=...
BACKFILL_ON_START=1
```

For **Aiven**, copy the CA certificate onto the VM, e.g. from your laptop:

```bash
scp -i ~/Downloads/tradedojo-vm_key.pem ca.pem azureuser@tradedojo.centralindia.cloudapp.azure.com:/tmp/ca.pem
# then on the VM:
sudo mv /tmp/ca.pem /opt/trade-dojo/backend/ca.pem
sudo chown tradedojo:tradedojo /opt/trade-dojo/backend/ca.pem && sudo chmod 600 /opt/trade-dojo/backend/ca.pem
```

---

## Part 6: Run it as a service, behind HTTPS

Install the service (it starts the backend now and after every reboot or crash):

```bash
sudo cp /opt/trade-dojo/deploy/azure/tradedojo.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now tradedojo
sudo systemctl status tradedojo --no-pager
```

Watch the logs. On first start it creates the tables, creates the admin, connects to Upstox and starts downloading history:

```bash
sudo journalctl -u tradedojo -f
```

You should see `[api] TradeDojo backend listening on http://127.0.0.1:4000`. Press Ctrl+C to stop watching.

Set up HTTPS with Caddy (replace the DNS name with yours):

```bash
sudo cp /opt/trade-dojo/deploy/azure/Caddyfile /etc/caddy/Caddyfile
sudo sed -i 's/YOUR-DNS-NAME/tradedojo.centralindia.cloudapp.azure.com/' /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

Check from your laptop:

```bash
curl https://tradedojo.centralindia.cloudapp.azure.com/api/health
```

It should return `{"ok":true,...}`. If Caddy can't get a certificate, check that ports 80 and 443 are open in the VM's network settings and that the DNS name is right (`sudo journalctl -u caddy -n 50`).

Optional: add the demo users:

```bash
cd /opt/trade-dojo/backend && sudo -H -u tradedojo npm run seed:demo
```

---

## Part 7: The frontend

### Option A: Azure Static Web Apps (free tier)

1. Portal → **Static Web Apps → Create**. Plan: **Free**. Source: **GitHub**, pick the repository and the `main` branch.
2. Build details: preset **Custom**, app location `frontend`, api location empty, output location `dist`.
3. Azure adds a GitHub Actions workflow file to the repository. Open it (in `.github/workflows/`) and add the backend URL to the build step, under the `Azure/static-web-apps-deploy` step:

   ```yaml
           env:
             VITE_API_URL: https://tradedojo.centralindia.cloudapp.azure.com
   ```

   Commit; the next run builds with it.
4. `frontend/public/staticwebapp.config.json` (already in the repo) makes links like `/trades/12` load the app.
5. Copy the site URL (e.g. `https://xxxx.azurestaticapps.net`) into `CORS_ORIGINS` in the backend `.env`, then `sudo systemctl restart tradedojo`.

### Option B: Cloudflare Pages

Same as README section 6, with `VITE_API_URL=https://tradedojo.centralindia.cloudapp.azure.com`.

Open the site, log in with your admin account, and check **Admin → Feed health**: the WebSocket should say `connected`, the token `valid`, and active contracts should be listed. During market hours, prices should move on the Trade screen.

---

## Part 8: Updating after code changes

Allow the `tradedojo` user to restart its own service (and nothing else) without a password:

```bash
echo 'tradedojo ALL=(root) NOPASSWD: /usr/bin/systemctl restart tradedojo' | sudo tee /etc/sudoers.d/tradedojo
sudo chmod 440 /etc/sudoers.d/tradedojo
```

Then, after merging changes on GitHub:

```bash
sudo -H -u tradedojo /opt/trade-dojo/deploy/azure/update.sh
```

It pulls, reinstalls, rebuilds and restarts. Database migrations run automatically on startup. The frontend redeploys by itself on every push to `main` (Static Web Apps and Cloudflare both watch the branch).

---

## Part 9: Day-to-day operations

| Task | Command |
|---|---|
| Is it running? | `sudo systemctl status tradedojo` |
| Live logs | `sudo journalctl -u tradedojo -f` |
| Logs since this morning | `sudo journalctl -u tradedojo --since today` |
| Restart | `sudo systemctl restart tradedojo` |
| Caddy logs | `sudo journalctl -u caddy -n 100` |
| Disk space | `df -h` |
| Memory | `free -h` |

- **Upstox token**: it expires after a year. Admin → Feed health shows the date. To replace it, edit `UPSTOX_ANALYTICS_TOKEN` in `.env` and restart.
- **Security updates**: run `sudo apt update && sudo apt -y upgrade` now and then (or enable `unattended-upgrades`, which Ubuntu usually has on by default).
- **Backups**: Aiven and Azure PostgreSQL both take automatic backups; check the retention period in their consoles.
- **Run exactly one backend**: don't start a second VM with the same database and token. It would open a second Upstox connection and split replay sessions.
- **Stopping costs**: if you stop the VM from the portal, choose **Stop (deallocate)** so compute isn't billed; the public IP may still be.

---

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `curl .../api/health` times out | Ports 80/443 not open in the VM's network settings, or Caddy not running |
| Caddy logs mention ACME / certificate errors | DNS name typo in the Caddyfile, or port 80 blocked (Let's Encrypt checks over port 80) |
| Service keeps restarting | Run `sudo journalctl -u tradedojo -n 50`; usually a missing or wrong `.env` value (the app prints which one) |
| `ECONNREFUSED` / timeout to the database | The database firewall doesn't allow the VM's public IP |
| `self-signed certificate` / SSL errors (Aiven) | `DB_CA_CERT_PATH` wrong, or `?sslmode=require` left in the Aiven URI |
| Browser shows CORS errors | `CORS_ORIGINS` doesn't exactly match the frontend URL (scheme, no trailing slash) |
| "Live prices unavailable" | Token missing/expired, or the VM can't reach Upstox; see Admin → Feed health → Recent errors |
| `npm ci` killed / out of memory | The swap file from Part 2 isn't active (`swapon --show`) |
