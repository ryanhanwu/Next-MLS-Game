/**
 * TRMNL MLS Plugin — Cloudflare Worker
 *
 * GET /mls?team={team_name_or_id}
 *
 * Returns MLS team stats, conference standing, last result, and next 3 upcoming games.
 * Uses public site-facing ESPN APIs (site.api.espn.com).
 */

const SITE_API = "https://site.api.espn.com";

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

const DEFAULT_TEAM_ID = "20232"; // Inter Miami CF default

function resolveTeamId(param: string | null): string {
  if (!param) return DEFAULT_TEAM_ID;
  const trimmed = param.trim();
  if (!trimmed || trimmed.includes("{{") || trimmed.includes("}}")) {
    return DEFAULT_TEAM_ID;
  }
  if (/^\d+$/.test(trimmed) && MLS_TEAMS_DATA[trimmed]) {
    return trimmed;
  }
  const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const normalizedParam = normalize(trimmed);

  // 1. Exact name or abbreviation match
  const exactMatch = Object.entries(MLS_TEAMS_DATA).find(
    ([, meta]) => normalize(meta.name) === normalizedParam || normalize(meta.abbr) === normalizedParam
  );
  if (exactMatch) return exactMatch[0];

  // 2. Substring match
  const partialMatch = Object.entries(MLS_TEAMS_DATA).find(
    ([, meta]) => normalize(meta.name).includes(normalizedParam)
  );
  if (partialMatch) return partialMatch[0];

  return DEFAULT_TEAM_ID;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function get<T>(url: string): Promise<T> {
  const safeUrl = url.replace(/^http:\/\//, "https://");
  const res = await fetch(safeUrl, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
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

  let rank = "?";
  let points = "?";
  let wins = "?";
  let losses = "?";
  let draws = "?";
  let record = "?";
  let confName: string = teamMeta.conf;

  let lastResult: any = null;
  const nextGames: any[] = [];

  // Fetch standings, past schedule, and upcoming fixtures concurrently
  const [standingsRes, scheduleRes, fixturesRes] = await Promise.allSettled([
    get<any>(`${SITE_API}/apis/v2/sports/soccer/usa.1/standings`),
    get<any>(`${SITE_API}/apis/site/v2/sports/soccer/usa.1/teams/${teamId}/schedule`),
    get<any>(`${SITE_API}/apis/site/v2/sports/soccer/usa.1/teams/${teamId}/schedule?fixture=true`),
  ]);

  // 1. Process Standings
  if (standingsRes.status === "fulfilled") {
    try {
      const standData = standingsRes.value;
      for (const conf of standData.children || []) {
        const cName = conf.name?.includes("Eastern")
          ? "East"
          : conf.name?.includes("Western")
          ? "West"
          : conf.name;

        for (const entry of conf.standings?.entries || []) {
          if (entry.team?.id === teamId) {
            confName = cName;
            const stats: Record<string, string> = {};
            for (const s of entry.stats || []) {
              stats[s.name] = String(s.displayValue ?? s.value ?? "");
              if (s.name === "overall" || s.id === "0") {
                stats.record = s.summary ?? s.displayValue;
              }
            }
            rank = stats.rank ?? "?";
            points = stats.points ?? "?";
            wins = stats.wins ?? "?";
            losses = stats.losses ?? "?";
            draws = stats.ties ?? "?";
            record = stats.record ?? `${wins}-${draws}-${losses}`;
            break;
          }
        }
      }
    } catch (err) {
      console.error("Standings parse error:", err);
    }
  } else {
    console.error("Standings fetch error:", standingsRes.reason);
  }

  // 2. Process Past Schedule (Last Completed Result)
  if (scheduleRes.status === "fulfilled") {
    try {
      const schedData = scheduleRes.value;
      const completedEvents = (schedData.events || []).filter((e: any) => {
        const comp = e.competitions?.[0];
        return comp?.status?.type?.completed || comp?.status?.type?.state === "post";
      });

      // Events are sorted newest first
      const lastEv = completedEvents[0];
      if (lastEv) {
        const comp = lastEv.competitions?.[0];
        const comps: any[] = comp?.competitors || [];
        const myComp = comps.find((c) => c.id === teamId);
        const oppComp = comps.find((c) => c.id !== teamId);
        const oppMeta = (oppComp?.id && MLS_TEAMS_DATA[oppComp.id]) || {
          name: oppComp?.team?.displayName || lastEv.name || "Opponent",
          abbr: oppComp?.team?.abbreviation || "?",
        };

        const myScore = String(myComp?.score?.displayValue ?? myComp?.score?.value ?? "?");
        const oppScore = String(oppComp?.score?.displayValue ?? oppComp?.score?.value ?? "?");

        let outcome = "?";
        if (myComp?.winner === true) outcome = "W";
        else if (oppComp?.winner === true) outcome = "L";
        else if (myScore !== "?" && oppScore !== "?" && myScore === oppScore) outcome = "D";

        lastResult = {
          opponent: oppMeta.name,
          opponent_abbr: oppMeta.abbr,
          score: `${myScore}-${oppScore}`,
          outcome,
          date: formatDate(lastEv.date),
          is_home: myComp?.homeAway === "home",
        };
      }
    } catch (err) {
      console.error("Schedule parse error:", err);
    }
  } else {
    console.error("Schedule fetch error:", scheduleRes.reason);
  }

  // 3. Process Fixtures (Next Upcoming Matches)
  if (fixturesRes.status === "fulfilled") {
    try {
      const fixData = fixturesRes.value;
      const upcomingEvents = (fixData.events || []).filter((e: any) => {
        const comp = e.competitions?.[0];
        return !comp?.status?.type?.completed && comp?.status?.type?.state !== "post";
      });

      for (const upEv of upcomingEvents.slice(0, 3)) {
        const comp = upEv.competitions?.[0];
        const comps: any[] = comp?.competitors || [];
        const myComp = comps.find((c) => c.id === teamId);
        const oppComp = comps.find((c) => c.id !== teamId);
        const oppMeta = (oppComp?.id && MLS_TEAMS_DATA[oppComp.id]) || {
          name: oppComp?.team?.displayName || upEv.name || "Opponent",
          abbr: oppComp?.team?.abbreviation || "?",
        };

        nextGames.push({
          opponent: oppMeta.name,
          opponent_abbr: oppMeta.abbr,
          date: formatDate(upEv.date),
          time: formatTime(upEv.date),
          is_home: myComp?.homeAway === "home",
        });
      }
    } catch (err) {
      console.error("Fixtures parse error:", err);
    }
  } else {
    console.error("Fixtures fetch error:", fixturesRes.reason);
  }

  return {
    team_name: teamMeta.name,
    team_abbr: teamMeta.abbr,
    record,
    wins,
    losses,
    draws,
    points,
    conference: confName,
    standing: rank,
    last_result: lastResult,
    next_game: nextGames[0] ?? null,
    next_game_2: nextGames[1] ?? null,
    next_game_3: nextGames[2] ?? null,
    next_games: nextGames,
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

      const responsePayload = {
        ...data,
        merge_variables: data,
      };

      const cacheHeader =
        data.record === "?"
          ? "no-store, no-cache"
          : "public, max-age=1800";

      return new Response(JSON.stringify(responsePayload), {
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": cacheHeader,
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
