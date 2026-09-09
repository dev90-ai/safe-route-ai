-- =============================================================================
-- 0006  Region reference data, the anonymised worker view, and the RPCs
-- =============================================================================


-- --- regions -----------------------------------------------------------------
-- Reference data mirroring src/constants/regions.ts. It lives in the database
-- because the alert fan-out needs region geometry server-side: "the threat
-- falls inside one of this worker's declared regions" cannot be answered from
-- an id alone.
create table if not exists public.regions (
  id            text primary key,
  name          text not null,
  county        text not null,
  center        extensions.geography(Point, 4326) not null,
  radius_meters int not null
);

create index if not exists regions_center_idx on public.regions using gist (center);

alter table public.regions enable row level security;

drop policy if exists regions_select on public.regions;
create policy regions_select on public.regions for select to authenticated using (true);

insert into public.regions (id, name, county, center, radius_meters) values
  ('garissa-township', 'Garissa Township', 'Garissa', extensions.ST_Point(39.6583, -0.4569)::extensions.geography, 25000),
  ('dadaab',           'Dadaab',            'Garissa', extensions.ST_Point(40.3086,  0.0553)::extensions.geography, 45000),
  ('fafi',             'Fafi',              'Garissa', extensions.ST_Point(40.05,   -0.55)::extensions.geography,   50000),
  ('ijara',            'Ijara',             'Garissa', extensions.ST_Point(40.5261, -1.5936)::extensions.geography, 50000),
  ('hulugho',          'Hulugho',           'Garissa', extensions.ST_Point(41.05,   -1.15)::extensions.geography,   45000),
  ('lagdera',          'Lagdera (Modogashe)','Garissa', extensions.ST_Point(39.6833, 0.7167)::extensions.geography, 50000),
  ('balambala',        'Balambala',         'Garissa', extensions.ST_Point(39.6333, -0.0667)::extensions.geography, 40000),
  ('wajir-east',       'Wajir East',        'Wajir',   extensions.ST_Point(40.0573,  1.7471)::extensions.geography, 40000),
  ('wajir-west',       'Wajir West (Griftu)','Wajir',  extensions.ST_Point(39.7,     1.7333)::extensions.geography, 45000),
  ('wajir-north',      'Wajir North (Bute)','Wajir',   extensions.ST_Point(39.8167,  2.7667)::extensions.geography, 50000),
  ('wajir-south',      'Wajir South (Habaswein)','Wajir', extensions.ST_Point(39.4906, 1.0117)::extensions.geography, 50000),
  ('tarbaj',           'Tarbaj',            'Wajir',   extensions.ST_Point(40.4667,  1.9333)::extensions.geography, 45000),
  ('eldas',            'Eldas',             'Wajir',   extensions.ST_Point(39.5833,  2.5167)::extensions.geography, 45000),
  ('mandera-east',     'Mandera East',      'Mandera', extensions.ST_Point(41.867,   3.9366)::extensions.geography, 35000),
  ('mandera-north',    'Mandera North (Rhamu)','Mandera', extensions.ST_Point(41.2167, 3.9333)::extensions.geography, 40000),
  ('mandera-west',     'Mandera West (Takaba)','Mandera', extensions.ST_Point(40.2167, 3.4167)::extensions.geography, 45000),
  ('mandera-south',    'Mandera South (El Wak)','Mandera', extensions.ST_Point(40.9333, 2.8)::extensions.geography, 45000),
  ('banissa',          'Banissa',           'Mandera', extensions.ST_Point(40.3167,  3.9167)::extensions.geography, 40000),
  ('lafey',            'Lafey',             'Mandera', extensions.ST_Point(41.5167,  3.6333)::extensions.geography, 40000),
  ('isiolo',           'Isiolo',            'Isiolo',  extensions.ST_Point(37.5822,  0.3546)::extensions.geography, 40000),
  ('moyale',           'Moyale',            'Marsabit',extensions.ST_Point(39.0561,  3.5231)::extensions.geography, 35000),
  ('tana-delta',       'Tana Delta (Hola)', 'Tana River', extensions.ST_Point(40.0306, -1.4989)::extensions.geography, 45000)
on conflict (id) do update
  set name = excluded.name, county = excluded.county,
      center = excluded.center, radius_meters = excluded.radius_meters;


-- --- Reporter anonymity ------------------------------------------------------
-- RLS controls which rows you see; it cannot blank a column. This view is what
-- worker clients read: the reporter is stripped, the photo withheld, and the
-- pin blurred by ~250 m - enough to protect whoever filed it, far below any
-- alert radius. Retaliation against reporters is the specific risk here.
-- Dropped first: a later migration changes this view's columns, and
-- `create or replace view` cannot drop a column. Migrations must replay cleanly.
drop view if exists public.reports_for_worker;

create view public.reports_for_worker
with (security_invoker = true)
as
select
  r.id,
  r.reference,
  case when r.reporter_id = auth.uid() then r.reporter_id else null end as reporter_id,
  r.organization_id,
  r.description,
  case when r.reporter_id = auth.uid() then r.photo_url else null end as photo_url,
  case
    when r.reporter_id = auth.uid() then r.location
    else extensions.ST_Project(
           r.location,
           50 + (abs(hashtext(r.id::text)) % 250),
           radians((abs(hashtext(r.id::text || 'b')) % 360))
         )
  end as location,
  r.region_id,
  r.place_label,
  r.threat_type,
  r.severity,
  r.priority,
  r.alert_radius_meters,
  r.status,
  r.occurred_at,
  r.created_at,
  r.verified_at
from public.threat_reports r;

comment on view public.reports_for_worker is
  'Peer-facing report feed. Reporter identity removed and position jittered ~250m. Workers read this, never threat_reports directly.';


-- --- Invite lookup during sign-up --------------------------------------------
-- Sign-up happens before authentication, so the invites table cannot be read
-- under RLS. This returns only what the sign-up screen needs to confirm the
-- code is real - never the whole row, and never for a used or expired invite.
create or replace function public.peek_invite(invite_code text)
returns table (full_name text, email text, role public.user_role, organization_name text)
language sql
stable
security definer
set search_path = public
as $$
  select i.full_name, i.email, i.role, o.name
  from public.invites i
  join public.organizations o on o.id = i.organization_id
  where upper(i.code) = upper(btrim(invite_code))
    and i.accepted_at is null
    and i.expires_at > now()
  limit 1
$$;

grant execute on function public.peek_invite(text) to anon, authenticated;


-- --- Alert fan-out -----------------------------------------------------------
-- The four rules, in one statement. A worker is notified when ANY holds, and
-- the reasons travel with the notification so the alert is never mysterious:
--
--   1. same organisation as the report
--   2. a cross-share partner of the reporting organisation
--   3. their last known position is inside the alert radius
--   4. the threat falls inside one of their declared operating regions
--
-- Admins are excluded: they manage the organisation, they are not in the field,
-- and paging them on every incident trains everyone to ignore alerts.
create or replace function public.fan_out_alert(p_alert_id uuid)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  a public.safety_alerts;
  partners uuid[];
  delivered int;
begin
  select * into a from public.safety_alerts where id = p_alert_id;
  if a.id is null then
    raise exception 'Alert % not found', p_alert_id;
  end if;

  select cross_share_partners into partners from public.organizations where id = a.organization_id;

  with candidates as (
    select
      p.id as profile_id,
      case when p.organization_id = a.organization_id then 'same-organization' end as r_org,
      case when p.organization_id = any (coalesce(partners, '{}'::uuid[])) then 'partner-organization' end as r_partner,
      case
        when a.location is not null and a.radius_meters is not null and p.last_known_location is not null
         and extensions.ST_DWithin(p.last_known_location, a.location, a.radius_meters)
        then 'within-alert-radius'
      end as r_radius,
      case
        when exists (
          select 1 from public.regions g
          where g.id = any (p.operating_regions)
            and (
              g.id = any (a.region_ids)
              or (a.location is not null and extensions.ST_DWithin(g.center, a.location, g.radius_meters))
            )
        ) then 'operating-region'
      end as r_region,
      case
        when a.location is not null and p.last_known_location is not null
        then round(extensions.ST_Distance(p.last_known_location, a.location))::int
      end as distance_m
    from public.profiles p
    where p.status = 'active'
      and p.role <> 'admin'
      -- The reporter already knows; alerting them is noise, not safety.
      and p.id is distinct from (select reporter_id from public.threat_reports where id = a.related_report_id)
  ),
  matched as (
    select
      profile_id,
      distance_m,
      array_remove(array[r_org, r_partner, r_radius, r_region], null) as reasons
    from candidates
    where coalesce(r_org, r_partner, r_radius, r_region) is not null
  ),
  eligible as (
    select m.* from matched m
    join public.profiles p on p.id = m.profile_id
    -- "Only critical" is a preference about noise, but proximity outranks it:
    -- anything inside the radius is about the person's own safety.
    where not (
      (p.notification_preferences ->> 'criticalOnly')::boolean is true
      and a.severity in ('low', 'medium')
      and not ('within-alert-radius' = any (m.reasons))
    )
  )
  insert into public.notifications (profile_id, alert_id, report_id, title, body, severity, match_reasons, distance_meters)
  select e.profile_id, a.id, a.related_report_id, a.title, a.message, a.severity, e.reasons, e.distance_m
  from eligible e
  on conflict (profile_id, alert_id) do nothing;

  get diagnostics delivered = row_count;

  update public.safety_alerts set recipient_count = delivered where id = a.id;

  insert into public.audit_log (actor_id, actor_role, organization_id, action, entity, entity_id, summary)
  values (a.issued_by, 'officer', a.organization_id,
          case when a.kind = 'advisory' then 'alert.advisory_issued' else 'alert.fanout' end,
          'alert', a.id,
          format('"%s" delivered to %s recipient(s).', a.title, delivered));

  return delivered;
end $$;

grant execute on function public.fan_out_alert(uuid) to authenticated;


-- --- Safe Route: threats near a route ----------------------------------------
-- The real ST_DWithin the client's distanceToPath approximates. Takes the route
-- as GeoJSON so the app can hand over a Directions API polyline directly.
--
-- Only verified reports count. An unverified rumour must never close a road.
create or replace function public.threats_near_route(
  route_geojson jsonb,
  buffer_meters int default 2000,
  window_hours int default 720
)
returns table (
  report_id uuid,
  reference text,
  threat_type public.threat_type,
  severity public.severity,
  distance_from_route_meters int,
  occurred_at timestamptz,
  lat double precision,
  lng double precision
)
language sql
stable
security definer
set search_path = public
as $$
  select
    r.id,
    r.reference,
    r.threat_type,
    r.severity,
    round(extensions.ST_Distance(
      r.location,
      extensions.ST_GeomFromGeoJSON(route_geojson::text)::extensions.geography
    ))::int,
    r.occurred_at,
    extensions.ST_Y(r.location::extensions.geometry),
    extensions.ST_X(r.location::extensions.geometry)
  from public.threat_reports r
  where r.status = 'verified'
    and public.can_see_org(r.organization_id)
    and r.occurred_at > now() - make_interval(hours => window_hours)
    and extensions.ST_DWithin(
      r.location,
      extensions.ST_GeomFromGeoJSON(route_geojson::text)::extensions.geography,
      buffer_meters
    )
  order by 5 asc
$$;

grant execute on function public.threats_near_route(jsonb, int, int) to authenticated;


-- --- Threats near a point ----------------------------------------------------
create or replace function public.threats_nearby(
  p_lat double precision,
  p_lng double precision,
  radius_meters int default 60000,
  window_hours int default 336
)
returns table (
  report_id uuid,
  reference text,
  threat_type public.threat_type,
  severity public.severity,
  place_label text,
  distance_meters int,
  occurred_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select
    r.id, r.reference, r.threat_type, r.severity, r.place_label,
    round(extensions.ST_Distance(r.location, extensions.ST_Point(p_lng, p_lat)::extensions.geography))::int,
    r.occurred_at
  from public.threat_reports r
  where r.status = 'verified'
    and public.can_see_org(r.organization_id)
    and r.occurred_at > now() - make_interval(hours => window_hours)
    and extensions.ST_DWithin(r.location, extensions.ST_Point(p_lng, p_lat)::extensions.geography, radius_meters)
  order by 6 asc
$$;

grant execute on function public.threats_nearby(double precision, double precision, int, int) to authenticated;


-- --- Duplicate pre-filter ----------------------------------------------------
-- The cheap geo+time narrowing that runs before the model is asked anything.
create or replace function public.duplicate_candidates(
  p_report_id uuid,
  radius_meters int default 5000,
  window_hours int default 12
)
returns table (
  report_id uuid,
  reference text,
  description text,
  distance_meters int,
  minutes_apart int
)
language sql
stable
security definer
set search_path = public
as $$
  with target as (select * from public.threat_reports where id = p_report_id)
  select
    r.id, r.reference, r.description,
    round(extensions.ST_Distance(r.location, t.location))::int,
    round(abs(extract(epoch from (r.occurred_at - t.occurred_at))) / 60)::int
  from public.threat_reports r, target t
  where r.id <> t.id
    and r.organization_id = t.organization_id
    and r.status <> 'dismissed'
    and abs(extract(epoch from (r.occurred_at - t.occurred_at))) <= window_hours * 3600
    and extensions.ST_DWithin(r.location, t.location, radius_meters)
  order by 4 asc
  limit 8
$$;

grant execute on function public.duplicate_candidates(uuid, int, int) to authenticated;
