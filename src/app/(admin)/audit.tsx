import Feather from '@expo/vector-icons/Feather';
import { useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import { Pressable, View } from 'react-native';

import { orgApi } from '@/api/endpoints/org';
import type { AuditEntry } from '@/api/types';
import {
  Badge,
  Banner,
  Card,
  Chip,
  ChipRow,
  EmptyState,
  Field,
  Header,
  Screen,
  SkeletonCard,
  Text,
} from '@/components/ui';
import { useQuery } from '@/hooks/use-query';
import { formatDateTime } from '@/lib/format';
import { useTheme } from '@/theme';

/**
 * The organisation-wide audit log.
 *
 * Append-only and unfiltered by default. This is the artefact that makes the
 * whole "AI is advisory, humans decide" claim checkable after the fact: for
 * every verified threat there is a row naming the officer, the time, and what
 * they changed from the model's suggestion.
 */

const ENTITY_FILTERS = ['all', 'report', 'alert', 'sos', 'profile', 'organization', 'auth'] as const;

export default function AuditScreen() {
  const { colors, spacing } = useTheme();
  const router = useRouter();

  const [entity, setEntity] = useState<(typeof ENTITY_FILTERS)[number]>('all');
  const [search, setSearch] = useState('');

  const audit = useQuery({
    key: `audit.admin.${entity}.${search}`,
    fetcher: () =>
      orgApi.auditLog({
        limit: 150,
        entity: entity === 'all' ? undefined : (entity as AuditEntry['entity']),
        search: search.trim() || undefined,
      }),
    watch: ['audit'],
  });

  // Group by day so the log reads as a history rather than a wall.
  const grouped = useMemo(() => {
    const map = new Map<string, AuditEntry[]>();
    for (const entry of audit.data ?? []) {
      const day = new Date(entry.ts).toDateString();
      map.set(day, [...(map.get(day) ?? []), entry]);
    }
    return [...map.entries()];
  }, [audit.data]);

  const dotColor = (entry: AuditEntry) => {
    if (entry.action.includes('sos')) return colors.danger;
    if (entry.action.includes('dismiss') || entry.action.includes('revoke') || entry.action.includes('deactivat'))
      return colors.warning;
    if (entry.action.includes('verified')) return colors.success;
    if (entry.actorRole === 'system') return colors.textTertiary;
    return colors.accent;
  };

  const navigate = (entry: AuditEntry) => {
    if (entry.entity === 'report') router.push({ pathname: '/report/[id]', params: { id: entry.entityId } });
    else if (entry.entity === 'sos') router.push({ pathname: '/sos/[id]', params: { id: entry.entityId } });
    else if (entry.entity === 'alert') router.push({ pathname: '/alert/[id]', params: { id: entry.entityId } });
  };

  return (
    <Screen refreshing={audit.isRefreshing} onRefresh={() => void audit.refetch()} extraBottomPadding={40}>
      <Header title="Audit log" subtitle="Every state change, with who made it" />

      <View style={{ gap: spacing.lg }}>
        <Field
          placeholder="Search the log"
          value={search}
          onChangeText={setSearch}
          icon="search"
          autoCapitalize="none"
        />

        <ChipRow>
          {ENTITY_FILTERS.map((option) => (
            <Chip
              key={option}
              label={option === 'all' ? 'Everything' : option}
              selected={entity === option}
              onPress={() => setEntity(option)}
            />
          ))}
        </ChipRow>

        {audit.isLoading && !audit.data ? (
          <SkeletonCard lines={6} />
        ) : !grouped.length ? (
          <EmptyState
            icon="list"
            title="Nothing matches"
            message={search ? 'Try a different search term.' : 'Actions appear here as they happen.'}
            action={search ? { label: 'Clear search', onPress: () => setSearch('') } : undefined}
          />
        ) : (
          grouped.map(([day, entries]) => (
            <View key={day} style={{ gap: spacing.md }}>
              <Text variant="label" tone="tertiary">
                {day === new Date().toDateString() ? 'Today' : day}
              </Text>

              <Card>
                <View style={{ gap: spacing.lg }}>
                  {entries.map((entry, index) => {
                    const navigable = ['report', 'sos', 'alert'].includes(entry.entity);
                    return (
                      <Pressable
                        key={entry.id}
                        disabled={!navigable}
                        onPress={() => navigate(entry)}
                        accessibilityRole={navigable ? 'button' : 'none'}
                        accessibilityLabel={entry.summary}
                        style={({ pressed }) => ({
                          flexDirection: 'row',
                          gap: spacing.md,
                          opacity: pressed ? 0.7 : 1,
                        })}
                      >
                        <View style={{ alignItems: 'center', width: 18 }}>
                          <View
                            style={{
                              width: 8,
                              height: 8,
                              borderRadius: 4,
                              marginTop: 5,
                              backgroundColor: dotColor(entry),
                            }}
                          />
                          {index < entries.length - 1 ? (
                            <View style={{ flex: 1, width: 1, backgroundColor: colors.divider, marginTop: 3 }} />
                          ) : null}
                        </View>

                        <View style={{ flex: 1, gap: 5, paddingBottom: spacing.sm }}>
                          <Text variant="footnote">{entry.summary}</Text>

                          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                            <Badge label={entry.action} size="sm" />
                            <Text variant="caption" tone="tertiary">
                              {formatDateTime(entry.ts)}
                            </Text>
                            {entry.actorRole === 'system' ? (
                              <Badge label="system" size="sm" color={colors.textTertiary} />
                            ) : null}
                          </View>

                          {/* Before/after is what makes an override visible */}
                          {entry.before && entry.after ? (
                            <View
                              style={{
                                padding: spacing.sm,
                                borderRadius: 8,
                                backgroundColor: colors.surfaceSunken,
                                gap: 2,
                              }}
                            >
                              <Text variant="micro" tone="tertiary">
                                {Object.entries(entry.after)
                                  .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
                                  .join('  ·  ')}
                              </Text>
                            </View>
                          ) : null}
                        </View>

                        {navigable ? (
                          <Feather name="chevron-right" size={15} color={colors.textTertiary} style={{ marginTop: 2 }} />
                        ) : null}
                      </Pressable>
                    );
                  })}
                </View>
              </Card>
            </View>
          ))
        )}

        <Banner
          tone="neutral"
          icon="lock"
          title="Append-only"
          message="Nothing here can be edited or deleted from the app. Retention and export are configured server-side."
        />
      </View>
    </Screen>
  );
}
