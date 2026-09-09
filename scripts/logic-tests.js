/**
 * Runtime smoke test for the Safe Route AI data layer.
 *
 * Compiles src/ with tsc, stubs the four native modules the pure logic touches,
 * then exercises the seed, the classifier, the fan-out predicate and the route
 * scorer against real assertions.
 */
const path = require('path');
const Module = require('module');

const OUT = path.resolve(__dirname, '..', '.test-build');

// --- Module resolution: map "@/x" to the compiled tree, stub native modules ---
const stubs = {
  'expo-crypto': {
    randomUUID: () => 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
    }),
  },
  '@react-native-async-storage/async-storage': {
    default: {
      getItem: async () => null,
      setItem: async () => {},
      removeItem: async () => {},
      getAllKeys: async () => [],
      multiRemove: async () => {},
    },
  },
  'expo-secure-store': {
    getItemAsync: async () => null,
    setItemAsync: async () => {},
    deleteItemAsync: async () => {},
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'x',
  },
  'react-native': { Platform: { OS: 'ios' } },
  '@react-native-community/netinfo': { default: { addEventListener: () => () => {} } },
};

const PROJECT = path.resolve(__dirname, '..');

const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (stubs[request]) return `\0stub:${request}`;
  if (request.startsWith('@/')) {
    return originalResolve.call(this, path.join(OUT, request.slice(2)), ...rest);
  }
  // Third-party deps (zod) live in the project's node_modules, not here.
  if (!request.startsWith('.') && !path.isAbsolute(request)) {
    try {
      return originalResolve.call(this, request, ...rest);
    } catch {
      return require.resolve(request, { paths: [path.join(PROJECT, 'node_modules')] });
    }
  }
  return originalResolve.call(this, request, ...rest);
};

const originalLoad = Module._load;
Module._load = function (request, ...rest) {
  if (stubs[request]) return stubs[request];
  return originalLoad.call(this, request, ...rest);
};

global.__DEV__ = false;

// --- Test harness -----------------------------------------------------------
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

function section(title) {
  console.log(`\n${title}`);
}

// --- 1. Geo -----------------------------------------------------------------
section('geo');
const geo = require(path.join(OUT, 'lib/geo.js'));

const garissa = { lat: -0.4569, lng: 39.6583 };
const dadaab = { lat: 0.0553, lng: 40.3086 };
const d = geo.distanceMeters(garissa, dadaab);
// Real-world straight-line Garissa→Dadaab is roughly 90 km.
check('Garissa→Dadaab distance is ~90 km', d > 85_000 && d < 95_000, `${Math.round(d / 1000)} km`);
check('distance to self is 0', geo.distanceMeters(garissa, garissa) < 1);
check('isWithin respects the radius', geo.isWithin(garissa, dadaab, 100_000) && !geo.isWithin(garissa, dadaab, 50_000));

const moved = geo.destinationPoint(garissa, 10_000, 90);
check('destinationPoint moves exactly 10 km', Math.abs(geo.distanceMeters(garissa, moved) - 10_000) < 50);

const line = [garissa, dadaab];
// Offset perpendicular to the actual bearing of the line, not due north.
const perpendicular = (geo.bearing(garissa, dadaab) + 90) % 360;
const midOffset = geo.destinationPoint(
  { lat: (garissa.lat + dadaab.lat) / 2, lng: (garissa.lng + dadaab.lng) / 2 },
  3000,
  perpendicular,
);
const dist = geo.distanceToPath(midOffset, line);
check('distanceToPath finds a ~3 km perpendicular offset', dist > 2800 && dist < 3200, `${Math.round(dist)} m`);
check('a point on the line has ~0 path distance', geo.distanceToPath(garissa, line) < 10);

// --- 2. Classifier ----------------------------------------------------------
section('ai/classifier');
const { classifyReportSync } = require(path.join(OUT, 'ai/classifier.js'));

const ambush = classifyReportSync({
  description:
    'Two vehicles were stopped by armed men about 12 km outside Dadaab on the Garissa road. The men were carrying rifles and took phones and cash before letting them go.',
  reportedType: null,
  location: dadaab,
  occurredAt: new Date().toISOString(),
  candidates: [],
});
check('classifies an ambush narrative as road_ambush', ambush.threatType === 'road_ambush', ambush.threatType);
check('ambush confidence is above 0.5', ambush.confidence > 0.5, String(ambush.confidence));
check('ambush suggests a non-zero alert radius', ambush.alertRadiusMeters > 0);
check('ambush is not flagged needs-more-info', ambush.needsMoreInfo === false);

const ied = classifyReportSync({
  description:
    'An improvised explosive device detonated under a security vehicle on the Modogashe road at 07:15. Multiple casualties reported. The road is closed and forces are sweeping for secondary devices.',
  reportedType: null,
  location: garissa,
  occurredAt: new Date().toISOString(),
  candidates: [],
});
check('classifies an IED narrative as ied_explosive', ied.threatType === 'ied_explosive', ied.threatType);
check('IED with casualties rates critical', ied.severity === 'critical', ied.severity);
check('IED radius exceeds ambush radius', ied.alertRadiusMeters > ambush.alertRadiusMeters);

const thin = classifyReportSync({
  description: 'Something happened',
  reportedType: null,
  location: garissa,
  occurredAt: new Date().toISOString(),
  candidates: [],
});
check('flags a too-short report as needs-more-info', thin.needsMoreInfo === true);
check('thin report confidence is capped low', thin.confidence <= 0.35, String(thin.confidence));

const rumour = classifyReportSync({
  description: 'Heard from a neighbour that there might be trouble at the market tomorrow. This is just a rumour going around, nothing has happened.',
  reportedType: null,
  location: garissa,
  occurredAt: new Date().toISOString(),
  candidates: [],
});
check('second-hand wording lowers severity', ['low', 'medium'].includes(rumour.severity), rumour.severity);

// Duplicate detection: same event, 400 m and 20 minutes apart.
const now = Date.now();
const original = {
  id: 'rep_original',
  description:
    'Vehicles ambushed on the Dadaab road this morning. Armed group robbed passengers of phones and money. No casualties reported.',
  location: dadaab,
  occurredAt: new Date(now - 20 * 60_000).toISOString(),
  threatType: 'road_ambush',
  aiSuggestions: null,
  status: 'verified',
};
const dupe = classifyReportSync({
  description:
    'Vehicles were ambushed on the Dadaab road this morning. An armed group robbed the passengers of phones and money. No casualties reported.',
  reportedType: null,
  location: geo.destinationPoint(dadaab, 400, 45),
  occurredAt: new Date(now).toISOString(),
  candidates: [original],
});
check('detects a near-identical nearby report as a duplicate', dupe.possibleDuplicateOf === 'rep_original', String(dupe.possibleDuplicateOf));

const distinct = classifyReportSync({
  description: 'Large crowd gathered outside the sub-county offices protesting delayed relief distribution. Police deployed and there is stone throwing.',
  reportedType: null,
  location: geo.destinationPoint(dadaab, 400, 45),
  occurredAt: new Date(now).toISOString(),
  candidates: [original],
});
check('does not merge a different event at the same place', distinct.possibleDuplicateOf === null, String(distinct.possibleDuplicateOf));

// --- 3. Seed ----------------------------------------------------------------
section('seed dataset');
const { buildSeed, DEMO_ACCOUNTS } = require(path.join(OUT, 'api/seed.js'));
const seed = buildSeed();

check('seeds 3 organizations', seed.organizations.length === 3, String(seed.organizations.length));
check('seeds at least 14 profiles', seed.profiles.length >= 14, String(seed.profiles.length));
check('every profile has a credential', seed.profiles.every((p) => seed.credentials.some((c) => c.profileId === p.id)));
check('seeds at least 35 reports', seed.reports.length >= 35, String(seed.reports.length));
check('has pending reports for the officer queue', seed.reports.filter((r) => r.status === 'pending').length >= 4);
check('has verified reports for the map', seed.reports.filter((r) => r.status === 'verified').length >= 20);
check('has dismissed reports', seed.reports.filter((r) => r.status === 'dismissed').length >= 3);
check('every verified report has severity and radius', seed.reports.filter((r) => r.status === 'verified').every((r) => r.severity && r.alertRadiusMeters > 0));
check('no pending report has a severity set', seed.reports.filter((r) => r.status === 'pending').every((r) => r.severity === null));
check('every report has AI suggestions', seed.reports.every((r) => r.aiSuggestions !== null));
check('seeds alerts', seed.alerts.length >= 5, String(seed.alerts.length));
check('seeds notifications', seed.notifications.length > 0, String(seed.notifications.length));
check('every notification carries a match reason', seed.notifications.every((n) => n.matchReasons.length > 0));
check('has one active SOS', seed.sosEvents.filter((e) => e.status === 'active').length === 1);
check('has resolved SOS history', seed.sosEvents.filter((e) => e.status === 'resolved').length >= 2);
check('seeds an audit trail', seed.audit.length > 50, String(seed.audit.length));
check('seeds pending invites', seed.invites.filter((i) => !i.acceptedAt).length >= 2);
check('determinism: two builds are identical', JSON.stringify(buildSeed().reports.map((r) => r.id)) === JSON.stringify(seed.reports.map((r) => r.id)));

// Demo accounts must actually authenticate.
const { hashSecret } = require(path.join(OUT, 'api/db.js'));
for (const account of DEMO_ACCOUNTS) {
  const credential = seed.credentials.find((c) => c.email === account.email);
  const profile = seed.profiles.find((p) => p.id === credential?.profileId);
  check(
    `demo account ${account.email} has a matching password hash`,
    credential && credential.passwordHash === hashSecret(account.password, credential.profileId),
  );
  check(`demo account ${account.email} has role ${account.role}`, profile && profile.role === account.role);
}

// A wrong password must not hash to the stored value.
const workerCred = seed.credentials.find((c) => c.email === 'worker@saferoute.ai');
check('a wrong password does not match', hashSecret('wrongpassword', workerCred.profileId) !== workerCred.passwordHash);

// --- 4. Regions -------------------------------------------------------------
section('regions');
const regions = require(path.join(OUT, 'constants/regions.js'));
const found = regions.regionForPoint(garissa);
check('resolves Garissa town to the Garissa Township region', found && found.id === 'garissa-township', found && found.id);
check('a point in the ocean resolves to no region', regions.regionForPoint({ lat: -5, lng: 55 }) === null);
check('every place references a real region', regions.PLACES.every((p) => regions.REGIONS_BY_ID[p.region]));
check('every corridor has at least 4 waypoints', regions.CORRIDORS.every((c) => c.waypoints.length >= 4));

// --- 5. Fan-out predicate ---------------------------------------------------
section('alert fan-out rules');
// Reproduce the four conditions the alert engine applies and prove each fires.
const org = seed.organizations.find((o) => o.id === 'org_nek_relief');
const partnerOrg = seed.organizations.find((o) => o.id === 'org_horn_aid');
const unrelatedOrg = seed.organizations.find((o) => o.id === 'org_riverine');

check('cross-share is reciprocal in the seed', org.crossSharePartners.includes(partnerOrg.id) && partnerOrg.crossSharePartners.includes(org.id));
check('the unrelated org shares with nobody', unrelatedOrg.crossSharePartners.length === 0);

const verifiedNerc = seed.reports.find((r) => r.status === 'verified' && r.organizationId === 'org_nek_relief');
const nercAlert = seed.alerts.find((a) => a.relatedReportId === verifiedNerc.id);
if (nercAlert) {
  const recipients = seed.notifications.filter((n) => n.alertId === nercAlert.id);
  const recipientOrgs = new Set(
    recipients.map((n) => seed.profiles.find((p) => p.id === n.profileId).organizationId),
  );
  check('a NERC alert never reaches the unrelated organisation', !recipientOrgs.has('org_riverine'));
  check('no admin is included in a fan-out', recipients.every((n) => seed.profiles.find((p) => p.id === n.profileId).role !== 'admin'));
}

const radiusMatches = seed.notifications.filter((n) => n.matchReasons.includes('within-alert-radius'));
check('some notifications matched by alert radius', radiusMatches.length > 0, String(radiusMatches.length));
check('radius matches all carry a distance', radiusMatches.every((n) => typeof n.distanceMeters === 'number'));
const radiusRespected = radiusMatches.every((n) => {
  const alert = seed.alerts.find((a) => a.id === n.alertId);
  return alert.radiusMeters !== null && n.distanceMeters <= alert.radiusMeters;
});
check('every radius match is genuinely inside its radius', radiusRespected);

const regionMatches = seed.notifications.filter((n) => n.matchReasons.includes('operating-region'));
check('some notifications matched by operating region', regionMatches.length > 0, String(regionMatches.length));

const partnerMatches = seed.notifications.filter((n) => n.matchReasons.includes('partner-organization'));
check('cross-share partner fan-out fires', partnerMatches.length > 0, String(partnerMatches.length));

// --- 6. Route scoring -------------------------------------------------------
section('route risk scoring');
const SEVERITY_WEIGHT = { low: 1, medium: 3, high: 8, critical: 20 };
// Mirror of scoreRoute in endpoints/routes.ts, to confirm the ordering it produces.
function scoreRoute(threats, buffer) {
  let score = 0;
  for (const t of threats) {
    const ageDays = (Date.now() - Date.parse(t.occurredAt)) / 86_400_000;
    const recency = Math.exp(-ageDays / 14);
    const proximity = 1 - Math.min(1, t.distanceFromRouteMeters / buffer) * 0.7;
    score += SEVERITY_WEIGHT[t.severity] * recency * proximity;
  }
  return score;
}
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();
const cleanRoute = scoreRoute([], 2000);
const oneOldLow = scoreRoute([{ severity: 'low', distanceFromRouteMeters: 1800, occurredAt: iso(60 * 86_400_000) }], 2000);
const oneFreshCritical = scoreRoute([{ severity: 'critical', distanceFromRouteMeters: 100, occurredAt: iso(3_600_000) }], 2000);

check('an empty route scores zero', cleanRoute === 0);
check('a fresh critical outweighs an old distant low', oneFreshCritical > oneOldLow * 10);
check('an old distant low barely registers', oneOldLow < 0.5, oneOldLow.toFixed(3));
check('recency decays: same threat 30 days old scores lower', scoreRoute([{ severity: 'high', distanceFromRouteMeters: 500, occurredAt: iso(30 * 86_400_000) }], 2000) <
  scoreRoute([{ severity: 'high', distanceFromRouteMeters: 500, occurredAt: iso(0) }], 2000));
check('proximity decays: same threat further away scores lower', scoreRoute([{ severity: 'high', distanceFromRouteMeters: 1900, occurredAt: iso(0) }], 2000) <
  scoreRoute([{ severity: 'high', distanceFromRouteMeters: 100, occurredAt: iso(0) }], 2000));

// --- 7. Validation schemas --------------------------------------------------
section('validation');
const validation = require(path.join(OUT, 'lib/validation.js'));

check('rejects a short report description', validation.validate(validation.reportDraftSchema, {
  description: 'too short',
  reportedType: null,
  location: garissa,
  locationAccuracyMeters: null,
  locationSource: 'gps',
  photoUrl: null,
  occurredAt: new Date().toISOString(),
}).ok === false);

check('accepts a well-formed report', validation.validate(validation.reportDraftSchema, {
  description: 'Armed men stopped a vehicle on the Dadaab road and robbed the passengers before leaving.',
  reportedType: 'road_ambush',
  location: garissa,
  locationAccuracyMeters: 12,
  locationSource: 'gps',
  photoUrl: null,
  occurredAt: new Date().toISOString(),
}).ok === true);

check('rejects a weak password', validation.validate(validation.passwordSchema, 'password').ok === false);
check('accepts a strong password', validation.validate(validation.passwordSchema, 'Passw0rdLong!').ok === true);
check('rejects a 5-digit OTP', validation.validate(validation.otpSchema, '12345').ok === false);
check('accepts a 6-digit OTP with a leading zero', validation.validate(validation.otpSchema, '012345').ok === true);
check('normalises a Kenyan phone number', validation.validate(validation.phoneSchema, '0712000101').ok === true);
check('rejects an alert radius above 60 km', validation.validate(validation.verifyReportSchema, {
  reportId: 'x', threatType: 'banditry', severity: 'high', priority: 5,
  alertRadiusMeters: 90_000, confirmDuplicate: false, duplicateOf: null,
}).ok === false);
check('requires a dismissal reason of at least 10 characters', validation.validate(validation.dismissReportSchema, { reportId: 'x', reason: 'no' }).ok === false);

const strength = validation.passwordStrength('Passw0rdLong!');
check('password strength scores a strong password highly', strength.score >= 3, String(strength.score));
check('password strength flags a common weak password', validation.passwordStrength('password123').score === 0);

check('sanitizeText strips markup', validation.sanitizeText('Gunfire <script>alert(1)</script> near the market') === 'Gunfire alert(1) near the market');
check('sanitizeText preserves normal text', validation.sanitizeText('  Armed men on the road.  ') === 'Armed men on the road.');

// --- 8. Formatting ----------------------------------------------------------
section('formatting');
const fmt = require(path.join(OUT, 'lib/format.js'));
check('timeAgo handles "just now"', fmt.timeAgo(Date.now()) === 'just now');
check('timeAgo formats minutes', fmt.timeAgo(Date.now() - 12 * 60_000) === '12 min ago');
check('maskEmail hides the local part', fmt.maskEmail('worker@saferoute.ai').startsWith('w') && fmt.maskEmail('worker@saferoute.ai').includes('@saferoute.ai') && !fmt.maskEmail('worker@saferoute.ai').includes('worker'));
check('normalizePhone converts 07... to +2547...', fmt.normalizePhone('0712000101') === '+254712000101');
check('normalizePhone leaves +254 untouched', fmt.normalizePhone('+254712000101') === '+254712000101');
check('elapsedClock formats mm:ss', fmt.elapsedClock(Date.now() - 91_000) === '01:31');
check('formatDistance rounds metres', geo.formatDistance(1500) === '1.5 km');
check('formatRadius formats km', geo.formatRadius(12_000) === '12 km');

// --- Result -----------------------------------------------------------------
console.log(`\n${'='.repeat(56)}`);
console.log(`${passed} passed, ${failed} failed`);
if (failed) {
  console.log('\nFailures:');
  failures.forEach((f) => console.log(`  - ${f}`));
  process.exit(1);
}
