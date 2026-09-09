-- =============================================================================
-- 0011  Realtime publication
-- =============================================================================
-- The officer queue and SOS console are written against push, not polling, so
-- these tables must broadcast their changes.
--
-- RLS still applies to realtime: a client is only sent rows it could already
-- have read, so adding a table here does not widen access.
--
-- `alter publication ... add table` errors if the table is already a member, so
-- membership is checked first - migrations have to replay cleanly.
-- =============================================================================

do $$
declare
  t text;
begin
  foreach t in array array['threat_reports', 'safety_alerts', 'notifications', 'sos_events']
  loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;
