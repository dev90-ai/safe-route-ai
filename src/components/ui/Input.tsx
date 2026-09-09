import Feather from '@expo/vector-icons/Feather';
import { forwardRef, useMemo, useRef, useState } from 'react';
import { Pressable, TextInput, View, type TextInputProps, type ViewStyle } from 'react-native';

import { haptics } from '@/lib/haptics';
import { passwordStrength } from '@/lib/validation';
import { useTheme } from '@/theme';
import { Text } from './Text';

export type FieldProps = Omit<TextInputProps, 'style'> & {
  label?: string;
  hint?: string;
  error?: string;
  icon?: keyof typeof Feather.glyphMap;
  required?: boolean;
  /** Renders a show/hide toggle and starts masked. */
  secure?: boolean;
  /** Live counter, shown once past 60% of the limit. */
  maxLength?: number;
  containerStyle?: ViewStyle;
  rightAdornment?: React.ReactNode;
};

export const Field = forwardRef<TextInput, FieldProps>(function Field(
  {
    label,
    hint,
    error,
    icon,
    required,
    secure,
    maxLength,
    containerStyle,
    rightAdornment,
    onFocus,
    onBlur,
    value,
    multiline,
    ...rest
  },
  ref,
) {
  const { colors, radius, spacing, fontSize, minTouch } = useTheme();
  const [focused, setFocused] = useState(false);
  const [revealed, setRevealed] = useState(false);

  const borderColor = error ? colors.danger : focused ? colors.accent : colors.border;
  const length = value?.length ?? 0;
  const showCount = Boolean(maxLength && length > maxLength * 0.6);

  const handleFocus: NonNullable<TextInputProps['onFocus']> = (e) => {
    setFocused(true);
    onFocus?.(e);
  };
  const handleBlur: NonNullable<TextInputProps['onBlur']> = (e) => {
    setFocused(false);
    onBlur?.(e);
  };

  return (
    <View style={[{ gap: 6 }, containerStyle]}>
      {label ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
          <Text variant="footnote" weight="600" tone="secondary">
            {label}
            {required ? <Text variant="footnote" tone="danger"> *</Text> : null}
          </Text>
          {showCount ? (
            <Text variant="micro" tone={length >= (maxLength ?? 0) ? 'danger' : 'tertiary'} tabular>
              {length}/{maxLength}
            </Text>
          ) : null}
        </View>
      ) : null}

      <View
        style={{
          flexDirection: 'row',
          alignItems: multiline ? 'flex-start' : 'center',
          gap: spacing.sm,
          minHeight: multiline ? 100 : minTouch,
          paddingHorizontal: spacing.md,
          paddingVertical: multiline ? spacing.md : 0,
          borderRadius: radius.md,
          borderWidth: 1,
          borderColor,
          backgroundColor: colors.surfaceSunken,
        }}
      >
        {icon ? (
          <Feather
            name={icon}
            size={16}
            color={error ? colors.danger : focused ? colors.accent : colors.textTertiary}
            style={multiline ? { marginTop: 3 } : undefined}
          />
        ) : null}

        <TextInput
          ref={ref}
          {...rest}
          value={value}
          multiline={multiline}
          maxLength={maxLength}
          onFocus={handleFocus}
          onBlur={handleBlur}
          secureTextEntry={secure && !revealed}
          placeholderTextColor={colors.textTertiary}
          accessibilityLabel={rest.accessibilityLabel ?? label}
          accessibilityHint={hint}
          style={{
            flex: 1,
            color: colors.text,
            fontSize: fontSize.body,
            paddingVertical: multiline ? 0 : 10,
            textAlignVertical: multiline ? 'top' : 'center',
            minHeight: multiline ? 76 : undefined,
          }}
        />

        {secure ? (
          <Pressable
            onPress={() => {
              haptics.select();
              setRevealed((v) => !v);
            }}
            hitSlop={10}
            accessibilityRole="button"
            accessibilityLabel={revealed ? 'Hide password' : 'Show password'}
          >
            <Feather name={revealed ? 'eye-off' : 'eye'} size={16} color={colors.textTertiary} />
          </Pressable>
        ) : null}

        {rightAdornment}
      </View>

      {error ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
          <Feather name="alert-circle" size={12} color={colors.danger} />
          <Text variant="caption" tone="danger" style={{ flex: 1 }}>
            {error}
          </Text>
        </View>
      ) : hint ? (
        <Text variant="caption" tone="tertiary">
          {hint}
        </Text>
      ) : null}
    </View>
  );
});

/**
 * Six-box code entry.
 *
 * Implemented as one hidden input behind six rendered cells. That gives correct
 * SMS autofill and paste behaviour on both platforms, which six separate inputs
 * famously do not.
 */
export function CodeInput({
  value,
  onChange,
  length = 6,
  error,
  autoFocus = true,
  onComplete,
}: {
  value: string;
  onChange: (next: string) => void;
  length?: number;
  error?: string;
  autoFocus?: boolean;
  onComplete?: (code: string) => void;
}) {
  const { colors, radius, spacing, fontSize } = useTheme();
  const inputRef = useRef<TextInput>(null);
  const [focused, setFocused] = useState(false);

  const cells = useMemo(() => Array.from({ length }, (_, i) => value[i] ?? ''), [value, length]);

  const handleChange = (next: string) => {
    const digits = next.replace(/[^0-9]/g, '').slice(0, length);
    onChange(digits);
    if (digits.length === length) {
      haptics.success();
      onComplete?.(digits);
    } else if (digits.length > value.length) {
      haptics.select();
    }
  };

  return (
    <View style={{ gap: 8 }}>
      <Pressable
        onPress={() => inputRef.current?.focus()}
        accessibilityRole="none"
        accessibilityLabel={`Verification code, ${value.length} of ${length} digits entered`}
        style={{ flexDirection: 'row', gap: spacing.sm, justifyContent: 'space-between' }}
      >
        {cells.map((digit, index) => {
          const isActive = focused && index === Math.min(value.length, length - 1);
          return (
            <View
              key={index}
              style={{
                flex: 1,
                aspectRatio: 0.82,
                maxWidth: 56,
                borderRadius: radius.md,
                borderWidth: isActive ? 2 : 1,
                borderColor: error ? colors.danger : isActive ? colors.accent : colors.border,
                backgroundColor: colors.surfaceSunken,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Text
                style={{ fontSize: fontSize.title2, fontWeight: '700', color: colors.text }}
                tabular
              >
                {digit}
              </Text>
            </View>
          );
        })}
      </Pressable>

      <TextInput
        ref={inputRef}
        value={value}
        onChangeText={handleChange}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        keyboardType="number-pad"
        textContentType="oneTimeCode"
        autoComplete="one-time-code"
        autoFocus={autoFocus}
        maxLength={length}
        // Kept in the tree but visually hidden: this is the real input.
        style={{ position: 'absolute', opacity: 0, height: 1, width: 1 }}
      />

      {error ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
          <Feather name="alert-circle" size={12} color={colors.danger} />
          <Text variant="caption" tone="danger">
            {error}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

/** Password strength meter. Advisory, never blocking. */
export function PasswordMeter({ password }: { password: string }) {
  const { colors, spacing, radius } = useTheme();
  const { score, label, checks } = passwordStrength(password);

  if (!password) return null;

  const barColors = [colors.danger, colors.danger, colors.warning, colors.success, colors.success];
  const active = barColors[score];

  return (
    <View style={{ gap: spacing.sm, marginTop: 2 }}>
      <View style={{ flexDirection: 'row', gap: 4 }}>
        {[0, 1, 2, 3].map((i) => (
          <View
            key={i}
            style={{
              flex: 1,
              height: 3,
              borderRadius: radius.pill,
              backgroundColor: i < score ? active : colors.border,
            }}
          />
        ))}
      </View>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
        <Text variant="caption" color={active} weight="600">
          {label}
        </Text>
        <Text variant="caption" tone="tertiary">
          {checks.filter((c) => c.met).length}/{checks.length} checks passed
        </Text>
      </View>
      <View style={{ gap: 3 }}>
        {checks
          .filter((c) => !c.met)
          .slice(0, 2)
          .map((check) => (
            <View key={check.label} style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
              <Feather name="circle" size={9} color={colors.textTertiary} />
              <Text variant="caption" tone="tertiary">
                {check.label}
              </Text>
            </View>
          ))}
      </View>
    </View>
  );
}

/** Multi-line text area. Thin wrapper so screens read declaratively. */
export function TextArea(props: FieldProps) {
  return <Field {...props} multiline numberOfLines={5} />;
}
