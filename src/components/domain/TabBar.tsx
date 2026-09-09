import Feather from '@expo/vector-icons/Feather';
import type { BottomTabBarProps } from 'expo-router/js-tabs';
import { Pressable, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { haptics } from '@/lib/haptics';
import { useTheme } from '@/theme';
import { Text } from '../ui/Text';

export type TabItem = {
  /** Route file name, e.g. "index", "map". */
  name: string;
  label: string;
  icon: keyof typeof Feather.glyphMap;
};

export type TabBarProps = BottomTabBarProps & {
  items: TabItem[];
  getBadge?: (name: string) => number;
};

/**
 * Custom tab bar.
 *
 * Hand-built rather than themed, because two things have to be exactly right:
 * a badge must sit on the icon without nudging the label, and the bar has to
 * leave a clear lane at the right for the floating SOS button on worker screens.
 *
 * Must be *rendered* as an element, never called as a function:
 *
 *   tabBar={(props) => <TabBar {...props} items={TABS} />}   // correct
 *   tabBar={TabBar}                                          // hooks would throw
 *
 * The navigator invokes `tabBar` as a plain function, so passing the component
 * directly leaves its hooks with no fiber of their own to attach to.
 */
export function TabBar({ state, navigation, items, getBadge }: TabBarProps) {
  const { colors, spacing, radius } = useTheme();
  const insets = useSafeAreaInsets();

  return (
    <View
      style={{
        flexDirection: 'row',
        backgroundColor: colors.surface,
        borderTopWidth: 1,
        borderTopColor: colors.border,
        paddingBottom: insets.bottom || spacing.sm,
        paddingTop: spacing.sm,
        paddingHorizontal: spacing.sm,
      }}
    >
      {state.routes.map((route, index) => {
        const item = items.find((i) => i.name === route.name);
        if (!item) return null;

        const focused = state.index === index;
        const badge = getBadge?.(route.name) ?? 0;

        const onPress = () => {
          const event = navigation.emit({ type: 'tabPress', target: route.key, canPreventDefault: true });
          if (!focused && !event.defaultPrevented) {
            haptics.select();
            navigation.navigate(route.name);
          }
        };

        return (
          <Pressable
            key={route.key}
            onPress={onPress}
            accessibilityRole="tab"
            accessibilityState={{ selected: focused }}
            accessibilityLabel={badge ? `${item.label}, ${badge} new` : item.label}
            style={{ flex: 1, alignItems: 'center', gap: 3, paddingVertical: 4 }}
          >
            <View>
              <View
                style={{
                  paddingHorizontal: 14,
                  paddingVertical: 4,
                  borderRadius: radius.pill,
                  backgroundColor: focused ? colors.accentMuted : 'transparent',
                }}
              >
                <Feather name={item.icon} size={19} color={focused ? colors.accent : colors.textTertiary} />
              </View>

              {badge > 0 ? (
                <View
                  style={{
                    position: 'absolute',
                    top: -2,
                    right: 4,
                    minWidth: 17,
                    height: 17,
                    paddingHorizontal: 4,
                    borderRadius: 9,
                    backgroundColor: colors.danger,
                    alignItems: 'center',
                    justifyContent: 'center',
                    borderWidth: 2,
                    borderColor: colors.surface,
                  }}
                >
                  <Text variant="micro" weight="700" color={colors.white} tabular style={{ fontSize: 9 }}>
                    {badge > 99 ? '99+' : badge}
                  </Text>
                </View>
              ) : null}
            </View>

            <Text
              variant="micro"
              weight={focused ? '700' : '500'}
              tone={focused ? 'accent' : 'tertiary'}
              numberOfLines={1}
            >
              {item.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}
