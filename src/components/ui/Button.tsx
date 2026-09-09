import Feather from '@expo/vector-icons/Feather';
import { ActivityIndicator, Pressable, View, type PressableProps, type ViewStyle } from 'react-native';

import { haptics } from '@/lib/haptics';
import { useTheme } from '@/theme';
import { Text } from './Text';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'success' | 'outline';
export type ButtonSize = 'sm' | 'md' | 'lg';

export type ButtonProps = Omit<PressableProps, 'style' | 'children'> & {
  label: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: keyof typeof Feather.glyphMap;
  iconRight?: keyof typeof Feather.glyphMap;
  loading?: boolean;
  fullWidth?: boolean;
  style?: ViewStyle;
  /** Suppress the haptic tick, e.g. inside a list of rapid toggles. */
  silent?: boolean;
};

export function Button({
  label,
  variant = 'primary',
  size = 'md',
  icon,
  iconRight,
  loading = false,
  fullWidth = false,
  disabled,
  onPress,
  style,
  silent,
  ...rest
}: ButtonProps) {
  const { colors, radius, spacing, elevation, minTouch } = useTheme();
  const isDisabled = disabled || loading;

  const sizing: Record<ButtonSize, { height: number; padH: number; gap: number; iconSize: number }> = {
    sm: { height: 36, padH: spacing.md, gap: 6, iconSize: 14 },
    md: { height: minTouch, padH: spacing.lg, gap: 8, iconSize: 16 },
    lg: { height: 54, padH: spacing.xl, gap: 10, iconSize: 18 },
  };

  const palette: Record<ButtonVariant, { bg: string; fg: string; border: string; elevated: boolean }> = {
    primary: { bg: colors.accent, fg: colors.textOnAccent, border: 'transparent', elevated: true },
    secondary: { bg: colors.surfaceElevated, fg: colors.text, border: colors.border, elevated: false },
    ghost: { bg: 'transparent', fg: colors.accentText, border: 'transparent', elevated: false },
    outline: { bg: 'transparent', fg: colors.text, border: colors.borderStrong, elevated: false },
    danger: { bg: colors.danger, fg: colors.textOnAccent, border: 'transparent', elevated: true },
    success: { bg: colors.success, fg: colors.textOnAccent, border: 'transparent', elevated: true },
  };

  const tone = palette[variant];
  const dims = sizing[size];

  return (
    <Pressable
      {...rest}
      accessibilityRole="button"
      accessibilityState={{ disabled: isDisabled, busy: loading }}
      accessibilityLabel={rest.accessibilityLabel ?? label}
      disabled={isDisabled}
      onPress={(e) => {
        if (!silent) haptics.tap();
        onPress?.(e);
      }}
      style={({ pressed }) => [
        {
          height: dims.height,
          paddingHorizontal: dims.padH,
          borderRadius: radius.md,
          backgroundColor: tone.bg,
          borderWidth: tone.border === 'transparent' ? 0 : 1,
          borderColor: tone.border,
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'center',
          gap: dims.gap,
          alignSelf: fullWidth ? 'stretch' : 'flex-start',
          opacity: isDisabled ? 0.45 : pressed ? 0.86 : 1,
          transform: [{ scale: pressed && !isDisabled ? 0.985 : 1 }],
        },
        tone.elevated && !isDisabled ? elevation(1) : null,
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator size="small" color={tone.fg} />
      ) : icon ? (
        <Feather name={icon} size={dims.iconSize} color={tone.fg} />
      ) : null}

      <Text
        variant={size === 'lg' ? 'callout' : 'body'}
        weight="600"
        color={tone.fg}
        numberOfLines={1}
        style={{ flexShrink: 1 }}
      >
        {label}
      </Text>

      {iconRight && !loading ? <Feather name={iconRight} size={dims.iconSize} color={tone.fg} /> : null}
    </Pressable>
  );
}

/** Square icon-only button. Always carries an accessibility label. */
export function IconButton({
  icon,
  onPress,
  label,
  variant = 'secondary',
  size = 40,
  tone,
  disabled,
  style,
}: {
  icon: keyof typeof Feather.glyphMap;
  onPress?: () => void;
  label: string;
  variant?: 'secondary' | 'ghost' | 'danger';
  size?: number;
  tone?: string;
  disabled?: boolean;
  style?: ViewStyle;
}) {
  const { colors, radius } = useTheme();

  const bg =
    variant === 'ghost' ? 'transparent' : variant === 'danger' ? colors.dangerMuted : colors.surfaceElevated;
  const fg = tone ?? (variant === 'danger' ? colors.danger : colors.textSecondary);

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled }}
      disabled={disabled}
      hitSlop={8}
      onPress={() => {
        haptics.tap();
        onPress?.();
      }}
      style={({ pressed }) => [
        {
          width: size,
          height: size,
          borderRadius: radius.md,
          backgroundColor: bg,
          alignItems: 'center',
          justifyContent: 'center',
          borderWidth: variant === 'ghost' ? 0 : 1,
          borderColor: colors.border,
          opacity: disabled ? 0.4 : pressed ? 0.7 : 1,
        },
        style,
      ]}
    >
      <Feather name={icon} size={Math.round(size * 0.45)} color={fg} />
    </Pressable>
  );
}

/** A row of buttons that shares the remaining width evenly. */
export function ButtonRow({ children, gap = 10 }: { children: React.ReactNode; gap?: number }) {
  return <View style={{ flexDirection: 'row', gap }}>{children}</View>;
}
