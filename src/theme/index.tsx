import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useColorScheme } from 'react-native';

import { storage } from '@/lib/storage';
import {
  duration,
  elevation,
  fontSize,
  HIT_SLOP,
  lineHeight,
  MIN_TOUCH,
  palette,
  radius,
  schemes,
  spacing,
  type Colors,
  type SchemeName,
} from './tokens';

export * from './tokens';

export type ThemePreference = SchemeName | 'system';

export type Theme = {
  scheme: SchemeName;
  colors: Colors;
  spacing: typeof spacing;
  radius: typeof radius;
  fontSize: typeof fontSize;
  lineHeight: typeof lineHeight;
  duration: typeof duration;
  palette: typeof palette;
  hitSlop: typeof HIT_SLOP;
  minTouch: number;
  elevation: (level: 0 | 1 | 2 | 3) => object;
};

type ThemeContextValue = Theme & {
  preference: ThemePreference;
  setPreference: (next: ThemePreference) => void;
};

const PREFERENCE_KEY = 'theme.preference';

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const systemScheme = useColorScheme();
  const [preference, setPreferenceState] = useState<ThemePreference>('dark');

  useEffect(() => {
    let cancelled = false;
    storage.get<ThemePreference>(PREFERENCE_KEY).then((saved) => {
      if (!cancelled && saved) setPreferenceState(saved);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const setPreference = useCallback((next: ThemePreference) => {
    setPreferenceState(next);
    void storage.set(PREFERENCE_KEY, next);
  }, []);

  const scheme: SchemeName =
    preference === 'system' ? ((systemScheme ?? 'dark') as SchemeName) : preference;

  const value = useMemo<ThemeContextValue>(
    () => ({
      scheme,
      colors: schemes[scheme],
      spacing,
      radius,
      fontSize,
      lineHeight,
      duration,
      palette,
      hitSlop: HIT_SLOP,
      minTouch: MIN_TOUCH,
      elevation: (level) => elevation(scheme, level),
      preference,
      setPreference,
    }),
    [scheme, preference, setPreference],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used inside <ThemeProvider>');
  return ctx;
}

/**
 * Build a StyleSheet-shaped object from the active theme, memoised per scheme.
 * Keeps screens free of inline colour lookups without paying for a re-create
 * on every render.
 */
export function useThemedStyles<T extends Record<string, unknown>>(factory: (theme: Theme) => T): T {
  const theme = useTheme();
  return useMemo(() => factory(theme), [theme, factory]);
}
