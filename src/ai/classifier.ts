import { SEVERITIES, THREAT_META, type Severity, type ThreatType } from '@/constants/threats';
import { distanceMeters } from '@/lib/geo';
import type { AiSuggestion, ThreatReport } from '@/api/types';

/**
 * Stand-in for the Grok classification Edge Function.
 *
 * The real implementation posts the report text to Grok from a Supabase Edge
 * Function and never from the client - the key must not ship in the bundle.
 * This module reproduces its *contract* exactly: same output shape, same
 * latency profile, same failure modes (low confidence, needs-more-info,
 * outright failure), so the verification UI is built against reality.
 *
 * It stays honest about one thing above all: output is advisory. It writes
 * suggestions, never a verified status.
 */

export const MODEL_NAME = 'grok-4-fast (simulated)';

type Signal = { type: ThreatType; weight: number; term: string };

/**
 * Keyword lexicon. Weights are rough log-odds - a term like "IED" is nearly
 * decisive, while "men" alone barely moves anything.
 */
const LEXICON: { pattern: RegExp; type: ThreatType; weight: number }[] = [
  // Explosives
  { pattern: /\b(ieds?|explosives?|detonat\w*|landmines?|land mines?|uxo|unexploded|ordnance|blast|bombs?|grenades?)\b/i, type: 'ied_explosive', weight: 5 },

  // Road ambush. Field reports rarely use the word "ambush" - far more often
  // they describe a vehicle being stopped or fired on, so those phrasings carry
  // most of the weight here.
  { pattern: /\b(ambush\w*|waylaid)\b/i, type: 'road_ambush', weight: 4.5 },
  // A vehicle stopped or attacked on a road IS a road ambush, whoever did it.
  // These composite patterns are weighted above the generic armed-actor terms
  // on purpose: without that, "armed men stopped two vehicles" classifies as a
  // generic armed incident and the corridor never gets flagged in Safe Route.
  { pattern: /\b(vehicles?|convoys?|trucks?|lorr(?:y|ies)|buses|bus|land ?cruisers?|matatus?|motorcycles?)\b[^.]{0,60}\b(stopped|attacked|fired|ambush\w*|robbed|burnt|burned|hijack\w*|went off the road)\b/i, type: 'road_ambush', weight: 6 },
  { pattern: /\b(stopped|attacked|fired on|flagged down)\b[^.]{0,40}\b(vehicles?|convoys?|trucks?|buses|bus|lorr(?:y|ies))\b/i, type: 'road_ambush', weight: 6 },
  { pattern: /\bon the [a-z\s-]{0,24}road\b/i, type: 'road_ambush', weight: 1.6 },
  { pattern: /\b(convoys?|vehicles?|trucks?|land ?cruisers?|lorr(?:y|ies)|buses)\b/i, type: 'road_ambush', weight: 1.2 },

  // Abduction
  { pattern: /\b(abduct\w*|kidnap\w*|taken hostage|held against|missing staff|held captive)\b/i, type: 'abduction', weight: 5 },

  // Banditry
  { pattern: /\b(bandit\w*|raid\w*|rustl\w*|livestock|cattle|camels?|goats?|herders?)\b/i, type: 'banditry', weight: 3.5 },

  // Ordinary crime
  { pattern: /\b(robb\w*|steal|stole|stolen|theft|mugg\w*|burglar\w*|break-?ins?|siphon\w*|knifepoint)\b/i, type: 'crime', weight: 2.5 },

  // Armed actors. "Armed men" is the single most common phrasing in real
  // reporting from this region and has to be a first-class signal.
  { pattern: /\barmed (men|group|groups|gang|gangs|actors|individuals|assailants|people|persons|youths)\b/i, type: 'armed_incident', weight: 4.5 },
  { pattern: /\b(al[- ]?shabaab|militants?|insurgents?|gunmen|gunman|attackers?|assailants?|raiders?)\b/i, type: 'armed_incident', weight: 4 },
  { pattern: /\b(gunfire|gunshots?|shooting|shots|shot|firing|exchange of fire|small arms)\b/i, type: 'armed_incident', weight: 3.6 },
  // Weapons can be mentioned incidentally, so they carry less on their own.
  { pattern: /\b(rifles?|ak-?47s?|weapons?|pistols?|armed)\b/i, type: 'armed_incident', weight: 2.2 },
  { pattern: /\bat gunpoint\b/i, type: 'armed_incident', weight: 3.5 },

  // Civil unrest
  { pattern: /\b(protest\w*|riot\w*|demonstrat\w*|crowds?|mobs?|stone[- ]?throw\w*|barricad\w*|unrest)\b/i, type: 'civil_unrest', weight: 4 },

  // Checkpoints and extortion
  { pattern: /\b(roadblocks?|checkpoints?|barriers?|illegal (toll|tax)|demanded (money|payment)|bribes?|extort\w*)\b/i, type: 'checkpoint_extortion', weight: 3.5 },
  { pattern: /\b(demanded|asked for)\b[^.]{0,30}\b(shillings?|money|payment|cash)\b/i, type: 'checkpoint_extortion', weight: 3.5 },

  // Inter-communal
  { pattern: /\b(clans?|communal|clash\w*|inter-?communal|pasture|water pan|water point|boundary dispute|elders?)\b/i, type: 'inter_communal_conflict', weight: 3.5 },
];

/** Terms that push severity up regardless of category. */
const SEVERITY_SIGNALS: { pattern: RegExp; weight: number; label: string }[] = [
  { pattern: /\b(killed|dead|death|fatal\w*|casualt\w*|body|bodies)\b/i, weight: 4, label: 'fatalities reported' },
  { pattern: /\b(injur\w*|wounded|hurt|bleeding|hospital)\b/i, weight: 2.5, label: 'injuries reported' },
  { pattern: /\b(ongoing|still happening|right now|currently|as i write|in progress)\b/i, weight: 2.5, label: 'incident is ongoing' },
  { pattern: /\b(staff|colleague|our team|aid worker|humanitarian)\b/i, weight: 2, label: 'humanitarian personnel involved' },
  { pattern: /\b(heavy|multiple|several|many|dozens|large group)\b/i, weight: 1.5, label: 'multiple actors or events' },
  { pattern: /\b(children|women|school|clinic|hospital|camp|idp)\b/i, weight: 1.5, label: 'civilian or protected site affected' },
  { pattern: /\b(blocked|cut off|cannot pass|impassable|stranded|trapped)\b/i, weight: 2, label: 'movement obstructed' },
  { pattern: /\b(rumou?r|unconfirmed|heard that|allegedly|possibly|not sure)\b/i, weight: -2.5, label: 'source is second-hand' },
  { pattern: /\b(resolved|cleared|dispersed|calm now|no injur\w*|nobody hurt)\b/i, weight: -2.5, label: 'situation reported as de-escalating' },
];

const STOPWORDS = new Set(
  'a an and are as at be been but by for from had has have he her his i in is it its of on or our she that the their them there they this to was were what when which who will with you your at near around'.split(
    ' ',
  ),
);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
}

/** Jaccard overlap on content words - the cheap half of duplicate detection. */
function textSimilarity(a: string, b: string): number {
  const setA = new Set(tokenize(a));
  const setB = new Set(tokenize(b));
  if (!setA.size || !setB.size) return 0;
  let intersection = 0;
  for (const w of setA) if (setB.has(w)) intersection += 1;
  return intersection / (setA.size + setB.size - intersection);
}

function classifyType(text: string, hint: ThreatType | null): { type: ThreatType; signals: Signal[]; confidence: number } {
  const scores = new Map<ThreatType, number>();
  const signals: Signal[] = [];

  for (const rule of LEXICON) {
    const match = text.match(rule.pattern);
    if (!match) continue;
    scores.set(rule.type, (scores.get(rule.type) ?? 0) + rule.weight);
    signals.push({ type: rule.type, weight: rule.weight, term: match[0].toLowerCase() });
  }

  // The reporter's own pre-selection is evidence, but weak evidence: workers
  // under stress reach for the first plausible label.
  if (hint) scores.set(hint, (scores.get(hint) ?? 0) + 1.5);

  if (scores.size === 0) {
    return { type: hint ?? 'other', signals, confidence: hint ? 0.42 : 0.28 };
  }

  const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]);
  const [topType, topScore] = ranked[0];
  const runnerUp = ranked[1]?.[1] ?? 0;
  const margin = topScore - runnerUp;
  const confidence = Math.min(0.97, 0.5 + Math.min(topScore, 8) * 0.045 + Math.min(margin, 5) * 0.045);

  return { type: topType, signals, confidence };
}

function classifySeverity(
  text: string,
  type: ThreatType,
): { severity: Severity; indicators: string[]; score: number } {
  // Category baseline: an IED report starts far above a checkpoint report.
  const baseline: Record<ThreatType, number> = {
    ied_explosive: 7.5,
    abduction: 7.5,
    armed_incident: 6.5,
    road_ambush: 6.5,
    inter_communal_conflict: 5.5,
    banditry: 5,
    // Sits just above the low/medium boundary: a protest that blocks a road is
    // a movement problem even when nobody is hurt.
    civil_unrest: 4.6,
    checkpoint_extortion: 3,
    crime: 2.5,
    other: 3,
  };

  let score = baseline[type];
  const indicators: string[] = [];

  for (const signal of SEVERITY_SIGNALS) {
    if (signal.pattern.test(text)) {
      score += signal.weight;
      indicators.push(signal.label);
    }
  }

  // A very short report is weak evidence; pull toward the middle.
  if (text.trim().length < 60) score -= 1;

  const severity: Severity =
    score >= 10 ? 'critical' : score >= 7.5 ? 'high' : score >= 4.5 ? 'medium' : 'low';

  return { severity, indicators, score };
}

/**
 * Drop matched terms that are contained in a longer match, so the officer sees
 * `Mentions "armed men"` rather than that plus a redundant `Mentions "armed"`.
 */
function dedupeTerms(terms: string[]): string[] {
  const kept: string[] = [];
  for (const term of terms) {
    if (kept.some((existing) => existing.includes(term) || term.includes(existing))) continue;
    kept.push(term);
  }
  return kept;
}

function buildSummary(text: string, type: ThreatType, severity: Severity): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  const firstSentence = clean.split(/(?<=[.!?])\s/)[0] ?? clean;
  const trimmed = firstSentence.length > 120 ? `${firstSentence.slice(0, 117)}...` : firstSentence;
  return `${THREAT_META[type].label} (${severity}) - ${trimmed}`;
}

function recommendedActions(type: ThreatType, severity: Severity): string[] {
  const actions: string[] = [];
  if (severity === 'critical' || severity === 'high') {
    actions.push('Suspend all non-essential movement through the affected area.');
    actions.push('Account for all staff currently deployed nearby.');
  } else {
    actions.push('Advise staff to avoid the immediate area until further notice.');
  }

  if (type === 'road_ambush' || type === 'ied_explosive') {
    actions.push('Flag the corridor in Safe Route and prefer an alternate axis.');
  }
  if (type === 'abduction') {
    actions.push('Escalate to the country security focal point immediately.');
  }
  if (type === 'civil_unrest') {
    actions.push('Confirm whether main access roads remain passable before any movement.');
  }
  if (type === 'checkpoint_extortion') {
    actions.push('Record the checkpoint location and brief drivers on the standing no-payment policy.');
  }
  actions.push('Confirm the report with a second source before wider dissemination.');
  return actions.slice(0, 4);
}

export type ClassifyInput = {
  description: string;
  reportedType: ThreatType | null;
  location: { lat: number; lng: number };
  occurredAt: string;
  /** Recent nearby reports, already narrowed by the geo+time pre-filter. */
  candidates: ThreatReport[];
};

/**
 * Duplicate detection, in the two stages the real function uses:
 * a cheap geo+time+lexical pre-filter, then a semantic comparison over the
 * shortlist. Only a strong, corroborated match is flagged.
 */
function detectDuplicate(input: ClassifyInput, type: ThreatType) {
  const occurred = Date.parse(input.occurredAt);
  const scored = input.candidates
    .map((candidate) => {
      const dist = distanceMeters(input.location, candidate.location);
      const minutesApart = Math.abs(occurred - Date.parse(candidate.occurredAt)) / 60_000;
      const lexical = textSimilarity(input.description, candidate.description);

      // Proximity and recency decay smoothly rather than cutting off hard - two
      // reports of the same ambush are rarely pinned to the same metre.
      const proximity = Math.exp(-dist / 2500);
      const recency = Math.exp(-minutesApart / 240);
      const typeMatch =
        candidate.threatType === type || candidate.aiSuggestions?.threatType === type ? 1 : 0.45;

      const score = (0.45 * lexical + 0.3 * proximity + 0.25 * recency) * typeMatch;
      return { reportId: candidate.id, distanceMeters: Math.round(dist), minutesApart: Math.round(minutesApart), score, lexical };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);

  const best = scored[0];
  const isDuplicate = Boolean(best && best.score >= 0.55 && best.distanceMeters <= 5000 && best.minutesApart <= 720);

  return {
    candidates: scored.map(({ reportId, distanceMeters: d, minutesApart, score }) => ({
      reportId,
      distanceMeters: d,
      minutesApart,
      score: Number(score.toFixed(3)),
    })),
    duplicateOf: isDuplicate ? best.reportId : null,
    confidence: best ? Number(best.score.toFixed(3)) : 0,
    rationale: best
      ? isDuplicate
        ? `Describes the same event as an existing report ${best.distanceMeters} m away, filed ${best.minutesApart} min apart, with ${(best.lexical * 100).toFixed(0)}% wording overlap.`
        : `Closest nearby report is ${best.distanceMeters} m away and ${best.minutesApart} min apart, but the accounts differ enough to be separate events.`
      : null,
  };
}

/** Simulated inference latency, so the UI is designed for a real wait. */
function simulatedLatency(textLength: number): number {
  return Math.round(700 + textLength * 1.6 + Math.random() * 900);
}

export async function classifyReport(input: ClassifyInput): Promise<AiSuggestion> {
  const started = Date.now();
  const latency = simulatedLatency(input.description.length);
  await new Promise((r) => setTimeout(r, latency));

  const text = input.description;
  const trimmed = text.trim();

  // Real models are asked to refuse rather than guess on thin input, and the
  // officer UI must handle that case.
  const needsMoreInfo = trimmed.length < 25 || tokenize(trimmed).length < 4;

  const { type, signals, confidence: typeConfidence } = classifyType(text, input.reportedType);
  const { severity, indicators } = classifySeverity(text, type);
  const duplicate = detectDuplicate(input, type);

  const confidence = needsMoreInfo ? Math.min(typeConfidence, 0.35) : typeConfidence;
  const priority = Math.min(
    10,
    Math.max(
      1,
      Math.round(SEVERITIES.indexOf(severity) * 2.4 + confidence * 2 + (duplicate.duplicateOf ? -1.5 : 0) + 1),
    ),
  );

  const keyIndicators = [
    ...dedupeTerms(
      signals
        .filter((s) => s.type === type)
        .sort((a, b) => b.weight - a.weight)
        .map((s) => s.term),
    )
      .slice(0, 3)
      .map((term) => `Mentions "${term}"`),
    ...indicators,
  ].slice(0, 5);

  const rationale = needsMoreInfo
    ? 'The report is too short to classify with confidence. An officer should contact the reporter for detail before acting on any suggestion below.'
    : `Classified as ${THREAT_META[type].label.toLowerCase()} from ${signals.filter((s) => s.type === type).length} matching indicator(s). Severity ${severity} reflects ${
        indicators.length ? indicators.join(', ') : 'the base risk profile for this category'
      }.`;

  return {
    model: MODEL_NAME,
    generatedAt: new Date(started).toISOString(),
    latencyMs: Date.now() - started,
    threatType: type,
    severity,
    priority,
    confidence: Number(confidence.toFixed(2)),
    alertRadiusMeters: THREAT_META[type].radiusBySeverity[severity],
    summary: buildSummary(text, type, severity),
    rationale,
    keyIndicators,
    possibleDuplicateOf: duplicate.duplicateOf,
    duplicateConfidence: duplicate.confidence,
    duplicateRationale: duplicate.rationale,
    duplicateCandidates: duplicate.candidates,
    recommendedActions: recommendedActions(type, severity),
    needsMoreInfo,
  };
}

/** Synchronous variant used by the seeder to backfill historical reports. */
export function classifyReportSync(input: ClassifyInput): AiSuggestion {
  const text = input.description;
  const trimmed = text.trim();
  const needsMoreInfo = trimmed.length < 25 || tokenize(trimmed).length < 4;
  const { type, signals, confidence: typeConfidence } = classifyType(text, input.reportedType);
  const { severity, indicators } = classifySeverity(text, type);
  const duplicate = detectDuplicate(input, type);
  const confidence = needsMoreInfo ? Math.min(typeConfidence, 0.35) : typeConfidence;

  return {
    model: MODEL_NAME,
    generatedAt: input.occurredAt,
    latencyMs: simulatedLatency(text.length),
    threatType: type,
    severity,
    priority: Math.min(10, Math.max(1, Math.round(SEVERITIES.indexOf(severity) * 2.4 + confidence * 2 + 1))),
    confidence: Number(confidence.toFixed(2)),
    alertRadiusMeters: THREAT_META[type].radiusBySeverity[severity],
    summary: buildSummary(text, type, severity),
    rationale: needsMoreInfo
      ? 'Report too short to classify with confidence.'
      : `Classified as ${THREAT_META[type].label.toLowerCase()} from matching indicators.`,
    keyIndicators: [
      ...dedupeTerms(
        signals
          .filter((s) => s.type === type)
          .sort((a, b) => b.weight - a.weight)
          .map((s) => s.term),
      )
        .slice(0, 3)
        .map((term) => `Mentions "${term}"`),
      ...indicators,
    ].slice(0, 5),
    possibleDuplicateOf: duplicate.duplicateOf,
    duplicateConfidence: duplicate.confidence,
    duplicateRationale: duplicate.rationale,
    duplicateCandidates: duplicate.candidates,
    recommendedActions: recommendedActions(type, severity),
    needsMoreInfo,
  };
}
