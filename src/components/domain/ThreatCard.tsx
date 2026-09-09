import Feather from '@expo/vector-icons/Feather';
import { View } from 'react-native';

import { effectiveSeverity, effectiveType, regionLabel } from '@/api/endpoints/reports';
import type { ThreatReport } from '@/api/types';
import { SEVERITY_META, THREAT_META } from '@/constants/threats';
import { formatDistance, formatRadius } from '@/lib/geo';
import { timeAgo, truncate } from '@/lib/format';
import { useTheme } from '@/theme';
import { Badge } from '../ui/Display';
import { Card } from '../ui/Surface';
import { Text } from '../ui/Text';
import { ConfidenceBadge, SeverityBadge, StatusBadge } from './Badges';

/**
 * The report card, used in every list in the app.
 *
 * Deliberately shows the AI's suggestion and the officer's decision as visually
 * distinct things. A pending report displays "AI suggests"; a verified one
 * displays the confirmed values. Blurring those two would defeat the entire
 * point of the human verification step.
 */
export function ThreatCard({
  report,
  onPress,
  distanceMeters,
  showStatus = true,
  showAiSuggestion = true,
  compact = false,
  queued = false,
}: {
  report: ThreatReport;
  onPress?: () => void;
  distanceMeters?: number;
  showStatus?: boolean;
  showAiSuggestion?: boolean;
  compact?: boolean;
  queued?: boolean;
}) {
  const { colors, spacing } = useTheme();

  const severity = effectiveSeverity(report);
  const type = effectiveType(report);
  const isConfirmed = report.status === 'verified' && report.severity !== null;
  const accent = severity ? colors[SEVERITY_META[severity].colorKey] : colors.border;

  const ai = report.aiSuggestions;
  const duplicateFlag = report.possibleDuplicateOf ?? ai?.possibleDuplicateOf ?? null;

  return (
    <Card
      onPress={onPress}
      accent={accent}
      accessibilityLabel={`${report.reference}, ${severity ?? 'unclassified'} ${THREAT_META[type].label}, ${timeAgo(report.occurredAt)}`}
      style={{ paddingLeft: spacing.lg + 2 }}
    >
      <View style={{ gap: compact ? spacing.sm : spacing.md }}>
        {/* Row 1: classification + status */}
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flexWrap: 'wrap' }}>
          {severity ? <SeverityBadge severity={severity} size="sm" /> : <Badge label="Unclassified" size="sm" />}
          <Badge label={THREAT_META[type].label} size="sm" background={colors.surfaceSunken} />
          {showStatus && !queued ? <StatusBadge status={report.status} size="sm" /> : null}
          {queued ? (
            <Badge label="Waiting to send" icon="upload-cloud" size="sm" color={colors.warning} background={colors.warningMuted} />
          ) : null}
        </View>

        {/* Row 2: the report itself */}
        <Text variant="body" numberOfLines={compact ? 2 : 3} style={{ lineHeight: 21 }}>
          {truncate(report.description, compact ? 110 : 200)}
        </Text>

        {/* Row 3: where and when */}
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.md, flexWrap: 'wrap' }}>
          <Meta icon="map-pin" text={regionLabel(report)} />
          <Meta icon="clock" text={timeAgo(report.occurredAt)} />
          {distanceMeters !== undefined ? <Meta icon="navigation" text={`${formatDistance(distanceMeters)} away`} /> : null}
          {isConfirmed && report.alertRadiusMeters ? (
            <Meta icon="radio" text={`${formatRadius(report.alertRadiusMeters)} radius`} />
          ) : null}
        </View>

        {/* Row 4: AI state - only while a human has not yet decided */}
        {showAiSuggestion && report.status === 'pending' ? (
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: spacing.sm,
              paddingTop: spacing.sm,
              borderTopWidth: 1,
              borderTopColor: colors.divider,
              flexWrap: 'wrap',
            }}
          >
            {report.aiStatus === 'complete' && ai ? (
              <>
                <ConfidenceBadge confidence={ai.confidence} />
                {ai.needsMoreInfo ? (
                  <Badge label="Needs detail" icon="help-circle" size="sm" color={colors.warning} background={colors.warningMuted} />
                ) : null}
                {duplicateFlag ? (
                  <Badge label="Possible duplicate" icon="copy" size="sm" color={colors.warning} background={colors.warningMuted} />
                ) : null}
              </>
            ) : report.aiStatus === 'failed' ? (
              <Badge label="AI unavailable" icon="cloud-off" size="sm" color={colors.textTertiary} background={colors.surfaceSunken} />
            ) : (
              <Badge label="Analysing…" icon="loader" size="sm" color={colors.accentText} background={colors.accentMuted} />
            )}
          </View>
        ) : null}

        {report.status === 'dismissed' && report.dismissedReason ? (
          <View style={{ paddingTop: spacing.sm, borderTopWidth: 1, borderTopColor: colors.divider }}>
            <Text variant="caption" tone="tertiary">
              Dismissed: {report.dismissedReason}
            </Text>
          </View>
        ) : null}
      </View>
    </Card>
  );
}

function Meta({ icon, text }: { icon: keyof typeof Feather.glyphMap; text: string }) {
  const { colors } = useTheme();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
      <Feather name={icon} size={11} color={colors.textTertiary} />
      <Text variant="caption" tone="tertiary">
        {text}
      </Text>
    </View>
  );
}

export { Meta as MetaItem };
