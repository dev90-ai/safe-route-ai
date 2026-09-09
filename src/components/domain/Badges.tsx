import Feather from '@expo/vector-icons/Feather';
import { View } from 'react-native';

import {
  ROLE_META,
  SEVERITY_META,
  STATUS_META,
  THREAT_META,
  type ReportStatus,
  type Role,
  type Severity,
  type ThreatType,
} from '@/constants/threats';
import { useTheme } from '@/theme';
import { Badge } from '../ui/Display';
import { Text } from '../ui/Text';

/**
 * Severity is the single most important signal in this product, so it gets a
 * dedicated component rather than an ad-hoc Badge call per screen. It always
 * pairs colour with a word - colour alone is not an accessible signal, and this
 * app is used in direct sunlight by people who are not looking carefully.
 */
export function SeverityBadge({
  severity,
  size = 'md',
  showGuidance = false,
}: {
  severity: Severity;
  size?: 'sm' | 'md';
  showGuidance?: boolean;
}) {
  const { colors } = useTheme();
  const meta = SEVERITY_META[severity];

  return (
    <View style={{ gap: 4 }}>
      <Badge
        label={meta.label}
        color={colors[meta.colorKey]}
        background={colors[meta.mutedKey]}
        size={size}
        dot
      />
      {showGuidance ? (
        <Text variant="caption" tone="secondary">
          {meta.guidance}
        </Text>
      ) : null}
    </View>
  );
}

export function StatusBadge({ status, size = 'md' }: { status: ReportStatus; size?: 'sm' | 'md' }) {
  const { colors } = useTheme();
  const meta = STATUS_META[status];
  const icon: keyof typeof Feather.glyphMap =
    status === 'verified' ? 'check-circle' : status === 'dismissed' ? 'x-circle' : 'clock';

  return (
    <Badge
      label={meta.label}
      icon={icon}
      color={colors[meta.colorKey]}
      background={colors[meta.mutedKey]}
      size={size}
    />
  );
}

export function ThreatTypeBadge({
  threatType,
  size = 'md',
  muted,
}: {
  threatType: ThreatType;
  size?: 'sm' | 'md';
  muted?: boolean;
}) {
  const { colors } = useTheme();
  return (
    <Badge
      label={THREAT_META[threatType].label}
      color={muted ? colors.textTertiary : colors.textSecondary}
      background={colors.surfaceSunken}
      size={size}
    />
  );
}

export function RoleBadge({ role, size = 'sm' }: { role: Role; size?: 'sm' | 'md' }) {
  const { colors } = useTheme();
  const meta = ROLE_META[role];
  const tint = colors[meta.colorKey];
  const icon: keyof typeof Feather.glyphMap = role === 'admin' ? 'settings' : role === 'officer' ? 'shield' : 'user';

  return (
    <Badge
      label={role === 'worker' ? 'Worker' : role === 'officer' ? 'Officer' : 'Admin'}
      icon={icon}
      color={tint}
      background={`${tint}1F`}
      size={size}
    />
  );
}

/** Confidence read-out for AI output. Deliberately blunt about low confidence. */
export function ConfidenceBadge({ confidence, size = 'sm' }: { confidence: number; size?: 'sm' | 'md' }) {
  const { colors } = useTheme();
  const pct = Math.round(confidence * 100);
  const tone = confidence >= 0.75 ? colors.success : confidence >= 0.5 ? colors.warning : colors.danger;
  const label = confidence >= 0.75 ? 'High' : confidence >= 0.5 ? 'Moderate' : 'Low';

  return (
    <Badge
      label={`${label} confidence · ${pct}%`}
      color={tone}
      background={`${tone}1F`}
      size={size}
      icon="cpu"
    />
  );
}

/** Connectivity chip shown in headers. */
export function ConnectionBadge({ online, quality }: { online: boolean; quality: 'offline' | 'poor' | 'good' }) {
  const { colors } = useTheme();

  if (online && quality === 'good') return null;

  const config = !online
    ? { label: 'Offline', color: colors.warning, icon: 'wifi-off' as const }
    : { label: 'Weak signal', color: colors.warning, icon: 'wifi' as const };

  return <Badge label={config.label} icon={config.icon} color={config.color} background={colors.warningMuted} size="sm" />;
}
