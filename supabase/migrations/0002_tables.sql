-- =============================================================================
-- 0002  Tables and indexes
-- =============================================================================
-- Mirrors src/api/types.ts one-to-one, so the client contract is unchanged when
-- the mock transport is swapped for supabase-js.
-- =============================================================================


-- --- organizations -----------------------------------------------------------
create table if not exists public.organizations (
  id                    uuid primary key default gen_random_uuid(),
  name                  text not null check (length(btrim(name)) between 2 and 120),
  acronym               text not null check (length(btrim(acronym)) between 2 and 12),
  regions               text[] not null default '{}',
  -- Reciprocity is enforced by a trigger in 0005, not here: a one-way
  -- partnership would let an org consume threats without contributing any.
  cross_share_partners  uuid[] not null default '{}',
  contact_email         text check (contact_email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  settings              jsonb not null default jsonb_build_object(
                          'defaultAdvisoryHours', 24,
                          'dualControlForCritical', false,
                          'anonymiseReportersToOfficers', false
                        ),
  created_at            timestamptz not null default now()
);


-- --- profiles ----------------------------------------------------------------
-- One row per auth.users row. Deleting the auth user cascades.
create table if not exists public.profiles (
  id                        uuid primary key references auth.users(id) on delete cascade,
  email                     text not null unique,
  phone                     text,
  full_name                 text not null check (length(btrim(full_name)) between 2 and 80),
  role                      public.user_role not null default 'worker',
  organization_id           uuid not null references public.organizations(id) on delete restrict,
  job_title                 text,
  operating_regions         text[] not null default '{}',
  last_known_location       extensions.geography(Point, 4326),
  last_seen_at              timestamptz,
  status                    public.profile_status not null default 'active',
  avatar_color              text not null default '#3B82F6',
  onboarded_at              timestamptz,
  notification_preferences  jsonb not null default jsonb_build_object(
                              'push', true,
                              'criticalOnly', false,
                              'quietHours', jsonb_build_object('enabled', false, 'startHour', 22, 'endHour', 6)
                            ),
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now()
);

create index if not exists profiles_org_idx on public.profiles (organization_id);
create index if not exists profiles_role_idx on public.profiles (organization_id, role);
-- GIST on geography is what makes "everyone inside this alert radius" fast.
create index if not exists profiles_location_idx on public.profiles using gist (last_known_location);
create index if not exists profiles_regions_idx on public.profiles using gin (operating_regions);


-- --- threat_reports ----------------------------------------------------------
create table if not exists public.threat_reports (
  id                        uuid primary key default gen_random_uuid(),
  reference                 text not null unique,
  reporter_id               uuid not null references public.profiles(id) on delete restrict,
  organization_id           uuid not null references public.organizations(id) on delete restrict,
  description               text not null check (length(btrim(description)) between 20 and 2000),
  photo_url                 text,
  location                  extensions.geography(Point, 4326) not null,
  location_accuracy_meters  numeric,
  location_source           public.location_source not null default 'gps',
  region_id                 text,
  place_label               text,

  -- What the reporter optionally pre-selected. Never authoritative.
  reported_type             public.threat_type,

  -- Officer-confirmed fields. Null until a human signs off - that is the whole
  -- point of the verification step, so they are deliberately nullable.
  threat_type               public.threat_type,
  severity                  public.severity,
  priority                  int check (priority between 1 and 10),
  alert_radius_meters       int check (alert_radius_meters between 250 and 60000),

  status                    public.report_status not null default 'pending',
  possible_duplicate_of     uuid references public.threat_reports(id) on delete set null,

  -- Raw model output, kept verbatim for audit. Never overwritten by a human.
  ai_suggestions            jsonb,
  ai_status                 public.ai_status not null default 'queued',

  verified_by               uuid references public.profiles(id) on delete set null,
  verified_at               timestamptz,
  dismissed_reason          text,

  occurred_at               timestamptz not null,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),

  -- A verified report must carry the fields an alert needs. This is the
  -- database refusing to let a half-verified row exist.
  constraint verified_is_complete check (
    status <> 'verified'
    or (threat_type is not null and severity is not null and alert_radius_meters is not null)
  ),
  constraint resolved_has_actor check (
    status = 'pending' or verified_by is not null
  ),
  constraint dismissed_has_reason check (
    status <> 'dismissed' or dismissed_reason is not null
  )
);

create index if not exists reports_org_status_idx on public.threat_reports (organization_id, status);
create index if not exists reports_location_idx on public.threat_reports using gist (location);
create index if not exists reports_occurred_idx on public.threat_reports (occurred_at desc);
create index if not exists reports_reporter_idx on public.threat_reports (reporter_id);
-- Partial index for the officer queue - by far the hottest read in the system.
create index if not exists reports_pending_idx on public.threat_reports (organization_id, created_at)
  where status = 'pending';
-- Supports the duplicate pre-filter: recent verified reports, newest first.
create index if not exists reports_verified_recent_idx on public.threat_reports (organization_id, occurred_at desc)
  where status = 'verified';


-- --- safety_alerts -----------------------------------------------------------
create table if not exists public.safety_alerts (
  id                uuid primary key default gen_random_uuid(),
  issued_by         uuid not null references public.profiles(id) on delete restrict,
  organization_id   uuid not null references public.organizations(id) on delete restrict,
  related_report_id uuid references public.threat_reports(id) on delete cascade,
  title             text not null check (length(btrim(title)) between 6 and 90),
  message           text not null check (length(btrim(message)) between 20 and 1200),
  severity          public.severity not null,
  threat_type       public.threat_type,
  location          extensions.geography(Point, 4326),
  radius_meters     int check (radius_meters between 500 and 80000),
  region_ids        text[] not null default '{}',
  kind              public.alert_kind not null default 'threat',
  recipient_count   int not null default 0,
  created_at        timestamptz not null default now(),
  expires_at        timestamptz,
  cancelled_at      timestamptz
);

create index if not exists alerts_org_created_idx on public.safety_alerts (organization_id, created_at desc);
create index if not exists alerts_location_idx on public.safety_alerts using gist (location);
create index if not exists alerts_active_idx on public.safety_alerts (organization_id, expires_at)
  where cancelled_at is null;


-- --- notifications -----------------------------------------------------------
-- The persistent feed. Push can be missed; this is the record.
create table if not exists public.notifications (
  id                uuid primary key default gen_random_uuid(),
  profile_id        uuid not null references public.profiles(id) on delete cascade,
  alert_id          uuid not null references public.safety_alerts(id) on delete cascade,
  report_id         uuid references public.threat_reports(id) on delete set null,
  title             text not null,
  body              text not null,
  severity          public.severity not null,
  -- Why this person was in the fan-out. Shown verbatim in the feed, so an
  -- alert is never mysterious.
  match_reasons     text[] not null default '{}',
  distance_meters   int,
  delivered_at      timestamptz not null default now(),
  read_at           timestamptz,
  unique (profile_id, alert_id)
);

create index if not exists notifications_feed_idx on public.notifications (profile_id, delivered_at desc);
create index if not exists notifications_unread_idx on public.notifications (profile_id)
  where read_at is null;


-- --- sos_events --------------------------------------------------------------
-- `track` and `timeline` are jsonb arrays to match the client contract exactly.
-- At the volumes involved (one event, a few hundred pings) this is the right
-- trade: one row to read, one realtime payload, no join on the hot path.
create table if not exists public.sos_events (
  id                uuid primary key default gen_random_uuid(),
  worker_id         uuid not null references public.profiles(id) on delete restrict,
  organization_id   uuid not null references public.organizations(id) on delete restrict,
  status            public.sos_status not null default 'active',
  reason            text,
  location          extensions.geography(Point, 4326) not null,
  accuracy_meters   numeric,
  track             jsonb not null default '[]'::jsonb,
  timeline          jsonb not null default '[]'::jsonb,
  acknowledged_by   uuid references public.profiles(id) on delete set null,
  acknowledged_at   timestamptz,
  resolved_by       uuid references public.profiles(id) on delete set null,
  resolved_at       timestamptz,
  resolution_note   text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists sos_org_status_idx on public.sos_events (organization_id, status);
create index if not exists sos_worker_idx on public.sos_events (worker_id, created_at desc);
-- At most one open SOS per worker, so a second tap escalates rather than
-- fragmenting the officer's view across two cards.
create unique index if not exists sos_one_live_per_worker on public.sos_events (worker_id)
  where status in ('active', 'acknowledged');


-- --- invites -----------------------------------------------------------------
-- Workers and officers never self-register into an organisation; the code is
-- what binds an account to an org and a role.
create table if not exists public.invites (
  id                uuid primary key default gen_random_uuid(),
  email             text not null,
  full_name         text not null,
  role              public.user_role not null default 'worker',
  organization_id   uuid not null references public.organizations(id) on delete cascade,
  invited_by        uuid not null references public.profiles(id) on delete restrict,
  code              text not null unique,
  operating_regions text[] not null default '{}',
  created_at        timestamptz not null default now(),
  expires_at        timestamptz not null default (now() + interval '7 days'),
  accepted_at       timestamptz
);

create index if not exists invites_org_idx on public.invites (organization_id);
create unique index if not exists invites_one_open_per_email on public.invites (lower(email))
  where accepted_at is null;


-- --- audit_log ---------------------------------------------------------------
-- Append-only. No update or delete policy is ever granted on this table; that
-- is what makes the verification chain defensible after an incident.
create table if not exists public.audit_log (
  id                uuid primary key default gen_random_uuid(),
  ts                timestamptz not null default now(),
  actor_id          uuid references public.profiles(id) on delete set null,
  actor_role        text not null,
  organization_id   uuid references public.organizations(id) on delete set null,
  action            text not null,
  entity            text not null,
  entity_id         uuid,
  summary           text not null,
  before            jsonb,
  after             jsonb
);

create index if not exists audit_org_ts_idx on public.audit_log (organization_id, ts desc);
create index if not exists audit_entity_idx on public.audit_log (entity, entity_id);
