-- =============================================================================
-- 0003  RLS helper functions
-- =============================================================================

-- --- RLS helper functions ----------------------------------------------------
--
-- These are SECURITY DEFINER on purpose. A policy on `profiles` that itself
-- queries `profiles` would recurse infinitely; a definer function reads the row
-- with RLS bypassed, breaking the cycle. They are STABLE so the planner can
-- call them once per statement rather than once per row.
--
-- `search_path` is pinned on every one of them. Without that, a caller could
-- shadow `public` and have these resolve to their own tables.

create or replace function public.current_org_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select organization_id from public.profiles where id = auth.uid()
$$;

create or replace function public.current_role_name()
returns public.user_role
language sql
stable
security definer
set search_path = public
as $$
  select role from public.profiles where id = auth.uid()
$$;

create or replace function public.current_is_active()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select status = 'active' from public.profiles where id = auth.uid()), false)
$$;

-- True when `org` is the caller's own organisation, or a declared cross-share
-- partner of it. This single predicate is what makes partner threat-sharing
-- work without leaking anything else.
create or replace function public.can_see_org(org uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.profiles me
    join public.organizations mine on mine.id = me.organization_id
    where me.id = auth.uid()
      and me.status = 'active'
      and (org = me.organization_id or org = any (mine.cross_share_partners))
  )
$$;

comment on function public.current_org_id is 'Caller''s organisation. SECURITY DEFINER to avoid RLS recursion on profiles.';
comment on function public.can_see_org is 'True for the caller''s own org or a cross-share partner. The basis of partner threat sharing.';
