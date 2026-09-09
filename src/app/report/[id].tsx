import Feather from '@expo/vector-icons/Feather';
import { Image } from 'expo-image';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { Pressable, View } from 'react-native';

import { orgApi } from '@/api/endpoints/org';
import { effectiveSeverity, effectiveType, reportsApi } from '@/api/endpoints/reports';
import type { AuditEntry } from '@/api/types';
import { AiPanel } from '@/components/domain/AiPanel';
import { SeverityBadge, StatusBadge } from '@/components/domain/Badges';
import { ThreatMap } from '@/components/domain/ThreatMap';
import {
  ActionBar,
  Avatar,
  Badge,
  Banner,
  Button,
  Card,
  DetailRow,
  Header,
  Screen,
  Section,
  SkeletonCard,
  Text,
} from '@/components/ui';
import { REGIONS_BY_ID } from '@/constants/regions';
import { SEVERITY_META, THREAT_META } from '@/constants/threats';
import { useQuery } from '@/hooks/use-query';
import { formatDateTime, formatDuration, timeAgo } from '@/lib/format';
import { formatDistance, formatRadius } from '@/lib/geo';
import { useAuth } from '@/state/auth';
import { useTheme } from '@/theme';
import { VerifySheet } from '@/components/domain/VerifySheet';

/**
 * Report detail.
 *
 * One screen, three audiences. A worker sees the threat and what to do about
 * it. An officer additionally sees the reporter, the AI's reasoning, and the
 * verification controls. An admin sees everything but can act on none of it -
 * the separation of duties is enforced by the API, and reflected here by simply
 * not rendering controls they cannot use.
 */
export default function ReportDetailScreen() {
  const { colors, spacing } = useTheme();
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { user } = useAuth();

  const [verifyOpen, setVerifyOpen] = useState(false);

  const role = user!.profile.role;
  const isOfficer = role === 'officer';

  const report = useQuery({
    key: id ? `report.${id}` : null,
    fetcher: () => reportsApi.get(id!),
    watch: ['reports'],
  });

  const history = useQuery({
    key: id ? `report.history.${id}` : null,
    fetcher: () => reportsApi.history(id!),
    watch: ['audit'],
  });

  const directory = useQuery({
    key: 'org.directory',
    fetcher: () => orgApi.directory(),
  });

  const data = report.data;

  // Poll while the classifier is still working so the panel fills in live.
  useEffect(() => {
    if (!data || data.aiStatus === 'complete' || data.aiStatus === 'failed') return;
    const timer = setInterval(() => void report.refetch({ silent: true }), 1500);
    return () => clearInterval(timer);
  }, [data?.aiStatus, report, data]);

  const duplicateOf = useQuery({
    key: data?.possibleDuplicateOf ? `report.${data.possibleDuplicateOf}` : null,
    fetcher: () => reportsApi.get(data!.possibleDuplicateOf!),
  });

  const reporterName = useMemo(() => {
    if (!data) return '';
    if (data.reporterId === 'anonymous') return 'Anonymous reporter';
    return directory.data?.[data.reporterId]?.name ?? 'Unknown';
  }, [data, directory.data]);

  const verifierName = data?.verifiedBy ? directory.data?.[data.verifiedBy]?.name ?? 'Unknown officer' : null;

  if (report.isLoading && !data) {
    return (
      <Screen>
        <Header title="Report" onBack />
        <SkeletonCard lines={4} />
      </Screen>
    );
  }

  if (report.error || !data) {
    return (
      <Screen>
        <Header title="Report" onBack />
        <Banner
          tone="danger"
          title="Could not load this report"
          message={report.error?.userMessage ?? 'It may have been removed, or it belongs to another organisation.'}
          action={{ label: 'Try again', onPress: () => void report.refetch() }}
        />
      </Screen>
    );
  }

  const severity = effectiveSeverity(data);
  const type = effectiveType(data);
  const isPending = data.status === 'pending';
  const canVerify = isOfficer && isPending;
  const verificationMs =
    data.verifiedAt ? Date.parse(data.verifiedAt) - Date.parse(data.createdAt) : null;

  return (
    <>
      <Screen extraBottomPadding={canVerify ? 40 : 0}>
        <Header
          title={THREAT_META[type].label}
          subtitle={`${data.reference} · ${timeAgo(data.occurredAt)}`}
          onBack
          right={<StatusBadge status={data.status} />}
        />

        <View style={{ gap: spacing.xxl }}>
          {/* Severity and standing guidance */}
          {severity ? (
            <Card accent={colors[SEVERITY_META[severity].colorKey]}>
              <View style={{ gap: spacing.md }}>
                <SeverityBadge severity={severity} showGuidance />
                {isPending ? (
                  <Banner
                    tone="warning"
                    compact
                    icon="clock"
                    message="This severity is the AI's suggestion. No alert has been sent - an officer has not verified it yet."
                  />
                ) : null}
              </View>
            </Card>
          ) : null}

          {/* The report itself */}
          <Section title="Report">
            <Card>
              <View style={{ gap: spacing.md }}>
                <Text variant="body" style={{ lineHeight: 22 }}>
                  {data.description}
                </Text>

                {data.photoUrl && !data.photoUrl.startsWith('photo://') ? (
                  <Image
                    source={{ uri: data.photoUrl }}
                    style={{ width: '100%', height: 200, borderRadius: 12, backgroundColor: colors.surfaceSunken }}
                    contentFit="cover"
                    accessibilityLabel="Photo attached to the report"
                  />
                ) : data.photoUrl ? (
                  <View
                    style={{
                      height: 90,
                      borderRadius: 12,
                      backgroundColor: colors.surfaceSunken,
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: 6,
                    }}
                  >
                    <Feather name="image" size={18} color={colors.textTertiary} />
                    <Text variant="caption" tone="tertiary">
                      Photo attached (not available in this demo dataset)
                    </Text>
                  </View>
                ) : null}

                <View style={{ height: 1, backgroundColor: colors.divider }} />

                <DetailRow label="Occurred" value={formatDateTime(data.occurredAt)} icon="clock" />
                <DetailRow label="Filed" value={formatDateTime(data.createdAt)} icon="upload" />
                <DetailRow
                  label="Location"
                  value={`${data.location.lat.toFixed(4)}, ${data.location.lng.toFixed(4)}`}
                  icon="map-pin"
                />
                <DetailRow
                  label="Position source"
                  value={data.locationSource === 'gps' ? `GPS${data.locationAccuracyMeters ? ` (±${Math.round(data.locationAccuracyMeters)} m)` : ''}` : 'Manual pin'}
                  icon={data.locationSource === 'gps' ? 'crosshair' : 'map-pin'}
                  tone={data.locationSource === 'manual-pin' ? colors.warning : undefined}
                />
                {data.regionId ? (
                  <DetailRow label="Region" value={REGIONS_BY_ID[data.regionId]?.name ?? data.regionId} icon="map" />
                ) : null}
                {data.reportedType ? (
                  <DetailRow label="Reporter's category" value={THREAT_META[data.reportedType].label} icon="tag" />
                ) : null}
              </View>
            </Card>
          </Section>

          {/* Map */}
          <ThreatMap
            height={200}
            center={data.location}
            zoomRadiusMeters={data.alertRadiusMeters ?? 6000}
            showRadii={!!data.alertRadiusMeters}
            threats={[
              {
                id: data.id,
                point: data.location,
                severity: severity ?? 'low',
                threatType: type,
                label: data.reference,
                radiusMeters: data.alertRadiusMeters,
              },
            ]}
          />

          {/* Reporter - officers and admins only */}
          {role !== 'worker' || data.reporterId === user!.profile.id ? (
            <Section title="Reporter">
              <Card>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.md }}>
                  <Avatar
                    name={reporterName}
                    color={directory.data?.[data.reporterId]?.color}
                    size={40}
                  />
                  <View style={{ flex: 1, gap: 2 }}>
                    <Text variant="bodyStrong">
                      {data.reporterId === user!.profile.id ? 'You' : reporterName}
                    </Text>
                    <Text variant="caption" tone="tertiary">
                      {data.reporterId === 'anonymous'
                        ? 'Identity withheld by organisation policy'
                        : 'Visible to officers and admins only'}
                    </Text>
                  </View>
                </View>
              </Card>
            </Section>
          ) : (
            <Banner
              tone="neutral"
              icon="eye-off"
              title="Reporter identity is hidden"
              message="Workers never see who filed a report. The pin is also offset slightly. This protects reporters from retaliation."
            />
          )}

          {/* AI panel - officers see the reasoning, workers see the outcome */}
          {isOfficer || role === 'admin' ? (
            <Section title="Automated analysis">
              <AiPanel
                suggestion={data.aiSuggestions}
                status={data.aiStatus}
                onRetry={isOfficer ? () => void reportsApi.retryClassification(data.id).then(() => report.refetch()) : undefined}
              />
            </Section>
          ) : null}

          {/* Duplicate link */}
          {data.possibleDuplicateOf && duplicateOf.data ? (
            <Section title="Possible duplicate">
              <Pressable
                onPress={() => router.push({ pathname: '/report/[id]', params: { id: duplicateOf.data!.id } })}
                accessibilityRole="button"
              >
                <Card accent={colors.warning}>
                  <View style={{ gap: spacing.sm }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
                      <Badge label={duplicateOf.data.reference} icon="copy" size="sm" />
                      <StatusBadge status={duplicateOf.data.status} size="sm" />
                    </View>
                    <Text variant="footnote" numberOfLines={3}>
                      {duplicateOf.data.description}
                    </Text>
                    <Text variant="caption" tone="tertiary">
                      {formatDistance(0)} · {timeAgo(duplicateOf.data.occurredAt)} · tap to compare
                    </Text>
                  </View>
                </Card>
              </Pressable>
            </Section>
          ) : null}

          {/* Verification outcome */}
          {data.status !== 'pending' ? (
            <Section title="Verification">
              <Card>
                <View style={{ gap: spacing.sm }}>
                  <DetailRow
                    label="Decision"
                    value={data.status === 'verified' ? 'Verified' : 'Dismissed'}
                    icon={data.status === 'verified' ? 'check-circle' : 'x-circle'}
                    tone={data.status === 'verified' ? colors.success : colors.textTertiary}
                  />
                  {verifierName ? <DetailRow label="By" value={verifierName} icon="user-check" /> : null}
                  {data.verifiedAt ? <DetailRow label="At" value={formatDateTime(data.verifiedAt)} icon="clock" /> : null}
                  {verificationMs !== null ? (
                    <DetailRow label="Time to verify" value={formatDuration(verificationMs)} icon="activity" />
                  ) : null}
                  {data.alertRadiusMeters ? (
                    <DetailRow label="Alert radius" value={formatRadius(data.alertRadiusMeters)} icon="radio" />
                  ) : null}
                  {data.priority ? <DetailRow label="Priority" value={`${data.priority}/10`} icon="trending-up" /> : null}
                  {data.dismissedReason ? (
                    <DetailRow label="Reason" value={data.dismissedReason} icon="message-square" multiline />
                  ) : null}
                </View>
              </Card>
            </Section>
          ) : null}

          {/* Audit trail */}
          {role !== 'worker' && history.data?.length ? (
            <Section title="Audit trail" subtitle="Every state change, with who made it.">
              <Card>
                <View style={{ gap: spacing.lg }}>
                  {history.data.map((entry: AuditEntry, index: number) => (
                    <View key={entry.id} style={{ flexDirection: 'row', gap: spacing.md }}>
                      <View style={{ alignItems: 'center', width: 20 }}>
                        <View
                          style={{
                            width: 8,
                            height: 8,
                            borderRadius: 4,
                            backgroundColor: entry.actorRole === 'system' ? colors.textTertiary : colors.accent,
                            marginTop: 5,
                          }}
                        />
                        {index < history.data!.length - 1 ? (
                          <View style={{ flex: 1, width: 1, backgroundColor: colors.divider, marginTop: 3 }} />
                        ) : null}
                      </View>
                      <View style={{ flex: 1, gap: 3, paddingBottom: spacing.sm }}>
                        <Text variant="footnote">{entry.summary}</Text>
                        <Text variant="caption" tone="tertiary">
                          {formatDateTime(entry.ts)} · {entry.actorRole}
                        </Text>
                      </View>
                    </View>
                  ))}
                </View>
              </Card>
            </Section>
          ) : null}

          {role === 'admin' && isPending ? (
            <Banner
              tone="neutral"
              icon="lock"
              title="Admins do not verify reports"
              message="Verification is restricted to security officers so the chain of accountability stays clean and auditable. You can see everything here, but the decision belongs to an officer."
            />
          ) : null}
        </View>
      </Screen>

      {canVerify ? (
        <ActionBar>
          <Button label="Review and verify" size="lg" fullWidth icon="check-circle" onPress={() => setVerifyOpen(true)} />
          <Text variant="caption" tone="tertiary" align="center">
            No alert is sent until you confirm.
          </Text>
        </ActionBar>
      ) : null}

      {canVerify ? (
        <VerifySheet
          // Remount per report and per opening, so the form always starts from
          // the AI's current suggestion rather than a previous session's edits.
          key={`${data.id}:${verifyOpen}`}
          visible={verifyOpen}
          report={data}
          onClose={() => setVerifyOpen(false)}
          onDone={async () => {
            setVerifyOpen(false);
            await report.refetch();
            await history.refetch();
          }}
        />
      ) : null}
    </>
  );
}
