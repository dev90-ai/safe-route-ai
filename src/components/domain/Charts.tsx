import { useState } from 'react';
import { Pressable, View, type LayoutChangeEvent } from 'react-native';
import Svg, { Line, Rect } from 'react-native-svg';

import { useTheme } from '@/theme';
import { Text } from '../ui/Text';

/**
 * Charts.
 *
 * Deliberately small and specific rather than a generic charting layer. Three
 * rules they all follow:
 *
 *  - **One axis, never two.** Two measures at different scales get two charts.
 *  - **Colour never carries identity alone.** Every series is either the only
 *    one (so the title names it) or is direct-labelled next to its mark.
 *  - **Recessive chrome.** The grid and axes are barely there; the data is the
 *    only thing with contrast.
 */

const CHART_PAD = { top: 12, right: 8, bottom: 20, left: 30 };

/**
 * Daily volume. A single series, so no legend - the title says what it is.
 * Tapping a bar reveals its value rather than printing a number on all thirty.
 */
export function TrendChart({
  data,
  height = 140,
  color,
  label,
}: {
  data: { date: string; total: number }[];
  height?: number;
  color?: string;
  label?: string;
}) {
  const { colors } = useTheme();
  const [width, setWidth] = useState(0);
  const [active, setActive] = useState<number | null>(null);

  const tint = color ?? colors.accent;
  const max = Math.max(1, ...data.map((d) => d.total));

  const plotW = Math.max(1, width - CHART_PAD.left - CHART_PAD.right);
  const plotH = Math.max(1, height - CHART_PAD.top - CHART_PAD.bottom);
  const step = data.length ? plotW / data.length : plotW;
  const barW = Math.max(2, Math.min(14, step - 2));

  const onLayout = (e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width);

  return (
    <View style={{ gap: 6 }}>
      {label ? (
        <Text variant="caption" tone="tertiary">
          {label}
        </Text>
      ) : null}

      <Pressable
        onLayout={onLayout}
        onPress={(e) => {
          const x = e.nativeEvent.locationX - CHART_PAD.left;
          const index = Math.floor(x / step);
          setActive(index >= 0 && index < data.length ? index : null);
        }}
        accessibilityRole="image"
        accessibilityLabel={`Daily report volume. Peak ${max} on one day, ${data.reduce((s, d) => s + d.total, 0)} in total.`}
        style={{ height }}
      >
        {width > 0 ? (
          <Svg width={width} height={height}>
            {/* Recessive gridlines */}
            {[0, 0.5, 1].map((ratio) => {
              const y = CHART_PAD.top + plotH * (1 - ratio);
              return (
                <Line
                  key={ratio}
                  x1={CHART_PAD.left}
                  y1={y}
                  x2={width - CHART_PAD.right}
                  y2={y}
                  stroke={colors.divider}
                  strokeWidth={1}
                />
              );
            })}

            {data.map((point, index) => {
              const barH = (point.total / max) * plotH;
              const x = CHART_PAD.left + index * step + (step - barW) / 2;
              const y = CHART_PAD.top + plotH - barH;
              const isActive = active === index;
              return (
                <Rect
                  key={point.date}
                  x={x}
                  y={point.total === 0 ? CHART_PAD.top + plotH - 1 : y}
                  width={barW}
                  height={point.total === 0 ? 1 : Math.max(2, barH)}
                  rx={Math.min(4, barW / 2)}
                  fill={tint}
                  opacity={active === null ? 0.85 : isActive ? 1 : 0.3}
                />
              );
            })}
          </Svg>
        ) : null}
      </Pressable>

      <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
        <Text variant="micro" tone="tertiary">
          {data[0]?.date.slice(5) ?? ''}
        </Text>
        {active !== null && data[active] ? (
          <Text variant="micro" weight="700" color={tint}>
            {data[active].date.slice(5)}: {data[active].total} report{data[active].total === 1 ? '' : 's'}
          </Text>
        ) : (
          <Text variant="micro" tone="tertiary">
            tap a bar for detail
          </Text>
        )}
        <Text variant="micro" tone="tertiary">
          {data[data.length - 1]?.date.slice(5) ?? ''}
        </Text>
      </View>
    </View>
  );
}

/**
 * Ranked horizontal bars. Direct-labelled on both ends, so the colour is
 * decoration rather than the key - which is what lets it carry severity tint
 * without becoming colour-only encoding.
 */
export function RankedBars({
  data,
  max: providedMax,
  emptyMessage = 'Nothing recorded in this period.',
}: {
  data: { label: string; count: number; color?: string }[];
  max?: number;
  emptyMessage?: string;
}) {
  const { colors, radius, spacing } = useTheme();
  const max = providedMax ?? Math.max(1, ...data.map((d) => d.count));

  if (!data.length) {
    return (
      <Text variant="footnote" tone="tertiary">
        {emptyMessage}
      </Text>
    );
  }

  return (
    <View style={{ gap: spacing.md }}>
      {data.map((row) => (
        <View key={row.label} style={{ gap: 5 }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
            <Text variant="footnote" tone="secondary" numberOfLines={1} style={{ flex: 1 }}>
              {row.label}
            </Text>
            <Text variant="footnote" weight="700" tabular>
              {row.count}
            </Text>
          </View>
          <View
            style={{
              height: 6,
              borderRadius: radius.pill,
              backgroundColor: colors.surfaceSunken,
              overflow: 'hidden',
            }}
          >
            <View
              style={{
                width: `${Math.max(1.5, (row.count / max) * 100)}%`,
                height: '100%',
                borderRadius: radius.pill,
                backgroundColor: row.color ?? colors.accent,
              }}
            />
          </View>
        </View>
      ))}
    </View>
  );
}

/**
 * Proportional segments in a single bar, with a labelled legend beneath.
 * Segments are separated by a 2px surface gap so adjacent fills never merge.
 */
export function SegmentBar({
  segments,
  height = 10,
}: {
  segments: { label: string; count: number; color: string }[];
  height?: number;
}) {
  const { radius, spacing } = useTheme();
  const total = segments.reduce((sum, s) => sum + s.count, 0);

  if (total === 0) {
    return (
      <Text variant="footnote" tone="tertiary">
        Nothing recorded in this period.
      </Text>
    );
  }

  const visible = segments.filter((s) => s.count > 0);

  return (
    <View style={{ gap: spacing.md }}>
      <View style={{ flexDirection: 'row', height, gap: 2 }}>
        {visible.map((segment) => (
          <View
            key={segment.label}
            style={{
              flex: segment.count,
              backgroundColor: segment.color,
              borderRadius: radius.pill,
            }}
          />
        ))}
      </View>

      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md }}>
        {segments.map((segment) => (
          <View key={segment.label} style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
            <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: segment.color }} />
            <Text variant="caption" tone="secondary">
              {segment.label}
            </Text>
            <Text variant="caption" weight="700" tabular>
              {segment.count}
            </Text>
          </View>
        ))}
      </View>
    </View>
  );
}

/**
 * A hero number with a supporting line. Used where a single value is the whole
 * answer and a chart would be decoration.
 */
export function HeroStat({
  value,
  label,
  detail,
  tone,
}: {
  value: string;
  label: string;
  detail?: string;
  tone?: string;
}) {
  return (
    <View style={{ gap: 4 }}>
      <Text variant="caption" tone="tertiary">
        {label}
      </Text>
      <Text variant="display" color={tone} tabular>
        {value}
      </Text>
      {detail ? (
        <Text variant="footnote" tone="secondary">
          {detail}
        </Text>
      ) : null}
    </View>
  );
}
