-- Family Wall Calendar — screensaver slides can now be a short video
-- (.mov, .mp4, etc.) as well as a photo. Same storage bucket, same
-- table — media_type just tells the screensaver whether to render an
-- <img> or a muted, looping <video> for that slide.

alter table screensaver_photos add column if not exists media_type text not null default 'photo'
  check (media_type in ('photo','video'));
