-- =============================================================================
-- 0005  Triggers
-- =============================================================================
-- RLS decides which ROWS you may touch. These decide which CHANGES are legal
-- once you are allowed to touch a row - things a policy cannot express, because
-- a WITH CHECK clause cannot compare the new row against the old one.
-- =============================================================================


-- --- updated_at --------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists profiles_updated_at on public.profiles;
create trigger profiles_updated_at before update on public.profiles
  for each row execute function public.set_updated_at();

drop trigger if exists reports_updated_at on public.threat_reports;
create trigger reports_updated_at before update on public.threat_reports
  for each row execute function public.set_updated_at();

drop trigger if exists sos_updated_at on public.sos_events;
create trigger sos_updated_at before update on public.sos_events
  for each row execute function public.set_updated_at();


-- --- Invite-gated signup -----------------------------------------------------
-- Nobody self-registers into an organisation. The invite code carried in the
-- signup metadata is what binds the new account to an org and a role, and this
-- runs inside the signup transaction: no valid invite, no account.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  invite_code text := new.raw_user_meta_data ->> 'invite_code';
  inv public.invites;
  palette text[] := array['#3B82F6','#14B8A6','#8B5CF6','#F59E0B','#EC4899','#10B981','#F97316','#06B6D4'];
begin
  select * into inv
  from public.invites
  where upper(code) = upper(invite_code)
    and accepted_at is null
    and expires_at > now()
  for update;

  if inv.id is null then
    raise exception 'A valid invite code is required to create an account'
      using errcode = 'check_violation';
  end if;

  if lower(inv.email) <> lower(new.email) then
    raise exception 'This invite was issued to a different email address'
      using errcode = 'check_violation';
  end if;

  insert into public.profiles (
    id, email, full_name, phone, role, organization_id,
    operating_regions, avatar_color, status, onboarded_at
  )
  values (
    new.id,
    new.email,
    coalesce(nullif(btrim(new.raw_user_meta_data ->> 'full_name'), ''), inv.full_name),
    nullif(btrim(new.raw_user_meta_data ->> 'phone'), ''),
    inv.role,
    inv.organization_id,
    inv.operating_regions,
    palette[1 + (abs(hashtext(new.id::text)) % array_length(palette, 1))],
    'active',
    -- Workers must still declare their operating regions before alerts can
    -- reach them correctly, so they land in onboarding rather than a dashboard.
    case when inv.role = 'worker' then null else now() end
  );

  update public.invites set accepted_at = now() where id = inv.id;

  insert into public.audit_log (actor_id, actor_role, organization_id, action, entity, entity_id, summary)
  values (new.id, inv.role::text, inv.organization_id, 'auth.signed_up', 'profile', new.id,
          format('%s accepted an invite and joined as %s.', inv.full_name, inv.role));

  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();


-- --- Privilege escalation guard ----------------------------------------------
-- The `profiles_update_self` policy lets you edit your own row. This stops that
-- becoming "promote yourself to admin".
create or replace function public.guard_profile_update()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_role public.user_role := public.current_role_name();
  actor_org uuid := public.current_org_id();
begin
  -- Service role and triggers run without a JWT; leave them alone.
  if auth.uid() is null then
    return new;
  end if;

  if new.id = auth.uid() and actor_role is distinct from 'admin' then
    if new.role is distinct from old.role
       or new.organization_id is distinct from old.organization_id
       or new.status is distinct from old.status then
      raise exception 'You cannot change your own role, organisation or status'
        using errcode = 'insufficient_privilege';
    end if;
  end if;

  if actor_role = 'admin' then
    if new.organization_id is distinct from old.organization_id then
      raise exception 'A member cannot be moved between organisations'
        using errcode = 'insufficient_privilege';
    end if;
    if new.id = auth.uid() and (new.role is distinct from old.role or new.status is distinct from old.status) then
      raise exception 'Admins cannot change their own role or status. Ask another admin.'
        using errcode = 'insufficient_privilege';
    end if;
  end if;

  -- An organisation must never be left without a way back in.
  if (old.role = 'admin' and new.role <> 'admin')
     or (old.status = 'active' and new.status <> 'active' and old.role = 'admin') then
    if (select count(*) from public.profiles
        where organization_id = old.organization_id and role = 'admin' and status = 'active') <= 1 then
      raise exception 'An organisation must keep at least one active admin'
        using errcode = 'check_violation';
    end if;
  end if;

  return new;
end $$;

drop trigger if exists profiles_guard_update on public.profiles;
create trigger profiles_guard_update before update on public.profiles
  for each row execute function public.guard_profile_update();


-- --- Notifications are read-only except for read_at --------------------------
create or replace function public.guard_notification_update()
returns trigger language plpgsql as $$
begin
  if new.profile_id is distinct from old.profile_id
     or new.alert_id is distinct from old.alert_id
     or new.title is distinct from old.title
     or new.body is distinct from old.body
     or new.severity is distinct from old.severity
     or new.match_reasons is distinct from old.match_reasons then
    raise exception 'Only read_at may be updated on a notification'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end $$;

drop trigger if exists notifications_guard_update on public.notifications;
create trigger notifications_guard_update before update on public.notifications
  for each row execute function public.guard_notification_update();


-- --- Verification guard ------------------------------------------------------
-- The officer's decision must be attributable, one-way, and complete.
create or replace function public.guard_report_update()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    return new;
  end if;

  -- A resolved report is final. Reopening it would erase the audit trail's
  -- meaning, so it is simply not permitted.
  if old.status <> 'pending' and new.status is distinct from old.status then
    raise exception 'This report was already % and cannot be changed', old.status
      using errcode = 'check_violation';
  end if;

  if new.status <> old.status then
    -- Stamp the decision with whoever actually made it, not whoever was passed in.
    new.verified_by := auth.uid();
    new.verified_at := now();
  end if;

  -- The AI's raw output is evidence. It is written once by the classifier and
  -- never edited by a human, so the two can always be compared afterwards.
  if old.ai_suggestions is not null and new.ai_suggestions is distinct from old.ai_suggestions then
    raise exception 'AI suggestions are immutable once recorded'
      using errcode = 'insufficient_privilege';
  end if;

  if new.reporter_id is distinct from old.reporter_id then
    raise exception 'The reporter of a report cannot be changed'
      using errcode = 'insufficient_privilege';
  end if;

  return new;
end $$;

drop trigger if exists reports_guard_update on public.threat_reports;
create trigger reports_guard_update before update on public.threat_reports
  for each row execute function public.guard_report_update();


-- --- Human-quotable report reference -----------------------------------------
create or replace function public.set_report_reference()
returns trigger language plpgsql as $$
begin
  if new.reference is null or btrim(new.reference) = '' then
    new.reference := 'SR-' || upper(substr(replace(new.id::text, '-', ''), 1, 6));
  end if;
  return new;
end $$;

drop trigger if exists reports_set_reference on public.threat_reports;
create trigger reports_set_reference before insert on public.threat_reports
  for each row execute function public.set_report_reference();


-- --- Cross-share reciprocity -------------------------------------------------
-- A one-way partnership would let an organisation consume another's threat
-- intelligence without contributing its own. Partnerships are therefore always
-- mirrored, in both directions, automatically.
create or replace function public.sync_cross_share()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  added uuid;
  removed uuid;
begin
  foreach added in array (select coalesce(array(select unnest(new.cross_share_partners) except select unnest(old.cross_share_partners)), '{}'::uuid[]))
  loop
    update public.organizations
      set cross_share_partners = array_append(cross_share_partners, new.id)
      where id = added and not (new.id = any (cross_share_partners));
  end loop;

  foreach removed in array (select coalesce(array(select unnest(old.cross_share_partners) except select unnest(new.cross_share_partners)), '{}'::uuid[]))
  loop
    update public.organizations
      set cross_share_partners = array_remove(cross_share_partners, new.id)
      where id = removed;
  end loop;

  return new;
end $$;

drop trigger if exists organizations_sync_cross_share on public.organizations;
create trigger organizations_sync_cross_share after update of cross_share_partners on public.organizations
  for each row execute function public.sync_cross_share();


-- --- Audit trail -------------------------------------------------------------
-- Append-only, written by definer triggers so no client can forge or suppress
-- an entry. Every status transition names the actor.
create or replace function public.audit_report_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  actor text := coalesce((select full_name from public.profiles where id = auth.uid()), 'System');
  actor_role text := coalesce(public.current_role_name()::text, 'system');
begin
  if tg_op = 'INSERT' then
    insert into public.audit_log (actor_id, actor_role, organization_id, action, entity, entity_id, summary)
    values (new.reporter_id, actor_role, new.organization_id, 'report.created', 'report', new.id,
            format('%s filed report %s.', actor, new.reference));
    return new;
  end if;

  if new.status is distinct from old.status then
    insert into public.audit_log (actor_id, actor_role, organization_id, action, entity, entity_id, summary, before, after)
    values (
      auth.uid(), actor_role, new.organization_id,
      'report.' || new.status, 'report', new.id,
      case new.status
        when 'verified' then format('%s verified %s as %s %s with a %s km alert radius.',
          actor, new.reference, new.severity, new.threat_type, round((new.alert_radius_meters / 1000.0)::numeric, 1))
        when 'dismissed' then format('%s dismissed %s: %s', actor, new.reference, new.dismissed_reason)
        else format('%s changed %s to %s.', actor, new.reference, new.status)
      end,
      jsonb_build_object('status', old.status,
                         'aiSuggested', case when old.ai_suggestions is null then null
                           else jsonb_build_object('threatType', old.ai_suggestions->>'threatType',
                                                   'severity', old.ai_suggestions->>'severity') end),
      jsonb_build_object('status', new.status, 'threatType', new.threat_type,
                         'severity', new.severity, 'alertRadiusMeters', new.alert_radius_meters)
    );
  end if;

  return new;
end $$;

drop trigger if exists reports_audit on public.threat_reports;
create trigger reports_audit after insert or update on public.threat_reports
  for each row execute function public.audit_report_change();


create or replace function public.audit_sos_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  actor text := coalesce((select full_name from public.profiles where id = auth.uid()), 'System');
begin
  if tg_op = 'INSERT' then
    insert into public.audit_log (actor_id, actor_role, organization_id, action, entity, entity_id, summary)
    values (new.worker_id, 'worker', new.organization_id, 'sos.triggered', 'sos', new.id,
            format('%s triggered an SOS%s', actor, coalesce(': ' || new.reason, '.')));
    return new;
  end if;

  if new.status is distinct from old.status then
    insert into public.audit_log (actor_id, actor_role, organization_id, action, entity, entity_id, summary)
    values (auth.uid(), coalesce(public.current_role_name()::text, 'system'), new.organization_id,
            'sos.' || new.status, 'sos', new.id,
            format('%s marked the SOS %s.%s', actor, new.status, coalesce(' ' || new.resolution_note, '')));
  end if;

  return new;
end $$;

drop trigger if exists sos_audit on public.sos_events;
create trigger sos_audit after insert or update on public.sos_events
  for each row execute function public.audit_sos_change();
