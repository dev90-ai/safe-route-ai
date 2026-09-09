/**
 * End-to-end test of the Supabase transport.
 *
 * Exercises the same REST and RPC calls the app's api/supabase/* modules make,
 * as real signed-in users, and asserts the full loop works: file a report,
 * verify it, fan out the alert, see it arrive in a worker's feed.
 *
 *   node scripts/transport-tests.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

function env(key) {
  const raw = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
  const line = raw.split('\n').find((l) => l.trim().startsWith(`${key}=`));
  if (!line) throw new Error(`${key} missing from .env`);
  return line.slice(line.indexOf('=') + 1).trim();
}

const URL = env('EXPO_PUBLIC_SUPABASE_URL');
const ANON = env('EXPO_PUBLIC_SUPABASE_ANON_KEY');

let passed = 0;
let failed = 0;
const failures = [];

function check(name, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failed += 1;
    failures.push(name);
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function signIn(email) {
  const res = await fetch(`${URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: ANON, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'Passw0rd!' }),
  });
  const json = await res.json();
  if (!json.access_token) throw new Error(`sign-in failed for ${email}: ${JSON.stringify(json)}`);
  return { token: json.access_token, userId: json.user.id };
}

function api(token) {
  const headers = {
    apikey: ANON,
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
  return {
    async get(pathAndQuery) {
      const res = await fetch(`${URL}/rest/v1/${pathAndQuery}`, { headers });
      return { status: res.status, body: await res.json() };
    },
    async send(method, pathAndQuery, body) {
      const res = await fetch(`${URL}/rest/v1/${pathAndQuery}`, {
        method,
        headers: { ...headers, Prefer: 'return=representation' },
        body: JSON.stringify(body),
      });
      const text = await res.text();
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
      return { status: res.status, body: parsed };
    },
    async rpc(name, args) {
      const res = await fetch(`${URL}/rest/v1/rpc/${name}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(args),
      });
      return { status: res.status, body: await res.json() };
    },
  };
}

async function main() {
  console.log(`Supabase transport\n${URL}\n`);

  const worker = await signIn('worker@saferoute.ai');
  const officer = await signIn('officer@saferoute.ai');
  const peer = await signIn('halima.abdi@nerc.example.org'); // Dadaab region
  const w = api(worker.token);
  const pw = api(peer.token);
  const o = api(officer.token);

  // --- Coordinates come back usable ----------------------------------------
  console.log('geography mapping');
  const geoRows = await w.get('reports_for_worker?select=id,lat,lng&limit=3');
  check('worker view returns numeric lat/lng',
    Array.isArray(geoRows.body) && geoRows.body.every((r) => typeof r.lat === 'number' && typeof r.lng === 'number'),
    JSON.stringify(geoRows.body?.[0]));
  check('coordinates are inside East Africa',
    geoRows.body.every((r) => r.lat > -5 && r.lat < 6 && r.lng > 33 && r.lng < 43));

  const rawRow = await o.get('threat_reports?select=id,lat,lng&limit=1');
  const viewRow = await w.get(`reports_for_worker?select=id,lat,lng&id=eq.${rawRow.body[0].id}`);
  if (viewRow.body.length) {
    const dLat = Math.abs(rawRow.body[0].lat - viewRow.body[0].lat);
    const dLng = Math.abs(rawRow.body[0].lng - viewRow.body[0].lng);
    const offsetMetres = Math.hypot(dLat * 111_320, dLng * 111_320);
    check('reporter position is blurred for peers (50-300 m)',
      offsetMetres > 20 && offsetMetres < 400, `${Math.round(offsetMetres)} m`);
  }

  // --- The loop: report -> verify -> alert -> feed ---------------------------
  console.log('\nthe loop');
  // The reporter is deliberately excluded from their own alert, so the feed we
  // watch belongs to a colleague who operates in the same region.
  const before = await pw.get('notifications?select=id');
  const beforeCount = before.body.length;

  // The app mints the id on-device before any network call, so it doubles as
  // the idempotency key. It must be a real uuid: a prefixed string like
  // "rep_0fce3f33-4de" is rejected by Postgres, and if that rejection is
  // treated as retryable the offline queue loops forever.
  const clientId = crypto.randomUUID();

  const created = await w.send('POST', 'threat_reports', {
    id: clientId,
    reporter_id: worker.userId,
    organization_id: (await w.get(`profiles?select=organization_id&id=eq.${worker.userId}`)).body[0].organization_id,
    description:
      'Transport test: armed men stopped a vehicle on the Dadaab road and robbed the passengers before leaving. No injuries reported.',
    location: 'SRID=4326;POINT(40.2120 0.0115)',
    location_source: 'gps',
    region_id: 'dadaab',
    place_label: 'Dadaab Town',
    reported_type: 'road_ambush',
    status: 'pending',
    occurred_at: new Date().toISOString(),
  });

  check('worker can file a report', created.status === 201, `status ${created.status} ${JSON.stringify(created.body).slice(0, 140)}`);
  check('a client-minted uuid is accepted as the row id',
    Array.isArray(created.body) && created.body[0]?.id === clientId,
    created.body?.[0]?.id);

  // Idempotency: replaying the same id must not create a second report.
  const replay = await w.send('POST', 'threat_reports', {
    id: clientId,
    reporter_id: worker.userId,
    organization_id: created.body[0].organization_id,
    description: 'Transport test: replay of the same client id, must be rejected as a duplicate.',
    location: 'SRID=4326;POINT(40.2120 0.0115)',
    location_source: 'gps',
    status: 'pending',
    occurred_at: new Date().toISOString(),
  });
  check('replaying a client id cannot create a duplicate report',
    replay.status === 409 || replay.status >= 400, `status ${replay.status}`);
  const reportId = Array.isArray(created.body) ? created.body[0]?.id : null;
  check('report got a human-quotable reference',
    Array.isArray(created.body) && /^SR-[0-9A-F]{6}$/.test(created.body[0]?.reference ?? ''),
    created.body?.[0]?.reference);
  check('report starts pending and unclassified',
    created.body?.[0]?.status === 'pending' && created.body?.[0]?.severity === null);

  const inQueue = await o.get(`threat_reports?select=id,status&id=eq.${reportId}`);
  check('report appears in the officer queue', inQueue.body.length === 1 && inQueue.body[0].status === 'pending');

  const preview = await o.rpc('preview_alert_recipients', {
    p_org_id: (await o.get(`profiles?select=organization_id&id=eq.${officer.userId}`)).body[0].organization_id,
    p_lat: 0.0115,
    p_lng: 40.212,
    p_radius_meters: 15000,
    p_region_ids: ['dadaab'],
    p_share_with_partners: true,
  });
  check('recipient preview runs before sending', preview.status === 200 && Array.isArray(preview.body),
    `${preview.body?.length} recipients`);

  const verified = await o.send('PATCH', `threat_reports?id=eq.${reportId}`, {
    status: 'verified',
    threat_type: 'road_ambush',
    severity: 'high',
    priority: 8,
    alert_radius_meters: 15000,
  });
  check('officer can verify', verified.status === 200 && verified.body[0]?.status === 'verified',
    `status ${verified.status}`);
  check('verification is attributed automatically',
    verified.body?.[0]?.verified_by === officer.userId && verified.body?.[0]?.verified_at !== null);

  const alert = await o.send('POST', 'safety_alerts', {
    issued_by: officer.userId,
    organization_id: verified.body[0].organization_id,
    related_report_id: reportId,
    title: 'Road ambush near Dadaab Town',
    message: 'Verified high road ambush. Suspend movement through the area. Essential travel only, with clearance.',
    severity: 'high',
    threat_type: 'road_ambush',
    location: 'SRID=4326;POINT(40.2120 0.0115)',
    radius_meters: 15000,
    region_ids: ['dadaab'],
    kind: 'threat',
    expires_at: new Date(Date.now() + 72 * 3600_000).toISOString(),
  });
  check('officer can issue the alert', alert.status === 201, `status ${alert.status}`);

  const fanOut = await o.rpc('fan_out_alert', { p_alert_id: alert.body[0].id });
  check('fan_out_alert delivers to recipients', fanOut.status === 200 && fanOut.body > 0, `${fanOut.body} delivered`);

  const after = await pw.get('notifications?select=id,title,match_reasons,distance_meters&order=delivered_at.desc');
  check("the alert reached a colleague's feed", after.body.length > beforeCount,
    `${beforeCount} -> ${after.body.length}`);

  // The reporter already knows what they reported; alerting them is noise, not
  // safety. This is the one exclusion the fan-out makes on purpose.
  const reporterFeed = await w.get(`notifications?select=id&alert_id=eq.${alert.body[0].id}`);
  check('the reporter is NOT alerted about their own report',
    Array.isArray(reporterFeed.body) && reporterFeed.body.length === 0,
    `${reporterFeed.body?.length} rows`);

  check('notification carries its match reasons',
    Array.isArray(after.body[0]?.match_reasons) && after.body[0].match_reasons.length > 0,
    JSON.stringify(after.body[0]?.match_reasons));

  const readBack = await w.get(`reports_for_worker?select=id,severity,reporter_id&id=eq.${reportId}`);
  check('worker now sees it as a verified threat', readBack.body[0]?.severity === 'high');
  check('worker sees their own report un-anonymised', readBack.body[0]?.reporter_id === worker.userId);

  // --- Safe Route -----------------------------------------------------------
  console.log('\nSafe Route (PostGIS)');
  const route = await w.rpc('threats_near_route', {
    route_geojson: { type: 'LineString', coordinates: [[39.6583, -0.4569], [40.0, -0.05], [40.3086, 0.0553]] },
    buffer_meters: 5000,
    window_hours: 720,
  });
  check('threats_near_route returns incidents on the corridor',
    route.status === 200 && Array.isArray(route.body) && route.body.length > 0,
    `${route.body?.length} incidents`);
  check('route results carry usable coordinates',
    (route.body ?? []).every((r) => typeof r.lat === 'number' && typeof r.lng === 'number'));
  check('route results are ordered by distance from the road',
    (route.body ?? []).every((r, i, a) => i === 0 || a[i - 1].distance_from_route_meters <= r.distance_from_route_meters));

  const emptyRoute = await w.rpc('threats_near_route', {
    // A corridor far from any seeded incident.
    route_geojson: { type: 'LineString', coordinates: [[36.8, -1.3], [36.9, -1.2]] },
    buffer_meters: 2000,
    window_hours: 720,
  });
  check('a clear route returns no incidents', Array.isArray(emptyRoute.body) && emptyRoute.body.length === 0);

  // --- Duplicate detection --------------------------------------------------
  console.log('\nduplicate pre-filter');
  const dupes = await o.rpc('duplicate_candidates', { p_report_id: reportId, radius_meters: 5000, window_hours: 12 });
  check('duplicate_candidates finds the nearby Dadaab reports',
    dupes.status === 200 && Array.isArray(dupes.body) && dupes.body.length > 0,
    `${dupes.body?.length} candidates`);
  check('candidates carry distance and time separation',
    (dupes.body ?? []).every((d) => typeof d.distance_meters === 'number' && typeof d.minutes_apart === 'number'));

  // --- SOS ------------------------------------------------------------------
  console.log('\nSOS');
  const sosList = await o.get('sos_events?select=id,status,lat,lng,track');
  check('officer sees SOS events', sosList.body.length > 0, `${sosList.body.length} events`);
  check('SOS carries a position track',
    sosList.body.some((e) => Array.isArray(e.track) && e.track.length > 0));

  // --- Audit ----------------------------------------------------------------
  console.log('\naudit trail');
  const audit = await o.get(`audit_log?select=action,summary&entity_id=eq.${reportId}&order=ts.asc`);
  check('the loop wrote an audit trail', audit.body.length >= 2, `${audit.body.length} entries`);
  check('audit records creation and verification',
    audit.body.some((a) => a.action === 'report.created') && audit.body.some((a) => a.action === 'report.verified'),
    audit.body.map((a) => a.action).join(', '));

  // --- Cleanup --------------------------------------------------------------
  console.log(`\n${'='.repeat(60)}`);
  console.log(`${passed} passed, ${failed} failed`);
  console.log('\nRun `npm run db:seed` to reset the dataset after testing.');
  if (failed) {
    console.log('\nFailures:');
    failures.forEach((f) => console.log(`  - ${f}`));
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
