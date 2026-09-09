import type { LatLng } from '@/lib/geo';
import type { ReportStatus, Role, Severity, ThreatType } from '@/constants/threats';

// Re-exported so consumers of the API layer never need to reach into the
// constants module for the enums that appear on these rows.
export type { ReportStatus, Role, Severity, ThreatType, LatLng };

/**
 * These types are the contract between the app and the backend. They map 1:1
 * onto the Supabase tables described in the data model, so swapping the mock
 * client for a real supabase-js client is a change of transport, not of shape.
 */

export type Organization = {
  id: string;
  name: string;
  acronym: string;
  regions: string[];
  crossSharePartners: string[];
  contactEmail: string;
  createdAt: string;
  settings: {
    /** Auto-expire standalone advisories after this many hours by default. */
    defaultAdvisoryHours: number;
    /** Require two officers to verify Critical reports. */
    dualControlForCritical: boolean;
    /** Hide reporter identity even from officers (extra-sensitive contexts). */
    anonymiseReportersToOfficers: boolean;
  };
};

export type Profile = {
  id: string;
  email: string;
  phone: string | null;
  fullName: string;
  role: Role;
  organizationId: string;
  jobTitle: string | null;
  operatingRegions: string[];
  lastKnownLocation: LatLng | null;
  lastSeenAt: string | null;
  status: 'active' | 'invited' | 'deactivated';
  avatarColor: string;
  createdAt: string;
  /** Onboarding is complete once a worker has declared at least one region. */
  onboardedAt: string | null;
  notificationPreferences: {
    push: boolean;
    criticalOnly: boolean;
    quietHours: { enabled: boolean; startHour: number; endHour: number };
  };
};

/** Raw model output, stored verbatim for audit. Never overwritten by a human. */
export type AiSuggestion = {
  model: string;
  generatedAt: string;
  latencyMs: number;
  threatType: ThreatType;
  severity: Severity;
  priority: number;
  confidence: number;
  alertRadiusMeters: number;
  summary: string;
  rationale: string;
  keyIndicators: string[];
  possibleDuplicateOf: string | null;
  duplicateConfidence: number;
  duplicateRationale: string | null;
  /** Candidates the geo+time pre-filter handed to the model. */
  duplicateCandidates: { reportId: string; distanceMeters: number; minutesApart: number; score: number }[];
  recommendedActions: string[];
  /** Set when the model declines to classify (e.g. text too thin). */
  needsMoreInfo: boolean;
};

export type ThreatReport = {
  id: string;
  reference: string;
  reporterId: string;
  organizationId: string;
  description: string;
  photoUrl: string | null;
  location: LatLng;
  locationAccuracyMeters: number | null;
  locationSource: 'gps' | 'manual-pin';
  regionId: string | null;
  placeLabel: string | null;
  /** Worker's optional pre-selection. The AI still classifies independently. */
  reportedType: ThreatType | null;
  /** Officer-confirmed fields. Null until a human signs off. */
  threatType: ThreatType | null;
  severity: Severity | null;
  priority: number | null;
  alertRadiusMeters: number | null;
  status: ReportStatus;
  possibleDuplicateOf: string | null;
  aiSuggestions: AiSuggestion | null;
  aiStatus: 'queued' | 'processing' | 'complete' | 'failed';
  verifiedBy: string | null;
  verifiedAt: string | null;
  dismissedReason: string | null;
  occurredAt: string;
  createdAt: string;
  updatedAt: string;
  /** Client-side only: set on reports still sitting in the offline queue. */
  pendingSync?: boolean;
};

export type SafetyAlert = {
  id: string;
  issuedBy: string;
  organizationId: string;
  relatedReportId: string | null;
  title: string;
  message: string;
  severity: Severity;
  threatType: ThreatType | null;
  location: LatLng | null;
  radiusMeters: number | null;
  regionIds: string[];
  kind: 'threat' | 'advisory';
  createdAt: string;
  expiresAt: string | null;
  cancelledAt: string | null;
  /** How many profiles the fan-out resolved to. Shown to officers/admins. */
  recipientCount: number;
};

export type NotificationRecord = {
  id: string;
  profileId: string;
  alertId: string;
  reportId: string | null;
  title: string;
  body: string;
  severity: Severity;
  /** Why this person was in the fan-out - shown verbatim in the feed. */
  matchReasons: MatchReason[];
  distanceMeters: number | null;
  deliveredAt: string;
  readAt: string | null;
};

export type MatchReason =
  | 'same-organization'
  | 'partner-organization'
  | 'within-alert-radius'
  | 'operating-region'
  | 'direct-advisory';

export type SosEvent = {
  id: string;
  workerId: string;
  organizationId: string;
  status: 'active' | 'acknowledged' | 'resolved' | 'cancelled';
  reason: string | null;
  location: LatLng;
  accuracyMeters: number | null;
  track: { point: LatLng; ts: string; accuracyMeters: number | null }[];
  createdAt: string;
  acknowledgedBy: string | null;
  acknowledgedAt: string | null;
  resolvedBy: string | null;
  resolvedAt: string | null;
  resolutionNote: string | null;
  timeline: SosTimelineEntry[];
  pendingSync?: boolean;
};

export type SosTimelineEntry = {
  id: string;
  ts: string;
  actorId: string | null;
  kind: 'triggered' | 'location' | 'acknowledged' | 'note' | 'resolved' | 'cancelled' | 'queued-offline' | 'synced';
  text: string;
};

/** Append-only. Every state transition that matters for accountability. */
export type AuditEntry = {
  id: string;
  ts: string;
  actorId: string | null;
  actorRole: Role | 'system';
  organizationId: string;
  action: string;
  entity: 'report' | 'alert' | 'sos' | 'profile' | 'organization' | 'auth' | 'session';
  entityId: string;
  summary: string;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
};

export type Session = {
  token: string;
  refreshToken: string;
  profileId: string;
  issuedAt: string;
  expiresAt: string;
  deviceLabel: string;
};

export type AuthUser = {
  profile: Profile;
  organization: Organization;
};

export type Invite = {
  id: string;
  email: string;
  fullName: string;
  role: Role;
  organizationId: string;
  invitedBy: string;
  createdAt: string;
  acceptedAt: string | null;
  expiresAt: string;
  code: string;
  operatingRegions: string[];
};

export type RouteCandidate = {
  id: string;
  label: string;
  summary: string;
  path: LatLng[];
  distanceMeters: number;
  durationMinutes: number;
  corridorId: string | null;
  /** Verified threats within the analysis buffer of this line. */
  threats: RouteThreat[];
  incidentCount: number;
  highestSeverity: Severity | null;
  riskScore: number;
  riskBand: 'low' | 'moderate' | 'elevated' | 'high' | 'severe';
  advisory: string;
};

export type RouteThreat = {
  reportId: string;
  reference: string;
  threatType: ThreatType;
  severity: Severity;
  /** Already redacted for workers, so it is safe to plot. */
  location: LatLng;
  distanceFromRouteMeters: number;
  occurredAt: string;
  summary: string;
};

export type Analytics = {
  generatedAt: string;
  windowHours: number;
  totals: {
    reports: number;
    verified: number;
    dismissed: number;
    pending: number;
    alerts: number;
    sosEvents: number;
    activeWorkers: number;
    duplicatesCaught: number;
  };
  medianVerificationMs: number;
  p90VerificationMs: number;
  medianSosAckMs: number;
  aiAgreementRate: number;
  reportsByDay: { date: string; total: number; verified: number; dismissed: number }[];
  bySeverity: { severity: Severity; count: number }[];
  byType: { type: ThreatType; count: number }[];
  byRegion: { regionId: string; count: number; highestSeverity: Severity | null }[];
  officerLeaderboard: { profileId: string; name: string; verified: number; medianMs: number }[];
};

export type Paginated<T> = {
  items: T[];
  total: number;
  cursor: string | null;
  hasMore: boolean;
};
