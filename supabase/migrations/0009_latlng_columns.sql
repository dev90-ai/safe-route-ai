-- =============================================================================
-- 0009  Expose coordinates as plain columns
-- =============================================================================
-- PostgREST serialises a geography column as WKB hex
-- ("0101000020E6100000..."), which every client would then have to decode.
--
-- These generated columns hand back plain numbers instead. They are STORED, so
-- they cost a little disk and nothing at read time, and they cannot drift from
-- the geography they derive from - Postgres recomputes them on every write.
--
-- The geography columns remain the source of truth; PostGIS still does all the
-- distance and radius work. This is purely about the wire format.
-- =============================================================================

alter table public.threat_reports
  add column if not exists lat double precision
    generated always as (extensions.ST_Y(location::extensions.geometry)) stored,
  add column if not exists lng double precision
    generated always as (extensions.ST_X(location::extensions.geometry)) stored;

alter table public.profiles
  add column if not exists lat double precision
    generated always as (extensions.ST_Y(last_known_location::extensions.geometry)) stored,
  add column if not exists lng double precision
    generated always as (extensions.ST_X(last_known_location::extensions.geometry)) stored;

alter table public.safety_alerts
  add column if not exists lat double precision
    generated always as (extensions.ST_Y(location::extensions.geometry)) stored,
  add column if not exists lng double precision
    generated always as (extensions.ST_X(location::extensions.geometry)) stored;

alter table public.sos_events
  add column if not exists lat double precision
    generated always as (extensions.ST_Y(location::extensions.geometry)) stored,
  add column if not exists lng double precision
    generated always as (extensions.ST_X(location::extensions.geometry)) stored;

alter table public.regions
  add column if not exists lat double precision
    generated always as (extensions.ST_Y(center::extensions.geometry)) stored,
  add column if not exists lng double precision
    generated always as (extensions.ST_X(center::extensions.geometry)) stored;


-- The worker-facing view needs rebuilding to expose the blurred coordinates
-- rather than the blurred geography.
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
  -- Own reports keep their exact position; everyone else's is offset by
  -- 50-300 m. Enough to protect the reporter from retaliation, far below any
  -- alert radius, and deterministic so the pin does not wander between loads.
  case when r.reporter_id = auth.uid() then r.lat
       else extensions.ST_Y(extensions.ST_Project(
              r.location,
              50 + (abs(hashtext(r.id::text)) % 250),
              radians((abs(hashtext(r.id::text || 'b')) % 360))
            )::extensions.geometry)
  end as lat,
  case when r.reporter_id = auth.uid() then r.lng
       else extensions.ST_X(extensions.ST_Project(
              r.location,
              50 + (abs(hashtext(r.id::text)) % 250),
              radians((abs(hashtext(r.id::text || 'b')) % 360))
            )::extensions.geometry)
  end as lng,
  r.location_source,
  r.location_accuracy_meters,
  r.region_id,
  r.place_label,
  r.reported_type,
  r.threat_type,
  r.severity,
  r.priority,
  r.alert_radius_meters,
  r.status,
  r.possible_duplicate_of,
  r.ai_suggestions,
  r.ai_status,
  r.verified_at,
  r.occurred_at,
  r.created_at,
  r.updated_at
from public.threat_reports r;

comment on view public.reports_for_worker is
  'Peer-facing report feed. Reporter identity and photo removed, position offset 50-300m. Workers read this, never threat_reports directly.';
