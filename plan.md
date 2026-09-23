# TRMNL MLS Plugin — Shareable Edition

A shareable TRMNL plugin where each user picks their MLS team from a dropdown in the plugin settings UI. No GitHub forks, no secrets to configure — just install and choose.

---

## Architecture Pivot: Webhook → Polling

The original plan used **Webhook** strategy (GitHub Actions pushes data to TRMNL). That's great for personal use, but it can't know _which user_ wants _which team_.

**Polling strategy** inverts the flow — TRMNL calls _your_ server on a schedule. User-selected settings (like team ID) are injected into the URL automatically per-user. This enables full shareability:

```
User installs plugin → picks "Inter Miami" from dropdown
                               ↓
Every hour: TRMNL polls → https://your-server.com/mls?team=17012
                               ↓
           Server fetches ESPN API, shapes payload
                               ↓
           Returns JSON → TRMNL renders Liquid template
```

> [!NOTE]
> **GitHub Actions is still used** — but now as your CI/CD pipeline to deploy the server, not as the data fetcher itself.

---

## Two Sharing Paths

| Path | Effort | Who can install |
|---|---|---|
| **Recipe** (submit to TRMNL) | Medium — TRMNL team approves | All TRMNL users, appears in marketplace |
| **Third-party plugin** | Most control, you host server | Anyone you share the install link with |

**Recommended: build as a Third-party plugin first**, then submit as a Recipe once it's stable.

---

## Open Questions

> [!IMPORTANT]
> **Server hosting** — The polling server needs to be always-on. The cheapest options are a free-tier **Cloudflare Worker** (zero cold starts, 100k req/day free) or **Railway** (free hobby tier). Do you have a preference, or should we default to Cloudflare Worker (zero infra to manage)?

> [!NOTE]
> **ESPN API caveat** — Still using ESPN's internal endpoints (`site.api.espn.com`). Unofficial but widely used. No API key needed.

---

## Proposed Repository Structure

```
trmnl-mls-plugin/
├── .github/
│   └── workflows/
│       └── deploy.yml           ← Deploy server to Cloudflare on push to main
├── src/
│   └── index.ts                 ← Cloudflare Worker (TypeScript): ESPN → TRMNL JSON
├── plugin/
│   ├── markup.liquid            ← TRMNL Liquid template
│   └── custom-fields.yml        ← Team dropdown config (TRMNL form builder)
├── README.md
├── wrangler.toml                ← Cloudflare Worker config
└── package.json
```

---

## Proposed Changes

### 1. TRMNL Plugin Config — `plugin/custom-fields.yml`

This YAML defines the **team dropdown** that appears in each user's plugin settings:

```yaml
- keyname: mls_team_id
  field_type: select
  name: MLS Team
  description: Select your MLS team to follow
  options:
    - ["Atlanta United FC", "17012"]
    - ["Austin FC", "19538"]
    - ["Charlotte FC", "20232"]
    - ["Chicago Fire FC", "256"]
    - ["FC Cincinnati", "17892"]
    - ["Colorado Rapids", "253"]
    - ["Columbus Crew", "254"]
    - ["D.C. United", "255"]
    - ["FC Dallas", "258"]
    - ["Houston Dynamo FC", "2691"]
    - ["Inter Miami CF", "20232"]
    - ["LA Galaxy", "9"]
    - ["LAFC", "17012"]
    - ["Minnesota United FC", "17021"]
    - ["CF Montréal", "16572"]
    - ["Nashville SC", "20195"]
    - ["New England Revolution", "257"]
    - ["NY City FC", "17012"]
    - ["NY Red Bulls", "236"]
    - ["Orlando City SC", "17012"]
    - ["Philadelphia Union", "16629"]
    - ["Portland Timbers", "1581"]
    - ["Real Salt Lake", "11690"]
    - ["San Jose Earthquakes", "252"]
    - ["Seattle Sounders FC", "1686"]
    - ["Sporting Kansas City", "259"]
    - ["St. Louis City SC", "21492"]
    - ["Toronto FC", "9714"]
    - ["Vancouver Whitecaps FC", "1708"]
```

### 2. TRMNL Polling URL (set in plugin config)

```
https://your-worker.your-subdomain.workers.dev/mls?team={{ mls_team_id }}
```

TRMNL substitutes `{{ mls_team_id }}` with the user's selection automatically.

---

### 3. Server — `src/index.ts` (Cloudflare Worker)

Handles `GET /mls?team={id}`:

1. Fetches 3 ESPN endpoints in parallel:
   - `teams/{id}` → team name, record, conference
   - `standings` → find team's position + points
   - `teams/{id}/schedule` → last result + next 2 upcoming games
2. Shapes data into `merge_variables` JSON (≤ 2 KB)
3. Returns JSON response

**Response shape:**
```json
{
  "merge_variables": {
    "team_name": "Inter Miami CF",
    "team_abbr": "MIA",
    "wins": 18,
    "losses": 6,
    "draws": 4,
    "points": 58,
    "standing": 1,
    "conference": "Eastern",
    "last_result_opponent": "Nashville SC",
    "last_result_score": "3-1",
    "last_result_outcome": "W",
    "last_result_date": "Sep 20",
    "next_game_opponent": "Atlanta United",
    "next_game_date": "Sep 27",
    "next_game_time": "7:30 PM ET",
    "next_game_home": true,
    "next_game_2_opponent": "Charlotte FC",
    "next_game_2_date": "Oct 2",
    "next_game_2_time": "8:00 PM ET",
    "next_game_2_home": false,
    "updated_at": "Sep 22, 8:00 PM"
  }
}
```

---

### 4. Liquid Template — `plugin/markup.liquid`

```
┌─────────────────────────────────────────────────────┐
│  ⚽  INTER MIAMI CF          1st East  •  58 pts     │
│     18W - 6L - 4D                                    │
├─────────────────────────────────────────────────────┤
│  LAST RESULT                                         │
│  W  vs Nashville SC     3 - 1     Sep 20             │
├─────────────────────────────────────────────────────┤
│  UPCOMING                                            │
│  ▶  Atlanta United (H)         Sep 27  7:30 PM ET   │
│  ▶  Charlotte FC (A)           Oct 2   8:00 PM ET   │
├─────────────────────────────────────────────────────┤
│  Updated Sep 22, 8:00 PM                            │
└─────────────────────────────────────────────────────┘
```

---

### 5. GitHub Actions — `.github/workflows/deploy.yml`

Auto-deploys the Cloudflare Worker on every push to `main`:

```yaml
- uses: cloudflare/wrangler-action@v3
  with:
    apiToken: ${{ secrets.CF_API_TOKEN }}
```

Secrets needed in the repo: just `CF_API_TOKEN` (one-time Cloudflare setup).

---

## Verification Plan

### Automated
- `wrangler dev` — run Worker locally, hit `localhost:8787/mls?team=9` to verify payload
- Unit test the ESPN data shaping logic

### Manual
1. Deploy to Cloudflare, confirm `GET /mls?team=9` returns valid JSON
2. Set polling URL in TRMNL plugin, select a team
3. Trigger a manual refresh in TRMNL
4. Verify display on device/preview

---

## Submission Path (after it works)

1. **Test privately** with your own TRMNL device
2. **Share a beta link** with a few TRMNL users via the community Discord/forum
3. **Submit as a Recipe** to TRMNL — they'll host it in the marketplace and it becomes a one-click install for all users
