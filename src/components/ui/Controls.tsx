import Feather from '@expo/vector-icons/Feather';
import { useMemo, useState } from 'react';
import { Pressable, Switch, TextInput, View, type ViewStyle } from 'react-native';

import { haptics } from '@/lib/haptics';
import { useTheme } from '@/theme';
import { Text } from './Text';

/** Labelled switch row. The most common settings control in the app. */
export function Toggle({
  label,
  description,
  value,
  onChange,
  icon,
  disabled,
}: {
  label: string;
  description?: string;
  value: boolean;
  onChange: (next: boolean) => void;
  icon?: keyof typeof Feather.glyphMap;
  disabled?: boolean;
}) {
  const { colors, spacing } = useTheme();

  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.md,
        paddingVertical: spacing.sm,
        opacity: disabled ? 0.5 : 1,
      }}
    >
      {icon ? <Feather name={icon} size={16} color={colors.textTertiary} /> : null}
      <View style={{ flex: 1, gap: 2 }}>
        <Text variant="body" weight="500">
          {label}
        </Text>
        {description ? (
          <Text variant="caption" tone="tertiary">
            {description}
          </Text>
        ) : null}
      </View>
      <Switch
        value={value}
        disabled={disabled}
        onValueChange={(next) => {
          haptics.select();
          onChange(next);
        }}
        accessibilityLabel={label}
        trackColor={{ false: colors.borderStrong, true: colors.accent }}
        thumbColor={colors.surface}
      />
    </View>
  );
}

/** Tappable row that opens a picker and shows the current value. */
export function SelectRow({
  label,
  value,
  placeholder = 'Select',
  onPress,
  icon,
  error,
  color,
  required,
}: {
  label: string;
  value: string | null;
  placeholder?: string;
  onPress: () => void;
  icon?: keyof typeof Feather.glyphMap;
  error?: string;
  color?: string;
  required?: boolean;
}) {
  const { colors, radius, spacing, minTouch } = useTheme();

  return (
    <View style={{ gap: 6 }}>
      <Text variant="footnote" weight="600" tone="secondary">
        {label}
        {required ? <Text variant="footnote" tone="danger"> *</Text> : null}
      </Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${label}: ${value ?? placeholder}`}
        onPress={() => {
          haptics.tap();
          onPress();
        }}
        style={({ pressed }) => ({
          flexDirection: 'row',
          alignItems: 'center',
          gap: spacing.sm,
          minHeight: minTouch,
          paddingHorizontal: spacing.md,
          borderRadius: radius.md,
          borderWidth: 1,
          borderColor: error ? colors.danger : colors.border,
          backgroundColor: colors.surfaceSunken,
          opacity: pressed ? 0.8 : 1,
        })}
      >
        {icon ? <Feather name={icon} size={16} color={color ?? colors.textTertiary} /> : null}
        <Text variant="body" tone={value ? 'default' : 'tertiary'} color={value ? color : undefined} style={{ flex: 1 }} numberOfLines={1}>
          {value ?? placeholder}
        </Text>
        <Feather name="chevron-down" size={16} color={colors.textTertiary} />
      </Pressable>
      {error ? (
        <Text variant="caption" tone="danger">
          {error}
        </Text>
      ) : null}
    </View>
  );
}

/**
 * Searchable multi-select. Used for operating regions, where the list is long
 * enough that a plain chip wall becomes unusable.
 */
export function MultiSelect({
  options,
  selected,
  onChange,
  searchPlaceholder = 'Search',
  max,
  groupBy,
  emptyMessage = 'Nothing matches that search.',
}: {
  options: { value: string; label: string; group?: string }[];
  selected: string[];
  onChange: (next: string[]) => void;
  searchPlaceholder?: string;
  max?: number;
  groupBy?: boolean;
  emptyMessage?: string;
}) {
  const { colors, radius, spacing, fontSize, minTouch } = useTheme();
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matched = q ? options.filter((o) => o.label.toLowerCase().includes(q) || o.group?.toLowerCase().includes(q)) : options;

    if (!groupBy) return [{ group: null as string | null, items: matched }];

    const groups = new Map<string, typeof matched>();
    for (const option of matched) {
      const key = option.group ?? 'Other';
      groups.set(key, [...(groups.get(key) ?? []), option]);
    }
    return [...groups.entries()].map(([group, items]) => ({ group, items }));
  }, [options, query, groupBy]);

  const toggle = (value: string) => {
    haptics.select();
    if (selected.includes(value)) {
      onChange(selected.filter((v) => v !== value));
    } else {
      if (max && selected.length >= max) return;
      onChange([...selected, value]);
    }
  };

  const atLimit = max !== undefined && selected.length >= max;

  return (
    <View style={{ gap: spacing.md }}>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: spacing.sm,
          height: minTouch,
          paddingHorizontal: spacing.md,
          borderRadius: radius.md,
          borderWidth: 1,
          borderColor: colors.border,
          backgroundColor: colors.surfaceSunken,
        }}
      >
        <Feather name="search" size={15} color={colors.textTertiary} />
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder={searchPlaceholder}
          placeholderTextColor={colors.textTertiary}
          accessibilityLabel={searchPlaceholder}
          style={{ flex: 1, color: colors.text, fontSize: fontSize.body }}
        />
        {query ? (
          <Pressable onPress={() => setQuery('')} hitSlop={10} accessibilityLabel="Clear search" accessibilityRole="button">
            <Feather name="x-circle" size={15} color={colors.textTertiary} />
          </Pressable>
        ) : null}
      </View>

      {max ? (
        <Text variant="caption" tone={atLimit ? 'warning' : 'tertiary'}>
          {selected.length} of {max} selected
          {atLimit ? ' - remove one to add another' : ''}
        </Text>
      ) : null}

      {filtered.every((g) => g.items.length === 0) ? (
        <Text variant="footnote" tone="tertiary" style={{ paddingVertical: spacing.md }}>
          {emptyMessage}
        </Text>
      ) : (
        filtered.map(({ group, items }) => (
          <View key={group ?? 'all'} style={{ gap: spacing.sm }}>
            {group ? (
              <Text variant="label" tone="tertiary">
                {group}
              </Text>
            ) : null}
            <View style={{ gap: 6 }}>
              {items.map((option) => {
                const isSelected = selected.includes(option.value);
                const isBlocked = !isSelected && atLimit;
                return (
                  <Pressable
                    key={option.value}
                    accessibilityRole="checkbox"
                    accessibilityState={{ checked: isSelected, disabled: isBlocked }}
                    disabled={isBlocked}
                    onPress={() => toggle(option.value)}
                    style={({ pressed }) => ({
                      flexDirection: 'row',
                      alignItems: 'center',
                      gap: spacing.md,
                      paddingVertical: 11,
                      paddingHorizontal: spacing.md,
                      borderRadius: radius.md,
                      borderWidth: 1,
                      borderColor: isSelected ? colors.accent : colors.border,
                      backgroundColor: isSelected ? colors.accentMuted : colors.surface,
                      opacity: isBlocked ? 0.35 : pressed ? 0.8 : 1,
                    })}
                  >
                    <View
                      style={{
                        width: 20,
                        height: 20,
                        borderRadius: 6,
                        borderWidth: isSelected ? 0 : 1.5,
                        borderColor: colors.borderStrong,
                        backgroundColor: isSelected ? colors.accent : 'transparent',
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                    >
                      {isSelected ? <Feather name="check" size={13} color={colors.textOnAccent} /> : null}
                    </View>
                    <Text variant="body" style={{ flex: 1 }}>
                      {option.label}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          </View>
        ))
      )}
    </View>
  );
}

/**
 * Numeric stepper with live formatting. Used for the alert radius, where the
 * officer needs to feel the value change rather than type a number.
 */
export function Stepper({
  value,
  onChange,
  min,
  max,
  step,
  format,
  label,
  hint,
  presets,
}: {
  value: number;
  onChange: (next: number) => void;
  min: number;
  max: number;
  step: number;
  format: (value: number) => string;
  label?: string;
  hint?: string;
  presets?: { label: string; value: number }[];
}) {
  const { colors, radius, spacing } = useTheme();

  const adjust = (delta: number) => {
    const next = Math.max(min, Math.min(max, value + delta));
    if (next !== value) {
      haptics.select();
      onChange(next);
    }
  };

  return (
    <View style={{ gap: spacing.sm }}>
      {label ? (
        <Text variant="footnote" weight="600" tone="secondary">
          {label}
        </Text>
      ) : null}

      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          borderRadius: radius.md,
          borderWidth: 1,
          borderColor: colors.border,
          backgroundColor: colors.surfaceSunken,
          overflow: 'hidden',
        }}
      >
        <Pressable
          onPress={() => adjust(-step)}
          disabled={value <= min}
          accessibilityRole="button"
          accessibilityLabel="Decrease"
          style={{ width: 48, height: 48, alignItems: 'center', justifyContent: 'center', opacity: value <= min ? 0.3 : 1 }}
        >
          <Feather name="minus" size={18} color={colors.text} />
        </Pressable>

        <View style={{ flex: 1, alignItems: 'center' }}>
          <Text variant="title3" tabular>
            {format(value)}
          </Text>
        </View>

        <Pressable
          onPress={() => adjust(step)}
          disabled={value >= max}
          accessibilityRole="button"
          accessibilityLabel="Increase"
          style={{ width: 48, height: 48, alignItems: 'center', justifyContent: 'center', opacity: value >= max ? 0.3 : 1 }}
        >
          <Feather name="plus" size={18} color={colors.text} />
        </Pressable>
      </View>

      {presets?.length ? (
        <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
          {presets.map((preset) => {
            const active = preset.value === value;
            return (
              <Pressable
                key={preset.label}
                onPress={() => {
                  haptics.select();
                  onChange(preset.value);
                }}
                accessibilityRole="button"
                style={{
                  paddingHorizontal: spacing.md,
                  paddingVertical: 6,
                  borderRadius: radius.pill,
                  borderWidth: 1,
                  borderColor: active ? colors.accent : colors.border,
                  backgroundColor: active ? colors.accentMuted : 'transparent',
                }}
              >
                <Text variant="caption" weight="600" tone={active ? 'accent' : 'tertiary'}>
                  {preset.label}
                </Text>
              </Pressable>
            );
          })}
        </View>
      ) : null}

      {hint ? (
        <Text variant="caption" tone="tertiary">
          {hint}
        </Text>
      ) : null}
    </View>
  );
}

/** Navigation row for settings and list screens. */
export function ListRow({
  title,
  subtitle,
  icon,
  iconColor,
  right,
  onPress,
  destructive,
  style,
}: {
  title: string;
  subtitle?: string;
  icon?: keyof typeof Feather.glyphMap;
  iconColor?: string;
  right?: React.ReactNode;
  onPress?: () => void;
  destructive?: boolean;
  style?: ViewStyle;
}) {
  const { colors, radius, spacing } = useTheme();

  const body = (
    <View
      style={[
        { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingVertical: spacing.md, minHeight: 52 },
        style,
      ]}
    >
      {icon ? (
        <View
          style={{
            width: 32,
            height: 32,
            borderRadius: radius.sm,
            backgroundColor: colors.surfaceSunken,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Feather name={icon} size={15} color={destructive ? colors.danger : iconColor ?? colors.textSecondary} />
        </View>
      ) : null}

      <View style={{ flex: 1, gap: 2 }}>
        <Text variant="body" weight="500" tone={destructive ? 'danger' : 'default'}>
          {title}
        </Text>
        {subtitle ? (
          <Text variant="caption" tone="tertiary" numberOfLines={2}>
            {subtitle}
          </Text>
        ) : null}
      </View>

      {right ?? (onPress ? <Feather name="chevron-right" size={17} color={colors.textTertiary} /> : null)}
    </View>
  );

  if (!onPress) return body;

  return (
    <Pressable
      onPress={() => {
        haptics.tap();
        onPress();
      }}
      accessibilityRole="button"
      accessibilityLabel={title}
      style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}
    >
      {body}
    </Pressable>
  );
}
