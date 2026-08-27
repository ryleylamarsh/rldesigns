-- Family Wall Calendar — placeholder settings for a future Matter/Thread
-- presence sensor (see the "Presence sensor" Settings section and
-- window.setPresenceDetected() in index.html). Not wired to a real
-- device by this app itself — a separate bridge process would call that
-- hook using these settings.

alter table app_settings add column if not exists presence_enabled boolean not null default false;
alter table app_settings add column if not exists presence_away_minutes int not null default 5;
