import { Text as RNText, type TextProps as RNTextProps, type TextStyle } from 'react-native';

import { useTheme, type Colors } from '@/theme';

/**
 * The one text component.
 *
 * Screens never set a font size or colour directly - they choose a semantic
 * variant. That keeps the type scale consistent and, more importantly, keeps
 * contrast correct in both themes without every screen having to think about it.
 */

export type TextVariant =
  | 'display'
  | 'title1'
  | 'title2'
  | 'title3'
  | 'body'
  | 'bodyStrong'
  | 'callout'
  | 'footnote'
  | 'caption'
  | 'micro'
  | 'mono'
  | 'label';

export type TextTone = 'default' | 'secondary' | 'tertiary' | 'accent' | 'success' | 'warning' | 'danger' | 'inverse';

export type AppTextProps = RNTextProps & {
  variant?: TextVariant;
  tone?: TextTone;
  color?: string;
  weight?: TextStyle['fontWeight'];
  align?: TextStyle['textAlign'];
  /** Renders numbers with tabular figures so columns line up. */
  tabular?: boolean;
};

const TONE_KEY: Record<TextTone, keyof Colors> = {
  default: 'text',
  secondary: 'textSecondary',
  tertiary: 'textTertiary',
  accent: 'accentText',
  success: 'success',
  warning: 'warning',
  danger: 'danger',
  inverse: 'textInverse',
};

export function Text({
  variant = 'body',
  tone = 'default',
  color,
  weight,
  align,
  tabular,
  style,
  ...rest
}: AppTextProps) {
  const theme = useTheme();
  const { fontSize, lineHeight, colors } = theme;

  const variants: Record<TextVariant, TextStyle> = {
    display: { fontSize: fontSize.display, lineHeight: lineHeight.display, fontWeight: '800', letterSpacing: -0.6 },
    title1: { fontSize: fontSize.title1, lineHeight: lineHeight.title1, fontWeight: '700', letterSpacing: -0.4 },
    title2: { fontSize: fontSize.title2, lineHeight: lineHeight.title2, fontWeight: '700', letterSpacing: -0.3 },
    title3: { fontSize: fontSize.title3, lineHeight: lineHeight.title3, fontWeight: '600', letterSpacing: -0.2 },
    callout: { fontSize: fontSize.callout, lineHeight: lineHeight.callout, fontWeight: '500' },
    body: { fontSize: fontSize.body, lineHeight: lineHeight.body, fontWeight: '400' },
    bodyStrong: { fontSize: fontSize.body, lineHeight: lineHeight.body, fontWeight: '600' },
    footnote: { fontSize: fontSize.footnote, lineHeight: lineHeight.footnote, fontWeight: '400' },
    caption: { fontSize: fontSize.caption, lineHeight: lineHeight.caption, fontWeight: '500' },
    micro: { fontSize: fontSize.micro, lineHeight: lineHeight.micro, fontWeight: '600' },
    // Section headers: small, wide-tracked, quiet.
    label: {
      fontSize: fontSize.micro,
      lineHeight: lineHeight.micro,
      fontWeight: '700',
      letterSpacing: 0.8,
      textTransform: 'uppercase',
    },
    mono: {
      fontSize: fontSize.footnote,
      lineHeight: lineHeight.footnote,
      fontWeight: '500',
      fontVariant: ['tabular-nums'],
    },
  };

  return (
    <RNText
      {...rest}
      style={[
        variants[variant],
        { color: color ?? colors[TONE_KEY[tone]] },
        weight ? { fontWeight: weight } : null,
        align ? { textAlign: align } : null,
        tabular ? { fontVariant: ['tabular-nums'] } : null,
        style,
      ]}
    />
  );
}
