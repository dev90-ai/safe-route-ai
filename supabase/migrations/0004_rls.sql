-- =============================================================================
-- 0004  Row Level Security
-- =============================================================================
-- This file is the security boundary of the whole product. The anon key is
-- public by design and ships inside the app bundle; what makes that safe is
-- that every table below denies by default and only opens what a given role
-- genuinely needs.
--
-- These policies are the server-side twin of the predicates in
-- src/api/endpoints/reports.ts (`visibleReportsFor`) and src/api/client.ts
-- (`requireRole`, `assertOrgVisible`). The client checks are a courtesy to the
-- user; these are the actual guarantee.
--
-- The rule that shapes everything: **officers verify, admins manage, and
-- neither can do the other's job.** No single account can both create the
-- authority and exercise it.
-- =============================================================================

alter table public.organizations  enable row level security;
alter table public.profiles       enable row level security;
alter table public.threat_reports enable row level security;
alter table public.safety_alerts  enable row level security;
alter table public.notifications  enable row level security;
alter table public.sos_events     enable row level security;
alter table public.invites        enable row level security;
alter table public.audit_log      enable row level security;


-- =============================================================================
-- organizations
-- =============================================================================

drop policy if exists organizations_select on public.organizations;
create policy organizations_select on public.organizations
  for select to authenticated
  using (public.can_see_org(id));

-- Only an admin, and only their own organisation.
drop policy if exists organizations_update on public.organizations;
create policy organizations_update on public.organizations
  for update to authenticated
  using (id = public.current_org_id() and public.current_role_name() = 'admin')
  with check (id = public.current_org_id() and public.current_role_name() = 'admin');


-- =============================================================================
-- profiles
-- =============================================================================

-- Everyone can see colleagues in their own org (needed to resolve names on
-- reports, SOS events and the audit log). Partner orgs are deliberately NOT
-- included: sharing threats does not mean sharing staff lists.
drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles
  for select to authenticated
  using (organization_id = public.current_org_id());

-- You may edit yourself, but not your own role, org or status - those are
-- privilege escalation. Enforced by trigger in 0005, since a WITH CHECK clause
-- cannot compare against the OLD row.
drop policy if exists profiles_update_self on public.profiles;
create policy profiles_update_self on public.profiles
  for update to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

-- Admins manage everyone in their organisation.
drop policy if exists profiles_update_admin on public.profiles;
create policy profiles_update_admin on public.profiles
  for update to authenticated
  using (organization_id = public.current_org_id() and public.current_role_name() = 'admin')
  with check (organization_id = public.current_org_id() and public.current_role_name() = 'admin');

-- Insert happens through the signup trigger (0005), which runs as definer.
-- No direct insert policy is granted.


-- =============================================================================
-- threat_reports
-- =============================================================================

-- Worker: verified reports from their org or a partner, plus their own at any
-- status. Officer/admin: everything they can see, at any status.
--
-- Reporter anonymity for peers is NOT done here - a row-level policy cannot
-- blank one column. It is handled by the `reports_for_worker` view in 0006,
-- which is what the worker client actually reads.
drop policy if exists reports_select on public.threat_reports;
create policy reports_select on public.threat_reports
  for select to authenticated
  using (
    public.can_see_org(organization_id)
    and (
      reporter_id = auth.uid()
      or status = 'verified'
      or public.current_role_name() in ('officer', 'admin')
    )
  );

-- Anyone active may file, but only as themselves and only into their own org,
-- and only ever as `pending`. A client cannot self-verify.
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
  );

-- Verification is officers only. Admins are excluded on purpose: separation of
-- duties is what keeps the chain auditable.
drop policy if exists reports_update_officer on public.threat_reports;
create policy reports_update_officer on public.threat_reports
  for update to authenticated
  using (
    public.can_see_org(organization_id)
    and public.current_role_name() = 'officer'
    and public.current_is_active()
  )
  with check (
    public.can_see_org(organization_id)
    and public.current_role_name() = 'officer'
  );

-- No delete policy anywhere. Reports are part of the record.


-- =============================================================================
-- safety_alerts
-- =============================================================================

drop policy if exists alerts_select on public.safety_alerts;
create policy alerts_select on public.safety_alerts
  for select to authenticated
  using (public.can_see_org(organization_id));

-- Officers issue alerts. Not workers, not admins.
drop policy if exists alerts_insert on public.safety_alerts;
create policy alerts_insert on public.safety_alerts
  for insert to authenticated
  with check (
    public.current_role_name() = 'officer'
    and public.current_is_active()
    and issued_by = auth.uid()
    and organization_id = public.current_org_id()
  );

-- Withdrawing an advisory is an update, restricted to the issuing org.
drop policy if exists alerts_update on public.safety_alerts;
create policy alerts_update on public.safety_alerts
  for update to authenticated
  using (organization_id = public.current_org_id() and public.current_role_name() = 'officer')
  with check (organization_id = public.current_org_id() and public.current_role_name() = 'officer');


-- =============================================================================
-- notifications
-- =============================================================================
-- Strictly personal. Nobody reads anyone else's feed, including admins.

drop policy if exists notifications_select on public.notifications;
create policy notifications_select on public.notifications
  for select to authenticated
  using (profile_id = auth.uid());

-- Only ever to mark as read. The trigger in 0005 rejects any other change.
drop policy if exists notifications_update on public.notifications;
create policy notifications_update on public.notifications
  for update to authenticated
  using (profile_id = auth.uid())
  with check (profile_id = auth.uid());

-- Inserts come from the fan-out function (service role), never from a client.


-- =============================================================================
-- sos_events
-- =============================================================================
-- A live location is the most sensitive datum in the system, so SOS is the one
-- thing that is NEVER cross-shared. `organization_id = current_org_id()` here,
-- deliberately not `can_see_org`: a partner's threats are shared, their
-- people's positions are not.

drop policy if exists sos_select on public.sos_events;
create policy sos_select on public.sos_events
  for select to authenticated
  using (
    worker_id = auth.uid()
    or (organization_id = public.current_org_id() and public.current_role_name() in ('officer', 'admin'))
  );

drop policy if exists sos_insert on public.sos_events;
create policy sos_insert on public.sos_events
  for insert to authenticated
  with check (
    public.current_is_active()
    and worker_id = auth.uid()
    and organization_id = public.current_org_id()
    and status = 'active'
  );

-- The worker pushes location updates and can stand their own event down.
drop policy if exists sos_update_own on public.sos_events;
create policy sos_update_own on public.sos_events
  for update to authenticated
  using (worker_id = auth.uid())
  with check (worker_id = auth.uid());

-- Officers acknowledge, annotate and resolve - within their own org only.
drop policy if exists sos_update_officer on public.sos_events;
create policy sos_update_officer on public.sos_events
  for update to authenticated
  using (organization_id = public.current_org_id() and public.current_role_name() = 'officer')
  with check (organization_id = public.current_org_id() and public.current_role_name() = 'officer');


-- =============================================================================
-- invites
-- =============================================================================
-- The code is a credential: holding it grants membership at a chosen role.
-- Only admins may see or mint them. Unauthenticated lookup during sign-up goes
-- through a SECURITY DEFINER function in 0006, which returns only the invitee's
-- name and org - never the whole row.

drop policy if exists invites_select on public.invites;
create policy invites_select on public.invites
  for select to authenticated
  using (organization_id = public.current_org_id() and public.current_role_name() = 'admin');

drop policy if exists invites_insert on public.invites;
create policy invites_insert on public.invites
  for insert to authenticated
  with check (
    public.current_role_name() = 'admin'
    and public.current_is_active()
    and organization_id = public.current_org_id()
    and invited_by = auth.uid()
  );

drop policy if exists invites_delete on public.invites;
create policy invites_delete on public.invites
  for delete to authenticated
  using (
    organization_id = public.current_org_id()
    and public.current_role_name() = 'admin'
    and accepted_at is null
  );


-- =============================================================================
-- audit_log
-- =============================================================================
-- Readable by officers and admins; writable by nobody through the API.
-- Entries are appended by SECURITY DEFINER triggers only. There is deliberately
-- no insert, update or delete policy: append-only is the property that makes
-- this evidence rather than a changelog.

drop policy if exists audit_select on public.audit_log;
create policy audit_select on public.audit_log
  for select to authenticated
  using (
    organization_id = public.current_org_id()
    and public.current_role_name() in ('officer', 'admin')
  );
