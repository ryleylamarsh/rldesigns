-- Family Wall Calendar — recurring events.
-- 'none' | 'daily' | 'weekdays' | 'weekly' | 'monthly' | 'yearly'.
-- The specific day-of-week/day-of-month/month+day a weekly/monthly/yearly
-- rule follows isn't stored separately — it's derived from the event's own
-- start_at (its "anchor" occurrence) at read time. See expandRecurringEvents()
-- in index.html.

alter table events add column if not exists recurrence text not null default 'none'
  check (recurrence in ('none','daily','weekdays','weekly','monthly','yearly'));
