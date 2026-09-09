import Feather from '@expo/vector-icons/Feather';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Animated, Easing, Pressable, View } from 'react-native';

import { USE_NATIVE_DRIVER } from '@/lib/animation';
import { haptics } from '@/lib/haptics';
import { useTheme } from '@/theme';
import { Text } from '../ui/Text';

/**
 * SOS trigger.
 *
 * Hold-to-activate rather than tap: this broadcasts a live location to security
 * officers and cannot be undone quietly, so an accidental brush of a pocket must
 * not fire it. 1.6 seconds is long enough to be deliberate and short enough to
 * be usable under real stress - and the ring, the haptics and the countdown all
 * make the remaining time obvious so nobody is left guessing whether it worked.
 */

const HOLD_MS = 1600;

export function SosButton({
  onActivate,
  active,
  disabled,
  size = 72,
  label = 'SOS',
}: {
  onActivate: () => void;
  active?: boolean;
  disabled?: boolean;
  size?: number;
  label?: string;
}) {
  const { colors, elevation } = useTheme();
  const [progress] = useState(() => new Animated.Value(0));
  const [pulse] = useState(() => new Animated.Value(0));
  const [holding, setHolding] = useState(false);
  const completed = useRef(false);

  // Slow pulse while an SOS is live, so the state is visible at a glance.
  useEffect(() => {
    if (!active) {
      pulse.setValue(0);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 900, easing: Easing.out(Easing.ease), useNativeDriver: USE_NATIVE_DRIVER }),
        Animated.timing(pulse, { toValue: 0, duration: 900, easing: Easing.in(Easing.ease), useNativeDriver: USE_NATIVE_DRIVER }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [active, pulse]);

  const start = useCallback(() => {
    if (disabled || active) return;
    completed.current = false;
    setHolding(true);
    haptics.press();

    Animated.timing(progress, {
      toValue: 1,
      duration: HOLD_MS,
      easing: Easing.linear,
      useNativeDriver: false,
    }).start(({ finished }) => {
      if (finished && !completed.current) {
        completed.current = true;
        setHolding(false);
        progress.setValue(0);
        haptics.sos();
        onActivate();
      }
    });
  }, [disabled, active, progress, onActivate]);

  const cancel = useCallback(() => {
    if (completed.current) return;
    setHolding(false);
    progress.stopAnimation();
    Animated.timing(progress, { toValue: 0, duration: 180, useNativeDriver: false }).start();
  }, [progress]);

  const ringSize = size + 16;

  return (
    <View style={{ alignItems: 'center', gap: 6 }}>
      <View style={{ width: ringSize, height: ringSize, alignItems: 'center', justifyContent: 'center' }}>
        {active ? (
          <Animated.View
            style={{
              position: 'absolute',
              width: ringSize,
              height: ringSize,
              borderRadius: ringSize / 2,
              backgroundColor: colors.danger,
              opacity: pulse.interpolate({ inputRange: [0, 1], outputRange: [0.35, 0] }),
              transform: [{ scale: pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.35] }) }],
            }}
          />
        ) : null}

        {/* Hold progress ring */}
        <Animated.View
          style={{
            position: 'absolute',
            width: ringSize,
            height: ringSize,
            borderRadius: ringSize / 2,
            borderWidth: 4,
            borderColor: colors.danger,
            opacity: progress,
            transform: [{ scale: progress.interpolate({ inputRange: [0, 1], outputRange: [0.86, 1] }) }],
          }}
        />

        <Pressable
          onPressIn={start}
          onPressOut={cancel}
          disabled={disabled}
          accessibilityRole="button"
          accessibilityLabel={active ? 'SOS is active' : 'Hold to send SOS'}
          accessibilityHint={active ? undefined : 'Press and hold for two seconds to broadcast your location to security officers'}
          style={[
            {
              width: size,
              height: size,
              borderRadius: size / 2,
              backgroundColor: colors.danger,
              alignItems: 'center',
              justifyContent: 'center',
              opacity: disabled ? 0.5 : 1,
              borderWidth: 3,
              borderColor: colors.background,
            },
            elevation(3),
          ]}
        >
          {active ? (
            <Feather name="radio" size={size * 0.34} color={colors.white} />
          ) : (
            <Text weight="800" color={colors.white} style={{ fontSize: size * 0.24, letterSpacing: 0.5 }}>
              {label}
            </Text>
          )}
        </Pressable>
      </View>

      <Text variant="micro" tone={active ? 'danger' : 'tertiary'} weight="700">
        {active ? 'SOS ACTIVE' : holding ? 'Keep holding…' : 'Hold to send'}
      </Text>
    </View>
  );
}

/**
 * Floating SOS, anchored above the tab bar on every worker screen. Nothing else
 * is allowed to occupy this position.
 */
export function FloatingSos({
  onActivate,
  active,
  bottom,
}: {
  onActivate: () => void;
  active?: boolean;
  bottom: number;
}) {
  return (
    <View
      pointerEvents="box-none"
      style={{ position: 'absolute', right: 16, bottom, alignItems: 'center' }}
    >
      <SosButton onActivate={onActivate} active={active} size={60} />
    </View>
  );
}
