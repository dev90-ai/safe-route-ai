import Feather from '@expo/vector-icons/Feather';
import { View } from 'react-native';

import type { AiSuggestion } from '@/api/types';
import { SEVERITY_META, THREAT_META } from '@/constants/threats';
import { formatRadius } from '@/lib/geo';
import { useTheme } from '@/theme';
import { Badge, Meter } from '../ui/Display';
import { Banner, Card } from '../ui/Surface';
import { Text } from '../ui/Text';
import { Button } from '../ui/Button';
import { ConfidenceBadge } from './Badges';

/**
 * The AI suggestion panel an officer reads before deciding.
 *
 * Framed throughout as a proposal, never a verdict: the header says "suggests",
 * the reasoning is shown rather than hidden, and low confidence is stated
 * plainly instead of being smoothed over. An officer who cannot see why the
 * model said something cannot meaningfully take responsibility for accepting it.
 */
export function AiPanel({
  suggestion,
  status,
  onRetry,
  compact = false,
}: {
  suggestion: AiSuggestion | null;
  status: 'queued' | 'processing' | 'complete' | 'failed';
  onRetry?: () => void;
  compact?: boolean;
}) {
  const { colors, spacing, radius } = useTheme();

  if (status === 'failed') {
    return (
      <Card>
        <View style={{ gap: spacing.md }}>
          <Header />
          <Banner
            tone="warning"
            title="Classification unavailable"
            message="The analysis service did not respond. You can still verify this report manually - every field below is yours to set."
            icon="cloud-off"
          />
          {onRetry ? <Button label="Retry analysis" icon="refresh-cw" variant="secondary" onPress={onRetry} /> : null}
        </View>
      </Card>
    );
  }

  if (status !== 'complete' || !suggestion) {
    return (
      <Card>
        <View style={{ gap: spacing.md }}>
          <Header />
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
            <Feather name="loader" size={14} color={colors.accentText} />
            <Text variant="footnote" tone="secondary">
              Analysing the report text, checking for nearby duplicates…
            </Text>
          </View>
          <Text variant="caption" tone="tertiary">
            This does not block you. You can verify the report without waiting.
          </Text>
        </View>
      </Card>
    );
  }

  return (
    <Card>
      <View style={{ gap: spacing.lg }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm }}>
          <Header />
          <ConfidenceBadge confidence={suggestion.confidence} />
        </View>

        {suggestion.needsMoreInfo ? (
          <Banner
            tone="warning"
            title="Not enough detail to classify"
            message="The report is too short for a reliable classification. Contact the reporter for specifics before acting on anything below."
          />
        ) : null}

        {/* The proposal itself */}
        <View
          style={{
            flexDirection: 'row',
            flexWrap: 'wrap',
            gap: spacing.md,
            padding: spacing.md,
            borderRadius: radius.md,
            backgroundColor: colors.surfaceSunken,
          }}
        >
          <Proposal label="Threat type" value={THREAT_META[suggestion.threatType].label} />
          <Proposal label="Severity" value={SEVERITY_META[suggestion.severity].label} tone={colors[SEVERITY_META[suggestion.severity].colorKey]} />
          <Proposal label="Priority" value={`${suggestion.priority}/10`} />
          <Proposal label="Alert radius" value={formatRadius(suggestion.alertRadiusMeters)} />
        </View>

        <View style={{ gap: 6 }}>
          <Text variant="label" tone="tertiary">
            Summary
          </Text>
          <Text variant="footnote" tone="secondary">
            {suggestion.summary}
          </Text>
        </View>

        {!compact ? (
          <View style={{ gap: 6 }}>
            <Text variant="label" tone="tertiary">
              Why
            </Text>
            <Text variant="footnote" tone="secondary">
              {suggestion.rationale}
            </Text>
            {suggestion.keyIndicators.length ? (
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 4 }}>
                {suggestion.keyIndicators.map((indicator) => (
                  <Badge key={indicator} label={indicator} size="sm" />
                ))}
              </View>
            ) : null}
          </View>
        ) : null}

        {suggestion.duplicateRationale ? (
          <Banner
            tone={suggestion.possibleDuplicateOf ? 'warning' : 'neutral'}
            title={suggestion.possibleDuplicateOf ? 'Possible duplicate' : 'Duplicate check'}
            message={suggestion.duplicateRationale}
            icon="copy"
            compact
          />
        ) : null}

        {!compact && suggestion.recommendedActions.length ? (
          <View style={{ gap: spacing.sm }}>
            <Text variant="label" tone="tertiary">
              Suggested actions
            </Text>
            {suggestion.recommendedActions.map((action, index) => (
              <View key={action} style={{ flexDirection: 'row', gap: spacing.sm, alignItems: 'flex-start' }}>
                <Text variant="caption" tone="tertiary" tabular style={{ marginTop: 2 }}>
                  {index + 1}.
                </Text>
                <Text variant="footnote" tone="secondary" style={{ flex: 1 }}>
                  {action}
                </Text>
              </View>
            ))}
          </View>
        ) : null}

        <View style={{ gap: 6 }}>
          <Meter value={suggestion.confidence} color={suggestion.confidence >= 0.75 ? colors.success : suggestion.confidence >= 0.5 ? colors.warning : colors.danger} />
          <Text variant="micro" tone="tertiary">
            {suggestion.model} · {suggestion.latencyMs} ms · advisory only, not a decision
          </Text>
        </View>
      </View>
    </Card>
  );
}

function Header() {
  const { colors, spacing } = useTheme();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flex: 1 }}>
      <View
        style={{
          width: 26,
          height: 26,
          borderRadius: 8,
          backgroundColor: colors.accentMuted,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Feather name="cpu" size={14} color={colors.accentText} />
      </View>
      <View style={{ flex: 1 }}>
        <Text variant="bodyStrong">AI suggests</Text>
      </View>
    </View>
  );
}

function Proposal({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <View style={{ minWidth: 92, gap: 2 }}>
      <Text variant="micro" tone="tertiary">
        {label}
      </Text>
      <Text variant="body" weight="600" color={tone}>
        {value}
      </Text>
    </View>
  );
}
