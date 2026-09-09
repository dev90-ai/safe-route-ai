-- =============================================================================
-- Demo seed
-- =============================================================================
-- Not a migration: this is demo data, safe to drop and re-run. It creates the
-- three organisations, the demo accounts, and a small set of reports covering
-- every status so the officer queue, the map and the analytics all have
-- something real to show.
--
--   worker@saferoute.ai / officer@saferoute.ai / admin@saferoute.ai
--   password: Passw0rd!
--
-- Idempotent: re-running replaces the demo rows without touching the schema.
-- =============================================================================

begin;

-- Clear previous demo data (children first).
delete from public.notifications;
delete from public.safety_alerts;
delete from public.sos_events;
delete from public.audit_log;
delete from public.threat_reports;
delete from public.invites;
delete from public.profiles where email like '%@saferoute.ai' or email like '%.example.org';
delete from auth.users where email like '%@saferoute.ai' or email like '%.example.org';
delete from public.organizations;


-- --- Organisations -----------------------------------------------------------
insert into public.organizations (id, name, acronym, regions, contact_email, settings) values
  ('11111111-1111-4111-8111-111111111111',
   'North Eastern Relief Consortium', 'NERC',
   array['garissa-township','dadaab','fafi','lagdera','balambala','wajir-south','wajir-east'],
   'security@nerc.example.org',
   jsonb_build_object('defaultAdvisoryHours', 24, 'dualControlForCritical', true, 'anonymiseReportersToOfficers', false)),
  ('22222222-2222-4222-8222-222222222222',
   'Horn Aid International', 'HAI',
   array['wajir-east','wajir-north','mandera-east','mandera-south','tarbaj'],
   'ops@hornaid.example.org',
   jsonb_build_object('defaultAdvisoryHours', 12, 'dualControlForCritical', false, 'anonymiseReportersToOfficers', false)),
  ('33333333-3333-4333-8333-333333333333',
   'Riverine Health Trust', 'RHT',
   array['tana-delta','ijara','hulugho'],
   'admin@riverine.example.org',
   jsonb_build_object('defaultAdvisoryHours', 24, 'dualControlForCritical', false, 'anonymiseReportersToOfficers', true));

-- Reciprocal partnership between NERC and HAI. Set directly here because the
-- sync trigger fires on UPDATE, and this is the initial state.
update public.organizations
  set cross_share_partners = array['22222222-2222-4222-8222-222222222222'::uuid]
  where id = '11111111-1111-4111-8111-111111111111';
update public.organizations
  set cross_share_partners = array['11111111-1111-4111-8111-111111111111'::uuid]
  where id = '22222222-2222-4222-8222-222222222222';


-- --- Accounts ----------------------------------------------------------------
-- Seeded through the real invite flow rather than around it: a bootstrap invite
-- is created for each account, then the auth user is inserted and the
-- handle_new_user trigger builds the profile from that invite. This exercises
-- the same path a genuine sign-up takes, so a broken trigger fails here rather
-- than in front of a user.
do $$
declare
  person record;
  uid uuid;
  i int := 0;
begin
  for person in
    select * from (values
      ('worker@saferoute.ai',                'Amina Hassan',   'worker',  '11111111-1111-4111-8111-111111111111', 'Field Coordinator, WASH',    array['garissa-township','dadaab','fafi'],           '+254712000101'),
      ('officer@saferoute.ai',               'Daniel Kiptoo',  'officer', '11111111-1111-4111-8111-111111111111', 'Area Security Officer',      array['garissa-township','dadaab','fafi','lagdera'], '+254712000102'),
      ('admin@saferoute.ai',                 'Fatuma Noor',    'admin',   '11111111-1111-4111-8111-111111111111', 'Country Operations Manager', array[]::text[],                                     '+254712000103'),
      ('joseph.wanjala@nerc.example.org',    'Joseph Wanjala', 'worker',  '11111111-1111-4111-8111-111111111111', 'Logistics Officer',          array['garissa-township','lagdera'],                 '+254712000104'),
      ('halima.abdi@nerc.example.org',       'Halima Abdi',    'worker',  '11111111-1111-4111-8111-111111111111', 'Nutrition Officer',          array['dadaab'],                                     '+254712000105'),
      ('peter.mwangi@nerc.example.org',      'Peter Mwangi',   'worker',  '11111111-1111-4111-8111-111111111111', 'Driver / Fleet',             array['garissa-township','fafi','balambala'],        '+254712000106'),
      ('sarah.lokwang@nerc.example.org',     'Sarah Lokwang',  'worker',  '11111111-1111-4111-8111-111111111111', 'Protection Officer',         array['wajir-south','lagdera'],                      '+254712000107'),
      ('grace.otieno@nerc.example.org',      'Grace Otieno',   'officer', '11111111-1111-4111-8111-111111111111', 'Deputy Security Officer',    array['garissa-township','dadaab','wajir-east'],     '+254712000109'),
      ('zeinab.omar@hornaid.example.org',    'Zeinab Omar',    'worker',  '22222222-2222-4222-8222-222222222222', 'Field Officer',              array['wajir-east','tarbaj'],                        '+254712000110'),
      ('mohamed.ali@hornaid.example.org',    'Mohamed Ali',    'officer', '22222222-2222-4222-8222-222222222222', 'Security Manager',           array['wajir-east','mandera-east'],                  '+254712000111'),
      ('esther.mutua@riverine.example.org',  'Esther Mutua',   'worker',  '33333333-3333-4333-8333-333333333333', 'Clinical Officer',           array['tana-delta','ijara'],                         '+254712000113'),
      ('ruth.chebet@riverine.example.org',   'Ruth Chebet',    'officer', '33333333-3333-4333-8333-333333333333', 'Safety Focal Point',         array['tana-delta','ijara','hulugho'],               '+254712000114')
    ) as t(email, full_name, role, org, job_title, regions, phone)
  loop
    i := i + 1;
    uid := extensions.gen_random_uuid();

    -- Bootstrap invite: no issuer, because provisioning has no admin yet.
    insert into public.invites (email, full_name, role, organization_id, invited_by, code, operating_regions, expires_at)
    values (person.email, person.full_name, person.role::public.user_role, person.org::uuid, null,
            'SEED-' || lpad(i::text, 4, '0'), person.regions, now() + interval '1 day');

    insert into auth.users (
      instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
      raw_app_meta_data, raw_user_meta_data, created_at, updated_at
    ) values (
      '00000000-0000-0000-0000-000000000000', uid, 'authenticated', 'authenticated',
      person.email,
      extensions.crypt('Passw0rd!', extensions.gen_salt('bf')),
      now(),
      jsonb_build_object('provider', 'email', 'providers', array['email']),
      jsonb_build_object('full_name', person.full_name, 'phone', person.phone,
                         'invite_code', 'SEED-' || lpad(i::text, 4, '0')),
      now() - (i || ' days')::interval, now()
    );

    -- GoTrue needs a matching identity row or email sign-in fails.
    insert into auth.identities (provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
    values (
      uid::text, uid,
      jsonb_build_object('sub', uid::text, 'email', person.email, 'email_verified', true, 'phone_verified', false),
      'email', now(), now(), now()
    );

    -- Details the invite does not carry, plus a plausible last known position
    -- so the alert fan-out has something to match on.
    update public.profiles set
      job_title = person.job_title,
      last_seen_at = now() - (i || ' hours')::interval,
      onboarded_at = now() - (i || ' days')::interval,
      last_known_location = case
        when array_length(person.regions, 1) is null then null
        else (select extensions.ST_Project(g.center, (i * 1700) % 20000, radians(i * 47))
              from public.regions g where g.id = person.regions[1])
      end
    where id = uid;
  end loop;
end $$;


-- --- Outstanding invites -----------------------------------------------------
insert into public.invites (email, full_name, role, organization_id, invited_by, code, operating_regions, expires_at)
select 'nasra.yusuf@nerc.example.org', 'Nasra Yusuf', 'worker',
       '11111111-1111-4111-8111-111111111111', p.id, 'NERC-4821',
       array['garissa-township','balambala'], now() + interval '5 days'
from public.profiles p where p.email = 'admin@saferoute.ai';

insert into public.invites (email, full_name, role, organization_id, invited_by, code, operating_regions, expires_at)
select 'kevin.omondi@nerc.example.org', 'Kevin Omondi', 'officer',
       '11111111-1111-4111-8111-111111111111', p.id, 'NERC-9037',
       array['dadaab','fafi'], now() + interval '7 days'
from public.profiles p where p.email = 'admin@saferoute.ai';


-- --- Reports -----------------------------------------------------------------
-- Covers every status: a pending queue for the officer, verified threats for
-- the map and Safe Route, and dismissed rows so the AI-agreement metric is
-- honest. Two of the pending pair describe the same event, to exercise
-- duplicate detection.
do $$
declare
  amina uuid;  joseph uuid; halima uuid; peter uuid; sarah uuid;
  daniel uuid; zeinab uuid; esther uuid;
  nerc uuid := '11111111-1111-4111-8111-111111111111';
  hai  uuid := '22222222-2222-4222-8222-222222222222';
  rht  uuid := '33333333-3333-4333-8333-333333333333';
begin
  select id into amina  from public.profiles where email = 'worker@saferoute.ai';
  select id into joseph from public.profiles where email = 'joseph.wanjala@nerc.example.org';
  select id into halima from public.profiles where email = 'halima.abdi@nerc.example.org';
  select id into peter  from public.profiles where email = 'peter.mwangi@nerc.example.org';
  select id into sarah  from public.profiles where email = 'sarah.lokwang@nerc.example.org';
  select id into daniel from public.profiles where email = 'officer@saferoute.ai';
  select id into zeinab from public.profiles where email = 'zeinab.omar@hornaid.example.org';
  select id into esther from public.profiles where email = 'esther.mutua@riverine.example.org';

  -- Pending: the officer's queue on first launch.
  insert into public.threat_reports
    (reporter_id, organization_id, description, location, region_id, place_label, reported_type, status, occurred_at, created_at)
  values
    (halima, nerc,
     'Two vehicles were stopped by armed men about 12 km outside Dadaab on the Garissa road around 09:40. The men were carrying rifles and took phones and cash from the passengers before letting them go. Nobody was injured but the road is being avoided by matatus now.',
     extensions.ST_Point(40.2100, 0.0100)::extensions.geography, 'dadaab', 'Dadaab Town', 'road_ambush', 'pending', now() - interval '3 hours', now() - interval '2 hours 40 minutes'),

    (joseph, nerc,
     'Reports of gunfire near the livestock market this morning. I heard maybe six or seven shots from the direction of the market. People ran towards the town centre. Unconfirmed whether anyone was hurt.',
     extensions.ST_Point(39.6620, -0.4530)::extensions.geography, 'garissa-township', 'Garissa Town', null, 'pending', now() - interval '5 hours', now() - interval '4 hours 30 minutes'),

    -- Same event as the first, filed by someone else 35 minutes later.
    (peter, nerc,
     'Vehicles ambushed on the Dadaab road this morning, roughly 12km from town. Armed group robbed passengers of phones and money. No casualties reported. Transport operators are refusing to use the route.',
     extensions.ST_Point(40.2140, 0.0130)::extensions.geography, 'dadaab', 'Dadaab Town', 'road_ambush', 'pending', now() - interval '2 hours 24 minutes', now() - interval '2 hours'),

    (peter, nerc,
     'Illegal roadblock set up at the junction. Men in civilian clothes demanded 2000 shillings per vehicle to pass. Our driver refused and we turned back. This is the third time this month at the same spot.',
     extensions.ST_Point(39.8500, -1.1000)::extensions.geography, 'fafi', 'Bura Junction', 'checkpoint_extortion', 'pending', now() - interval '8 hours', now() - interval '7 hours'),

    (zeinab, hai,
     'Large crowd gathered outside the sub-county offices protesting the delayed relief distribution. Police have deployed and there is stone throwing. The main road past the offices is currently blocked and staff should not attempt to pass.',
     extensions.ST_Point(40.0600, 1.7500)::extensions.geography, 'wajir-east', 'Wajir Town', 'civil_unrest', 'pending', now() - interval '6 hours', now() - interval '5 hours');

  -- Verified: drives the map, Safe Route scoring and the alert feed.
  insert into public.threat_reports
    (reporter_id, organization_id, description, location, region_id, place_label,
     threat_type, severity, priority, alert_radius_meters, status, verified_by, verified_at, occurred_at, created_at)
  values
    (joseph, nerc,
     'An improvised explosive device detonated under a security vehicle on the Modogashe road at approximately 07:15. Multiple casualties reported. The road is closed in both directions and security forces are conducting a sweep for secondary devices. All movement on this axis must stop immediately.',
     extensions.ST_Point(39.6833, 0.7167)::extensions.geography, 'lagdera', 'Modogashe',
     'ied_explosive', 'critical', 10, 30000, 'verified', daniel, now() - interval '19 hours', now() - interval '20 hours', now() - interval '19 hours 40 minutes'),

    (halima, nerc,
     'Exchange of fire between security forces and an armed group approximately 8 km south of the camp during the night. Sustained gunfire for around forty minutes. Camp residents report the group moved east afterwards. Camp operations suspended pending assessment.',
     extensions.ST_Point(40.3500, 0.0000)::extensions.geography, 'dadaab', 'Hagadera Camp',
     'armed_incident', 'high', 8, 12000, 'verified', daniel, now() - interval '38 hours', now() - interval '40 hours', now() - interval '39 hours'),

    (peter, nerc,
     'Unexploded ordnance found by children near the dry riverbed east of the settlement. The area has been cordoned by local elders and police have been informed. Nobody has been hurt but the item is still in place.',
     extensions.ST_Point(39.6333, -0.0667)::extensions.geography, 'balambala', 'Balambala',
     'ied_explosive', 'high', 8, 18000, 'verified', daniel, now() - interval '82 hours', now() - interval '84 hours', now() - interval '83 hours'),

    (sarah, nerc,
     'Gunmen stopped a bus on the main road and robbed passengers at gunpoint before driving off. No injuries. Incident lasted about fifteen minutes. Passengers reported four attackers.',
     extensions.ST_Point(39.4906, 1.0117)::extensions.geography, 'wajir-south', 'Habaswein',
     'banditry', 'medium', 5, 5000, 'verified', daniel, now() - interval '94 hours', now() - interval '96 hours', now() - interval '95 hours'),

    (zeinab, hai,
     'Armed men attacked a livestock camp overnight and drove away several hundred camels. One herder was killed and two others were injured and taken to the dispensary. The attackers were heavily armed and moved north towards the border.',
     extensions.ST_Point(39.7000, 1.7333)::extensions.geography, 'wajir-west', 'Griftu',
     'banditry', 'critical', 9, 15000, 'verified', daniel, now() - interval '29 hours', now() - interval '30 hours', now() - interval '29 hours 30 minutes'),

    (esther, rht,
     'Vehicle carrying traders was ambushed on the Ijara road late afternoon. Gunmen fired at the vehicle and it went off the road. Two people were wounded and are being treated. The gunmen escaped into the bush.',
     extensions.ST_Point(40.1244, -1.6897)::extensions.geography, 'ijara', 'Masalani',
     'road_ambush', 'high', 8, 15000, 'verified', daniel, now() - interval '58 hours', now() - interval '60 hours', now() - interval '59 hours');

  -- Dismissed: proves the reject path and keeps AI agreement honest.
  insert into public.threat_reports
    (reporter_id, organization_id, description, location, region_id, place_label,
     status, verified_by, verified_at, dismissed_reason, occurred_at, created_at)
  values
    (joseph, nerc,
     'Heard from a neighbour that there might be trouble at the market tomorrow. Nothing has happened yet, this is just a rumour going around.',
     extensions.ST_Point(39.6583, -0.4569)::extensions.geography, 'garissa-township', 'Garissa Town',
     'dismissed', daniel, now() - interval '33 hours', 'Unsubstantiated rumour; no corroboration found.', now() - interval '34 hours', now() - interval '33 hours 30 minutes'),

    (zeinab, hai,
     'Loud bangs heard near the airstrip around midnight. Later confirmed to be a generator backfiring at the compound. No security incident, situation calm.',
     extensions.ST_Point(40.0573, 1.7471)::extensions.geography, 'wajir-east', 'Wajir Town',
     'dismissed', daniel, now() - interval '45 hours', 'Confirmed with a second source as a non-security event.', now() - interval '46 hours', now() - interval '45 hours 30 minutes');
end $$;


-- --- AI suggestions ----------------------------------------------------------
-- In production these are written by the Grok Edge Function on insert. Seeded
-- here so the officer queue shows a realistic verification decision: what the
-- model proposed, how confident it was, and where it flagged a duplicate.
--
-- Written before the 0008 guard can object because this runs as the service
-- role (auth.uid() is null), which is exactly the classifier's own path.
update public.threat_reports r set
  ai_status = 'complete',
  ai_suggestions = jsonb_build_object(
    'model', 'grok-4-fast',
    'generatedAt', to_char(r.created_at + interval '2 seconds', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'latencyMs', 900 + (abs(hashtext(r.id::text)) % 1600),
    'threatType', coalesce(r.threat_type, r.reported_type, 'other')::text,
    'severity', coalesce(r.severity::text,
      case
        when r.description ~* '(killed|dead|fatal|casualt)' then 'critical'
        when r.description ~* '(injur|wounded|gunfire|ambush|explosive|detonat)' then 'high'
        when r.description ~* '(roadblock|demanded|crowd|protest)' then 'medium'
        else 'low'
      end),
    'priority', coalesce(r.priority, 5),
    'confidence', round((0.55 + (abs(hashtext(r.id::text)) % 40) / 100.0)::numeric, 2),
    'alertRadiusMeters', coalesce(r.alert_radius_meters, 5000),
    'summary', left(regexp_replace(r.description, 's+', ' ', 'g'), 120),
    'rationale', 'Classified from matching indicators in the report text.',
    'keyIndicators', to_jsonb(array_remove(array[
      case when r.description ~* 'armed (men|group)' then 'Mentions "armed men"' end,
      case when r.description ~* '(ambush|stopped)' then 'Vehicle stopped or ambushed' end,
      case when r.description ~* '(killed|dead|fatal)' then 'fatalities reported' end,
      case when r.description ~* '(injur|wounded)' then 'injuries reported' end,
      case when r.description ~* '(rumou?r|unconfirmed|allegedly)' then 'source is second-hand' end
    ], null)),
    'possibleDuplicateOf', null,
    'duplicateConfidence', 0,
    'duplicateRationale', null,
    'duplicateCandidates', '[]'::jsonb,
    'recommendedActions', to_jsonb(array[
      'Confirm the report with a second source before wider dissemination.',
      'Advise staff to avoid the immediate area until further notice.'
    ]),
    'needsMoreInfo', length(btrim(r.description)) < 60
  )
where r.ai_suggestions is null;

-- The duplicate pair: the later Dadaab ambush report points at the earlier one,
-- so the officer queue has a real duplicate decision to make.
with pair as (
  select
    (select id from public.threat_reports where place_label = 'Dadaab Town' and status = 'pending' order by occurred_at asc  limit 1) as original,
    (select id from public.threat_reports where place_label = 'Dadaab Town' and status = 'pending' order by occurred_at desc limit 1) as duplicate
)
update public.threat_reports r set
  possible_duplicate_of = pair.original,
  ai_suggestions = jsonb_set(
    jsonb_set(r.ai_suggestions, '{possibleDuplicateOf}', to_jsonb(pair.original::text)),
    '{duplicateRationale}',
    to_jsonb('Describes the same event as an existing report roughly 400 m away, filed 35 min apart, with high wording overlap.'::text)
  )
from pair
where r.id = pair.duplicate and pair.original is distinct from pair.duplicate;


-- --- Alerts, fanned out through the real function ----------------------------
do $$
declare
  r record;
  daniel uuid;
  alert_id uuid;
begin
  select id into daniel from public.profiles where email = 'officer@saferoute.ai';

  for r in select * from public.threat_reports where status = 'verified' order by verified_at
  loop
    insert into public.safety_alerts
      (issued_by, organization_id, related_report_id, title, message, severity, threat_type,
       location, radius_meters, region_ids, kind, created_at, expires_at)
    values (
      daniel, r.organization_id, r.id,
      initcap(replace(r.threat_type::text, '_', ' ')) || ' near ' || coalesce(r.place_label, 'your area'),
      'Verified ' || r.severity || ' ' || replace(r.threat_type::text, '_', ' ') || '. '
        || case r.severity
             when 'critical' then 'Do not move. Shelter in place and contact your security officer now.'
             when 'high' then 'Suspend movement through the area. Essential travel only, with clearance.'
             when 'medium' then 'Avoid the immediate area. Confirm before non-essential movement.'
             else 'Stay aware. No movement restriction required.' end,
      r.severity, r.threat_type, r.location, r.alert_radius_meters,
      case when r.region_id is null then '{}'::text[] else array[r.region_id] end,
      'threat', r.verified_at, r.verified_at + interval '72 hours'
    )
    returning id into alert_id;

    perform public.fan_out_alert(alert_id);
  end loop;

  -- A standing advisory, not tied to any single incident.
  insert into public.safety_alerts
    (issued_by, organization_id, title, message, severity, threat_type, location, radius_meters, region_ids, kind, created_at, expires_at)
  values (
    daniel, '11111111-1111-4111-8111-111111111111',
    'Movement curfew: Garissa - Dadaab corridor',
    'Following repeated incidents on the Dadaab road, all movement on this corridor is restricted to 08:00-16:00 with a minimum two-vehicle convoy. Clearance required from the area security officer for any exception.',
    'high', 'road_ambush', extensions.ST_Point(39.9800, -0.2000)::extensions.geography, 40000,
    array['garissa-township','dadaab'], 'advisory', now() - interval '16 hours', now() + interval '5 days'
  ) returning id into alert_id;

  perform public.fan_out_alert(alert_id);
end $$;


-- --- SOS ---------------------------------------------------------------------
do $$
declare
  peter uuid; halima uuid; daniel uuid; origin extensions.geography;
begin
  select id into peter  from public.profiles where email = 'peter.mwangi@nerc.example.org';
  select id into halima from public.profiles where email = 'halima.abdi@nerc.example.org';
  select id into daniel from public.profiles where email = 'officer@saferoute.ai';

  -- One live event, so the officer console has something to respond to.
  origin := extensions.ST_Point(39.7100, -0.4200)::extensions.geography;
  insert into public.sos_events (worker_id, organization_id, status, reason, location, accuracy_meters, track, timeline, created_at)
  values (
    peter, '11111111-1111-4111-8111-111111111111', 'active',
    'Vehicle stopped by armed men on the Fafi road', origin, 22,
    jsonb_build_array(
      jsonb_build_object('point', jsonb_build_object('lat', -0.4200, 'lng', 39.7100), 'ts', to_char(now() - interval '9 minutes', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), 'accuracyMeters', 22),
      jsonb_build_object('point', jsonb_build_object('lat', -0.4195, 'lng', 39.7112), 'ts', to_char(now() - interval '5 minutes', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), 'accuracyMeters', 31)
    ),
    jsonb_build_array(
      jsonb_build_object('id','t1','ts', to_char(now() - interval '9 minutes', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), 'kind','triggered','text','SOS triggered by Peter Mwangi.'),
      jsonb_build_object('id','t2','ts', to_char(now() - interval '5 minutes', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), 'kind','location','text','Location update received (31 m accuracy).')
    ),
    now() - interval '9 minutes'
  );

  -- A resolved event with a full timeline, for post-incident review.
  origin := extensions.ST_Point(40.3086, 0.0553)::extensions.geography;
  insert into public.sos_events
    (worker_id, organization_id, status, reason, location, accuracy_meters, track, timeline,
     acknowledged_by, acknowledged_at, resolved_by, resolved_at, resolution_note, created_at)
  values (
    halima, '11111111-1111-4111-8111-111111111111', 'resolved',
    'Crowd surrounded the vehicle at the distribution point', origin, 15,
    jsonb_build_array(jsonb_build_object('point', jsonb_build_object('lat', 0.0553, 'lng', 40.3086), 'ts', to_char(now() - interval '4 days', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), 'accuracyMeters', 15)),
    jsonb_build_array(
      jsonb_build_object('id','p1','ts', to_char(now() - interval '4 days', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), 'kind','triggered','text','SOS triggered by Halima Abdi.'),
      jsonb_build_object('id','p2','ts', to_char(now() - interval '4 days' + interval '12 seconds', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), 'kind','queued-offline','text','No connectivity - SOS held in the local queue.'),
      jsonb_build_object('id','p3','ts', to_char(now() - interval '4 days' + interval '71 seconds', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), 'kind','synced','text','Connectivity restored - SOS delivered to officers.'),
      jsonb_build_object('id','p4','ts', to_char(now() - interval '4 days' + interval '96 seconds', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), 'kind','acknowledged','text','Acknowledged by Daniel Kiptoo.'),
      jsonb_build_object('id','p5','ts', to_char(now() - interval '4 days' + interval '41 minutes', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), 'kind','resolved','text','Resolved: worker safe, no injuries.')
    ),
    daniel, now() - interval '4 days' + interval '96 seconds',
    daniel, now() - interval '4 days' + interval '41 minutes',
    'Worker extracted by the county security team. No injuries. Distribution rescheduled.',
    now() - interval '4 days'
  );
end $$;

commit;
