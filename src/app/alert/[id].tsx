import { useLocalSearchParams, useRouter } from 'expo-router';
import { useMemo } from 'react';
import { View } from 'react-native';

import { alertsApi } from '@/api/endpoints/alerts';
import { orgApi } from '@/api/endpoints/org';
import { SeverityBadge } from '@/components/domain/Badges';
import { ThreatMap } from '@/components/domain/ThreatMap';
import {
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
import { useNow } from '@/hooks/use-now';
import { formatRadius } from '@/lib/geo';
import { formatDateTime, pluralize, timeAgo, timeUntil } from '@/lib/format';
import { useAuth } from '@/state/auth';
import { useTheme } from '@/theme';

/** Full detail for a safety alert or standalone advisory. */
export default function AlertDetailScreen() {
  const { colors, spacing } = useTheme();
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { user } = useAuth();

  const now = useNow(60_000);

  const alerts = useQuery({
    key: 'alerts.list.all',
    fetcher: () => alertsApi.list({ includeExpired: true }),
    watch: ['alerts'],
  });

  const directory = useQuery({ key: 'org.directory', fetcher: () => orgApi.directory() });

  const alert = useMemo(() => (alerts.data ?? []).find((a) => a.id === id) ?? null, [alerts.data, id]);

  if (alerts.isLoading && !alerts.data) {
    return (
      <Screen>
        <Header title="Alert" onBack />
        <SkeletonCard lines={4} />
      </Screen>
    );
  }

  if (!alert) {
    return (
      <Screen>
        <Header title="Alert" onBack />
        <Banner
          tone="warning"
          title="Alert not found"
          message="It may have been withdrawn, or it belongs to another organisation."
        />
      </Screen>
    );
  }

  const expired = alert.expiresAt ? Date.parse(alert.expiresAt) < now : false;
  const cancelled = !!alert.cancelledAt;
  const issuer = directory.data?.[alert.issuedBy]?.name ?? 'Unknown';

  return (
    <Screen>
      <Header
        title={alert.kind === 'advisory' ? 'Advisory' : 'Threat alert'}
        subtitle={`Issued ${timeAgo(alert.createdAt)} by ${issuer}`}
        onBack
      />

      <View style={{ gap: spacing.xxl }}>
        <Card accent={colors[SEVERITY_META[alert.severity].colorKey]}>
          <View style={{ gap: spacing.md }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flexWrap: 'wrap' }}>
              <SeverityBadge severity={alert.severity} size="sm" />
              {alert.threatType ? <Badge label={THREAT_META[alert.threatType].label} size="sm" /> : null}
              {cancelled ? (
                <Badge label="Withdrawn" size="sm" color={colors.textTertiary} />
              ) : expired ? (
                <Badge label="Expired" size="sm" color={colors.textTertiary} />
              ) : (
                <Badge label="Active" size="sm" color={colors.success} background={colors.successMuted} dot />
              )}
            </View>

            <Text variant="title3">{alert.title}</Text>
            <Text variant="body" tone="secondary" style={{ lineHeight: 22 }}>
              {alert.message}
            </Text>

            <View style={{ height: 1, backgroundColor: colors.divider }} />

            <SeverityBadge severity={alert.severity} showGuidance />
          </View>
        </Card>

        {cancelled ? (
          <Banner
            tone="neutral"
            icon="x-circle"
            title="This advisory was withdrawn"
            message={`Withdrawn ${timeAgo(alert.cancelledAt!)}. It no longer applies.`}
          />
        ) : expired ? (
          <Banner
            tone="neutral"
            icon="clock"
            title="This alert has expired"
            message="It is kept for the record. Check the map for current threats in this area."
          />
        ) : null}

        {alert.location ? (
          <Section title="Area">
            <ThreatMap
              height={200}
              center={alert.location}
              zoomRadiusMeters={alert.radiusMeters ?? 8000}
              showRadii={!!alert.radiusMeters}
              threats={[
                {
                  id: alert.id,
                  point: alert.location,
                  severity: alert.severity,
                  threatType: alert.threatType ?? 'other',
                  label: alert.title,
                  radiusMeters: alert.radiusMeters,
                },
              ]}
            />
          </Section>
        ) : null}

        <Section title="Details">
          <Card>
            <View style={{ gap: 2 }}>
              <DetailRow label="Issued by" value={issuer} icon="user" />
              <DetailRow label="Issued at" value={formatDateTime(alert.createdAt)} icon="clock" />
              {alert.expiresAt ? (
                <DetailRow
                  label={expired ? 'Expired' : 'Expires'}
                  value={expired ? formatDateTime(alert.expiresAt) : timeUntil(alert.expiresAt)}
                  icon="calendar"
                />
              ) : null}
              {alert.radiusMeters ? (
                <DetailRow label="Alert radius" value={formatRadius(alert.radiusMeters)} icon="radio" />
              ) : null}
              {alert.regionIds.length ? (
                <DetailRow
                  label="Regions"
                  value={alert.regionIds.map((r) => REGIONS_BY_ID[r]?.name ?? r).join(', ')}
                  icon="map"
                  multiline
                />
              ) : null}
              {user!.profile.role !== 'worker' ? (
                <DetailRow label="Delivered to" value={pluralize(alert.recipientCount, 'person', 'people')} icon="users" />
              ) : null}
            </View>
          </Card>
        </Section>

        {alert.relatedReportId ? (
          <Button
            label="Open the underlying report"
            icon="file-text"
            variant="secondary"
            fullWidth
            onPress={() => router.push({ pathname: '/report/[id]', params: { id: alert.relatedReportId! } })}
          />
        ) : null}
      </View>
    </Screen>
  );
}
