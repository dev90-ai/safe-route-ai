import type {
  AiSuggestion,
  AuditEntry,
  Invite,
  NotificationRecord,
  Organization,
  Profile,
  SafetyAlert,
  SosEvent,
  ThreatReport,
} from '../types';
import type { LatLng } from '@/lib/geo';

/**
 * Row <-> app-object mapping.
 *
 * Postgres speaks snake_case and PostGIS geography; the app speaks camelCase
 * and `{ lat, lng }`. Keeping every conversion in this one file means the
 * screens never learn that the backend changed, and a column rename has exactly
 * one place to break.
 */

// --- Geography ---------------------------------------------------------------

/**
 * Read a coordinate from a row.
 *
 * Queries select the generated `lat`/`lng` columns rather than the geography
 * itself, because PostgREST serialises geography as WKB hex. This helper takes
 * the whole row so callers do not have to care which shape arrived.
 */
export function rowToLatLng(row: Row): LatLng | null {
  if (row == null) return null;
  if (typeof row.lat === 'number' && typeof row.lng === 'number') {
    return { lat: row.lat, lng: row.lng };
  }
  // Fall back to whatever geography column the row carries.
  return toLatLng(row.location ?? row.last_known_location ?? row.center ?? null);
}

/**
 * Parse a geography value in whichever form it arrives: GeoJSON, an app-shaped
 * object, or WKT. WKB hex is deliberately not decoded here - queries select the
 * generated lat/lng columns instead, which is cheaper and clearer.
 */
export function toLatLng(value: unknown): LatLng | null {
  if (!value) return null;

  // GeoJSON: { type: 'Point', coordinates: [lng, lat] }
  if (typeof value === 'object' && value !== null && 'coordinates' in value) {
    const coords = (value as { coordinates?: unknown }).coordinates;
    if (Array.isArray(coords) && coords.length >= 2) {
      return { lat: Number(coords[1]), lng: Number(coords[0]) };
    }
  }

  // Already in app shape (e.g. from an RPC returning lat/lng columns).
  if (typeof value === 'object' && value !== null && 'lat' in value && 'lng' in value) {
    const v = value as { lat: unknown; lng: unknown };
    return { lat: Number(v.lat), lng: Number(v.lng) };
  }

  if (typeof value === 'string') {
    // WKT: POINT(lng lat), optionally SRID-prefixed.
    const wkt = /^(?:SRID=\d+;)?POINT\s*\(\s*(-?[\d.]+)\s+(-?[\d.]+)\s*\)$/i.exec(value);
    if (wkt) return { lat: Number(wkt[2]), lng: Number(wkt[1]) };
    try {
      return toLatLng(JSON.parse(value));
    } catch {
      return null;
    }
  }

  return null;
}

/** App point -> the GeoJSON PostGIS accepts on insert. */
export function toGeoJSONPoint(point: LatLng): object {
  return { type: 'Point', coordinates: [point.lng, point.lat] };
}

export function toGeoJSONLine(path: LatLng[]): object {
  return { type: 'LineString', coordinates: path.map((p) => [p.lng, p.lat]) };
}

// --- Rows --------------------------------------------------------------------

type Row = Record<string, any>;

export function mapOrganization(row: Row): Organization {
  return {
    id: row.id,
    name: row.name,
    acronym: row.acronym,
    regions: row.regions ?? [],
    crossSharePartners: row.cross_share_partners ?? [],
    contactEmail: row.contact_email ?? '',
    createdAt: row.created_at,
    settings: {
      defaultAdvisoryHours: row.settings?.defaultAdvisoryHours ?? 24,
      dualControlForCritical: row.settings?.dualControlForCritical ?? false,
      anonymiseReportersToOfficers: row.settings?.anonymiseReportersToOfficers ?? false,
    },
  };
}

export function mapProfile(row: Row): Profile {
  return {
    id: row.id,
    email: row.email,
    phone: row.phone ?? null,
    fullName: row.full_name,
    role: row.role,
    organizationId: row.organization_id,
    jobTitle: row.job_title ?? null,
    operatingRegions: row.operating_regions ?? [],
    lastKnownLocation: rowToLatLng(row),
    lastSeenAt: row.last_seen_at ?? null,
    status: row.status,
    avatarColor: row.avatar_color ?? '#3B82F6',
    createdAt: row.created_at,
    onboardedAt: row.onboarded_at ?? null,
    notificationPreferences: {
      push: row.notification_preferences?.push ?? true,
      criticalOnly: row.notification_preferences?.criticalOnly ?? false,
      quietHours: {
        enabled: row.notification_preferences?.quietHours?.enabled ?? false,
        startHour: row.notification_preferences?.quietHours?.startHour ?? 22,
        endHour: row.notification_preferences?.quietHours?.endHour ?? 6,
      },
    },
  };
}

export function mapAiSuggestion(value: Row | null): AiSuggestion | null {
  if (!value) return null;
  return {
    model: value.model ?? 'unknown',
    generatedAt: value.generatedAt ?? new Date().toISOString(),
    latencyMs: value.latencyMs ?? 0,
    threatType: value.threatType ?? 'other',
    severity: value.severity ?? 'low',
    priority: value.priority ?? 5,
    confidence: value.confidence ?? 0,
    alertRadiusMeters: value.alertRadiusMeters ?? 5000,
    summary: value.summary ?? '',
    rationale: value.rationale ?? '',
    keyIndicators: value.keyIndicators ?? [],
    possibleDuplicateOf: value.possibleDuplicateOf ?? null,
    duplicateConfidence: value.duplicateConfidence ?? 0,
    duplicateRationale: value.duplicateRationale ?? null,
    duplicateCandidates: value.duplicateCandidates ?? [],
    recommendedActions: value.recommendedActions ?? [],
    needsMoreInfo: value.needsMoreInfo ?? false,
  };
}

export function mapReport(row: Row): ThreatReport {
  return {
    id: row.id,
    reference: row.reference,
    // The worker-facing view nulls this out; the app treats null as anonymous.
    reporterId: row.reporter_id ?? 'anonymous',
    organizationId: row.organization_id,
    description: row.description,
    photoUrl: row.photo_url ?? null,
    location: rowToLatLng(row) ?? { lat: 0, lng: 0 },
    locationAccuracyMeters: row.location_accuracy_meters ?? null,
    locationSource: row.location_source ?? 'gps',
    regionId: row.region_id ?? null,
    placeLabel: row.place_label ?? null,
    reportedType: row.reported_type ?? null,
    threatType: row.threat_type ?? null,
    severity: row.severity ?? null,
    priority: row.priority ?? null,
    alertRadiusMeters: row.alert_radius_meters ?? null,
    status: row.status,
    possibleDuplicateOf: row.possible_duplicate_of ?? null,
    aiSuggestions: mapAiSuggestion(row.ai_suggestions ?? null),
    aiStatus: row.ai_status ?? 'queued',
    verifiedBy: row.verified_by ?? null,
    verifiedAt: row.verified_at ?? null,
    dismissedReason: row.dismissed_reason ?? null,
    occurredAt: row.occurred_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at ?? row.created_at,
  };
}

export function mapAlert(row: Row): SafetyAlert {
  return {
    id: row.id,
    issuedBy: row.issued_by,
    organizationId: row.organization_id,
    relatedReportId: row.related_report_id ?? null,
    title: row.title,
    message: row.message,
    severity: row.severity,
    threatType: row.threat_type ?? null,
    location: rowToLatLng(row),
    radiusMeters: row.radius_meters ?? null,
    regionIds: row.region_ids ?? [],
    kind: row.kind,
    createdAt: row.created_at,
    expiresAt: row.expires_at ?? null,
    cancelledAt: row.cancelled_at ?? null,
    recipientCount: row.recipient_count ?? 0,
  };
}

export function mapNotification(row: Row): NotificationRecord {
  return {
    id: row.id,
    profileId: row.profile_id,
    alertId: row.alert_id,
    reportId: row.report_id ?? null,
    title: row.title,
    body: row.body,
    severity: row.severity,
    matchReasons: row.match_reasons ?? [],
    distanceMeters: row.distance_meters ?? null,
    deliveredAt: row.delivered_at,
    readAt: row.read_at ?? null,
  };
}

export function mapSosEvent(row: Row): SosEvent {
  return {
    id: row.id,
    workerId: row.worker_id,
    organizationId: row.organization_id,
    status: row.status,
    reason: row.reason ?? null,
    location: rowToLatLng(row) ?? { lat: 0, lng: 0 },
    accuracyMeters: row.accuracy_meters ?? null,
    track: (row.track ?? []).map((t: Row) => ({
      point: { lat: t.point?.lat ?? 0, lng: t.point?.lng ?? 0 },
      ts: t.ts,
      accuracyMeters: t.accuracyMeters ?? null,
    })),
    createdAt: row.created_at,
    acknowledgedBy: row.acknowledged_by ?? null,
    acknowledgedAt: row.acknowledged_at ?? null,
    resolvedBy: row.resolved_by ?? null,
    resolvedAt: row.resolved_at ?? null,
    resolutionNote: row.resolution_note ?? null,
    timeline: (row.timeline ?? []).map((t: Row) => ({
      id: t.id,
      ts: t.ts,
      actorId: t.actorId ?? null,
      kind: t.kind,
      text: t.text,
    })),
  };
}

export function mapInvite(row: Row): Invite {
  return {
    id: row.id,
    email: row.email,
    fullName: row.full_name,
    role: row.role,
    organizationId: row.organization_id,
    invitedBy: row.invited_by ?? '',
    createdAt: row.created_at,
    acceptedAt: row.accepted_at ?? null,
    expiresAt: row.expires_at,
    code: row.code,
    operatingRegions: row.operating_regions ?? [],
  };
}

export function mapAudit(row: Row): AuditEntry {
  return {
    id: row.id,
    ts: row.ts,
    actorId: row.actor_id ?? null,
    actorRole: row.actor_role,
    organizationId: row.organization_id ?? '',
    action: row.action,
    entity: row.entity,
    entityId: row.entity_id ?? '',
    summary: row.summary,
    before: row.before ?? undefined,
    after: row.after ?? undefined,
  };
}
