import Feather from '@expo/vector-icons/Feather';
import { useEffect, useState } from 'react';
import { Animated, Easing, Modal, Pressable, ScrollView, View, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { USE_NATIVE_DRIVER } from '@/lib/animation';
import { haptics } from '@/lib/haptics';
import { useTheme } from '@/theme';
import { Button } from './Button';
import { Text } from './Text';

/**
 * Bottom sheet.
 *
 * Used for anything that must not lose the context behind it - confirming a
 * verification, choosing a threat type, reviewing a duplicate. Modal screens are
 * reserved for genuinely separate tasks.
 */
export function Sheet({
  visible,
  onClose,
  title,
  subtitle,
  children,
  footer,
  maxHeightRatio = 0.86,
  dismissable = true,
}: {
  visible: boolean;
  onClose: () => void;
  title?: string;
  subtitle?: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
  maxHeightRatio?: number;
  dismissable?: boolean;
}) {
  const { colors, radius, spacing } = useTheme();
  const insets = useSafeAreaInsets();
  const [anim] = useState(() => new Animated.Value(0));

  useEffect(() => {
    Animated.timing(anim, {
      toValue: visible ? 1 : 0,
      duration: visible ? 260 : 180,
      easing: visible ? Easing.out(Easing.cubic) : Easing.in(Easing.cubic),
      useNativeDriver: USE_NATIVE_DRIVER,
    }).start();
  }, [visible, anim]);

  return (
    <Modal
      visible={visible}
      transparent
      animationType="none"
      statusBarTranslucent
      onRequestClose={dismissable ? onClose : undefined}
    >
      <View style={{ flex: 1, justifyContent: 'flex-end' }}>
        <Animated.View style={{ ...StyleSheetAbsolute, backgroundColor: colors.overlay, opacity: anim }}>
          <Pressable
            style={{ flex: 1 }}
            onPress={dismissable ? onClose : undefined}
            accessibilityLabel={dismissable ? 'Dismiss' : undefined}
            accessibilityRole={dismissable ? 'button' : undefined}
          />
        </Animated.View>

        <Animated.View
          style={{
            backgroundColor: colors.surface,
            borderTopLeftRadius: radius.xxl,
            borderTopRightRadius: radius.xxl,
            borderTopWidth: 1,
            borderColor: colors.border,
            maxHeight: `${maxHeightRatio * 100}%`,
            transform: [{ translateY: anim.interpolate({ inputRange: [0, 1], outputRange: [600, 0] }) }],
          }}
        >
          <View style={{ alignItems: 'center', paddingTop: spacing.md, paddingBottom: spacing.sm }}>
            <View style={{ width: 36, height: 4, borderRadius: 2, backgroundColor: colors.borderStrong }} />
          </View>

          {title ? (
            <View
              style={{
                paddingHorizontal: spacing.xl,
                paddingBottom: spacing.md,
                flexDirection: 'row',
                alignItems: 'flex-start',
                gap: spacing.md,
              }}
            >
              <View style={{ flex: 1, gap: 3 }}>
                <Text variant="title3">{title}</Text>
                {subtitle ? (
                  <Text variant="footnote" tone="secondary">
                    {subtitle}
                  </Text>
                ) : null}
              </View>
              {dismissable ? (
                <Pressable onPress={onClose} hitSlop={12} accessibilityRole="button" accessibilityLabel="Close">
                  <Feather name="x" size={20} color={colors.textTertiary} />
                </Pressable>
              ) : null}
            </View>
          ) : null}

          <ScrollView
            contentContainerStyle={{
              paddingHorizontal: spacing.xl,
              paddingBottom: footer ? spacing.md : spacing.xl + insets.bottom,
            }}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          >
            {children}
          </ScrollView>

          {footer ? (
            <View
              style={{
                paddingHorizontal: spacing.xl,
                paddingTop: spacing.md,
                paddingBottom: spacing.md + insets.bottom,
                borderTopWidth: 1,
                borderTopColor: colors.border,
                gap: spacing.sm,
              }}
            >
              {footer}
            </View>
          ) : null}
        </Animated.View>
      </View>
    </Modal>
  );
}

const StyleSheetAbsolute: ViewStyle = {
  position: 'absolute',
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
};

/**
 * Destructive/consequential confirmation.
 *
 * Every irreversible action in the app routes through this, so the phrasing of
 * consequences is consistent: what will happen, to whom, and whether it can be
 * undone.
 */
export function ConfirmSheet({
  visible,
  onClose,
  onConfirm,
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  tone = 'danger',
  loading,
  children,
}: {
  visible: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: 'danger' | 'primary' | 'success';
  loading?: boolean;
  children?: React.ReactNode;
}) {
  const { spacing } = useTheme();

  return (
    <Sheet
      visible={visible}
      onClose={onClose}
      title={title}
      dismissable={!loading}
      footer={
        <View style={{ gap: spacing.sm }}>
          <Button
            label={confirmLabel}
            variant={tone}
            fullWidth
            loading={loading}
            onPress={() => {
              haptics.press();
              onConfirm();
            }}
          />
          <Button label={cancelLabel} variant="ghost" fullWidth onPress={onClose} disabled={loading} />
        </View>
      }
    >
      <Text variant="body" tone="secondary" style={{ marginBottom: children ? spacing.lg : 0 }}>
        {message}
      </Text>
      {children}
    </Sheet>
  );
}

/** Single-select list rendered in a sheet. */
export function OptionSheet<T extends string>({
  visible,
  onClose,
  title,
  subtitle,
  options,
  value,
  onSelect,
}: {
  visible: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  options: { value: T; label: string; description?: string; icon?: keyof typeof Feather.glyphMap; color?: string }[];
  value: T | null;
  onSelect: (value: T) => void;
}) {
  const { colors, radius, spacing } = useTheme();

  return (
    <Sheet visible={visible} onClose={onClose} title={title} subtitle={subtitle}>
      <View style={{ gap: spacing.sm }}>
        {options.map((option) => {
          const selected = option.value === value;
          return (
            <Pressable
              key={option.value}
              accessibilityRole="radio"
              accessibilityState={{ selected }}
              onPress={() => {
                haptics.select();
                onSelect(option.value);
                onClose();
              }}
              style={({ pressed }) => ({
                flexDirection: 'row',
                alignItems: 'center',
                gap: spacing.md,
                padding: spacing.md,
                borderRadius: radius.md,
                borderWidth: 1,
                borderColor: selected ? option.color ?? colors.accent : colors.border,
                backgroundColor: selected ? `${option.color ?? colors.accent}18` : colors.surfaceSunken,
                opacity: pressed ? 0.8 : 1,
              })}
            >
              {option.icon ? (
                <Feather
                  name={option.icon}
                  size={18}
                  color={selected ? option.color ?? colors.accent : colors.textTertiary}
                />
              ) : null}
              <View style={{ flex: 1, gap: 2 }}>
                <Text variant="body" weight={selected ? '600' : '400'}>
                  {option.label}
                </Text>
                {option.description ? (
                  <Text variant="caption" tone="tertiary">
                    {option.description}
                  </Text>
                ) : null}
              </View>
              {selected ? <Feather name="check" size={18} color={option.color ?? colors.accent} /> : null}
            </Pressable>
          );
        })}
      </View>
    </Sheet>
  );
}
