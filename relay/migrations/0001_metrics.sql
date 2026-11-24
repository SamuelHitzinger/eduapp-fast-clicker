-- Anonymous beta diagnostics (see relay/README.md "Monitoring"). No names, logins, questions or answers.
-- reports: what each app instance tells about itself every ~10 minutes and when a question opens.
CREATE TABLE IF NOT EXISTS reports (
  ts INTEGER NOT NULL,        -- server time (ms)
  day TEXT NOT NULL,          -- UTC date
  install TEXT NOT NULL,      -- random id made by the app on first start (not linked to the ETH account)
  platform TEXT NOT NULL,     -- ios | android | web | addon
  version TEXT NOT NULL,
  kind TEXT NOT NULL,         -- period | question
  data TEXT NOT NULL          -- JSON of numbers (timings, counts)
);
CREATE INDEX IF NOT EXISTS reports_day_kind ON reports(day, kind);
-- rooms: what the relay itself sees, per lecture room, every ~5 minutes while it is in use.
CREATE TABLE IF NOT EXISTS rooms (
  ts INTEGER NOT NULL,
  day TEXT NOT NULL,
  room TEXT NOT NULL,         -- first 8 hex digits of the room code (a hash; the relay never knows the course)
  members INTEGER NOT NULL,
  scouts INTEGER NOT NULL,    -- active scouts (each checks the feed in turn)
  standby INTEGER NOT NULL,
  hints INTEGER NOT NULL      -- hints accepted since the last snapshot
);
CREATE INDEX IF NOT EXISTS rooms_day ON rooms(day);
