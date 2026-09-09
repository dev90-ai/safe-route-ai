-- =============================================================================
-- 0001  Extensions and enums
-- =============================================================================
-- PostGIS lives in the `extensions` schema rather than `public`, per Supabase
-- guidance: it keeps the public schema to application objects and stops the
-- security advisor flagging a writable extension surface.
-- =============================================================================

create schema if not exists extensions;

create extension if not exists postgis with schema extensions;
create extension if not exists pgcrypto with schema extensions;

-- --- Enums -------------------------------------------------------------------
-- These mirror src/constants/threats.ts exactly. Keeping them as enums rather
-- than free text means a bad client cannot invent a severity level.

do $$ begin
  create type public.user_role as enum ('worker', 'officer', 'admin');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.profile_status as enum ('active', 'invited', 'deactivated');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.threat_type as enum (
    'armed_incident',
    'banditry',
    'road_ambush',
    'ied_explosive',
    'abduction',
    'civil_unrest',
    'checkpoint_extortion',
    'inter_communal_conflict',
    'crime',
    'other'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.severity as enum ('low', 'medium', 'high', 'critical');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.report_status as enum ('pending', 'verified', 'dismissed');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.ai_status as enum ('queued', 'processing', 'complete', 'failed');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.sos_status as enum ('active', 'acknowledged', 'resolved', 'cancelled');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.alert_kind as enum ('threat', 'advisory');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.location_source as enum ('gps', 'manual-pin');
exception when duplicate_object then null; end $$;
