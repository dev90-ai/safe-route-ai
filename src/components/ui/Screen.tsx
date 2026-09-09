import Feather from '@expo/vector-icons/Feather';
import { useRouter } from 'expo-router';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  View,
  type ScrollViewProps,
  type ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useTheme } from '@/theme';
import { Text } from './Text';

export const SCREEN_PADDING = 20;

/**
 * Standard screen chrome.
 *
 * Bottom padding accounts for the tab bar AND the floating SOS button. Nothing
 * may ever end up underneath the SOS button, so the safe bottom inset is
 * computed here once instead of being guessed per screen.
 */
export function Screen({
  children,
  scroll = true,
  refreshing,
  onRefresh,
  padded = true,
  style,
  contentStyle,
  keyboardAvoiding = false,
  extraBottomPadding = 0,
  ...rest
}: ScrollViewProps & {
  children: React.ReactNode;
  scroll?: boolean;
  refreshing?: boolean;
  onRefresh?: () => void;
  padded?: boolean;
  contentStyle?: ViewStyle;
  keyboardAvoiding?: boolean;
  extraBottomPadding?: number;
}) {
  const { colors, spacing } = useTheme();
  const insets = useSafeAreaInsets();

  const padding: ViewStyle = {
    paddingHorizontal: padded ? SCREEN_PADDING : 0,
    paddingBottom: spacing.xxxl + insets.bottom + extraBottomPadding,
  };

  const body = scroll ? (
    <ScrollView
      {...rest}
      style={[{ flex: 1, backgroundColor: colors.background }, style]}
      contentContainerStyle={[padding, contentStyle]}
      keyboardShouldPersistTaps="handled"
      showsVerticalScrollIndicator={false}
      refreshControl={
        onRefresh ? (
          <RefreshControl
            refreshing={!!refreshing}
            onRefresh={onRefresh}
            tintColor={colors.accent}
            colors={[colors.accent]}
            progressBackgroundColor={colors.surface}
          />
        ) : undefined
      }
    >
      {children}
    </ScrollView>
  ) : (
    <View style={[{ flex: 1, backgroundColor: colors.background }, padding, contentStyle, style as ViewStyle]}>
      {children}
    </View>
  );

  if (keyboardAvoiding) {
    return (
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={Platform.OS === 'ios' ? 8 : 0}
        style={{ flex: 1, backgroundColor: colors.background }}
      >
        {body}
      </KeyboardAvoidingView>
    );
  }

  return body;
}

/** Screen header. Sits inside the scroll view so it scrolls away naturally. */
export function Header({
  title,
  subtitle,
  right,
  onBack,
  large = true,
  style,
}: {
  title: string;
  subtitle?: string;
  right?: React.ReactNode;
  onBack?: boolean | (() => void);
  large?: boolean;
  style?: ViewStyle;
}) {
  const { colors, spacing } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();

  const handleBack = () => {
    if (typeof onBack === 'function') onBack();
    else if (router.canGoBack()) router.back();
  };

  return (
    <View style={[{ paddingTop: insets.top + spacing.md, paddingBottom: spacing.lg, gap: spacing.sm }, style]}>
      {onBack ? (
        <Pressable
          onPress={handleBack}
          hitSlop={12}
          accessibilityRole="button"
          accessibilityLabel="Go back"
          style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginBottom: 2, alignSelf: 'flex-start' }}
        >
          <Feather name="chevron-left" size={18} color={colors.accentText} />
          <Text variant="footnote" tone="accent" weight="600">
            Back
          </Text>
        </Pressable>
      ) : null}

      <View style={{ flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: spacing.md }}>
        <View style={{ flex: 1, gap: 3 }}>
          <Text variant={large ? 'title1' : 'title2'}>{title}</Text>
          {subtitle ? (
            <Text variant="footnote" tone="secondary">
              {subtitle}
            </Text>
          ) : null}
        </View>
        {right}
      </View>
    </View>
  );
}

/** Sticky bar for primary form actions. Respects the home indicator. */
export function ActionBar({ children, style }: { children: React.ReactNode; style?: ViewStyle }) {
  const { colors, spacing } = useTheme();
  const insets = useSafeAreaInsets();

  return (
    <View
      style={[
        {
          paddingHorizontal: SCREEN_PADDING,
          paddingTop: spacing.md,
          paddingBottom: spacing.md + insets.bottom,
          backgroundColor: colors.surface,
          borderTopWidth: 1,
          borderTopColor: colors.border,
          gap: spacing.sm,
        },
        style,
      ]}
    >
      {children}
    </View>
  );
}
