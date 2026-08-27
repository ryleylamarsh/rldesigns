-- Family Wall Calendar — add an optional photo to each family member,
-- shown in the calendar toolbar's family filter chips (a small color
-- dot in the corner still carries their assigned color, since the
-- photo itself replaces the colored-initials circle).

alter table family_members add column if not exists photo_url text;
