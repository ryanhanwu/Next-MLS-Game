# ⚽ TRMNL MLS Plugin

A [TRMNL](https://usetrmnl.com) plugin that shows your MLS team's current season record, standings position, last result, and next two upcoming fixtures — refreshed automatically on every screen update.

Each user picks their own team from a dropdown in the plugin settings. No code to edit, no secrets to configure.

---

## Install the Public Plugin

This plugin is published as a public TRMNL recipe — install it directly, no setup or hosting required:

👉 **[trmnl.com/recipes/485679](https://trmnl.com/recipes/485679)**

---

## What It Shows

```
┌──────────────────────────────────────────────────────┐
│  ⚽  Seattle Sounders FC      #9 Western • 29 pts    │
│     7W - 8L - 9D                                     │
├──────────────────────────────────────────────────────┤
│  LAST RESULT                                         │
│  W   vs Colorado Rapids    2 - 0    Sep 20           │
├──────────────────────────────────────────────────────┤
│  UPCOMING                                            │
│  ▶  @ Portland Timbers           Sep 28  10:00 PM ET │
│  ▶  vs LA Galaxy                 Oct 4    9:30 PM ET │
└──────────────────────────────────────────────────────┘
```

---

## Architecture

```
TRMNL polls → https://trmnl-mls-plugin.<subdomain>.workers.dev/mls?team={{ mls_team_id }}
                  ↓
          Cloudflare Worker fetches 3 ESPN Site API endpoints in parallel
                  ↓
          Returns merge_variables JSON → TRMNL renders Liquid template
```

- **Data source:** ESPN's public Site API (`site.api.espn.com`, league `usa.1`) — unofficial but stable, no API key needed
- **Server:** Cloudflare Worker (free tier: 100k req/day)
- **Deploy:** GitHub Actions on push to `main`

### ESPN endpoints used

| Purpose | Endpoint |
|---|---|
| Standings (conference rank, record, points) | `GET https://site.api.espn.com/apis/v2/sports/soccer/usa.1/standings` |
| Last result (completed matches, newest first) | `GET https://site.api.espn.com/apis/site/v2/sports/soccer/usa.1/teams/{id}/schedule` |
| Next 3 fixtures (upcoming matches) | `GET https://site.api.espn.com/apis/site/v2/sports/soccer/usa.1/teams/{id}/schedule?fixture=true` |

> **Note:** Standings must use `/apis/v2/` — `/apis/site/v2/.../standings` only returns a stub.
>
> The ESPN Core API (`sports.core.api.espn.com`) is **not** used: it returns `403 Forbidden` to requests from Cloudflare Workers and requires many chained `$ref` lookups.
>
> These endpoints are undocumented and may change without notice. See [References](#references).

---

## Customize & Self-Host

Want to tweak the layout or run your own copy? Skip this section if you just installed the [public plugin](#install-the-public-plugin) — it's only needed for self-hosting.

### 1. Clone and deploy the Worker

```bash
git clone https://github.com/YOUR_USERNAME/trmnl-mls-plugin
cd trmnl-mls-plugin
npm install
```

**One-time Cloudflare setup:**
1. Create a free account at [cloudflare.com](https://cloudflare.com)
2. Go to **Workers & Pages** → grab your **Account ID** from the sidebar
3. Create an **API Token** with `Workers Scripts: Edit` permission
4. Add these as GitHub repository secrets:
   - `CF_API_TOKEN` — your Cloudflare API token
   - `CF_ACCOUNT_ID` — your Cloudflare Account ID

Push to `main` — GitHub Actions deploys the Worker automatically. Note your Worker URL (e.g. `https://trmnl-mls-plugin.YOUR-SUBDOMAIN.workers.dev`).

**Test locally first:**
```bash
npm run dev
# Then: curl "http://localhost:8787/mls?team=9726"
```

### 2. Create the TRMNL plugin

1. Log into [usetrmnl.com](https://usetrmnl.com) → **Plugins** → **New Private Plugin**
2. Set **Strategy** to `Polling`
3. Set **Polling URL** to:
   ```
   https://trmnl-mls-plugin.YOUR-SUBDOMAIN.workers.dev/mls?team={{ mls_team_id }}
   ```
4. In the **Custom Fields** section, paste the contents of [`plugin/custom-fields.yml`](plugin/custom-fields.yml)
5. In the **Markup** editor, paste the contents of [`plugin/markup.liquid`](plugin/markup.liquid)
6. Save the plugin

### 3. Configure your team

On the plugin settings page, select your MLS team from the dropdown and save. TRMNL will start polling your Worker and displaying your team's data on the next refresh.

---

## All 30 MLS Teams Supported

| Team | ESPN ID |
|---|---|
| Atlanta United FC | 18418 |
| Austin FC | 20906 |
| CF Montréal | 9720 |
| Charlotte FC | 21300 |
| Chicago Fire FC | 182 |
| Colorado Rapids | 184 |
| Columbus Crew | 183 |
| D.C. United | 193 |
| FC Cincinnati | 18267 |
| FC Dallas | 185 |
| Houston Dynamo FC | 6077 |
| Inter Miami CF | 20232 |
| LA Galaxy | 187 |
| LAFC | 18966 |
| Minnesota United FC | 17362 |
| Nashville SC | 18986 |
| New England Revolution | 189 |
| New York City FC | 17606 |
| New York Red Bulls | 190 |
| Orlando City SC | 12011 |
| Philadelphia Union | 10739 |
| Portland Timbers | 9723 |
| Real Salt Lake | 4771 |
| San Diego FC | 22529 |
| San Jose Earthquakes | 191 |
| Seattle Sounders FC | 9726 |
| Sporting Kansas City | 186 |
| St. Louis CITY SC | 21812 |
| Toronto FC | 7318 |
| Vancouver Whitecaps | 9727 |

---

## Local Development

```bash
npm run dev          # Run Worker locally (Miniflare)
npm run type-check   # TypeScript check
npm run deploy       # Deploy manually to Cloudflare
```

---

## References

- [pseudo-r/Public-ESPN-API](https://github.com/pseudo-r/Public-ESPN-API) — community documentation of ESPN's undocumented public endpoints
  - [Soccer endpoints & league slugs](https://github.com/pseudo-r/Public-ESPN-API/blob/main/docs/sports/soccer.md) (MLS = `usa.1`)
- [TRMNL Plugins docs](https://docs.usetrmnl.com)
- [Cloudflare Workers docs](https://developers.cloudflare.com/workers/)

---

## License

MIT
