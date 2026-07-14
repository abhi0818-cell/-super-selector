-- READ-ONLY. Lists every tournament whose name matches '%Major%' so we can
-- confirm fix_transfers_mlc_season.sql / check_transfers_mlc_readonly.sql
-- (which both use `ILIKE '%Major%' LIMIT 1`) targeted the right one.
-- If more than one row comes back, the LIMIT 1 in those scripts may have
-- silently picked the wrong season's tournament.
SELECT id, name, created_at
FROM tournaments
WHERE name ILIKE '%Major%'
ORDER BY created_at DESC;
