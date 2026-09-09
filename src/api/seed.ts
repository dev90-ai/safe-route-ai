import { classifyReportSync } from '@/ai/classifier';
import { PLACES, REGIONS_BY_ID, regionForPoint } from '@/constants/regions';
import { SEVERITY_META, THREAT_META, type Severity, type ThreatType } from '@/constants/threats';
import { destinationPoint, distanceMeters } from '@/lib/geo';
import { shortRef } from '@/lib/ids';
import { hashSecret } from '@/lib/hash';
import type { Credential, DbShape } from './db';
import type {
  AuditEntry,
  Invite,
  NotificationRecord,
  Organization,
  Profile,
  SafetyAlert,
  SosEvent,
  ThreatReport,
} from './types';

/**
 * Deterministic seed data.
 *
 * A fixed PRNG means every reviewer, screenshot and demo sees the same dataset,
 * which makes the analytics screens meaningful and bug reports reproducible.
 * The report texts are written to exercise the classifier honestly: some are
 * unambiguous, some are thin, two pairs are genuine duplicates, and a few are
 * near-misses that the duplicate detector should decline to merge.
 */

let seed = 0x5a3e7c1;
function rand(): number {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
}
const pick = <T>(arr: readonly T[]): T => arr[Math.floor(rand() * arr.length)];
const randInt = (min: number, max: number) => Math.floor(rand() * (max - min + 1)) + min;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.now();
const iso = (ms: number) => new Date(ms).toISOString();

const AVATAR_COLORS = ['#3B82F6', '#14B8A6', '#8B5CF6', '#F59E0B', '#EC4899', '#10B981', '#F97316', '#06B6D4'];

// --------------------------------------------------------------------------
// Organizations
// --------------------------------------------------------------------------

const ORG_MAIN = 'org_nek_relief';
const ORG_PARTNER = 'org_horn_aid';
const ORG_OTHER = 'org_riverine';

const organizations: Organization[] = [
  {
    id: ORG_MAIN,
    name: 'North Eastern Relief Consortium',
    acronym: 'NERC',
    regions: ['garissa-township', 'dadaab', 'fafi', 'lagdera', 'balambala', 'wajir-south', 'wajir-east'],
    crossSharePartners: [ORG_PARTNER],
    contactEmail: 'security@nerc.example.org',
    createdAt: iso(NOW - 900 * DAY),
    settings: { defaultAdvisoryHours: 24, dualControlForCritical: true, anonymiseReportersToOfficers: false },
  },
  {
    id: ORG_PARTNER,
    name: 'Horn Aid International',
    acronym: 'HAI',
    regions: ['wajir-east', 'wajir-north', 'mandera-east', 'mandera-south', 'tarbaj', 'el-wak'],
    crossSharePartners: [ORG_MAIN],
    contactEmail: 'ops@hornaid.example.org',
    createdAt: iso(NOW - 1200 * DAY),
    settings: { defaultAdvisoryHours: 12, dualControlForCritical: false, anonymiseReportersToOfficers: false },
  },
  {
    id: ORG_OTHER,
    name: 'Riverine Health Trust',
    acronym: 'RHT',
    regions: ['tana-delta', 'ijara', 'hulugho'],
    crossSharePartners: [],
    contactEmail: 'admin@riverine.example.org',
    createdAt: iso(NOW - 500 * DAY),
    settings: { defaultAdvisoryHours: 24, dualControlForCritical: false, anonymiseReportersToOfficers: true },
  },
];

// --------------------------------------------------------------------------
// People
// --------------------------------------------------------------------------

type SeedPerson = {
  id: string;
  email: string;
  fullName: string;
  role: Profile['role'];
  org: string;
  jobTitle: string;
  regions: string[];
  phone: string;
  password: string;
};

/** The three signed-posted demo accounts, plus a populated supporting cast. */
const PEOPLE: SeedPerson[] = [
  {
    id: 'usr_worker_amina',
    email: 'worker@saferoute.ai',
    fullName: 'Amina Hassan',
    role: 'worker',
    org: ORG_MAIN,
    jobTitle: 'Field Coordinator, WASH',
    regions: ['garissa-township', 'dadaab', 'fafi'],
    phone: '+254712000101',
    password: 'Passw0rd!',
  },
  {
    id: 'usr_officer_daniel',
    email: 'officer@saferoute.ai',
    fullName: 'Daniel Kiptoo',
    role: 'officer',
    org: ORG_MAIN,
    jobTitle: 'Area Security Officer',
    regions: ['garissa-township', 'dadaab', 'fafi', 'lagdera', 'balambala', 'wajir-south'],
    phone: '+254712000102',
    password: 'Passw0rd!',
  },
  {
    id: 'usr_admin_fatuma',
    email: 'admin@saferoute.ai',
    fullName: 'Fatuma Noor',
    role: 'admin',
    org: ORG_MAIN,
    jobTitle: 'Country Operations Manager',
    regions: [],
    phone: '+254712000103',
    password: 'Passw0rd!',
  },

  // Supporting cast - NERC
  { id: 'usr_worker_joseph', email: 'joseph.wanjala@nerc.example.org', fullName: 'Joseph Wanjala', role: 'worker', org: ORG_MAIN, jobTitle: 'Logistics Officer', regions: ['garissa-township', 'lagdera'], phone: '+254712000104', password: 'Passw0rd!' },
  { id: 'usr_worker_halima', email: 'halima.abdi@nerc.example.org', fullName: 'Halima Abdi', role: 'worker', org: ORG_MAIN, jobTitle: 'Nutrition Officer', regions: ['dadaab'], phone: '+254712000105', password: 'Passw0rd!' },
  { id: 'usr_worker_peter', email: 'peter.mwangi@nerc.example.org', fullName: 'Peter Mwangi', role: 'worker', org: ORG_MAIN, jobTitle: 'Driver / Fleet', regions: ['garissa-township', 'fafi', 'balambala'], phone: '+254712000106', password: 'Passw0rd!' },
  { id: 'usr_worker_sarah', email: 'sarah.lokwang@nerc.example.org', fullName: 'Sarah Lokwang', role: 'worker', org: ORG_MAIN, jobTitle: 'Protection Officer', regions: ['wajir-south', 'lagdera'], phone: '+254712000107', password: 'Passw0rd!' },
  { id: 'usr_worker_ibrahim', email: 'ibrahim.dahir@nerc.example.org', fullName: 'Ibrahim Dahir', role: 'worker', org: ORG_MAIN, jobTitle: 'Community Mobiliser', regions: ['dadaab', 'fafi'], phone: '+254712000108', password: 'Passw0rd!' },
  { id: 'usr_officer_grace', email: 'grace.otieno@nerc.example.org', fullName: 'Grace Otieno', role: 'officer', org: ORG_MAIN, jobTitle: 'Deputy Security Officer', regions: ['garissa-township', 'dadaab', 'wajir-east'], phone: '+254712000109', password: 'Passw0rd!' },

  // Partner org - proves cross-share fan-out
  { id: 'usr_worker_zeinab', email: 'zeinab.omar@hornaid.example.org', fullName: 'Zeinab Omar', role: 'worker', org: ORG_PARTNER, jobTitle: 'Field Officer', regions: ['wajir-east', 'tarbaj'], phone: '+254712000110', password: 'Passw0rd!' },
  { id: 'usr_officer_mohamed', email: 'mohamed.ali@hornaid.example.org', fullName: 'Mohamed Ali', role: 'officer', org: ORG_PARTNER, jobTitle: 'Security Manager', regions: ['wajir-east', 'mandera-east', 'mandera-south'], phone: '+254712000111', password: 'Passw0rd!' },
  { id: 'usr_admin_lucy', email: 'lucy.karanja@hornaid.example.org', fullName: 'Lucy Karanja', role: 'admin', org: ORG_PARTNER, jobTitle: 'Head of Programmes', regions: [], phone: '+254712000112', password: 'Passw0rd!' },

  // Unrelated org - proves isolation
  { id: 'usr_worker_esther', email: 'esther.mutua@riverine.example.org', fullName: 'Esther Mutua', role: 'worker', org: ORG_OTHER, jobTitle: 'Clinical Officer', regions: ['tana-delta', 'ijara'], phone: '+254712000113', password: 'Passw0rd!' },
  { id: 'usr_officer_ruth', email: 'ruth.chebet@riverine.example.org', fullName: 'Ruth Chebet', role: 'officer', org: ORG_OTHER, jobTitle: 'Safety Focal Point', regions: ['tana-delta', 'ijara', 'hulugho'], phone: '+254712000114', password: 'Passw0rd!' },
];

function buildProfiles(): { profiles: Profile[]; credentials: Credential[] } {
  const profiles: Profile[] = [];
  const credentials: Credential[] = [];

  PEOPLE.forEach((person, index) => {
    const homeRegion = person.regions[0] ? REGIONS_BY_ID[person.regions[0]] : null;
    const lastKnown = homeRegion
      ? destinationPoint(homeRegion.center, rand() * homeRegion.radiusMeters * 0.6, rand() * 360)
      : null;

    profiles.push({
      id: person.id,
      email: person.email,
      phone: person.phone,
      fullName: person.fullName,
      role: person.role,
      organizationId: person.org,
      jobTitle: person.jobTitle,
      operatingRegions: person.regions,
      lastKnownLocation: lastKnown,
      lastSeenAt: iso(NOW - randInt(2, 600) * 60_000),
      status: 'active',
      avatarColor: AVATAR_COLORS[index % AVATAR_COLORS.length],
      createdAt: iso(NOW - randInt(60, 700) * DAY),
      onboardedAt: person.role === 'worker' && !person.regions.length ? null : iso(NOW - randInt(50, 690) * DAY),
      notificationPreferences: {
        push: true,
        criticalOnly: false,
        quietHours: { enabled: person.role === 'admin', startHour: 22, endHour: 6 },
      },
    });

    credentials.push({
      profileId: person.id,
      email: person.email,
      passwordHash: hashSecret(person.password, person.id),
      passwordVersion: 1,
      failedAttempts: 0,
      lockedUntil: null,
      lastSignInAt: iso(NOW - randInt(1, 72) * HOUR),
    });
  });

  return { profiles, credentials };
}

// --------------------------------------------------------------------------
// Report narratives
// --------------------------------------------------------------------------

type NarrativeSeed = {
  text: string;
  place: string;
  hoursAgo: number;
  reporter: string;
  reportedType?: ThreatType;
  /** Force a particular resolution so the dataset covers every path. */
  outcome?: 'verified' | 'dismissed' | 'pending';
  /** Marks a text intended to duplicate another (used only for commentary). */
  offsetMeters?: number;
};

const NARRATIVES: NarrativeSeed[] = [
  // --- Pending queue (what the officer sees on first launch) ---
  {
    text: 'Two vehicles were stopped by armed men about 12 km outside Dadaab on the Garissa road around 09:40. The men were carrying rifles and took phones and cash from the passengers before letting them go. Nobody was injured but the road is being avoided by matatus now.',
    place: 'dadaab-town',
    hoursAgo: 3,
    reporter: 'usr_worker_halima',
    reportedType: 'road_ambush',
    outcome: 'pending',
    offsetMeters: 12_000,
  },
  {
    text: 'Reports of gunfire near the livestock market this morning. I heard maybe six or seven shots from the direction of the market. People ran towards the town centre. Unconfirmed whether anyone was hurt.',
    place: 'garissa-town',
    hoursAgo: 5,
    reporter: 'usr_worker_joseph',
    outcome: 'pending',
  },
  {
    text: 'Vehicles ambushed on the Dadaab road this morning, roughly 12km from town. Armed group robbed passengers of phones and money. No casualties reported. Transport operators are refusing to use the route.',
    place: 'dadaab-town',
    hoursAgo: 2.4,
    reporter: 'usr_worker_ibrahim',
    reportedType: 'road_ambush',
    outcome: 'pending',
    offsetMeters: 11_400,
  },
  {
    text: 'Illegal roadblock set up at the junction. Men in civilian clothes demanded 2000 shillings per vehicle to pass. Our driver refused and we turned back. This is the third time this month at the same spot.',
    place: 'bura-junction',
    hoursAgo: 8,
    reporter: 'usr_worker_peter',
    reportedType: 'checkpoint_extortion',
    outcome: 'pending',
  },
  {
    text: 'Something happened near the borehole',
    place: 'habaswein',
    hoursAgo: 11,
    reporter: 'usr_worker_sarah',
    outcome: 'pending',
  },
  {
    text: 'Large crowd gathered outside the sub-county offices protesting the delayed relief distribution. Police have deployed and there is stone throwing. The main road past the offices is currently blocked and staff should not attempt to pass.',
    place: 'wajir-town',
    hoursAgo: 6,
    reporter: 'usr_worker_zeinab',
    reportedType: 'civil_unrest',
    outcome: 'pending',
  },

  // --- Verified, recent (drives the map and alerts feed) ---
  {
    text: 'An improvised explosive device detonated under a security vehicle on the Modogashe road at approximately 07:15. Multiple casualties reported. The road is closed in both directions and security forces are conducting a sweep for secondary devices. All movement on this axis must stop immediately.',
    place: 'modogashe',
    hoursAgo: 20,
    reporter: 'usr_worker_joseph',
    reportedType: 'ied_explosive',
    outcome: 'verified',
  },
  {
    text: 'Armed men attacked a livestock camp overnight and drove away several hundred camels. One herder was killed and two others were injured and taken to the dispensary. The attackers were heavily armed and moved north towards the border.',
    place: 'griftu',
    hoursAgo: 30,
    reporter: 'usr_worker_zeinab',
    reportedType: 'banditry',
    outcome: 'verified',
  },
  {
    text: 'A staff member from a partner agency was abducted from a vehicle at a fake checkpoint on the El Wak road yesterday evening. The vehicle was found abandoned this morning. This is an active incident and all agencies are asked to suspend movement on the corridor.',
    place: 'el-wak',
    hoursAgo: 26,
    reporter: 'usr_officer_mohamed',
    reportedType: 'abduction',
    outcome: 'verified',
  },
  {
    text: 'Exchange of fire between security forces and an armed group approximately 8 km south of the camp during the night. Sustained gunfire for around forty minutes. Camp residents report the group moved east afterwards. Camp operations suspended pending assessment.',
    place: 'hagadera-camp',
    hoursAgo: 40,
    reporter: 'usr_worker_halima',
    reportedType: 'armed_incident',
    outcome: 'verified',
  },
  {
    text: 'Clashes between two communities over access to the water pan escalated this afternoon. Several people injured. Elders are attempting mediation but the situation remains tense and could restart tonight.',
    place: 'tarbaj-town',
    hoursAgo: 52,
    reporter: 'usr_worker_zeinab',
    reportedType: 'inter_communal_conflict',
    outcome: 'verified',
  },
  {
    text: 'Vehicle carrying traders was ambushed on the Ijara road late afternoon. Gunmen fired at the vehicle and it went off the road. Two people were wounded and are being treated. The gunmen escaped into the bush.',
    place: 'masalani',
    hoursAgo: 60,
    reporter: 'usr_worker_esther',
    reportedType: 'road_ambush',
    outcome: 'verified',
  },
  {
    text: 'Break-in at a partner agency compound overnight. Office equipment and a generator were stolen. No staff were present at the time and nobody was hurt. Perimeter fence was cut on the north side.',
    place: 'garissa-town',
    hoursAgo: 70,
    reporter: 'usr_worker_peter',
    reportedType: 'crime',
    outcome: 'verified',
  },
  {
    text: 'Unexploded ordnance found by children near the dry riverbed east of the settlement. The area has been cordoned by local elders and police have been informed. Nobody has been hurt but the item is still in place.',
    place: 'balambala-town',
    hoursAgo: 84,
    reporter: 'usr_worker_peter',
    reportedType: 'ied_explosive',
    outcome: 'verified',
  },
  {
    text: 'Gunmen stopped a bus on the main road and robbed passengers at gunpoint before driving off. No injuries. Incident lasted about fifteen minutes. Passengers reported four attackers.',
    place: 'habaswein',
    hoursAgo: 96,
    reporter: 'usr_worker_sarah',
    reportedType: 'banditry',
    outcome: 'verified',
  },

  // --- Dismissed (proves the reject path and keeps AI-agreement honest) ---
  {
    text: 'Heard from a neighbour that there might be trouble at the market tomorrow. Nothing has happened yet, this is just a rumour going around.',
    place: 'garissa-town',
    hoursAgo: 34,
    reporter: 'usr_worker_ibrahim',
    outcome: 'dismissed',
  },
  {
    text: 'Loud bangs heard near the airstrip around midnight. Later confirmed to be a generator backfiring at the compound. No security incident, situation calm.',
    place: 'wajir-town',
    hoursAgo: 46,
    reporter: 'usr_worker_zeinab',
    outcome: 'dismissed',
  },
  {
    text: 'A crowd formed near the school this morning but it turned out to be a scheduled community meeting about the borehole rota. It dispersed peacefully by midday, no incident.',
    place: 'dadaab-town',
    hoursAgo: 58,
    reporter: 'usr_worker_halima',
    outcome: 'dismissed',
  },

  // --- Older verified history (gives the analytics screens real trends) ---
  { text: 'Armed robbery at a shop in the market. Two attackers with pistols took cash and fled on a motorcycle. Shopkeeper was assaulted but not seriously hurt.', place: 'garissa-town', hoursAgo: 5 * 24, reporter: 'usr_worker_joseph', outcome: 'verified' },
  { text: 'Roadblock by unidentified armed men on the Fafi road. Vehicles were searched and money demanded. Our team turned back and used the alternate track.', place: 'bura-junction', hoursAgo: 6 * 24, reporter: 'usr_worker_peter', outcome: 'verified' },
  { text: 'Gunfire exchange reported near the district boundary overnight. Security forces pursued an armed group. No civilian casualties confirmed.', place: 'modogashe', hoursAgo: 7 * 24, reporter: 'usr_worker_sarah', outcome: 'verified' },
  { text: 'Livestock raid on the outskirts of the settlement. Armed raiders drove off goats and camels. One person was injured during the raid.', place: 'bute', hoursAgo: 9 * 24, reporter: 'usr_worker_zeinab', outcome: 'verified' },
  { text: 'Protest over water rationing blocked the main access road for around three hours. Crowd dispersed after county officials arrived. No violence reported.', place: 'wajir-town', hoursAgo: 11 * 24, reporter: 'usr_worker_zeinab', outcome: 'verified' },
  { text: 'Vehicle ambushed near the seasonal river crossing. Driver was shot in the arm and the vehicle was taken. This route has had repeated incidents.', place: 'masalani', hoursAgo: 12 * 24, reporter: 'usr_worker_esther', outcome: 'verified' },
  { text: 'Attempted abduction of a local trader at a checkpoint. He escaped when a security patrol approached. The checkpoint was not official.', place: 'el-wak', hoursAgo: 14 * 24, reporter: 'usr_worker_zeinab', outcome: 'verified' },
  { text: 'Explosive device found and safely disposed of by police on the road shoulder. The device had been placed overnight. Road reopened after four hours.', place: 'modogashe', hoursAgo: 16 * 24, reporter: 'usr_worker_joseph', outcome: 'verified' },
  { text: 'Clashes over pasture between herding groups left several injured. Both sides have withdrawn but tension remains high in the area.', place: 'griftu', hoursAgo: 18 * 24, reporter: 'usr_worker_zeinab', outcome: 'verified' },
  { text: 'Armed men entered a compound at night and demanded money from the caretaker. They left without harming anyone after taking a small amount of cash.', place: 'habaswein', hoursAgo: 20 * 24, reporter: 'usr_worker_sarah', outcome: 'verified' },
  { text: 'Bus attacked on the highway at dawn. Gunmen fired on the vehicle causing it to stop, then robbed passengers. Three passengers were injured by broken glass.', place: 'garissa-town', hoursAgo: 23 * 24, reporter: 'usr_worker_peter', outcome: 'verified' },
  { text: 'Illegal checkpoint operating on the camp access road. Drivers report being asked for payment daily. No violence but it is now routine.', place: 'ifo-camp', hoursAgo: 26 * 24, reporter: 'usr_worker_halima', outcome: 'verified' },
  { text: 'Grenade thrown at a security post overnight. One officer injured. Attackers fled on foot. Area cordoned and searched.', place: 'mandera-town', hoursAgo: 29 * 24, reporter: 'usr_worker_zeinab', outcome: 'verified' },
  { text: 'Riot at the distribution point after the food queue collapsed. Crowd pushed through the barrier and distribution was suspended. Two staff sustained minor injuries.', place: 'dagahaley-camp', hoursAgo: 32 * 24, reporter: 'usr_worker_halima', outcome: 'verified' },
  { text: 'Theft of fuel from a parked vehicle at the guesthouse overnight. Tank was siphoned. Reported to police, no suspects.', place: 'wajir-town', hoursAgo: 35 * 24, reporter: 'usr_worker_zeinab', outcome: 'dismissed' },
  { text: 'Armed group sighted moving through the bush west of the settlement in the early morning. No contact made, but community members are alarmed.', place: 'takaba', hoursAgo: 38 * 24, reporter: 'usr_worker_zeinab', outcome: 'verified' },
  { text: 'Convoy stopped by armed men on the corridor. Cargo was searched and some items taken. Drivers were released unharmed after an hour.', place: 'rhamu', hoursAgo: 42 * 24, reporter: 'usr_worker_zeinab', outcome: 'verified' },
  { text: 'Communal tension escalated after a boundary dispute. Youths from both sides gathered but elders intervened before any violence.', place: 'banissa-town', hoursAgo: 46 * 24, reporter: 'usr_worker_zeinab', outcome: 'verified' },
  { text: 'Night-time gunfire heard on the edge of town. Source not established. Security patrol found nothing.', place: 'lafey-town', hoursAgo: 50 * 24, reporter: 'usr_worker_zeinab', outcome: 'dismissed' },
  { text: 'Robbery of a motorcycle taxi rider at knifepoint on the outskirts. Rider was not seriously hurt, motorcycle was taken.', place: 'hola', hoursAgo: 54 * 24, reporter: 'usr_worker_esther', outcome: 'verified' },
  { text: 'Ambush on a supply vehicle on the Ijara road. Driver escaped on foot, vehicle was burnt. This corridor remains high risk after dark.', place: 'masalani', hoursAgo: 58 * 24, reporter: 'usr_worker_esther', outcome: 'verified' },
];

// --------------------------------------------------------------------------
// Build reports
// --------------------------------------------------------------------------

const PHOTO_RATIO = 0.35;

function buildReports(profiles: Profile[]): ThreatReport[] {
  const byId = new Map(profiles.map((p) => [p.id, p]));
  const reports: ThreatReport[] = [];

  // Oldest first so the duplicate detector sees a growing history.
  const ordered = [...NARRATIVES].sort((a, b) => b.hoursAgo - a.hoursAgo);

  for (const narrative of ordered) {
    const place = PLACES.find((p) => p.id === narrative.place);
    if (!place) continue;
    const reporter = byId.get(narrative.reporter);
    if (!reporter) continue;

    const occurredMs = NOW - narrative.hoursAgo * HOUR;
    const createdMs = occurredMs + randInt(4, 90) * 60_000;
    const spread = narrative.offsetMeters ?? randInt(400, 6000);
    const location = destinationPoint(place.point, spread, rand() * 360);

    const id = `rep_${Math.floor(rand() * 1e9).toString(36)}${reports.length}`;

    // Only reports the pre-filter would surface: same window, same corridor.
    const candidates = reports.filter(
      (r) =>
        Math.abs(Date.parse(r.occurredAt) - occurredMs) <= 12 * HOUR &&
        distanceMeters(r.location, location) <= 5000,
    );

    const ai = classifyReportSync({
      description: narrative.text,
      reportedType: narrative.reportedType ?? null,
      location,
      occurredAt: iso(occurredMs),
      candidates,
    });

    const outcome = narrative.outcome ?? 'verified';
    const region = regionForPoint(location);

    // Officers agree with the model most of the time but not always - that gap
    // is exactly what the "AI agreement rate" metric is meant to expose.
    const officerDisagrees = outcome === 'verified' && rand() < 0.22;
    const severityOptions: Severity[] = ['low', 'medium', 'high', 'critical'];
    const aiIndex = severityOptions.indexOf(ai.severity);
    const finalSeverity: Severity = officerDisagrees
      ? severityOptions[Math.max(0, Math.min(3, aiIndex + (rand() < 0.5 ? -1 : 1)))]
      : ai.severity;

    const verifierPool = profiles.filter(
      (p) => p.role === 'officer' && p.organizationId === reporter.organizationId,
    );
    const verifier = verifierPool.length ? verifierPool[Math.floor(rand() * verifierPool.length)] : null;
    const verificationDelayMs = randInt(4, 140) * 60_000;

    const report: ThreatReport = {
      id,
      reference: shortRef(id),
      reporterId: reporter.id,
      organizationId: reporter.organizationId,
      description: narrative.text,
      photoUrl: rand() < PHOTO_RATIO ? `photo://${id}` : null,
      location,
      locationAccuracyMeters: randInt(8, 65),
      locationSource: rand() < 0.85 ? 'gps' : 'manual-pin',
      regionId: region?.id ?? null,
      placeLabel: place.name,
      reportedType: narrative.reportedType ?? null,
      threatType: outcome === 'verified' ? (officerDisagrees && rand() < 0.35 ? ai.threatType : ai.threatType) : null,
      severity: outcome === 'verified' ? finalSeverity : null,
      priority: outcome === 'verified' ? ai.priority : null,
      alertRadiusMeters:
        outcome === 'verified'
          ? THREAT_META[ai.threatType].radiusBySeverity[finalSeverity] * (rand() < 0.3 ? 1.25 : 1)
          : null,
      status: outcome,
      possibleDuplicateOf: ai.possibleDuplicateOf,
      aiSuggestions: ai,
      aiStatus: 'complete',
      verifiedBy: outcome === 'pending' ? null : verifier?.id ?? null,
      verifiedAt: outcome === 'pending' ? null : iso(createdMs + verificationDelayMs),
      dismissedReason:
        outcome === 'dismissed'
          ? pick([
              'Confirmed with a second source as a non-security event.',
              'Duplicate of an already verified report.',
              'Unsubstantiated rumour; no corroboration found.',
              'Reporter confirmed the situation resolved without incident.',
            ])
          : null,
      occurredAt: iso(occurredMs),
      createdAt: iso(createdMs),
      updatedAt: iso(outcome === 'pending' ? createdMs : createdMs + verificationDelayMs),
    };

    if (report.alertRadiusMeters) report.alertRadiusMeters = Math.round(report.alertRadiusMeters / 500) * 500;

    reports.push(report);
  }

  return reports.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

// --------------------------------------------------------------------------
// Alerts, notifications, SOS, audit
// --------------------------------------------------------------------------

function buildAlerts(reports: ThreatReport[], profiles: Profile[]): SafetyAlert[] {
  const alerts: SafetyAlert[] = [];

  for (const report of reports) {
    if (report.status !== 'verified' || !report.severity || !report.threatType) continue;
    // Only the last three weeks produced live alerts; older ones have aged out.
    if (Date.parse(report.verifiedAt ?? report.createdAt) < NOW - 21 * DAY) continue;

    const meta = THREAT_META[report.threatType];
    alerts.push({
      id: `alt_${report.id.slice(4)}`,
      issuedBy: report.verifiedBy ?? 'system',
      organizationId: report.organizationId,
      relatedReportId: report.id,
      title: `${meta.label} near ${report.placeLabel ?? 'your area'}`,
      message: `${report.aiSuggestions?.summary ?? meta.label}. ${SEVERITY_META[report.severity].guidance}`,
      severity: report.severity,
      threatType: report.threatType,
      location: report.location,
      radiusMeters: report.alertRadiusMeters,
      regionIds: report.regionId ? [report.regionId] : [],
      kind: 'threat',
      createdAt: report.verifiedAt ?? report.createdAt,
      expiresAt: iso(Date.parse(report.verifiedAt ?? report.createdAt) + 72 * HOUR),
      cancelledAt: null,
      recipientCount: 0,
    });
  }

  // Standalone advisories - officers issuing guidance not tied to one report.
  alerts.push({
    id: 'alt_advisory_curfew',
    issuedBy: 'usr_officer_daniel',
    organizationId: ORG_MAIN,
    relatedReportId: null,
    title: 'Movement curfew: Garissa - Dadaab corridor',
    message:
      'Following repeated incidents on the Dadaab road, all movement on this corridor is restricted to 08:00-16:00 with a minimum two-vehicle convoy. Clearance required from the area security officer for any exception.',
    severity: 'high',
    threatType: 'road_ambush',
    location: { lat: -0.2, lng: 39.98 },
    radiusMeters: 40_000,
    regionIds: ['garissa-township', 'dadaab'],
    kind: 'advisory',
    createdAt: iso(NOW - 16 * HOUR),
    expiresAt: iso(NOW + 5 * DAY),
    cancelledAt: null,
    recipientCount: 0,
  });

  alerts.push({
    id: 'alt_advisory_comms',
    issuedBy: 'usr_officer_grace',
    organizationId: ORG_MAIN,
    relatedReportId: null,
    title: 'Network outage: Fafi and Balambala',
    message:
      'Mobile coverage is intermittent across Fafi and Balambala following a mast failure. Confirm radio checks before departure and expect delayed report sync. Reports filed offline will send automatically once coverage returns.',
    severity: 'medium',
    threatType: null,
    location: null,
    radiusMeters: null,
    regionIds: ['fafi', 'balambala'],
    kind: 'advisory',
    createdAt: iso(NOW - 2.5 * DAY),
    expiresAt: iso(NOW + 1.5 * DAY),
    cancelledAt: null,
    recipientCount: 0,
  });

  alerts.push({
    id: 'alt_advisory_partner',
    issuedBy: 'usr_officer_mohamed',
    organizationId: ORG_PARTNER,
    relatedReportId: null,
    title: 'Suspend movement: Wajir - El Wak corridor',
    message:
      'Following the abduction on the El Wak road, all agency movement on the Wajir - El Wak - Mandera corridor is suspended until further notice. Shared with partner organisations.',
    severity: 'critical',
    threatType: 'abduction',
    location: { lat: 2.8, lng: 40.9333 },
    radiusMeters: 60_000,
    regionIds: ['mandera-south', 'wajir-east', 'tarbaj'],
    kind: 'advisory',
    createdAt: iso(NOW - 25 * HOUR),
    expiresAt: iso(NOW + 3 * DAY),
    cancelledAt: null,
    recipientCount: 0,
  });

  return alerts.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

/**
 * Reproduces the fan-out rules so the seeded feed is consistent with what the
 * live alert function would have produced.
 */
function buildNotifications(
  alerts: SafetyAlert[],
  reports: ThreatReport[],
  profiles: Profile[],
  organizations: Organization[],
): NotificationRecord[] {
  const orgById = new Map(organizations.map((o) => [o.id, o]));
  const notifications: NotificationRecord[] = [];

  for (const alert of alerts) {
    const sourceOrg = orgById.get(alert.organizationId);
    let recipients = 0;

    for (const profile of profiles) {
      if (profile.role === 'admin') continue;
      if (profile.status !== 'active') continue;

      const reasons: NotificationRecord['matchReasons'] = [];
      if (profile.organizationId === alert.organizationId) reasons.push('same-organization');
      else if (sourceOrg?.crossSharePartners.includes(profile.organizationId)) reasons.push('partner-organization');

      let distance: number | null = null;
      if (alert.location && profile.lastKnownLocation) {
        distance = Math.round(distanceMeters(alert.location, profile.lastKnownLocation));
        if (alert.radiusMeters && distance <= alert.radiusMeters) reasons.push('within-alert-radius');
      }

      if (alert.regionIds.some((r) => profile.operatingRegions.includes(r))) reasons.push('operating-region');
      if (
        alert.location &&
        profile.operatingRegions.some((rid) => {
          const region = REGIONS_BY_ID[rid];
          return region && distanceMeters(region.center, alert.location!) <= region.radiusMeters;
        })
      ) {
        if (!reasons.includes('operating-region')) reasons.push('operating-region');
      }

      if (!reasons.length) continue;
      recipients += 1;

      const deliveredAt = Date.parse(alert.createdAt) + randInt(2, 90) * 1000;
      notifications.push({
        id: `ntf_${alert.id}_${profile.id.slice(-6)}`,
        profileId: profile.id,
        alertId: alert.id,
        reportId: alert.relatedReportId,
        title: alert.title,
        body: alert.message,
        severity: alert.severity,
        matchReasons: reasons,
        distanceMeters: distance,
        deliveredAt: iso(deliveredAt),
        readAt: rand() < 0.55 ? iso(deliveredAt + randInt(1, 400) * 60_000) : null,
      });
    }

    alert.recipientCount = recipients;
  }

  return notifications.sort((a, b) => Date.parse(b.deliveredAt) - Date.parse(a.deliveredAt));
}

function buildSosEvents(profiles: Profile[]): SosEvent[] {
  const events: SosEvent[] = [];

  const makeTrack = (start: { lat: number; lng: number }, points: number, startMs: number) => {
    const track: SosEvent['track'] = [];
    let cursor = start;
    for (let i = 0; i < points; i += 1) {
      track.push({ point: cursor, ts: iso(startMs + i * 60_000), accuracyMeters: randInt(9, 48) });
      cursor = destinationPoint(cursor, randInt(60, 400), rand() * 360);
    }
    return track;
  };

  // One live event so the officer console has something to respond to on launch.
  const activeWorker = profiles.find((p) => p.id === 'usr_worker_peter')!;
  const activeStart = NOW - 9 * 60_000;
  const activeOrigin = activeWorker.lastKnownLocation ?? { lat: -0.4569, lng: 39.6583 };
  events.push({
    id: 'sos_active_peter',
    workerId: activeWorker.id,
    organizationId: activeWorker.organizationId,
    status: 'active',
    reason: 'Vehicle stopped by armed men on the Fafi road',
    location: activeOrigin,
    accuracyMeters: 22,
    track: makeTrack(activeOrigin, 9, activeStart),
    createdAt: iso(activeStart),
    acknowledgedBy: null,
    acknowledgedAt: null,
    resolvedBy: null,
    resolvedAt: null,
    resolutionNote: null,
    timeline: [
      { id: 'sostl_1', ts: iso(activeStart), actorId: activeWorker.id, kind: 'triggered', text: 'SOS triggered by Peter Mwangi.' },
      { id: 'sostl_2', ts: iso(activeStart + 60_000), actorId: null, kind: 'location', text: 'Location update received (22 m accuracy).' },
      { id: 'sostl_3', ts: iso(activeStart + 300_000), actorId: null, kind: 'location', text: 'Location update received (31 m accuracy).' },
    ],
  });

  // A resolved event with a full timeline, for post-incident review.
  const pastWorker = profiles.find((p) => p.id === 'usr_worker_halima')!;
  const pastStart = NOW - 4 * DAY;
  const pastOrigin = pastWorker.lastKnownLocation ?? { lat: 0.0553, lng: 40.3086 };
  events.push({
    id: 'sos_resolved_halima',
    workerId: pastWorker.id,
    organizationId: pastWorker.organizationId,
    status: 'resolved',
    reason: 'Crowd surrounded the vehicle at the distribution point',
    location: pastOrigin,
    accuracyMeters: 15,
    track: makeTrack(pastOrigin, 14, pastStart),
    createdAt: iso(pastStart),
    acknowledgedBy: 'usr_officer_daniel',
    acknowledgedAt: iso(pastStart + 96_000),
    resolvedBy: 'usr_officer_daniel',
    resolvedAt: iso(pastStart + 41 * 60_000),
    resolutionNote: 'Worker extracted by the county security team. No injuries. Distribution rescheduled.',
    timeline: [
      { id: 'sostl_p1', ts: iso(pastStart), actorId: pastWorker.id, kind: 'triggered', text: 'SOS triggered by Halima Abdi.' },
      { id: 'sostl_p2', ts: iso(pastStart + 12_000), actorId: null, kind: 'queued-offline', text: 'No connectivity - SOS held in the local queue.' },
      { id: 'sostl_p3', ts: iso(pastStart + 71_000), actorId: null, kind: 'synced', text: 'Connectivity restored - SOS delivered to officers.' },
      { id: 'sostl_p4', ts: iso(pastStart + 96_000), actorId: 'usr_officer_daniel', kind: 'acknowledged', text: 'Acknowledged by Daniel Kiptoo.' },
      { id: 'sostl_p5', ts: iso(pastStart + 15 * 60_000), actorId: 'usr_officer_daniel', kind: 'note', text: 'County security team dispatched to the location.' },
      { id: 'sostl_p6', ts: iso(pastStart + 41 * 60_000), actorId: 'usr_officer_daniel', kind: 'resolved', text: 'Resolved: worker safe, no injuries.' },
    ],
  });

  const oldWorker = profiles.find((p) => p.id === 'usr_worker_sarah')!;
  const oldStart = NOW - 17 * DAY;
  const oldOrigin = oldWorker.lastKnownLocation ?? { lat: 1.0117, lng: 39.4906 };
  events.push({
    id: 'sos_resolved_sarah',
    workerId: oldWorker.id,
    organizationId: oldWorker.organizationId,
    status: 'resolved',
    reason: 'Lost contact with convoy after dark',
    location: oldOrigin,
    accuracyMeters: 40,
    track: makeTrack(oldOrigin, 8, oldStart),
    createdAt: iso(oldStart),
    acknowledgedBy: 'usr_officer_grace',
    acknowledgedAt: iso(oldStart + 180_000),
    resolvedBy: 'usr_officer_grace',
    resolvedAt: iso(oldStart + 63 * 60_000),
    resolutionNote: 'Convoy regrouped at Habaswein. All staff accounted for.',
    timeline: [
      { id: 'sostl_s1', ts: iso(oldStart), actorId: oldWorker.id, kind: 'triggered', text: 'SOS triggered by Sarah Lokwang.' },
      { id: 'sostl_s2', ts: iso(oldStart + 180_000), actorId: 'usr_officer_grace', kind: 'acknowledged', text: 'Acknowledged by Grace Otieno.' },
      { id: 'sostl_s3', ts: iso(oldStart + 63 * 60_000), actorId: 'usr_officer_grace', kind: 'resolved', text: 'Resolved: convoy regrouped, all accounted for.' },
    ],
  });

  return events;
}

function buildAudit(reports: ThreatReport[], alerts: SafetyAlert[], sos: SosEvent[], profiles: Profile[]): AuditEntry[] {
  const byId = new Map(profiles.map((p) => [p.id, p]));
  const entries: AuditEntry[] = [];
  let counter = 0;
  const add = (e: Omit<AuditEntry, 'id'>) => entries.push({ ...e, id: `aud_seed_${(counter += 1)}` });

  for (const report of reports) {
    const reporter = byId.get(report.reporterId);
    add({
      ts: report.createdAt,
      actorId: report.reporterId,
      actorRole: 'worker',
      organizationId: report.organizationId,
      action: 'report.created',
      entity: 'report',
      entityId: report.id,
      summary: `${reporter?.fullName ?? 'A worker'} filed report ${report.reference}.`,
    });

    if (report.aiStatus === 'complete' && report.aiSuggestions) {
      add({
        ts: iso(Date.parse(report.createdAt) + report.aiSuggestions.latencyMs),
        actorId: null,
        actorRole: 'system',
        organizationId: report.organizationId,
        action: 'report.ai_classified',
        entity: 'report',
        entityId: report.id,
        summary: `AI suggested ${THREAT_META[report.aiSuggestions.threatType].label} / ${report.aiSuggestions.severity} at ${Math.round(report.aiSuggestions.confidence * 100)}% confidence.`,
        after: {
          threatType: report.aiSuggestions.threatType,
          severity: report.aiSuggestions.severity,
          possibleDuplicateOf: report.aiSuggestions.possibleDuplicateOf,
        },
      });
    }

    if (report.status === 'verified' && report.verifiedAt) {
      const officer = byId.get(report.verifiedBy ?? '');
      add({
        ts: report.verifiedAt,
        actorId: report.verifiedBy,
        actorRole: 'officer',
        organizationId: report.organizationId,
        action: 'report.verified',
        entity: 'report',
        entityId: report.id,
        summary: `${officer?.fullName ?? 'An officer'} verified ${report.reference} as ${report.severity} severity with a ${((report.alertRadiusMeters ?? 0) / 1000).toFixed(1)} km alert radius.`,
        before: { status: 'pending' },
        after: { status: 'verified', severity: report.severity, alertRadiusMeters: report.alertRadiusMeters },
      });
    }

    if (report.status === 'dismissed' && report.verifiedAt) {
      const officer = byId.get(report.verifiedBy ?? '');
      add({
        ts: report.verifiedAt,
        actorId: report.verifiedBy,
        actorRole: 'officer',
        organizationId: report.organizationId,
        action: 'report.dismissed',
        entity: 'report',
        entityId: report.id,
        summary: `${officer?.fullName ?? 'An officer'} dismissed ${report.reference}: ${report.dismissedReason}`,
        before: { status: 'pending' },
        after: { status: 'dismissed' },
      });
    }
  }

  for (const alert of alerts) {
    add({
      ts: alert.createdAt,
      actorId: alert.issuedBy,
      actorRole: 'officer',
      organizationId: alert.organizationId,
      action: alert.kind === 'advisory' ? 'alert.advisory_issued' : 'alert.fanout',
      entity: 'alert',
      entityId: alert.id,
      summary: `"${alert.title}" delivered to ${alert.recipientCount} recipient(s).`,
    });
  }

  for (const event of sos) {
    for (const item of event.timeline) {
      if (item.kind === 'location') continue;
      add({
        ts: item.ts,
        actorId: item.actorId,
        actorRole: item.actorId?.includes('officer') ? 'officer' : item.actorId ? 'worker' : 'system',
        organizationId: event.organizationId,
        action: `sos.${item.kind}`,
        entity: 'sos',
        entityId: event.id,
        summary: item.text,
      });
    }
  }

  return entries.sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts)).slice(0, 600);
}

function buildInvites(): Invite[] {
  return [
    {
      id: 'inv_pending_1',
      email: 'nasra.yusuf@nerc.example.org',
      fullName: 'Nasra Yusuf',
      role: 'worker',
      organizationId: ORG_MAIN,
      invitedBy: 'usr_admin_fatuma',
      createdAt: iso(NOW - 2 * DAY),
      acceptedAt: null,
      expiresAt: iso(NOW + 5 * DAY),
      code: 'NERC-4821',
      operatingRegions: ['garissa-township', 'balambala'],
    },
    {
      id: 'inv_pending_2',
      email: 'kevin.omondi@nerc.example.org',
      fullName: 'Kevin Omondi',
      role: 'officer',
      organizationId: ORG_MAIN,
      invitedBy: 'usr_admin_fatuma',
      createdAt: iso(NOW - 6 * HOUR),
      acceptedAt: null,
      expiresAt: iso(NOW + 7 * DAY),
      code: 'NERC-9037',
      operatingRegions: ['dadaab', 'fafi'],
    },
  ];
}

// --------------------------------------------------------------------------

export function buildSeed(): DbShape {
  seed = 0x5a3e7c1; // reset so repeated calls are identical
  const { profiles, credentials } = buildProfiles();
  const reports = buildReports(profiles);
  const alerts = buildAlerts(reports, profiles);
  const notifications = buildNotifications(alerts, reports, profiles, organizations);
  const sosEvents = buildSosEvents(profiles);
  const audit = buildAudit(reports, alerts, sosEvents, profiles);

  return {
    organizations,
    profiles,
    credentials,
    verificationCodes: [],
    reports,
    alerts,
    notifications,
    sosEvents,
    audit,
    invites: buildInvites(),
    sessions: [],
    meta: { seededAt: iso(NOW), version: 1 },
  };
}

/** Surfaced on the sign-in screen so the demo is self-explanatory. */
export const DEMO_ACCOUNTS = [
  { email: 'worker@saferoute.ai', password: 'Passw0rd!', role: 'worker' as const, name: 'Amina Hassan', detail: 'Field Coordinator - reports, alerts, safe route, SOS' },
  { email: 'officer@saferoute.ai', password: 'Passw0rd!', role: 'officer' as const, name: 'Daniel Kiptoo', detail: 'Security Officer - verification queue, advisories, SOS console' },
  { email: 'admin@saferoute.ai', password: 'Passw0rd!', role: 'admin' as const, name: 'Fatuma Noor', detail: 'Org Admin - people, partnerships, analytics, audit log' },
];
