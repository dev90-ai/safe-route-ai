import Feather from '@expo/vector-icons/Feather';
import { useEffect, useState } from 'react';
import { Animated, Easing, Pressable, ScrollView, View, type ViewStyle } from 'react-native';

import { initials } from '@/lib/format';
import { USE_NATIVE_DRIVER } from '@/lib/animation';
import { haptics } from '@/lib/haptics';
import { useTheme } from '@/theme';
import { Button } from './Button';
import { Text } from './Text';

/** Small status pill. `dot` adds a leading indicator for at-a-glance scanning. */
export function Badge({
  label,
  color,
  background,
  icon,
  dot,
  size = 'md',
  style,
}: {
  label: string;
  color?: string;
  background?: string;
  icon?: keyof typeof Feather.glyphMap;
  dot?: boolean;
  size?: 'sm' | 'md';
  style?: ViewStyle;
}) {
  const { colors, radius, spacing } = useTheme();
  const fg = color ?? colors.textSecondary;
  const bg = background ?? colors.surfaceSunken;

  return (
    <View
      style={[
        {
          flexDirection: 'row',
          alignItems: 'center',
          gap: 5,
          paddingHorizontal: size === 'sm' ? spacing.sm : spacing.md - 2,
          paddingVertical: size === 'sm' ? 3 : 5,
          borderRadius: radius.pill,
          backgroundColor: bg,
          alignSelf: 'flex-start',
        },
        style,
      ]}
    >
      {dot ? <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: fg }} /> : null}
      {icon ? <Feather name={icon} size={size === 'sm' ? 10 : 11} color={fg} /> : null}
      <Text variant={size === 'sm' ? 'micro' : 'caption'} weight="700" color={fg}>
        {label}
      </Text>
    </View>
  );
}

/** Selectable chip. Used for filters, region pickers, threat types. */
export function Chip({
  label,
  selected,
  onPress,
  icon,
  color,
  count,
  disabled,
}: {
  label: string;
  selected?: boolean;
  onPress?: () => void;
  icon?: keyof typeof Feather.glyphMap;
  color?: string;
  count?: number;
  disabled?: boolean;
}) {
  const { colors, radius, spacing } = useTheme();
  const tint = color ?? colors.accent;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: !!selected, disabled: !!disabled }}
      accessibilityLabel={count !== undefined ? `${label}, ${count}` : label}
      disabled={disabled}
      onPress={() => {
        haptics.select();
        onPress?.();
      }}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        paddingHorizontal: spacing.md,
        paddingVertical: 8,
        borderRadius: radius.pill,
        borderWidth: 1,
        borderColor: selected ? tint : colors.border,
        backgroundColor: selected ? `${tint}22` : colors.surface,
        opacity: disabled ? 0.4 : pressed ? 0.75 : 1,
      })}
    >
      {icon ? <Feather name={icon} size={13} color={selected ? tint : colors.textTertiary} /> : null}
      <Text variant="footnote" weight={selected ? '700' : '500'} color={selected ? tint : colors.textSecondary}>
        {label}
      </Text>
      {count !== undefined ? (
        <View
          style={{
            minWidth: 18,
            paddingHorizontal: 4,
            height: 18,
            borderRadius: 9,
            backgroundColor: selected ? tint : colors.surfaceSunken,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Text variant="micro" weight="700" color={selected ? colors.textOnAccent : colors.textTertiary} tabular>
            {count}
          </Text>
        </View>
      ) : null}
    </Pressable>
  );
}

/** Horizontally scrollable chip row with edge padding that matches screens. */
export function ChipRow({ children, padding = 20 }: { children: React.ReactNode; padding?: number }) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={{ gap: 8, paddingHorizontal: padding }}
      style={{ marginHorizontal: -padding }}
    >
      {children}
    </ScrollView>
  );
}

/** Segmented control for mutually exclusive views. */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  fullWidth = true,
}: {
  options: { value: T; label: string; badge?: number }[];
  value: T;
  onChange: (value: T) => void;
  fullWidth?: boolean;
}) {
  const { colors, radius, spacing } = useTheme();

  return (
    <View
      accessibilityRole="tablist"
      style={{
        flexDirection: 'row',
        backgroundColor: colors.surfaceSunken,
        borderRadius: radius.md,
        padding: 3,
        gap: 3,
        alignSelf: fullWidth ? 'stretch' : 'flex-start',
      }}
    >
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <Pressable
            key={option.value}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            onPress={() => {
              haptics.select();
              onChange(option.value);
            }}
            style={{
              flex: fullWidth ? 1 : undefined,
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 6,
              paddingVertical: 8,
              paddingHorizontal: spacing.md,
              borderRadius: radius.sm,
              backgroundColor: selected ? colors.surface : 'transparent',
            }}
          >
            <Text variant="footnote" weight={selected ? '700' : '500'} tone={selected ? 'default' : 'tertiary'}>
              {option.label}
            </Text>
            {option.badge ? (
              <View
                style={{
                  minWidth: 17,
                  height: 17,
                  paddingHorizontal: 4,
                  borderRadius: 9,
                  backgroundColor: colors.danger,
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Text variant="micro" weight="700" color={colors.textOnAccent} tabular>
                  {option.badge > 99 ? '99+' : option.badge}
                </Text>
              </View>
            ) : null}
          </Pressable>
        );
      })}
    </View>
  );
}

export function Avatar({
  name,
  color,
  size = 40,
  badge,
}: {
  name: string;
  color?: string;
  size?: number;
  badge?: { icon: keyof typeof Feather.glyphMap; color: string };
}) {
  const { colors } = useTheme();
  const tint = color ?? colors.accent;

  return (
    <View>
      <View
        style={{
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: `${tint}28`,
          borderWidth: 1,
          borderColor: `${tint}55`,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Text weight="700" color={tint} style={{ fontSize: size * 0.36 }}>
          {initials(name)}
        </Text>
      </View>
      {badge ? (
        <View
          style={{
            position: 'absolute',
            right: -2,
            bottom: -2,
            width: size * 0.42,
            height: size * 0.42,
            borderRadius: size * 0.21,
            backgroundColor: badge.color,
            alignItems: 'center',
            justifyContent: 'center',
            borderWidth: 2,
            borderColor: colors.background,
          }}
        >
          <Feather name={badge.icon} size={size * 0.2} color={colors.textOnAccent} />
        </View>
      ) : null}
    </View>
  );
}

/** Shimmering placeholder. Sized by the caller to match real content. */
export function Skeleton({
  width,
  height = 14,
  radius: r,
  style,
}: {
  width?: number | `${number}%`;
  height?: number;
  radius?: number;
  style?: ViewStyle;
}) {
  const { colors, radius: tokens } = useTheme();
  const [shimmer] = useState(() => new Animated.Value(0));

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(shimmer, { toValue: 1, duration: 900, easing: Easing.inOut(Easing.ease), useNativeDriver: USE_NATIVE_DRIVER }),
        Animated.timing(shimmer, { toValue: 0, duration: 900, easing: Easing.inOut(Easing.ease), useNativeDriver: USE_NATIVE_DRIVER }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [shimmer]);

  return (
    <Animated.View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[
        {
          width: width ?? '100%',
          height,
          borderRadius: r ?? tokens.sm,
          backgroundColor: colors.skeleton,
          opacity: shimmer.interpolate({ inputRange: [0, 1], outputRange: [0.5, 1] }),
        },
        style,
      ]}
    />
  );
}

/** Card-shaped skeleton used while lists load. */
export function SkeletonCard({ lines = 3 }: { lines?: number }) {
  const { colors, radius, spacing } = useTheme();
  return (
    <View
      style={{
        padding: spacing.lg,
        borderRadius: radius.lg,
        borderWidth: 1,
        borderColor: colors.border,
        backgroundColor: colors.surface,
        gap: spacing.md,
      }}
    >
      <View style={{ flexDirection: 'row', gap: spacing.md, alignItems: 'center' }}>
        <Skeleton width={64} height={20} radius={999} />
        <Skeleton width={48} height={20} radius={999} />
      </View>
      {Array.from({ length: lines }).map((_, i) => (
        <Skeleton key={i} width={i === lines - 1 ? '62%' : '100%'} height={12} />
      ))}
    </View>
  );
}

/** The state a list is in when there is genuinely nothing to show. */
export function EmptyState({
  icon = 'inbox',
  title,
  message,
  action,
  tone = 'neutral',
  compact,
}: {
  icon?: keyof typeof Feather.glyphMap;
  title: string;
  message: string;
  action?: { label: string; onPress: () => void; icon?: keyof typeof Feather.glyphMap };
  tone?: 'neutral' | 'positive';
  compact?: boolean;
}) {
  const { colors, spacing, radius } = useTheme();
  const tint = tone === 'positive' ? colors.success : colors.textTertiary;

  return (
    <View style={{ alignItems: 'center', paddingVertical: compact ? spacing.xl : spacing.huge, paddingHorizontal: spacing.xl, gap: spacing.md }}>
      <View
        style={{
          width: 56,
          height: 56,
          borderRadius: radius.xl,
          backgroundColor: tone === 'positive' ? colors.successMuted : colors.surfaceSunken,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Feather name={icon} size={24} color={tint} />
      </View>
      <Text variant="title3" align="center">
        {title}
      </Text>
      <Text variant="footnote" tone="secondary" align="center" style={{ maxWidth: 320 }}>
        {message}
      </Text>
      {action ? (
        <Button label={action.label} icon={action.icon} variant="secondary" onPress={action.onPress} style={{ marginTop: 4 }} />
      ) : null}
    </View>
  );
}

/** Large single number with a caption. The building block of stat rows. */
export function Stat({
  label,
  value,
  sublabel,
  tone,
  icon,
  onPress,
  style,
}: {
  label: string;
  value: string | number;
  sublabel?: string;
  tone?: string;
  icon?: keyof typeof Feather.glyphMap;
  onPress?: () => void;
  style?: ViewStyle;
}) {
  const { colors, radius, spacing } = useTheme();

  const content = (
    <View
      style={[
        {
          flex: 1,
          padding: spacing.md,
          borderRadius: radius.md,
          backgroundColor: colors.surface,
          borderWidth: 1,
          borderColor: colors.border,
          gap: 3,
          minWidth: 96,
        },
        style,
      ]}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
        {icon ? <Feather name={icon} size={11} color={colors.textTertiary} /> : null}
        <Text variant="micro" tone="tertiary" numberOfLines={1}>
          {label}
        </Text>
      </View>
      <Text variant="title2" color={tone} tabular>
        {value}
      </Text>
      {sublabel ? (
        <Text variant="caption" tone="tertiary" numberOfLines={1}>
          {sublabel}
        </Text>
      ) : null}
    </View>
  );

  if (onPress) {
    return (
      <Pressable onPress={onPress} style={{ flex: 1 }} accessibilityRole="button" accessibilityLabel={`${label}: ${value}`}>
        {content}
      </Pressable>
    );
  }
  return content;
}

/** Horizontal progress/meter bar with an optional threshold marker. */
export function Meter({
  value,
  max = 1,
  color,
  height = 6,
  label,
}: {
  value: number;
  max?: number;
  color?: string;
  height?: number;
  label?: string;
}) {
  const { colors, radius } = useTheme();
  const ratio = Math.max(0, Math.min(1, value / max));

  return (
    <View style={{ gap: 4 }}>
      {label ? (
        <Text variant="caption" tone="tertiary">
          {label}
        </Text>
      ) : null}
      <View
        accessibilityRole="progressbar"
        accessibilityValue={{ min: 0, max: 100, now: Math.round(ratio * 100) }}
        style={{ height, borderRadius: radius.pill, backgroundColor: colors.surfaceSunken, overflow: 'hidden' }}
      >
        <View
          style={{
            width: `${ratio * 100}%`,
            height: '100%',
            borderRadius: radius.pill,
            backgroundColor: color ?? colors.accent,
          }}
        />
      </View>
    </View>
  );
}
