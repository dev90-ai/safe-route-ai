-- =============================================================================
-- 0010  Recipient preview
-- =============================================================================
-- Answers "who will this actually reach" before an officer commits to sending.
-- It applies exactly the same four rules as fan_out_alert, so the number an
-- officer sees while dragging the radius slider is the number that will be
-- notified - not an estimate that drifts from reality.
-- =============================================================================

create or replace function public.preview_alert_recipients(
  p_org_id uuid,
  p_lat double precision default null,
  p_lng double precision default null,
  p_radius_meters int default null,
  p_region_ids text[] default '{}',
  p_share_with_partners boolean default true
)
returns table (profile_id uuid, full_name text, reasons text[], distance_meters int)
language sql
stable
security definer
set search_path = public
as $$
  with target as (
    select case
      when p_lat is null or p_lng is null then null
      else extensions.ST_Point(p_lng, p_lat)::extensions.geography
    end as loc
  ),
  partners as (
    select case when p_share_with_partners
      then coalesce((select cross_share_partners from public.organizations where id = p_org_id), '{}'::uuid[])
      else '{}'::uuid[] end as ids
  )
  select
    p.id,
    p.full_name,
    array_remove(array[
      case when p.organization_id = p_org_id then 'same-organization' end,
      case when p.organization_id = any (pt.ids) then 'partner-organization' end,
      case
        when t.loc is not null and p_radius_meters is not null and p.last_known_location is not null
         and extensions.ST_DWithin(p.last_known_location, t.loc, p_radius_meters)
        then 'within-alert-radius'
      end,
      case
        when exists (
          select 1 from public.regions g
          where g.id = any (p.operating_regions)
            and (g.id = any (p_region_ids)
                 or (t.loc is not null and extensions.ST_DWithin(g.center, t.loc, g.radius_meters)))
        ) then 'operating-region'
      end
    ], null) as reasons,
    case
      when t.loc is not null and p.last_known_location is not null
      then round(extensions.ST_Distance(p.last_known_location, t.loc))::int
    end
  from public.profiles p, target t, partners pt
  where p.status = 'active'
    -- Admins manage the organisation; they are not the people in the field.
    and p.role <> 'admin'
    and (
      p.organization_id = p_org_id
      or p.organization_id = any (pt.ids)
      or (t.loc is not null and p_radius_meters is not null and p.last_known_location is not null
          and extensions.ST_DWithin(p.last_known_location, t.loc, p_radius_meters))
      or exists (
        select 1 from public.regions g
        where g.id = any (p.operating_regions)
          and (g.id = any (p_region_ids)
               or (t.loc is not null and extensions.ST_DWithin(g.center, t.loc, g.radius_meters)))
      )
    )
  order by 4 nulls last
$$;

grant execute on function public.preview_alert_recipients(uuid, double precision, double precision, int, text[], boolean)
  to authenticated;
