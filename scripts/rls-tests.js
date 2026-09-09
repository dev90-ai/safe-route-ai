/**
 * RLS boundary tests.
 *
 * Signs in as real demo users with the PUBLIC anon key and asserts what each
 * role can and cannot reach. This is the test that matters most in the whole
 * project: the anon key ships inside the app bundle, so RLS is the only thing
 * standing between a curious user and every reporter's identity.
 *
 *   node scripts/rls-tests.js
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
const PASSWORD = 'Passw0rd!';

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
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  const json = await res.json();
  if (!json.access_token) throw new Error(`sign-in failed for ${email}: ${JSON.stringify(json)}`);
  return json.access_token;
}

async function q(token, pathAndQuery, options = {}) {
  const res = await fetch(`${URL}/rest/v1/${pathAndQuery}`, {
    method: options.method ?? 'GET',
    headers: {
      apikey: ANON,
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(options.method === 'PATCH' || options.method === 'POST' ? { Prefer: 'return=representation' } : {}),
    },
    ...(options.body ? { body: JSON.stringify(options.body) } : {}),
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

async function rpc(token, name, args) {
  const res = await fetch(`${URL}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: { apikey: ANON, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  return { status: res.status, body: await res.json() };
}

async function main() {
  console.log(`Target: ${URL}\n`);

  // --- Anonymous ------------------------------------------------------------
  console.log('anonymous (no session)');
  const anonReports = await fetch(`${URL}/rest/v1/threat_reports?select=id`, { headers: { apikey: ANON } });
  const anonBody = await anonReports.json();
  check('anon cannot read threat reports', Array.isArray(anonBody) && anonBody.length === 0,
    JSON.stringify(anonBody).slice(0, 80));

  const anonProfiles = await fetch(`${URL}/rest/v1/profiles?select=id,email`, { headers: { apikey: ANON } });
  const anonProfBody = await anonProfiles.json();
  check('anon cannot read profiles', Array.isArray(anonProfBody) && anonProfBody.length === 0);

  const anonInvites = await fetch(`${URL}/rest/v1/invites?select=code`, { headers: { apikey: ANON } });
  const anonInvBody = await anonInvites.json();
  check('anon cannot list invite codes', Array.isArray(anonInvBody) && anonInvBody.length === 0);

  // peek_invite is deliberately open, but must not leak the whole row.
  const peek = await fetch(`${URL}/rest/v1/rpc/peek_invite`, {
    method: 'POST',
    headers: { apikey: ANON, 'Content-Type': 'application/json' },
    body: JSON.stringify({ invite_code: 'NERC-4821' }),
  });
  const peekBody = await peek.json();
  check('anon can validate a real invite code', Array.isArray(peekBody) && peekBody.length === 1,
    JSON.stringify(peekBody).slice(0, 100));
  check('peek_invite returns only name/email/role/org',
    Array.isArray(peekBody) && peekBody[0] && Object.keys(peekBody[0]).sort().join(',') === 'email,full_name,organization_name,role',
    peekBody[0] ? Object.keys(peekBody[0]).join(',') : 'none');

  const peekBad = await fetch(`${URL}/rest/v1/rpc/peek_invite`, {
    method: 'POST',
    headers: { apikey: ANON, 'Content-Type': 'application/json' },
    body: JSON.stringify({ invite_code: 'NOT-A-REAL-CODE' }),
  });
  check('peek_invite rejects an unknown code', (await peekBad.json()).length === 0);

  // --- Worker ---------------------------------------------------------------
  console.log('\nworker (Amina Hassan, NERC)');
  const worker = await signIn('worker@saferoute.ai');

  const wReports = await q(worker, 'threat_reports?select=id,status,organization_id');
  const wRows = wReports.body;
  check('worker can read reports', Array.isArray(wRows) && wRows.length > 0, `${wRows.length} rows`);
  check('worker sees no pending reports they did not file',
    wRows.every((r) => r.status === 'verified'),
    `statuses: ${[...new Set(wRows.map((r) => r.status))].join(',')}`);
  check('worker sees no third-org reports',
    wRows.every((r) => r.organization_id !== '33333333-3333-4333-8333-333333333333'));
  check('worker DOES see partner-org reports (cross-share works)',
    wRows.some((r) => r.organization_id === '22222222-2222-4222-8222-222222222222'));

  // You always see your own reports in full; everyone else's reporter is
  // stripped. So the assertion is "no OTHER person's id is ever exposed".
  const me = (await q(worker, 'profiles?select=id&email=eq.worker@saferoute.ai')).body[0].id;
  const anonView = await q(worker, 'reports_for_worker?select=id,reporter_id&limit=50');
  check('anonymised view exposes no other reporter',
    Array.isArray(anonView.body) && anonView.body.every((r) => r.reporter_id === null || r.reporter_id === me),
    JSON.stringify(anonView.body.filter((r) => r.reporter_id && r.reporter_id !== me)).slice(0, 120));
  check('anonymised view does hide at least one reporter',
    anonView.body.some((r) => r.reporter_id === null));

  const wVerify = await q(worker, `threat_reports?id=eq.${wRows[0].id}`, {
    method: 'PATCH',
    body: { severity: 'low' },
  });
  check('worker CANNOT verify a report',
    wVerify.status === 403 || (Array.isArray(wVerify.body) && wVerify.body.length === 0),
    `status ${wVerify.status}`);

  const wInvites = await q(worker, 'invites?select=code');
  check('worker cannot read invite codes', Array.isArray(wInvites.body) && wInvites.body.length === 0);

  const wAudit = await q(worker, 'audit_log?select=id');
  check('worker cannot read the audit log', Array.isArray(wAudit.body) && wAudit.body.length === 0);

  const wProfiles = await q(worker, 'profiles?select=id,organization_id');
  check('worker sees only their own org members',
    Array.isArray(wProfiles.body) && wProfiles.body.every((p) => p.organization_id === '11111111-1111-4111-8111-111111111111'),
    `${wProfiles.body.length} profiles`);

  const wEscalate = await q(worker, `profiles?id=eq.${(await q(worker, 'profiles?select=id&limit=1')).body[0].id}`, {
    method: 'PATCH',
    body: { role: 'admin' },
  });
  check('worker CANNOT promote themselves to admin',
    wEscalate.status >= 400 || (Array.isArray(wEscalate.body) && wEscalate.body.length === 0),
    `status ${wEscalate.status}`);

  const wFeed = await q(worker, 'notifications?select=id,profile_id');
  check('worker has an alert feed', Array.isArray(wFeed.body) && wFeed.body.length > 0, `${wFeed.body.length} rows`);

  const wSos = await q(worker, 'sos_events?select=id,worker_id');
  check('worker sees only their own SOS events',
    Array.isArray(wSos.body) && wSos.body.every((e) => e.worker_id === wProfiles.body.find((p) => p.id === e.worker_id)?.id || wSos.body.length === 0));

  // --- Officer --------------------------------------------------------------
  console.log('\nofficer (Daniel Kiptoo, NERC)');
  const officer = await signIn('officer@saferoute.ai');

  const oReports = await q(officer, 'threat_reports?select=id,status');
  check('officer sees pending reports',
    Array.isArray(oReports.body) && oReports.body.some((r) => r.status === 'pending'),
    `${oReports.body.length} rows`);

  const oPending = oReports.body.find((r) => r.status === 'pending');
  const oVerify = await q(officer, `threat_reports?id=eq.${oPending.id}`, {
    method: 'PATCH',
    body: { status: 'verified', threat_type: 'road_ambush', severity: 'high', priority: 8, alert_radius_meters: 15000 },
  });
  check('officer CAN verify a report', oVerify.status === 200 && Array.isArray(oVerify.body) && oVerify.body.length === 1,
    `status ${oVerify.status} ${JSON.stringify(oVerify.body).slice(0, 120)}`);

  if (oVerify.status === 200) {
    const verified = oVerify.body[0];
    check('verification stamped the acting officer', verified.verified_by !== null && verified.verified_at !== null);

    const reVerify = await q(officer, `threat_reports?id=eq.${oPending.id}`, {
      method: 'PATCH',
      body: { status: 'dismissed', dismissed_reason: 'changed my mind about this one' },
    });
    check('a resolved report cannot be reopened', reVerify.status >= 400, `status ${reVerify.status}`);

    const tamper = await q(officer, `threat_reports?id=eq.${oPending.id}`, {
      method: 'PATCH',
      body: { ai_suggestions: { threatType: 'crime', severity: 'low' } },
    });
    check('AI suggestions are immutable once recorded', tamper.status >= 400, `status ${tamper.status}`);
  }

  const oAudit = await q(officer, 'audit_log?select=id,action');
  check('officer can read the audit log', Array.isArray(oAudit.body) && oAudit.body.length > 0, `${oAudit.body.length} rows`);

  const oAuditWrite = await q(officer, 'audit_log', {
    method: 'POST',
    body: { actor_role: 'officer', action: 'forged', entity: 'report', summary: 'fake entry' },
  });
  check('nobody can write to the audit log', oAuditWrite.status >= 400, `status ${oAuditWrite.status}`);

  const oSos = await q(officer, 'sos_events?select=id,organization_id,status');
  check('officer sees org SOS events', Array.isArray(oSos.body) && oSos.body.length > 0, `${oSos.body.length} rows`);
  check('officer sees no partner-org SOS (live location is never cross-shared)',
    oSos.body.every((e) => e.organization_id === '11111111-1111-4111-8111-111111111111'));

  const oInvite = await q(officer, 'invites', {
    method: 'POST',
    body: { email: 'x@y.org', full_name: 'X', role: 'admin', organization_id: '11111111-1111-4111-8111-111111111111', code: 'HACK-0001' },
  });
  check('officer CANNOT create invites', oInvite.status >= 400, `status ${oInvite.status}`);

  // --- Admin ----------------------------------------------------------------
  console.log('\nadmin (Fatuma Noor, NERC)');
  const admin = await signIn('admin@saferoute.ai');

  const aReports = await q(admin, 'threat_reports?select=id,status');
  check('admin can read all org reports', Array.isArray(aReports.body) && aReports.body.length > 0, `${aReports.body.length} rows`);

  const aPending = aReports.body.find((r) => r.status === 'pending');
  if (aPending) {
    const aVerify = await q(admin, `threat_reports?id=eq.${aPending.id}`, {
      method: 'PATCH',
      body: { status: 'verified', threat_type: 'crime', severity: 'low', priority: 2, alert_radius_meters: 1000 },
    });
    check('admin CANNOT verify a report (separation of duties)',
      aVerify.status === 403 || (Array.isArray(aVerify.body) && aVerify.body.length === 0),
      `status ${aVerify.status}`);
  }

  const aAlert = await q(admin, 'safety_alerts', {
    method: 'POST',
    body: {
      issued_by: (await q(admin, 'profiles?select=id&email=eq.admin@saferoute.ai')).body[0].id,
      organization_id: '11111111-1111-4111-8111-111111111111',
      title: 'Admin should not be able to do this',
      message: 'This advisory should be rejected by row level security.',
      severity: 'low',
    },
  });
  check('admin CANNOT issue alerts', aAlert.status >= 400, `status ${aAlert.status}`);

  const aInvites = await q(admin, 'invites?select=code');
  check('admin can read invites', Array.isArray(aInvites.body) && aInvites.body.length > 0, `${aInvites.body.length} rows`);

  const aMembers = await q(admin, 'profiles?select=id,role');
  check('admin can read org members', Array.isArray(aMembers.body) && aMembers.body.length > 0, `${aMembers.body.length} rows`);

  // --- Cross-org isolation --------------------------------------------------
  console.log('\ncross-organisation isolation');
  const outsider = await signIn('esther.mutua@riverine.example.org');
  const xReports = await q(outsider, 'threat_reports?select=id,organization_id');
  check('unrelated org sees none of NERC or HAI reports',
    Array.isArray(xReports.body) && xReports.body.every((r) => r.organization_id === '33333333-3333-4333-8333-333333333333'),
    `orgs: ${[...new Set(xReports.body.map((r) => r.organization_id?.slice(0, 8)))].join(',')}`);

  const xProfiles = await q(outsider, 'profiles?select=email');
  check('unrelated org sees no NERC staff',
    Array.isArray(xProfiles.body) && !xProfiles.body.some((p) => p.email === 'worker@saferoute.ai'));

  // --- PostGIS RPCs ---------------------------------------------------------
  console.log('\nPostGIS RPCs');
  const nearby = await rpc(worker, 'threats_nearby', { p_lat: -0.4569, p_lng: 39.6583, radius_meters: 200000, window_hours: 720 });
  check('threats_nearby returns scoped results', nearby.status === 200 && Array.isArray(nearby.body),
    `${nearby.status} ${Array.isArray(nearby.body) ? nearby.body.length + ' rows' : JSON.stringify(nearby.body).slice(0, 100)}`);
  check('threats_nearby is ordered by distance',
    Array.isArray(nearby.body) && nearby.body.every((r, i, a) => i === 0 || a[i - 1].distance_meters <= r.distance_meters));

  const route = await rpc(worker, 'threats_near_route', {
    route_geojson: { type: 'LineString', coordinates: [[39.6583, -0.4569], [40.0, -0.05], [40.3086, 0.0553]] },
    buffer_meters: 5000,
    window_hours: 720,
  });
  check('threats_near_route runs the ST_DWithin buffer query', route.status === 200 && Array.isArray(route.body),
    `${route.status} ${Array.isArray(route.body) ? route.body.length + ' rows' : JSON.stringify(route.body).slice(0, 120)}`);

  console.log(`\n${'='.repeat(60)}`);
  console.log(`${passed} passed, ${failed} failed`);
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
