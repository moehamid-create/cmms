# CMMS — Go Live (domain + HTTPS + cloud storage)

Your app is now production-ready. It runs anywhere Docker runs.
Storage: **Postgres via `DATABASE_URL`** (free Neon/Supabase — survives restarts/deploys on Render's free plan),
or SQLite file at `DATA_DIR` (needs a paid disk).
Health check = `GET /healthz`.

## Option A — Render free + Neon free = 100% free, permanent storage ✅

**Step 1 — free cloud database (5 min, once):**

1. Go to https://neon.tech → Sign up (free, no credit card)
2. **Create a project** (name `cmms`, region closest to you) → it creates a database `neondb`
3. Open the project → **Connect** → copy the connection string. It looks like:
   `postgresql://user:password@ep-xxxx.region.aws.neon.tech/neondb?sslmode=require`
4. Done with Neon. (Free tier: 3 GB — plenty for this app.)

**Step 2 — plug it into Render:**

1. https://dashboard.render.com → open your `cmms-pmar` service
2. Left menu → **Environment** → **Add Environment Variable**
   - Key: `DATABASE_URL` — Value: *(paste the Neon string)* → Save
3. It redeploys automatically (~3 min) → **Live** 🟢
4. Check `https://cmms-pmar.onrender.com/api/health` — `db` should now say `"postgres"`.
   That means permanent cloud storage is active. Data now survives restarts and redeploys.
5. Login with `admin / 1234` → **change the password immediately** (Users screen).

> First deploy with `DATABASE_URL` seeds a fresh database (admin/1234 etc.).
> Anything you saved while on the temporary disk is a separate copy — re-enter it once.

## Option A — Render (recommended, ~10 min, free HTTPS)

1. Push this folder to GitHub:
   - `git init; git add -A; git commit -m "cmms prod"; gh repo create cmms --public --source=. --push`
   - or upload via github.com → New repo → `git remote add origin <url>; git push -u origin main`
2. Go to https://dashboard.render.com → **New → Web Service → select your repo**
   - Render auto-detects `render.yaml` + `Dockerfile`
   - Disk `/data` (1 GB) is created automatically → this is your cloud storage
   - Wait until **Live** 🟢 at `https://cmms-xxxx.onrender.com`
3. Check: `https://YOUR-APP.onrender.com/healthz` → `ok`
4. Login with `admin / 1234` → **change the password immediately** (Users screen).

### Add your own domain (e.g. `cmms.yourcompany.com`)

1. Buy a domain once (~$10/yr): Cloudflare Registrar, Porkbun, or Namecheap.
2. Render dashboard → your service → **Settings → Custom Domain → Add** → type `cmms.yourdomain.com`
3. Render shows a CNAME target like `cmms-xxxx.onrender.com` — copy it.
4. Go to your DNS (Cloudflare/Porkbun):
   - Type: `CNAME` | Name/Host: `cmms` | Target: `cmms-xxxx.onrender.com` | Proxy: OFF (DNS only) for first 10 min
   - Wait 5–30 min → Render auto-issues free HTTPS (Let's Encrypt) and shows **Verified ✓**
5. Open `https://cmms.yourdomain.com` — done. Full thing: domain + HTTPS + cloud DB disk.

## Option B — Fly.io (Docker, volume = cloud storage)

```bash
fly launch --no-deploy
fly volumes create cmms_data --size 1 --region ruh
fly deploy
fly open
# custom domain:
fly certs add cmms.yourdomain.com
# add CNAME cmms → your-app.fly.dev at your DNS
```

`fly.toml` is already configured (`/data` mount + `/healthz` check).

## Option C — Any VPS (Hetzner/Contabo, ~$5/mo)

```bash
docker build -t cmms .
docker run -d --restart always --name cmms -p 3000:3000 \
  -e DATA_DIR=/data -v cmms-data:/data cmms
# put Caddy/Nginx in front for https://yourdomain.com → http://localhost:3000
```

## Backups (important — do this weekly)

Render disk ≠ backup. Download a copy:

```bash
# from running container / Render shell:
cat /data/cmms.db > backup-$(date +%F).db
```

Or: Render dashboard → Shell → `cp /data/cmms.db /tmp/` then download.

## Change default passwords NOW

`server.js` seeds `admin/1234, eng/1234, ...`. After first login, change every password
from the app's Users screen, or delete demo users you don't need.

## Files added for launch

- `server.js` → `DATA_DIR` persistent path, `/healthz`, rate-limit, security headers, SPA fallback, fixed `/api` base for hosted domains
- `public/index.html` → `API_BASE=' /api'` on any domain (was broken on port 443 before)
- `Dockerfile` (prod), `.dockerignore`, `render.yaml` (web + 1GB disk), `fly.toml`
