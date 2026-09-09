import type { Colors } from '@/theme/tokens';

export const THREAT_TYPES = [
  'armed_incident',
  'banditry',
  'road_ambush',
  'ied_explosive',
  'abduction',
  'civil_unrest',
  'checkpoint_extortion',
  'inter_communal_conflict',
  'crime',
  'other',
] as const;

export type ThreatType = (typeof THREAT_TYPES)[number];

export const SEVERITIES = ['low', 'medium', 'high', 'critical'] as const;
export type Severity = (typeof SEVERITIES)[number];

export const REPORT_STATUSES = ['pending', 'verified', 'dismissed'] as const;
export type ReportStatus = (typeof REPORT_STATUSES)[number];

export const ROLES = ['worker', 'officer', 'admin'] as const;
export type Role = (typeof ROLES)[number];

type ThreatMeta = {
  label: string;
  short: string;
  icon: string;
  description: string;
  /** Default alert radius in metres per severity - the AI's starting suggestion. */
  radiusBySeverity: Record<Severity, number>;
};

export const THREAT_META: Record<ThreatType, ThreatMeta> = {
  armed_incident: {
    label: 'Armed incident',
    short: 'Armed',
    icon: 'alert-octagon',
    description: 'Shooting, armed attack, or exchange of fire involving armed actors.',
    radiusBySeverity: { low: 3000, medium: 6000, high: 12_000, critical: 20_000 },
  },
  banditry: {
    label: 'Banditry',
    short: 'Banditry',
    icon: 'crosshair',
    description: 'Armed robbery, livestock raiding, or opportunistic attacks on travellers.',
    radiusBySeverity: { low: 2500, medium: 5000, high: 9000, critical: 15_000 },
  },
  road_ambush: {
    label: 'Road ambush',
    short: 'Ambush',
    icon: 'road',
    description: 'Vehicles stopped or attacked on a route. Highest routing relevance.',
    radiusBySeverity: { low: 4000, medium: 8000, high: 15_000, critical: 25_000 },
  },
  ied_explosive: {
    label: 'IED / explosive',
    short: 'IED',
    icon: 'bomb',
    description: 'Improvised explosive device, unexploded ordnance, or detonation.',
    radiusBySeverity: { low: 5000, medium: 10_000, high: 18_000, critical: 30_000 },
  },
  abduction: {
    label: 'Abduction / kidnapping',
    short: 'Abduction',
    icon: 'user-x',
    description: 'Person taken or held against their will, including aid worker abduction.',
    radiusBySeverity: { low: 5000, medium: 10_000, high: 20_000, critical: 35_000 },
  },
  civil_unrest: {
    label: 'Civil unrest',
    short: 'Unrest',
    icon: 'users',
    description: 'Protest, riot, or crowd action that may turn violent or block movement.',
    radiusBySeverity: { low: 1500, medium: 3000, high: 6000, critical: 10_000 },
  },
  checkpoint_extortion: {
    label: 'Checkpoint / extortion',
    short: 'Checkpoint',
    icon: 'shield-off',
    description: 'Illegal roadblock, demand for payment, or harassment at a control point.',
    radiusBySeverity: { low: 1500, medium: 3000, high: 5000, critical: 8000 },
  },
  inter_communal_conflict: {
    label: 'Inter-communal conflict',
    short: 'Communal',
    icon: 'flame',
    description: 'Clashes between communities, often over water, pasture, or boundaries.',
    radiusBySeverity: { low: 4000, medium: 8000, high: 15_000, critical: 25_000 },
  },
  crime: {
    label: 'Crime',
    short: 'Crime',
    icon: 'briefcase',
    description: 'Theft, burglary, or assault without an armed-group dimension.',
    radiusBySeverity: { low: 1000, medium: 2000, high: 4000, critical: 7000 },
  },
  other: {
    label: 'Other',
    short: 'Other',
    icon: 'help-circle',
    description: 'Anything that does not fit the categories above.',
    radiusBySeverity: { low: 2000, medium: 4000, high: 8000, critical: 12_000 },
  },
};

export const SEVERITY_META: Record<
  Severity,
  { label: string; rank: number; guidance: string; colorKey: keyof Colors; mutedKey: keyof Colors }
> = {
  low: {
    label: 'Low',
    rank: 1,
    guidance: 'Stay aware. No movement restriction required.',
    colorKey: 'sevLow',
    mutedKey: 'sevLowMuted',
  },
  medium: {
    label: 'Medium',
    rank: 2,
    guidance: 'Avoid the immediate area. Confirm before non-essential movement.',
    colorKey: 'sevMedium',
    mutedKey: 'sevMediumMuted',
  },
  high: {
    label: 'High',
    rank: 3,
    guidance: 'Suspend movement through the area. Essential travel only, with clearance.',
    colorKey: 'sevHigh',
    mutedKey: 'sevHighMuted',
  },
  critical: {
    label: 'Critical',
    rank: 4,
    guidance: 'Do not move. Shelter in place and contact your security officer now.',
    colorKey: 'sevCritical',
    mutedKey: 'sevCriticalMuted',
  },
};

export const severityRank = (s: Severity) => SEVERITY_META[s].rank;

export function highestSeverity(list: Severity[]): Severity | null {
  if (!list.length) return null;
  return list.reduce((a, b) => (severityRank(b) > severityRank(a) ? b : a));
}

export const ROLE_META: Record<Role, { label: string; description: string; colorKey: keyof Colors }> = {
  worker: {
    label: 'Humanitarian worker',
    description: 'Reports threats, receives alerts, plans safer routes, triggers SOS.',
    colorKey: 'roleWorker',
  },
  officer: {
    label: 'Security officer',
    description: 'Verifies reports, sets alert radius, issues advisories, responds to SOS.',
    colorKey: 'roleOfficer',
  },
  admin: {
    label: 'Organisation admin',
    description: 'Manages people, partnerships, and org-wide analytics.',
    colorKey: 'roleAdmin',
  },
};

export const STATUS_META: Record<
  ReportStatus,
  { label: string; colorKey: keyof Colors; mutedKey: keyof Colors }
> = {
  pending: { label: 'Awaiting verification', colorKey: 'warning', mutedKey: 'warningMuted' },
  verified: { label: 'Verified', colorKey: 'success', mutedKey: 'successMuted' },
  dismissed: { label: 'Dismissed', colorKey: 'textTertiary', mutedKey: 'surfaceSunken' },
};

/** Time windows offered on the map and analytics filters. */
export const TIME_WINDOWS = [
  { id: '24h', label: '24 h', hours: 24 },
  { id: '7d', label: '7 days', hours: 24 * 7 },
  { id: '14d', label: '14 days', hours: 24 * 14 },
  { id: '30d', label: '30 days', hours: 24 * 30 },
  { id: '90d', label: '90 days', hours: 24 * 90 },
] as const;

export type TimeWindowId = (typeof TIME_WINDOWS)[number]['id'];
