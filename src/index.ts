/**
 * TRMNL MLS Plugin — Cloudflare Worker
 *
 * GET /mls?team={team_name_or_id}
 *
 * Returns MLS team stats, conference standing, and upcoming fixtures
 * formatted for TRMNL polling plugins.
 */

const CORE = "https://sports.core.api.espn.com/v2/sports/soccer/leagues/usa.1";

interface TeamMeta {
  name: string;
  abbr: string;
  conf: "East" | "West";
}

const MLS_TEAMS_DATA: Record<string, TeamMeta> = {
  "18418": { name: "Atlanta United FC", abbr: "ATL", conf: "East" },
  "20906": { name: "Austin FC", abbr: "ATX", conf: "West" },
  "9720":  { name: "CF Montréal", abbr: "MTL", conf: "East" },
  "21300": { name: "Charlotte FC", abbr: "CLT", conf: "East" },
  "182":   { name: "Chicago Fire FC", abbr: "CHI", conf: "East" },
  "184":   { name: "Colorado Rapids", abbr: "COL", conf: "West" },
  "183":   { name: "Columbus Crew", abbr: "CLB", conf: "East" },
  "193":   { name: "D.C. United", abbr: "DC", conf: "East" },
  "18267": { name: "FC Cincinnati", abbr: "CIN", conf: "East" },
  "185":   { name: "FC Dallas", abbr: "DAL", conf: "West" },
  "6077":  { name: "Houston Dynamo FC", abbr: "HOU", conf: "West" },
  "20232": { name: "Inter Miami CF", abbr: "MIA", conf: "East" },
  "187":   { name: "LA Galaxy", abbr: "LA", conf: "West" },
  "18966": { name: "LAFC", abbr: "LAFC", conf: "West" },
  "17362": { name: "Minnesota United FC", abbr: "MIN", conf: "West" },
  "18986": { name: "Nashville SC", abbr: "NSH", conf: "East" },
  "189":   { name: "New England Revolution", abbr: "NE", conf: "East" },
  "17606": { name: "New York City FC", abbr: "NYC", conf: "East" },
  "190":   { name: "New York Red Bulls", abbr: "RBNY", conf: "East" },
  "12011": { name: "Orlando City SC", abbr: "ORL", conf: "East" },
  "10739": { name: "Philadelphia Union", abbr: "PHI", conf: "East" },
  "9723":  { name: "Portland Timbers", abbr: "POR", conf: "West" },
  "4771":  { name: "Real Salt Lake", abbr: "RSL", conf: "West" },
  "22529": { name: "San Diego FC", abbr: "SD", conf: "West" },
  "191":   { name: "San Jose Earthquakes", abbr: "SJ", conf: "West" },
  "9726":  { name: "Seattle Sounders FC", abbr: "SEA", conf: "West" },
  "186":   { name: "Sporting Kansas City", abbr: "SKC", conf: "West" },
  "21812": { name: "St. Louis CITY SC", abbr: "STL", conf: "West" },
  "7318":  { name: "Toronto FC", abbr: "TOR", conf: "East" },
  "9727":  { name: "Vancouver Whitecaps", abbr: "VAN", conf: "West" },
};

const DEFAULT_TEAM_ID = "20232"; // Inter Miami CF

function resolveTeamId(param: string | null): string {
  if (!param) return DEFAULT_TEAM_ID;
  const trimmed = param.trim();
  if (!trimmed || trimmed.includes("{{") || trimmed.includes("}}")) {
    return DEFAULT_TEAM_ID;
  }
  if (/^\d+$/.test(trimmed) && MLS_TEAMS_DATA[trimmed]) {
    return trimmed;
  }
  const match = Object.entries(MLS_TEAMS_DATA).find(
    ([, meta]) => meta.name.toLowerCase() === trimmed.toLowerCase()
  );
  if (match) return match[0];
  return DEFAULT_TEAM_ID;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function get<T>(url: string): Promise<T> {
  const safeUrl = url.replace(/^http:\/\//, "https://");
  const res = await fetch(safeUrl, {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; TRMNL-MLS-Plugin/1.0)",
    },
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} — ${safeUrl}`);
  return res.json() as Promise<T>;
}

function formatDate(isoDate: string): string {
  return new Date(isoDate).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "America/New_York",
  });
}

function formatTime(isoDate: string): string {
  return (
    new Date(isoDate).toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
      timeZone: "America/New_York",
      hour12: true,
    }) + " ET"
  );
}

function formatUpdatedAt(): string {
  return new Date().toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: "America/New_York",
  });
}

// ── Data Fetcher ──────────────────────────────────────────────────────────────

async function getTeamData(teamId: string) {
  const teamMeta = MLS_TEAMS_DATA[teamId] || {
    name: "Unknown FC",
    abbr: "MLS",
    conf: "East" as const,
  };
  const groupId = teamMeta.conf === "West" ? "2" : "1";
  const currentYear = new Date().getFullYear();

  let rank = "?";
  let points = "?";
  let wins = "?";
  let losses = "?";
  let draws = "?";
  let record = "?";

  // 1. Fetch conference standings for position, points, and W/D/L
  try {
    const standData = await get<any>(
      `${CORE}/seasons/${currentYear}/types/1/groups/${groupId}/standings/0?lang=en&region=us`
    );
    const standings: any[] = standData.standings ?? [];
    for (let i = 0; i < standings.length; i++) {
      const it = standings[i];
      if (it.team?.["$ref"]?.includes(`/teams/${teamId}`)) {
        const rec = it.records?.[0];
        const stats = Object.fromEntries(
          (rec?.stats ?? []).map((s: any) => [s.name, s.displayValue])
        );
        rank = stats.rank ?? String(i + 1);
        points = stats.points ?? "?";
        wins = stats.wins ?? "?";
        losses = stats.losses ?? "?";
        draws = stats.ties ?? "?";
        record = rec?.summary ?? `${wins}-${draws}-${losses}`;
        break;
      }
    }
  } catch (err) {
    console.error("Standings fetch error:", err);
  }

  // 2. Fetch events / schedule
  let lastResult: any = null;
  const nextGames: any[] = [];

  try {
    const evData = await get<any>(
      `${CORE}/teams/${teamId}/events?lang=en&region=us&limit=10&season=${currentYear}`
    );
    const refs: string[] = (evData.items ?? []).map((i: any) => i["$ref"]);

    for (const ref of refs.slice(0, 4)) {
      try {
        const ev = await get<any>(ref);
        const comp = ev.competitions?.[0];
        const comps: any[] = comp?.competitors ?? [];
        const myComp = comps.find(
          (c) => c.id === teamId || c.team?.["$ref"]?.includes(`/teams/${teamId}`)
        );
        const oppComp = comps.find(
          (c) => c.id !== teamId && !c.team?.["$ref"]?.includes(`/teams/${teamId}`)
        );
        const opp = (oppComp?.id && MLS_TEAMS_DATA[oppComp.id]) || {
          name: ev.name ?? "Opponent",
          abbr: "?",
        };

        const eventTime = new Date(ev.date).getTime();
        const isCompleted =
          comp?.status?.type?.completed === true ||
          eventTime < Date.now() - 3 * 3600 * 1000;

        if (isCompleted && !lastResult) {
          lastResult = {
            opponent: opp.name,
            opponent_abbr: opp.abbr,
            score: "FT",
            outcome: myComp?.winner ? "W" : oppComp?.winner ? "L" : "D",
            date: formatDate(ev.date),
            is_home: myComp?.homeAway === "home",
          };
        } else if (!isCompleted && nextGames.length < 2) {
          nextGames.push({
            opponent: opp.name,
            opponent_abbr: opp.abbr,
            date: formatDate(ev.date),
            time: formatTime(ev.date),
            is_home: myComp?.homeAway === "home",
          });
        }
      } catch (e) {
        console.error("Event fetch error:", e);
      }
    }
  } catch (err) {
    console.error("Events fetch error:", err);
  }

  return {
    team_name: teamMeta.name,
    team_abbr: teamMeta.abbr,
    record,
    wins,
    losses,
    draws,
    points,
    conference: teamMeta.conf,
    standing: rank,
    last_result: lastResult,
    next_game: nextGames[0] ?? null,
    next_game_2: nextGames[1] ?? null,
    no_upcoming: nextGames.length === 0,
    season_complete: nextGames.length === 0 && lastResult !== null,
    updated_at: formatUpdatedAt(),
  };
}

// ── Main Handler ──────────────────────────────────────────────────────────────

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/") {
      return new Response(JSON.stringify({ status: "ok", plugin: "TRMNL MLS" }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    if (url.pathname !== "/mls") {
      return new Response("Not Found", { status: 404 });
    }

    const rawTeam = url.searchParams.get("team");
    const teamId = resolveTeamId(rawTeam);

    try {
      const data = await getTeamData(teamId);

      // Return data at root level (what TRMNL expects) AND nested under merge_variables
      const responsePayload = {
        ...data,
        merge_variables: data,
      };

      return new Response(JSON.stringify(responsePayload), {
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "public, max-age=1800",
        },
      });
    } catch (err: any) {
      console.error("ESPN fetch error:", err);
      return new Response(
        JSON.stringify({ error: "Failed to fetch MLS data", detail: err.message }),
        { status: 502, headers: { "Content-Type": "application/json" } }
      );
    }
  },
};
