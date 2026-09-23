/**
 * TRMNL MLS Plugin — Cloudflare Worker
 *
 * GET /mls?team={espn_team_id}
 *
 * Uses sports.core.api.espn.com which works from Cloudflare IPs.
 * site.api.espn.com returns 403 from datacenter IPs.
 */

const CORE = "https://sports.core.api.espn.com/v2/sports/soccer/leagues/usa.1";

const MLS_TEAMS: Record<string, string> = {
  "Atlanta United FC": "18418",
  "Austin FC": "20906",
  "CF Montréal": "9720",
  "Charlotte FC": "21300",
  "Chicago Fire FC": "182",
  "Colorado Rapids": "184",
  "Columbus Crew": "183",
  "D.C. United": "193",
  "FC Cincinnati": "18267",
  "FC Dallas": "185",
  "Houston Dynamo FC": "6077",
  "Inter Miami CF": "20232",
  "LA Galaxy": "187",
  "LAFC": "18966",
  "Minnesota United FC": "17362",
  "Nashville SC": "18986",
  "New England Revolution": "189",
  "New York City FC": "17606",
  "New York Red Bulls": "190",
  "Orlando City SC": "12011",
  "Philadelphia Union": "10739",
  "Portland Timbers": "9723",
  "Real Salt Lake": "4771",
  "San Diego FC": "22529",
  "San Jose Earthquakes": "191",
  "Seattle Sounders FC": "9726",
  "Sporting Kansas City": "186",
  "St. Louis CITY SC": "21812",
  "Toronto FC": "7318",
  "Vancouver Whitecaps": "9727",
};

const DEFAULT_TEAM_ID = "20232"; // Inter Miami CF default

function resolveTeamId(param: string | null): string {
  if (!param) return DEFAULT_TEAM_ID;
  const trimmed = param.trim();
  if (!trimmed || trimmed.includes("{{") || trimmed.includes("}}")) {
    return DEFAULT_TEAM_ID;
  }
  if (/^\d+$/.test(trimmed)) return trimmed;
  const match = Object.entries(MLS_TEAMS).find(
    ([name]) => name.toLowerCase() === trimmed.toLowerCase()
  );
  if (match) return match[1];
  return DEFAULT_TEAM_ID;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Fetch JSON, throwing on non-2xx */
async function get<T>(url: string): Promise<T> {
  // ESPN core API uses http:// in $ref links — upgrade to https
  const safeUrl = url.replace(/^http:\/\//, "https://");
  const res = await fetch(safeUrl, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (compatible; TRMNL-MLS-Plugin/1.0)",
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

// ── ESPN Fetchers ─────────────────────────────────────────────────────────────

async function fetchTeamInfo(teamId: string) {
  const data = await get<any>(
    `${CORE}/teams/${teamId}?lang=en&region=us`
  );
  return {
    name: data.displayName as string,
    abbr: data.abbreviation as string,
  };
}

async function fetchRecord(teamId: string) {
  // type 1 = regular season record (works for current season)
  const year = new Date().getFullYear();
  const data = await get<any>(
    `${CORE}/seasons/${year}/types/1/teams/${teamId}/record?lang=en&region=us`
  );
  const total = (data.items ?? []).find((i: any) => i.type === "total");
  const stats = Object.fromEntries(
    (total?.stats ?? []).map((s: any) => [s.name, s.displayValue])
  );
  return {
    record: total?.summary ?? "?",
    wins: stats.wins ?? "?",
    losses: stats.losses ?? "?",
    draws: stats.ties ?? "?",
    points: stats.points ?? "?",
  };
}

async function fetchStandings(teamId: string) {
  // Fetch all events to find standing — use the team events list
  // The core API embeds record + groups on each competitor
  // Instead, walk all events to find the team's group standing
  // Simpler: re-use the record endpoint which contains points
  // For position, fetch the scoreboard-style standing from the team's record groups

  // Fetch the team's season record which includes group/conference info
  const teamData = await get<any>(
    `${CORE}/teams/${teamId}?lang=en&region=us`
  );

  // Try to get conference from team's groups
  const groupsRef: string | undefined = teamData.groups?.["$ref"];

  let conference = "?";
  let position: number | string = "?";

  if (groupsRef) {
    try {
      const groups = await get<any>(groupsRef);
      const items: any[] = groups.items ?? [];
      if (items.length > 0) {
        const groupData = await get<any>(items[0]["$ref"]);
        conference = (groupData.name as string)
          .replace(" Conference", "")
          .replace("Eastern", "East")
          .replace("Western", "West");

        // Fetch standings for this conference group
        const standRef: string | undefined = groupData.standings?.["$ref"];
        if (standRef) {
          const standData = await get<any>(standRef + "&limit=30");
          const entries: any[] = standData.entries ?? [];
          const idx = entries.findIndex(
            (e: any) => e.team?.id === teamId || e.team?.["$ref"]?.includes(`/teams/${teamId}`)
          );
          if (idx !== -1) position = idx + 1;
        }
      }
    } catch {
      // non-critical — fall through with defaults
    }
  }

  return { conference, position };
}

async function fetchSchedule(teamId: string) {
  const year = new Date().getFullYear();

  // Get paginated events for this team
  const data = await get<any>(
    `${CORE}/teams/${teamId}/events?lang=en&region=us&limit=100&season=${year}`
  );

  const refs: string[] = (data.items ?? []).map((i: any) => i["$ref"]);

  if (refs.length === 0) {
    return { lastResult: null, nextGames: [] };
  }

  // Fetch all events in parallel (batched to avoid overload)
  const batchSize = 20;
  const events: any[] = [];
  for (let i = 0; i < refs.length; i += batchSize) {
    const batch = refs.slice(i, i + batchSize);
    const results = await Promise.allSettled(batch.map((r) => get<any>(r)));
    for (const r of results) {
      if (r.status === "fulfilled") events.push(r.value);
    }
  }

  // Sort by date
  events.sort(
    (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime()
  );

  const now = Date.now();
  const completed = events.filter(
    (e) =>
      e.competitions?.[0]?.status?.type?.completed === true ||
      new Date(e.date).getTime() < now - 2 * 60 * 60 * 1000 // > 2h ago
  );
  const upcoming = events.filter(
    (e) =>
      !e.competitions?.[0]?.status?.type?.completed &&
      new Date(e.date).getTime() > now - 60 * 60 * 1000 // not more than 1h ago
  );

  function parseCompetitor(comp: any, myTeamId: string) {
    const competitors: any[] = comp.competitors ?? [];
    const mine = competitors.find(
      (c) =>
        c.team?.id === myTeamId ||
        c.team?.["$ref"]?.includes(`/teams/${myTeamId}`)
    );
    const opp = competitors.find(
      (c) =>
        c.team?.id !== myTeamId &&
        !c.team?.["$ref"]?.includes(`/teams/${myTeamId}`)
    );
    return { mine, opp };
  }

  // Last result
  let lastResult = null;
  if (completed.length > 0) {
    const last = completed[completed.length - 1];
    const comp = last.competitions?.[0];
    if (comp) {
      const { mine, opp } = parseCompetitor(comp, teamId);
      if (mine && opp) {
        const oppTeam = opp.team ?? {};
        const oppName: string =
          oppTeam.displayName ??
          oppTeam.shortDisplayName ??
          oppTeam["$ref"]?.split("/teams/")[1]?.split("?")[0] ??
          "Unknown";
        const oppAbbr: string = oppTeam.abbreviation ?? "?";
        const myScore =
          typeof mine.score === "object"
            ? mine.score?.displayValue ?? mine.score?.value?.toString() ?? "?"
            : mine.score ?? "?";
        const oppScore =
          typeof opp.score === "object"
            ? opp.score?.displayValue ?? opp.score?.value?.toString() ?? "?"
            : opp.score ?? "?";
        const myG = parseFloat(myScore);
        const oppG = parseFloat(oppScore);
        const outcome = isNaN(myG) || isNaN(oppG) ? "?" : myG > oppG ? "W" : myG < oppG ? "L" : "D";
        lastResult = {
          opponent: oppName,
          opponent_abbr: oppAbbr,
          score: `${myScore}-${oppScore}`,
          outcome,
          date: formatDate(last.date),
          is_home: mine.homeAway === "home",
        };
      }
    }
  }

  // Next 2 upcoming
  const nextGames = upcoming.slice(0, 2).map((e) => {
    const comp = e.competitions?.[0];
    const { mine, opp } = parseCompetitor(comp ?? {}, teamId);
    const oppTeam = opp?.team ?? {};
    const oppName: string =
      oppTeam.displayName ??
      oppTeam.shortDisplayName ??
      "Unknown";
    return {
      opponent: oppName,
      opponent_abbr: oppTeam.abbreviation ?? "?",
      date: formatDate(e.date),
      time: formatTime(e.date),
      is_home: mine?.homeAway === "home",
    };
  });

  return { lastResult, nextGames };
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
      const [teamInfo, recordInfo, scheduleInfo] = await Promise.all([
        fetchTeamInfo(teamId),
        fetchRecord(teamId),
        fetchSchedule(teamId),
      ]);

      // Standings is non-critical — don't block on it
      const standingsInfo = await fetchStandings(teamId).catch(() => ({
        conference: "?",
        position: "?",
      }));

      const { lastResult, nextGames } = scheduleInfo;

      const merge_variables: Record<string, unknown> = {
        team_name: teamInfo.name,
        team_abbr: teamInfo.abbr,
        record: recordInfo.record,
        wins: recordInfo.wins,
        losses: recordInfo.losses,
        draws: recordInfo.draws,
        points: recordInfo.points,
        conference: standingsInfo.conference,
        standing: standingsInfo.position,
        last_result: lastResult,
        next_game: nextGames[0] ?? null,
        next_game_2: nextGames[1] ?? null,
        no_upcoming: nextGames.length === 0,
        season_complete: nextGames.length === 0 && lastResult !== null,
        updated_at: formatUpdatedAt(),
      };

      return new Response(JSON.stringify({ merge_variables }), {
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
