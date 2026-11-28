-- Queries and the daily cleanup filter on time: index (kind, ts) and (ts) instead of the day columns, so neither
-- tools/monitor.js nor the cleanup reads the whole table. One index per table, as before (each index costs a
-- row write per insert on D1).
DROP INDEX IF EXISTS reports_day_kind;
DROP INDEX IF EXISTS rooms_day;
CREATE INDEX IF NOT EXISTS reports_kind_ts ON reports(kind, ts);
CREATE INDEX IF NOT EXISTS rooms_ts ON rooms(ts);
