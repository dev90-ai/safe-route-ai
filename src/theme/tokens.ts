import { Platform } from 'react-native';

/**
 * Design tokens for Safe Route AI.
 *
 * The palette is dark-first: field workers use this app at night, in vehicles,
 * and in low-light compounds, where a bright white screen is both a comfort
 * problem and a personal-security problem (it makes the user visible).
 * Every colour is defined for both schemes so nothing falls back to a guess.
 */

export const palette = {
  // Neutral ramp (cool navy, not pure grey - reads calmer under stress)
  navy950: '#070C16',
  navy900: '#0B1220',
  navy850: '#111A2B',
  navy: '#162034',
  navy700: '#1E2A42',
  navy600: '#2A3852',
  navy500: '#3B4A66',
  navy400: '#5C6C89',
  navy300: '#8494AF',
  navy200: '#B4C0D4',
  navy100: '#DCE3EE',
  navy50: '#F1F4F9',
  white: '#FFFFFF',

  // Brand - signal blue. Trustworthy, high contrast on navy, not alarmist.
  blue600: '#1D4ED8',
  blue500: '#2563EB',
  blue400: '#3B82F6',
  blue300: '#60A5FA',
  blue100: '#DBEAFE',

  // Severity ramp. These are load-bearing: they are the fastest signal in the
  // whole product, so they are never reused for decoration.
  emerald600: '#059669',
  emerald500: '#10B981',
  emerald400: '#34D399',
  emerald100: '#D1FAE5',

  amber600: '#D97706',
  amber500: '#F59E0B',
  amber400: '#FBBF24',
  amber100: '#FEF3C7',

  orange600: '#EA580C',
  orange500: '#F97316',
  orange400: '#FB923C',
  orange100: '#FFEDD5',

  rose600: '#BE123C',
  rose500: '#E11D48',
  rose400: '#FB7185',
  rose100: '#FFE4E6',

  violet500: '#8B5CF6',
  violet400: '#A78BFA',
  violet100: '#EDE9FE',

  teal700: '#0D9488',
  teal500: '#14B8A6',
  teal400: '#2DD4BF',

  amber800: '#92400E',
} as const;

export const spacing = {
  none: 0,
  xxs: 2,
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 24,
  xxxl: 32,
  huge: 48,
} as const;

export const radius = {
  none: 0,
  sm: 6,
  md: 10,
  lg: 14,
  xl: 20,
  xxl: 28,
  pill: 999,
} as const;

export const fontSize = {
  micro: 11,
  caption: 12,
  footnote: 13,
  body: 15,
  callout: 16,
  title3: 18,
  title2: 22,
  title1: 28,
  display: 34,
} as const;

export const lineHeight = {
  micro: 14,
  caption: 16,
  footnote: 18,
  body: 21,
  callout: 22,
  title3: 24,
  title2: 28,
  title1: 34,
  display: 40,
} as const;

/** Minimum touch target. Field use means gloves, motion, and hurry. */
export const HIT_SLOP = { top: 8, bottom: 8, left: 8, right: 8 } as const;
export const MIN_TOUCH = 44;

export const duration = {
  instant: 90,
  fast: 160,
  normal: 240,
  slow: 380,
} as const;

export type SchemeName = 'light' | 'dark';

type ColorSet = {
  // Surfaces
  background: string;
  surface: string;
  surfaceElevated: string;
  surfaceSunken: string;
  overlay: string;
  scrim: string;

  // Lines
  border: string;
  borderStrong: string;
  divider: string;

  // Text
  text: string;
  textSecondary: string;
  textTertiary: string;
  textInverse: string;
  textOnAccent: string;

  // Brand
  accent: string;
  accentPressed: string;
  accentMuted: string;
  accentText: string;

  // Feedback
  success: string;
  successMuted: string;
  warning: string;
  warningMuted: string;
  danger: string;
  dangerMuted: string;
  info: string;
  infoMuted: string;

  // Severity (Low to Critical)
  sevLow: string;
  sevLowMuted: string;
  sevMedium: string;
  sevMediumMuted: string;
  sevHigh: string;
  sevHighMuted: string;
  sevCritical: string;
  sevCriticalMuted: string;

  // Roles
  roleWorker: string;
  roleOfficer: string;
  roleAdmin: string;

  // Map
  mapLand: string;
  mapWater: string;
  mapRoad: string;
  mapGrid: string;

  skeleton: string;
  shadow: string;
  /** Fixed white, for text and icons sitting on a saturated fill in either scheme. */
  white: string;
};

const dark: ColorSet = {
  background: palette.navy900,
  surface: palette.navy,
  surfaceElevated: palette.navy700,
  surfaceSunken: palette.navy950,
  overlay: 'rgba(7,12,22,0.82)',
  scrim: 'rgba(7,12,22,0.6)',

  border: 'rgba(180,192,212,0.14)',
  borderStrong: 'rgba(180,192,212,0.28)',
  divider: 'rgba(180,192,212,0.09)',

  text: palette.navy50,
  textSecondary: palette.navy200,
  textTertiary: palette.navy300,
  textInverse: palette.navy900,
  textOnAccent: palette.white,

  accent: palette.blue400,
  accentPressed: palette.blue500,
  accentMuted: 'rgba(59,130,246,0.16)',
  accentText: palette.blue300,

  success: palette.emerald400,
  successMuted: 'rgba(16,185,129,0.16)',
  warning: palette.amber400,
  warningMuted: 'rgba(245,158,11,0.16)',
  danger: palette.rose400,
  dangerMuted: 'rgba(225,29,72,0.18)',
  info: palette.blue300,
  infoMuted: 'rgba(59,130,246,0.14)',

  // Severity ramp, validated for colour-vision deficiency against this surface
  // (worst adjacent pair: ΔE 12.9 deutan, 16.3 normal). It escalates by hue AND
  // by lightness, and every use in the app pairs it with the severity word, so
  // the level is never carried by colour alone.
  sevLow: palette.teal400,
  sevLowMuted: 'rgba(45,212,191,0.16)',
  sevMedium: palette.amber400,
  sevMediumMuted: 'rgba(251,191,36,0.16)',
  sevHigh: palette.orange500,
  sevHighMuted: 'rgba(249,115,22,0.18)',
  sevCritical: palette.rose500,
  sevCriticalMuted: 'rgba(225,29,72,0.22)',

  roleWorker: palette.teal400,
  roleOfficer: palette.blue400,
  roleAdmin: palette.violet400,

  mapLand: '#101A2B',
  mapWater: '#0C1725',
  mapRoad: 'rgba(180,192,212,0.22)',
  mapGrid: 'rgba(180,192,212,0.07)',

  skeleton: 'rgba(180,192,212,0.10)',
  shadow: '#000000',
  white: palette.white,
};

const light: ColorSet = {
  background: palette.navy50,
  surface: palette.white,
  surfaceElevated: palette.white,
  surfaceSunken: '#E8EDF5',
  overlay: 'rgba(11,18,32,0.55)',
  scrim: 'rgba(11,18,32,0.35)',

  border: 'rgba(11,18,32,0.10)',
  borderStrong: 'rgba(11,18,32,0.20)',
  divider: 'rgba(11,18,32,0.07)',

  text: palette.navy900,
  textSecondary: '#44536E',
  textTertiary: palette.navy400,
  textInverse: palette.white,
  textOnAccent: palette.white,

  accent: palette.blue500,
  accentPressed: palette.blue600,
  accentMuted: 'rgba(37,99,235,0.10)',
  accentText: palette.blue600,

  success: palette.emerald600,
  successMuted: 'rgba(5,150,105,0.12)',
  warning: palette.amber600,
  warningMuted: 'rgba(217,119,6,0.12)',
  danger: palette.rose600,
  dangerMuted: 'rgba(190,18,60,0.10)',
  info: palette.blue600,
  infoMuted: 'rgba(37,99,235,0.10)',

  // Light-mode severity ramp, separately validated on a white surface
  // (ΔE 13.9 protan, 15.5 normal, all steps >= 3:1 contrast). Amber has to go
  // to its 800 step here - a true amber cannot reach 3:1 on white.
  sevLow: palette.teal700,
  sevLowMuted: 'rgba(13,148,136,0.12)',
  sevMedium: palette.amber800,
  sevMediumMuted: 'rgba(146,64,14,0.12)',
  sevHigh: palette.orange600,
  sevHighMuted: 'rgba(234,88,12,0.14)',
  sevCritical: palette.rose600,
  sevCriticalMuted: 'rgba(190,18,60,0.14)',

  roleWorker: palette.teal500,
  roleOfficer: palette.blue500,
  roleAdmin: palette.violet500,

  mapLand: '#E4EBF4',
  mapWater: '#D3E0EF',
  mapRoad: 'rgba(11,18,32,0.18)',
  mapGrid: 'rgba(11,18,32,0.06)',

  skeleton: 'rgba(11,18,32,0.07)',
  shadow: '#0B1220',
  white: palette.white,
};

export const schemes: Record<SchemeName, ColorSet> = { light, dark };
export type Colors = ColorSet;

/** #RRGGBB to `rgba(r, g, b, a)`, for the web boxShadow string. */
function rgba(hex: string, alpha: number): string {
  const value = hex.replace('#', '');
  const full = value.length === 3 ? value.split('').map((c) => c + c).join('') : value;
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/**
 * Elevation, expressed the way each platform wants it.
 *
 * React Native Web deprecated the `shadow*` props in favour of CSS `boxShadow`
 * and warns once per style object otherwise, so the two are kept apart here
 * rather than every component having to branch.
 */
export const elevation = (scheme: SchemeName, level: 0 | 1 | 2 | 3) => {
  if (level === 0) return {};
  const opacity = scheme === 'dark' ? [0, 0.34, 0.44, 0.55] : [0, 0.06, 0.1, 0.16];
  const blur = [0, 6, 14, 28];
  const offset = [0, 2, 6, 14];

  if (Platform.OS === 'web') {
    return {
      boxShadow: `0px ${offset[level]}px ${blur[level]}px ${rgba(schemes[scheme].shadow, opacity[level])}`,
    };
  }

  return {
    shadowColor: schemes[scheme].shadow,
    shadowOpacity: opacity[level],
    shadowRadius: blur[level],
    shadowOffset: { width: 0, height: offset[level] },
    elevation: level * 3,
  };
};
