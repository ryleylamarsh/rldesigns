// sync-ics — Supabase Edge Function
//
// Runs server-side on a schedule (Supabase Cron Trigger, e.g. every 15
// minutes — see ../../README.md for the `select cron.schedule(...)` call).
// Reads every row in `ics_sources` with the service_role key (the only key
// that can — RLS denies anon entirely), fetches each family member's
// secret "Secret address in iCal format" URL, parses VEVENTs with a small
// hand-rolled parser, and upserts the results into the public `events`
// table keyed on `google_event_id`.
//
// Browsers can't fetch Google's .ics URLs directly (no CORS headers on
// that endpoint) — this is why the sync has to happen server-side, not
// just why it's safer.

import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// How far back/forward to materialize recurring event instances. Keeps the
// `events` table bounded even for an indefinitely-recurring RRULE.
const WINDOW_PAST_DAYS = 30;
const WINDOW_FUTURE_DAYS = 180;
const MAX_INSTANCES_PER_EVENT = 200;

Deno.serve(async () => {
  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  const { data: sources, error: sourcesErr } = await supabase
    .from("ics_sources")
    .select("id, family_member_id, ics_url");

  if (sourcesErr) {
    return new Response(JSON.stringify({ error: sourcesErr.message }), { status: 500 });
  }

  const results: Record<string, string> = {};

  for (const source of sources ?? []) {
    try {
      const res = await fetch(source.ics_url, {
        headers: { "User-Agent": "family-wall-calendar-sync/1.0" },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();

      const rows = parseIcsToEventRows(text, source.family_member_id);

      if (rows.length > 0) {
        const { error: upsertErr } = await supabase
          .from("events")
          .upsert(rows, { onConflict: "google_event_id" });
        if (upsertErr) throw upsertErr;
      }

      await supabase
        .from("ics_sources")
        .update({ last_polled_at: new Date().toISOString(), last_status: "ok" })
        .eq("id", source.id);

      results[source.id] = `ok (${rows.length} events)`;
    } catch (err) {
      await supabase
        .from("ics_sources")
        .update({
          last_polled_at: new Date().toISOString(),
          last_status: `error: ${String(err instanceof Error ? err.message : err).slice(0, 200)}`,
        })
        .eq("id", source.id);
      results[source.id] = `error: ${err}`;
    }
  }

  return new Response(JSON.stringify({ results }), {
    headers: { "content-type": "application/json" },
  });
});

// ---------------------------------------------------------------------------
// Minimal ICS (RFC 5545) parsing — just enough for what Google's calendar
// export actually emits, not a general-purpose library.
// ---------------------------------------------------------------------------

interface EventRow {
  google_event_id: string;
  family_member_id: string;
  title: string;
  start_at: string;
  end_at: string | null;
  all_day: boolean;
  location: string | null;
  last_synced_at: string;
}

function parseIcsToEventRows(ics: string, familyMemberId: string): EventRow[] {
  const unfolded = unfoldLines(ics);
  const blocks = extractBlocks(unfolded, "VEVENT");
  const now = new Date();
  const windowStart = new Date(now.getTime() - WINDOW_PAST_DAYS * 86400000);
  const windowEnd = new Date(now.getTime() + WINDOW_FUTURE_DAYS * 86400000);

  const rows: EventRow[] = [];

  for (const block of blocks) {
    const props = parseProps(block);
    const uid = props["UID"]?.value ?? crypto.randomUUID();
    const summary = props["SUMMARY"]?.value ?? "(untitled)";
    const location = props["LOCATION"]?.value || null;
    const dtstart = props["DTSTART"];
    const dtend = props["DTEND"];
    if (!dtstart) continue;

    const start = parseIcsDate(dtstart);
    if (!start) continue;
    const end = dtend ? parseIcsDate(dtend) : null;
    const allDay = dtstart.params.VALUE === "DATE" || /^\d{8}$/.test(dtstart.value);
    const durationMs = end && start ? end.date.getTime() - start.date.getTime() : null;

    const rrule = props["RRULE"]?.value;
    const exdates = new Set(
      (props["EXDATE"]?.value ?? "")
        .split(",")
        .map((v) => v.trim())
        .filter(Boolean)
        .map((v) => parseIcsDate({ value: v, params: dtstart.params })?.date.toISOString().slice(0, 10))
        .filter(Boolean),
    );

    const occurrences = rrule
      ? expandRRule(rrule, start.date, windowStart, windowEnd, MAX_INSTANCES_PER_EVENT)
      : [start.date];

    for (const occStart of occurrences) {
      if (occStart < windowStart || occStart > windowEnd) continue;
      if (exdates.has(occStart.toISOString().slice(0, 10))) continue;
      const occEnd = durationMs !== null ? new Date(occStart.getTime() + durationMs) : null;
      const instanceId = `${uid}::${occStart.toISOString()}`;

      rows.push({
        google_event_id: instanceId,
        family_member_id: familyMemberId,
        title: summary,
        start_at: occStart.toISOString(),
        end_at: occEnd ? occEnd.toISOString() : null,
        all_day: allDay,
        location,
        last_synced_at: now.toISOString(),
      });
    }
  }

  return rows;
}

function unfoldLines(ics: string): string[] {
  const rawLines = ics.split(/\r\n|\n|\r/);
  const lines: string[] = [];
  for (const line of rawLines) {
    if ((line.startsWith(" ") || line.startsWith("\t")) && lines.length > 0) {
      lines[lines.length - 1] += line.slice(1);
    } else {
      lines.push(line);
    }
  }
  return lines;
}

function extractBlocks(lines: string[], tag: string): string[][] {
  const blocks: string[][] = [];
  let current: string[] | null = null;
  for (const line of lines) {
    if (line === `BEGIN:${tag}`) {
      current = [];
    } else if (line === `END:${tag}`) {
      if (current) blocks.push(current);
      current = null;
    } else if (current) {
      current.push(line);
    }
  }
  return blocks;
}

interface IcsProp {
  value: string;
  params: Record<string, string>;
}

function parseProps(lines: string[]): Record<string, IcsProp> {
  const props: Record<string, IcsProp> = {};
  for (const line of lines) {
    const match = line.match(/^([A-Za-z-]+)((?:;[^:]*)?):(.*)$/);
    if (!match) continue;
    const [, rawName, rawParams, value] = match;
    const name = rawName.toUpperCase();
    const params: Record<string, string> = {};
    for (const p of rawParams.split(";").filter(Boolean)) {
      const [k, v] = p.split("=");
      if (k && v) params[k.toUpperCase()] = v;
    }
    // Last one wins if a property repeats (good enough for our fields).
    props[name] = { value, params };
  }
  return props;
}

function parseIcsDate(prop: IcsProp): { date: Date; allDay: boolean } | null {
  const v = prop.value;
  if (/^\d{8}$/.test(v)) {
    const y = +v.slice(0, 4), m = +v.slice(4, 6), d = +v.slice(6, 8);
    return { date: new Date(Date.UTC(y, m - 1, d)), allDay: true };
  }
  const m = v.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, z] = m;
  // Google's exported .ics normalizes timed events to UTC ("Z"). A bare
  // TZID-qualified local time (no Z) is treated as UTC too, which is a
  // deliberate simplification — full IANA timezone-database handling is
  // out of scope for a "small parser" per the build spec.
  return {
    date: new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s)),
    allDay: false,
  };
}

// Minimal RRULE expansion: FREQ=DAILY|WEEKLY|MONTHLY|YEARLY with INTERVAL,
// COUNT, UNTIL, and BYDAY (weekly only). No BYMONTHDAY/BYSETPOS/etc — those
// are rare enough in real family calendars to skip for v1.
function expandRRule(rrule: string, dtstart: Date, windowStart: Date, windowEnd: Date, maxInstances: number): Date[] {
  const parts: Record<string, string> = {};
  for (const p of rrule.split(";")) {
    const [k, v] = p.split("=");
    if (k && v) parts[k.toUpperCase()] = v;
  }
  const freq = parts["FREQ"];
  const interval = parseInt(parts["INTERVAL"] ?? "1", 10) || 1;
  const count = parts["COUNT"] ? parseInt(parts["COUNT"], 10) : null;
  const until = parts["UNTIL"] ? parseIcsDate({ value: parts["UNTIL"], params: {} })?.date ?? null : null;
  const byday = parts["BYDAY"] ? parts["BYDAY"].split(",") : null;
  const dayMap: Record<string, number> = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

  const out: Date[] = [];
  let cursor = new Date(dtstart);
  let n = 0;

  const pushIfInWindow = (d: Date) => {
    if (d >= windowStart && d <= windowEnd) out.push(new Date(d));
  };

  while (out.length < maxInstances && n < maxInstances * 8) {
    n++;
    if (count !== null && n > count) break;
    if (until && cursor > until) break;
    if (cursor > windowEnd) break;

    if (freq === "WEEKLY" && byday) {
      const weekStart = new Date(cursor);
      weekStart.setUTCDate(weekStart.getUTCDate() - weekStart.getUTCDay());
      for (const code of byday) {
        const dow = dayMap[code];
        if (dow === undefined) continue;
        const occ = new Date(weekStart);
        occ.setUTCDate(occ.getUTCDate() + dow);
        occ.setUTCHours(dtstart.getUTCHours(), dtstart.getUTCMinutes(), dtstart.getUTCSeconds());
        if (occ >= dtstart) pushIfInWindow(occ);
      }
      cursor = new Date(cursor);
      cursor.setUTCDate(cursor.getUTCDate() + 7 * interval);
    } else {
      pushIfInWindow(cursor);
      const next = new Date(cursor);
      if (freq === "DAILY") next.setUTCDate(next.getUTCDate() + interval);
      else if (freq === "WEEKLY") next.setUTCDate(next.getUTCDate() + 7 * interval);
      else if (freq === "MONTHLY") next.setUTCMonth(next.getUTCMonth() + interval);
      else if (freq === "YEARLY") next.setUTCFullYear(next.getUTCFullYear() + interval);
      else break; // unsupported FREQ
      cursor = next;
    }

    if (out.length >= maxInstances) break;
  }

  return out;
}
