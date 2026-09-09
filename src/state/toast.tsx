import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Animated, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { localId } from '@/lib/ids';
import { USE_NATIVE_DRIVER } from '@/lib/animation';
import { haptics } from '@/lib/haptics';
import { useTheme } from '@/theme';

/**
 * Transient feedback.
 *
 * Toasts appear at the top rather than the bottom: the SOS button and the tab
 * bar own the bottom of the screen, and nothing may ever obscure the SOS
 * button, not even for a second.
 */

export type ToastTone = 'success' | 'error' | 'info' | 'warning';

export type Toast = {
  id: string;
  tone: ToastTone;
  title: string;
  description?: string;
  durationMs: number;
  action?: { label: string; onPress: () => void };
};

type ToastContextValue = {
  show: (toast: Omit<Toast, 'id' | 'durationMs'> & { durationMs?: number }) => string;
  success: (title: string, description?: string) => string;
  error: (title: string, description?: string) => string;
  info: (title: string, description?: string) => string;
  warning: (title: string, description?: string) => string;
  dismiss: (id: string) => void;
};

const ToastContext = createContext<ToastContextValue | null>(null);

const MAX_VISIBLE = 3;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: string) => {
    const timer = timers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const show = useCallback<ToastContextValue['show']>(
    (input) => {
      const id = localId('toast');
      const toast: Toast = {
        id,
        tone: input.tone,
        title: input.title,
        description: input.description,
        // Errors stay longer - people need time to read what went wrong.
        durationMs: input.durationMs ?? (input.tone === 'error' ? 6000 : 3600),
        action: input.action,
      };

      setToasts((prev) => [toast, ...prev].slice(0, MAX_VISIBLE));

      if (toast.tone === 'error') haptics.error();
      else if (toast.tone === 'success') haptics.success();
      else if (toast.tone === 'warning') haptics.warning();

      timers.current.set(
        id,
        setTimeout(() => dismiss(id), toast.durationMs),
      );
      return id;
    },
    [dismiss],
  );

  useEffect(() => {
    const map = timers.current;
    return () => {
      map.forEach((t) => clearTimeout(t));
      map.clear();
    };
  }, []);

  const value = useMemo<ToastContextValue>(
    () => ({
      show,
      dismiss,
      success: (title, description) => show({ tone: 'success', title, description }),
      error: (title, description) => show({ tone: 'error', title, description }),
      info: (title, description) => show({ tone: 'info', title, description }),
      warning: (title, description) => show({ tone: 'warning', title, description }),
    }),
    [show, dismiss],
  );

  return (
    <ToastContext.Provider value={value}>
      {children}
      <ToastViewport toasts={toasts} onDismiss={dismiss} />
    </ToastContext.Provider>
  );
}

function ToastViewport({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: string) => void }) {
  const insets = useSafeAreaInsets();

  if (!toasts.length) return null;

  return (
    <View
      pointerEvents="box-none"
      style={[styles.viewport, { top: insets.top + 8 }]}
      accessibilityLiveRegion="polite"
    >
      {toasts.map((toast) => (
        <ToastCard key={toast.id} toast={toast} onDismiss={onDismiss} />
      ))}
    </View>
  );
}

function ToastCard({ toast, onDismiss }: { toast: Toast; onDismiss: (id: string) => void }) {
  const { colors, radius, spacing, fontSize, elevation } = useTheme();
  const [anim] = useState(() => new Animated.Value(0));

  useEffect(() => {
    Animated.spring(anim, { toValue: 1, useNativeDriver: USE_NATIVE_DRIVER, damping: 18, stiffness: 220 }).start();
  }, [anim]);

  const toneColor = {
    success: colors.success,
    error: colors.danger,
    warning: colors.warning,
    info: colors.accent,
  }[toast.tone];

  const toneBackground = {
    success: colors.successMuted,
    error: colors.dangerMuted,
    warning: colors.warningMuted,
    info: colors.accentMuted,
  }[toast.tone];

  return (
    <Animated.View
      style={{
        opacity: anim,
        transform: [{ translateY: anim.interpolate({ inputRange: [0, 1], outputRange: [-24, 0] }) }],
      }}
    >
      <Pressable
        onPress={() => onDismiss(toast.id)}
        accessibilityRole="alert"
        accessibilityLabel={`${toast.title}. ${toast.description ?? ''}`}
        style={[
          styles.card,
          elevation(2),
          {
            backgroundColor: colors.surfaceElevated,
            borderColor: colors.border,
            borderRadius: radius.lg,
            padding: spacing.md,
            marginBottom: spacing.sm,
          },
        ]}
      >
        <View style={[styles.stripe, { backgroundColor: toneColor, borderTopLeftRadius: radius.lg, borderBottomLeftRadius: radius.lg }]} />
        <View style={[styles.iconWrap, { backgroundColor: toneBackground, borderRadius: radius.sm }]}>
          <Text style={{ color: toneColor, fontSize: fontSize.footnote, fontWeight: '700' }}>
            {toast.tone === 'success' ? '✓' : toast.tone === 'error' ? '!' : toast.tone === 'warning' ? '▲' : 'i'}
          </Text>
        </View>
        <View style={styles.body}>
          <Text
            numberOfLines={2}
            style={{ color: colors.text, fontSize: fontSize.body, fontWeight: '600' }}
          >
            {toast.title}
          </Text>
          {toast.description ? (
            <Text
              numberOfLines={3}
              style={{ color: colors.textSecondary, fontSize: fontSize.footnote, marginTop: 2 }}
            >
              {toast.description}
            </Text>
          ) : null}
        </View>
        {toast.action ? (
          <Pressable
            onPress={() => {
              toast.action!.onPress();
              onDismiss(toast.id);
            }}
            hitSlop={8}
            style={{ paddingHorizontal: spacing.sm, paddingVertical: spacing.xs }}
          >
            <Text style={{ color: colors.accentText, fontSize: fontSize.footnote, fontWeight: '700' }}>
              {toast.action.label}
            </Text>
          </Pressable>
        ) : null}
      </Pressable>
    </Animated.View>
  );
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used inside <ToastProvider>');
  return ctx;
}

const styles = StyleSheet.create({
  viewport: {
    position: 'absolute',
    left: 12,
    right: 12,
    zIndex: 1000,
  },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
    gap: 10,
  },
  stripe: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    width: 3,
  },
  iconWrap: {
    width: 26,
    height: 26,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: 2,
  },
  body: { flex: 1 },
});
