-- =============================================================================
-- 0008  AI suggestions are server-only
-- =============================================================================
-- The previous guard rejected *changes* to ai_suggestions but still allowed an
-- authenticated client to write them for the first time. That is a hole: an
-- officer could fabricate an AI recommendation on a report that never had one,
-- and the audit trail would show the model agreeing with a decision it never
-- made.
--
-- AI output is evidence. It is written exactly once, by the classifier Edge
-- Function running under the service role (where auth.uid() is null), and is
-- untouchable from any client session thereafter.
-- =============================================================================

create or replace function public.guard_report_update()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- No JWT means the service role or a trigger: the classifier's write path.
  if auth.uid() is null then
    return new;
  end if;

  -- A resolved report is final. Reopening it would hollow out the audit trail.
  if old.status <> 'pending' and new.status is distinct from old.status then
    raise exception 'This report was already % and cannot be changed', old.status
      using errcode = 'check_violation';
  end if;

  if new.status <> old.status then
    -- Stamp the decision with whoever actually made it, not whoever was passed in.
    new.verified_by := auth.uid();
    new.verified_at := now();
  end if;

  -- Any client-side write to the model's output is refused, including the
  -- first one. Only the server-side classifier may set this column.
  if new.ai_suggestions is distinct from old.ai_suggestions then
    raise exception 'AI suggestions are written by the classifier and cannot be set from a client'
      using errcode = 'insufficient_privilege';
  end if;

  if new.ai_status is distinct from old.ai_status then
    raise exception 'AI status is managed by the classifier'
      using errcode = 'insufficient_privilege';
  end if;

  if new.reporter_id is distinct from old.reporter_id then
    raise exception 'The reporter of a report cannot be changed'
      using errcode = 'insufficient_privilege';
  end if;

  if new.organization_id is distinct from old.organization_id then
    raise exception 'A report cannot be moved between organisations'
      using errcode = 'insufficient_privilege';
  end if;

  return new;
end $$;

-- The insert policy already forbids a client setting classification fields;
-- this closes the same door on ai_suggestions at insert time.
drop policy if exists reports_insert on public.threat_reports;
create policy reports_insert on public.threat_reports
  for insert to authenticated
  with check (
    public.current_is_active()
    and reporter_id = auth.uid()
    and organization_id = public.current_org_id()
    and status = 'pending'
    and threat_type is null
    and severity is null
    and verified_by is null
    and ai_suggestions is null
  );
