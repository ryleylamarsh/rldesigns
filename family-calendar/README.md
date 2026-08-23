# Family Wall Calendar

Single-file HTML/CSS/JS app (no build step) on Supabase, deployed to Cloudflare
Pages — a self-built, Skylight-style family wall calendar. See the original
build spec for the full design rationale; this README just covers setup.

## What's here

```
index.html                       the entire app (portrait + landscape, all 4 screens)
manifest.json + icons/           PWA manifest so it can "Add to Home Screen" full-screen
supabase/migrations/0001_init.sql   schema + RLS for a new Supabase project
supabase/functions/sync-ics/     Edge Function that syncs Google Calendar → events table
```

## 0. Try it in the local sandbox first

Open `index.html` directly — as a local file, via `python3 -m http.server` in
this folder, or the published Artifact preview — with no setup at all. If the
`SUPABASE_URL`/`SUPABASE_ANON_KEY` constants at the top of the script are
still their placeholder values, the app automatically runs against a
**local, in-browser sandbox** instead of Supabase:

- No network calls, no Supabase project, no Cloudflare deploy.
- Seeded with a few demo family members, events, chores, and a grocery list
  so every screen has something to look at immediately.
- All reads/writes go to `localStorage` (key `fc_local_db_v1`) instead of a
  server — refresh the page and your test edits are still there; clear that
  key (or your browser's site data for the page) to reset to the seed data.
- A "LOCAL SANDBOX" badge appears top-right as a reminder nothing is being
  saved anywhere real.
- Drag-to-reorder (chores, list items) uses a small built-in pointer-based
  implementation rather than a CDN library, so the sandbox has zero external
  script dependencies — it also works inside network-locked/CSP-sandboxed
  previews.

This is the place to click through the whole app — add/edit family members,
check off chores, drag-reorder, add list items, flip dark mode, open the
screensaver — before touching any real infrastructure. Once you're happy
with it, move to step 1 and fill in the two config constants; nothing else
in `index.html` needs to change to go from sandbox to a real backend.

## 1. Create the Supabase project

Create a **new, separate** Supabase project (don't reuse another project's keys).
This repo's session couldn't provision one automatically — the account's org
was already at its 2-project free-tier cap — so do this manually:

1. https://supabase.com/dashboard → New project.
2. Open the SQL editor and run `supabase/migrations/0001_init.sql` once.
   It creates all tables, locks `ics_sources` down to the service role only,
   adds the `ics_sources_status` view + `upsert_ics_source`/`delete_ics_source`
   RPCs the Settings screen uses, creates the `screensaver-photos` storage
   bucket, and adds every table to the `supabase_realtime` publication.
3. Settings → API → copy the **Project URL** and **anon/publishable key**
   into the two `SUPABASE_URL` / `SUPABASE_ANON_KEY` constants near the top
   of `index.html`'s `<script>` block.

There is intentionally **no login screen**. Every table except `ics_sources`
grants the anon key full read/write — the security boundary for v1 is
**Cloudflare Access** in front of the whole site (step 4 below), not
app-level auth. `ics_sources` (which holds bearer-token-style secret iCal
URLs) is the one table that stays locked to the service role even from a
signed-in browser tab, by RLS design, not convention.

## 2. Deploy the Google Calendar sync function

```
supabase functions deploy sync-ics --project-ref <your-project-ref>
```

Then schedule it every 15 minutes with a Cron Trigger (SQL editor):

```sql
select cron.schedule(
  'sync-ics-15min',
  '*/15 * * * *',
  $$
  select net.http_post(
    url := 'https://<your-project-ref>.supabase.co/functions/v1/sync-ics',
    headers := jsonb_build_object('Authorization', 'Bearer ' || '<service-role-key>')
  );
  $$
);
```

(Requires the `pg_cron` and `pg_net` extensions — enable both under
Database → Extensions first, or use the Dashboard's Cron Triggers UI, which
does this for you.)

Each family member connects their calendar from the app's **Settings →
Google Calendar sync** screen by pasting their calendar's "Secret address in
iCal format" (Google Calendar → Settings → that calendar → Integrate
calendar). That URL never touches a client-readable table — it goes straight
into `ics_sources` via a `SECURITY DEFINER` RPC and is only ever read back by
the Edge Function using the service-role key.

The bundled ICS parser handles Google's typical export (UTC timestamps,
`RRULE` with `FREQ`/`INTERVAL`/`COUNT`/`UNTIL`/weekly `BYDAY`, `EXDATE`) and
materializes recurring instances 30 days back to 180 days forward. It's
intentionally not a full RFC 5545 implementation — exotic recurrence rules
(`BYMONTHDAY`, `BYSETPOS`, etc.) are skipped rather than mis-expanded.

## 3. Deploy to Cloudflare Pages

Drag-and-drop the `family-calendar/` folder in the Cloudflare Pages
dashboard, or via Wrangler:

```
npx wrangler pages deploy family-calendar --project-name=family-calendar
```

No build command / output directory needed — it's static files as-is.

Then put **Cloudflare Access** in front of the Pages project (Zero Trust →
Access → Applications → add the Pages domain, gate it with an email/OTP
rule for your household). This is the recommended stand-in for
app-level auth per the spec — free, and it doesn't touch the app code.

## 4. Seed data / first run

Add family members and their colors from **Settings** first — Chores and
the calendar filter both key off that list. Everything else (chores, lists,
countdown, screensaver photos, idle timeout, dark-mode override) is editable
from the app itself once it's pointed at your project.

## 5. Install on the wall tablet

Open the deployed URL in the kiosk browser and use "Add to Home Screen" /
"Install app" — the manifest is set to `display: fullscreen` so it launches
with no browser chrome. The app auto-reloads once daily at 3am local time
(hygiene against long-running-tab memory creep) and listens for
`online`/`visibilitychange` to recover a dropped connection without a manual
reload.

## Known limitations (carried over from the v1 scope in the build spec)

- Google Calendar only — no Apple/Outlook/Yahoo/Cozi sync.
- No authentication UI; security relies on Cloudflare Access at the edge.
- RRULE expansion is a small hand-rolled parser, not a full ICS library —
  see the sync function's comments for exactly what's supported.
- Single device — the schema is realtime-ready for a second wall unit or a
  phone pointed at the same project, but that's not built as a distinct
  feature in v1.
