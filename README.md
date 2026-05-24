# ReturnLink

Smarter returns — drop off locally, save shipping costs.

Stack: vanilla JS PWA + Netlify (static + serverless function) + Railway (Express + lowdb).

## Repository layout

```
.
├── public/                 → Netlify publish dir (the PWA)
│   ├── index.html          → app shell + UI
│   ├── manifest.json       → PWA manifest
│   ├── sw.js               → service worker (offline + caching)
│   ├── favicon.svg
│   ├── icon-192.png
│   ├── icon-512.png
│   ├── icon-192-maskable.png
│   ├── icon-512-maskable.png
│   └── apple-touch-icon.png
├── netlify/
│   └── functions/
│       └── ai-match.js     → calls Anthropic API for AI partner matching
├── server/                 → Railway service (separate deployment)
│   ├── server.js           → Express + lowdb REST API
│   └── package.json
├── netlify.toml            → publish/functions config + headers
├── .env.example            → required env vars for both deployments
└── README.md
```

## Deploy — frontend + AI function (Netlify)

1. Push this repo to GitHub.
2. Netlify → **Add new site → Import from GitHub** → pick the repo.
3. Build settings auto-detected from `netlify.toml`:
   - Publish dir: `public`
   - Functions dir: `netlify/functions`
4. Site settings → **Environment variables** → add:
   - `ANTHROPIC_API_KEY` = your Anthropic API key
5. Deploy.

The AI function will be live at `https://<your-site>.netlify.app/.netlify/functions/ai-match`.

## Deploy — backend (Railway)

1. Railway → **New project → Deploy from GitHub** → pick this repo.
2. Set the **Root directory** to `server` (in the service's settings → Source).
3. Variables tab → add:
   - `ALLOWED_ORIGIN` = your Netlify URL (e.g. `https://returnlink.netlify.app`)
4. Railway auto-detects `npm start`. Deploy.
5. Note the public URL (e.g. `https://returnlink-api.up.railway.app`).

### Wire the frontend to the backend

In `public/index.html`, find the `CONFIG` block near the top of the `<script>`:

```js
const CONFIG = {
  API_BASE: (window.__RETURNLINK_API__ || '').replace(/\/$/, ''),
  ...
};
```

You have two options:

**Option A — hardcode the URL (simplest):**
```js
const CONFIG = {
  API_BASE: 'https://returnlink-api.up.railway.app',
  ...
};
```

**Option B — inject via a small script tag** in `index.html` (lets you keep separate prod/staging):
```html
<script>window.__RETURNLINK_API__ = 'https://returnlink-api.up.railway.app';</script>
```

The frontend gracefully degrades to localStorage if the backend is unreachable, so you can ship without a backend for demos.

## Local dev

```bash
# Backend
cd server
npm install
ALLOWED_ORIGIN=* npm start
# → API on http://localhost:3000

# Frontend (any static server)
cd public
python3 -m http.server 5000
# → http://localhost:5000
```

For local AI function testing, install Netlify CLI:
```bash
npm i -g netlify-cli
netlify dev   # serves public/ + functions on localhost:8888
```

## API reference (Railway backend)

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | Liveness check |
| GET | `/api/state` | Full state snapshot |
| POST | `/api/returns/:id/approve-ai` | Seller approves AI match (body: `partnerId`, `reasoning`, `estimatedCredit`) |
| POST | `/api/returns/:id/approve-ship` | Seller chooses standard shipping |
| POST | `/api/returns/:id/partner` | Customer changes drop-off partner (body: `partnerId`) |
| POST | `/api/returns/:id/skip` | Customer falls back to shipping |
| POST | `/api/scan` | Partner processes drop-off (body: `code`) |
| POST | `/api/reset` | Reset to seed data (for demos) |

## AI function reference

`POST /.netlify/functions/ai-match`

Request:
```json
{
  "product": "Wool sweater · beige · M",
  "partners": [
    { "id": "P1", "name": "Maple Street Dry Cleaners", "specialty": "...", "distance": "0.2 mi" },
    { "id": "P2", "name": "GreenCycle Thrift", "specialty": "...", "distance": "0.4 mi" }
  ]
}
```

Response:
```json
{
  "partner_id": "P1",
  "reasoning": "Dry cleaners can refresh wool garments before resale.",
  "estimated_credit_back": 4.50,
  "source": "ai"
}
```

If the API key is missing, the function fails, or the model returns unparseable JSON, the function returns a heuristic-matched fallback so the frontend never breaks. The frontend has its own heuristic fallback too — defense in depth.

Model used: `claude-haiku-4-5-20251001` (fast + cheap for routing tasks). Estimated cost: well under $1 per 1000 returns.

## Notes on data persistence

The Railway backend uses **lowdb** with a JSON file (`db.json`). For Railway's ephemeral filesystem this is fine for demo / single-instance use. For production:

- Add a Railway **Volume** mounted at `/data` and set `DB_FILE=/data/db.json`, or
- Swap lowdb for Railway Postgres (15-minute change — replace the `Low` instance with a `pg.Pool` and adapt the route handlers).

## What's working

- PWA: installable, offline-capable, runs in standalone mode after install
- Three roles share one source of truth via the backend
- AI-routed returns: Claude picks the best partner from the available list and explains why to the customer
- Graceful degradation: backend down → localStorage; AI down → heuristic fallback; offline entirely → cached app shell still works
- Optimistic UI: every action updates the screen instantly, then syncs to backend
