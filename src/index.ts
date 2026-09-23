/**
 * TRMNL MLS Plugin — Cloudflare Worker
 *
 * GET /mls?team={espn_team_id}
 * Returns a TRMNL-compatible merge_variables payload with:
 *   - Team name, record, conference, points, standing position
 *   - Last completed result
 *   - Next 2 upcoming fixtures
 */

const ESPN_BASE = "https://site.api.espn.com/apis/site/v2/sports/soccer/usa.1";
const ESPN_STANDINGS = "https://site.api.espn.com/apis/v2/sports/soccer/usa.1/standings";

// ── Types ────────────────────────────────────────────────────────────────────

interface Competitor {
  homeAway: "home" | "away";
  team: { id: string; displayName: string; abbreviation: string };
  score: string | { displayValue: string; winner?: boolean };
  winner?: boolean;
}

interface EspnEvent {
  id: string;
  date: string;
  name: string;
  competitions: Array<{
    status: { type: { completed: boolean; description: string } };
    competitors: Competitor[];
    venue?: { fullName: string };
  }>;
}

interface StandingsEntry {
  team: { id: string; displayName: string };
  stats: Array<{ name: string; value: number; displayValue: string }>;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function getScore(score: string | { displayValue: string }): string {
  if (typeof score === "string") return score;
  return score?.displayValue ?? "?";
}

function formatDate(isoDate: string): string {
  const d = new Date(isoDate);
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "America/New_York",
  });
}

function formatTime(isoDate: string): string {
  const d = new Date(isoDate);
  return (
    d.toLocaleTimeString("en-US", {
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

function statValue(stats: StandingsEntry["stats"], name: string): string {
  return stats.find((s) => s.name === name)?.displayValue ?? "?";
}

// ── ESPN Fetchers ─────────────────────────────────────────────────────────────

async function fetchTeam(teamId: string) {
  const res = await fetch(`${ESPN_BASE}/teams/${teamId}`);
  if (!res.ok) throw new Error(`Team fetch failed: ${res.status}`);
  const data: any = await res.json();
  const team = data.team;
  const recordItems: Array<{ type: string; summary: string }> =
    team?.record?.items ?? [];
  const total = recordItems.find((r: any) => r.type === "total");
  return {
    name: team.displayName as string,
    abbr: team.abbreviation as string,
    record: total?.summary ?? "?",
  };
}

async function fetchSchedule(teamId: string) {
  const year = new Date().getFullYear();
  const res = await fetch(`${ESPN_BASE}/teams/${teamId}/schedule?season=${year}`);
  if (!res.ok) throw new Error(`Schedule fetch failed: ${res.status}`);
  const data: any = await res.json();
  const events: EspnEvent[] = data.events ?? [];

  const completed = events.filter(
    (e) => e.competitions?.[0]?.status?.type?.completed === true
  );
  const upcoming = events.filter(
    (e) => e.competitions?.[0]?.status?.type?.completed === false
  );

  // Last result
  let lastResult: Record<string, unknown> | null = null;
  if (completed.length > 0) {
    const last = completed[completed.length - 1];
    const comp = last.competitions[0];
    const home = comp.competitors.find((c) => c.homeAway === "home")!;
    const away = comp.competitors.find((c) => c.homeAway === "away")!;
    const isHome = home.team.id === teamId;
    const myTeam = isHome ? home : away;
    const opponent = isHome ? away : home;
    const myScore = getScore(myTeam.score);
    const oppScore = getScore(opponent.score);
    const myGoals = parseInt(myScore, 10);
    const oppGoals = parseInt(oppScore, 10);
    const outcome =
      myGoals > oppGoals ? "W" : myGoals < oppGoals ? "L" : "D";
    lastResult = {
      opponent: opponent.team.displayName,
      opponent_abbr: opponent.team.abbreviation,
      score: `${myScore}-${oppScore}`,
      outcome,
      date: formatDate(last.date),
      is_home: isHome,
    };
  }

  // Next 2 upcoming games
  const nextGames = upcoming.slice(0, 2).map((e) => {
    const comp = e.competitions[0];
    const home = comp.competitors.find((c) => c.homeAway === "home")!;
    const away = comp.competitors.find((c) => c.homeAway === "away")!;
    const isHome = home.team.id === teamId;
    const opponent = isHome ? away : home;
    return {
      opponent: opponent.team.displayName,
      opponent_abbr: opponent.team.abbreviation,
      date: formatDate(e.date),
      time: formatTime(e.date),
      is_home: isHome,
    };
  });

  return { lastResult, nextGames };
}

async function fetchStandings(teamId: string) {
  const res = await fetch(ESPN_STANDINGS);
  if (!res.ok) throw new Error(`Standings fetch failed: ${res.status}`);
  const data: any = await res.json();

  const conferences: Array<{ name: string; standings: { entries: StandingsEntry[] } }> =
    data.children ?? [];

  for (const conf of conferences) {
    const entries = conf.standings?.entries ?? [];
    const idx = entries.findIndex((e: any) => e.team?.id === teamId);
    if (idx !== -1) {
      const entry = entries[idx];
      const stats = entry.stats ?? [];
      return {
        conference: conf.name.replace(" Conference", ""),
        position: idx + 1,
        points: statValue(stats, "points"),
        wins: statValue(stats, "wins"),
        losses: statValue(stats, "losses"),
        draws: statValue(stats, "ties"),
      };
    }
  }
  return null;
}

// ── Main Handler ──────────────────────────────────────────────────────────────

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // Health check
    if (url.pathname === "/") {
      return new Response(JSON.stringify({ status: "ok", plugin: "TRMNL MLS" }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    if (url.pathname !== "/mls") {
      return new Response("Not Found", { status: 404 });
    }

    const teamId = url.searchParams.get("team");
    if (!teamId || !/^\d+$/.test(teamId)) {
      return new Response(
        JSON.stringify({ error: "Missing or invalid ?team= parameter" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    try {
      // Fetch all three ESPN sources in parallel
      const [teamInfo, scheduleInfo, standingsInfo] = await Promise.all([
        fetchTeam(teamId),
        fetchSchedule(teamId),
        fetchStandings(teamId),
      ]);

      const { lastResult, nextGames } = scheduleInfo;
      const next1 = nextGames[0] ?? null;
      const next2 = nextGames[1] ?? null;

      const merge_variables: Record<string, unknown> = {
        // Team identity
        team_name: teamInfo.name,
        team_abbr: teamInfo.abbr,
        record: teamInfo.record,

        // Standings
        conference: standingsInfo?.conference ?? "?",
        standing: standingsInfo?.position ?? "?",
        points: standingsInfo?.points ?? "?",
        wins: standingsInfo?.wins ?? "?",
        losses: standingsInfo?.losses ?? "?",
        draws: standingsInfo?.draws ?? "?",

        // Last result
        last_result: lastResult
          ? {
              opponent: lastResult.opponent,
              opponent_abbr: lastResult.opponent_abbr,
              score: lastResult.score,
              outcome: lastResult.outcome,
              date: lastResult.date,
              is_home: lastResult.is_home,
            }
          : null,

        // Upcoming fixtures
        next_game: next1,
        next_game_2: next2,

        // Metadata
        updated_at: formatUpdatedAt(),
        no_upcoming: nextGames.length === 0,
        season_complete: nextGames.length === 0 && lastResult !== null,
      };

      return new Response(JSON.stringify({ merge_variables }), {
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "public, max-age=1800", // cache 30 min
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
