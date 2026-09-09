import Feather from '@expo/vector-icons/Feather';
import { Pressable, View, type ViewProps, type ViewStyle } from 'react-native';

import { haptics } from '@/lib/haptics';
import { useTheme, type Colors } from '@/theme';
import { Text } from './Text';

/** Card: the default container for a discrete unit of content. */
export function Card({
  children,
  style,
  padded = true,
  level = 1,
  accent,
  onPress,
  accessibilityLabel,
  ...rest
}: ViewProps & {
  padded?: boolean;
  level?: 0 | 1 | 2 | 3;
  /** Left edge stripe - used to carry severity without shouting. */
  accent?: string;
  onPress?: () => void;
  accessibilityLabel?: string;
}) {
  const { colors, radius, spacing, elevation } = useTheme();

  const body = (
    <>
      {accent ? (
        <View
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            bottom: 0,
            width: 3,
            backgroundColor: accent,
            borderTopLeftRadius: radius.lg,
            borderBottomLeftRadius: radius.lg,
          }}
        />
      ) : null}
      {children}
    </>
  );

  const containerStyle: ViewStyle = {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: padded ? spacing.lg : 0,
    overflow: 'hidden',
  };

  if (onPress) {
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        onPress={() => {
          haptics.tap();
          onPress();
        }}
        style={({ pressed }) => [containerStyle, elevation(level), pressed ? { opacity: 0.82 } : null, style as ViewStyle]}
      >
        {body}
      </Pressable>
    );
  }

  return (
    <View {...rest} style={[containerStyle, elevation(level), style]}>
      {body}
    </View>
  );
}

/** A titled block with an optional trailing action. */
export function Section({
  title,
  subtitle,
  action,
  children,
  style,
}: {
  title?: string;
  subtitle?: string;
  action?: { label: string; onPress: () => void };
  children: React.ReactNode;
  style?: ViewStyle;
}) {
  const { spacing } = useTheme();

  return (
    <View style={[{ gap: spacing.md }, style]}>
      {title || action ? (
        <View style={{ flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', gap: spacing.md }}>
          <View style={{ flex: 1, gap: 2 }}>
            {title ? <Text variant="label" tone="tertiary">{title}</Text> : null}
            {subtitle ? <Text variant="footnote" tone="secondary">{subtitle}</Text> : null}
          </View>
          {action ? (
            <Pressable onPress={action.onPress} hitSlop={10} accessibilityRole="button">
              <Text variant="footnote" tone="accent" weight="600">
                {action.label}
              </Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
      {children}
    </View>
  );
}

export function Divider({ inset = 0, vertical = false }: { inset?: number; vertical?: boolean }) {
  const { colors } = useTheme();
  return (
    <View
      style={
        vertical
          ? { width: 1, alignSelf: 'stretch', backgroundColor: colors.divider }
          : { height: 1, marginLeft: inset, backgroundColor: colors.divider }
      }
    />
  );
}

/** Inline message block. Used for offline notices, policy notes, warnings. */
export function Banner({
  tone = 'info',
  title,
  message,
  icon,
  action,
  compact,
  style,
}: {
  tone?: 'info' | 'success' | 'warning' | 'danger' | 'neutral';
  title?: string;
  message: string;
  icon?: keyof typeof Feather.glyphMap;
  action?: { label: string; onPress: () => void };
  compact?: boolean;
  style?: ViewStyle;
}) {
  const { colors, radius, spacing } = useTheme();

  const map: Record<string, { fg: keyof Colors; bg: keyof Colors; icon: keyof typeof Feather.glyphMap }> = {
    info: { fg: 'accentText', bg: 'accentMuted', icon: 'info' },
    success: { fg: 'success', bg: 'successMuted', icon: 'check-circle' },
    warning: { fg: 'warning', bg: 'warningMuted', icon: 'alert-triangle' },
    danger: { fg: 'danger', bg: 'dangerMuted', icon: 'alert-octagon' },
    neutral: { fg: 'textSecondary', bg: 'surfaceSunken', icon: 'info' },
  };

  const config = map[tone];

  return (
    <View
      accessibilityRole="alert"
      style={[
        {
          flexDirection: 'row',
          gap: spacing.md,
          padding: compact ? spacing.md : spacing.lg,
          borderRadius: radius.md,
          backgroundColor: colors[config.bg],
          borderWidth: 1,
          borderColor: colors.border,
          alignItems: 'flex-start',
        },
        style,
      ]}
    >
      <Feather name={icon ?? config.icon} size={16} color={colors[config.fg]} style={{ marginTop: 1 }} />
      <View style={{ flex: 1, gap: 3 }}>
        {title ? (
          <Text variant="footnote" weight="700" color={colors[config.fg]}>
            {title}
          </Text>
        ) : null}
        <Text variant="footnote" tone="secondary">
          {message}
        </Text>
        {action ? (
          <Pressable onPress={action.onPress} hitSlop={8} style={{ marginTop: 4 }} accessibilityRole="button">
            <Text variant="footnote" weight="700" color={colors[config.fg]}>
              {action.label}
            </Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

/** Key/value row used across detail screens. */
export function DetailRow({
  label,
  value,
  icon,
  tone,
  onPress,
  multiline,
}: {
  label: string;
  value: string;
  icon?: keyof typeof Feather.glyphMap;
  tone?: string;
  onPress?: () => void;
  multiline?: boolean;
}) {
  const { colors, spacing } = useTheme();

  const content = (
    <View
      style={{
        flexDirection: multiline ? 'column' : 'row',
        alignItems: multiline ? 'flex-start' : 'center',
        justifyContent: 'space-between',
        gap: multiline ? 4 : spacing.lg,
        paddingVertical: spacing.sm,
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
        {icon ? <Feather name={icon} size={13} color={colors.textTertiary} /> : null}
        <Text variant="footnote" tone="tertiary">
          {label}
        </Text>
      </View>
      <Text
        variant="footnote"
        weight="500"
        color={tone}
        style={multiline ? undefined : { flexShrink: 1, textAlign: 'right' }}
      >
        {value}
      </Text>
    </View>
  );

  if (onPress) {
    return (
      <Pressable onPress={onPress} accessibilityRole="button">
        {content}
      </Pressable>
    );
  }
  return content;
}
