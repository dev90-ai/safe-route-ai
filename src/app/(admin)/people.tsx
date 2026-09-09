import Feather from '@expo/vector-icons/Feather';
import { useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import { Pressable, View } from 'react-native';

import { orgApi } from '@/api/endpoints/org';
import type { Invite, Profile, Role } from '@/api/types';
import { RoleBadge } from '@/components/domain/Badges';
import {
  Avatar,
  Badge,
  Banner,
  Button,
  Card,
  ConfirmSheet,
  EmptyState,
  Field,
  Header,
  ListRow,
  MultiSelect,
  OptionSheet,
  Screen,
  Section,
  Segmented,
  Sheet,
  SkeletonCard,
  Text,
} from '@/components/ui';
import { REGIONS, regionNames } from '@/constants/regions';
import { ROLE_META } from '@/constants/threats';
import { useQuery } from '@/hooks/use-query';
import { useNow } from '@/hooks/use-now';
import { timeAgo, timeUntil } from '@/lib/format';
import { useAuth } from '@/state/auth';
import { useToast } from '@/state/toast';
import { useTheme } from '@/theme';

/**
 * People management.
 *
 * The guards here are the interesting part: an admin cannot change their own
 * role, cannot deactivate themselves, and cannot remove the last active admin.
 * All three are enforced by the API - this screen just explains them before the
 * user hits the wall.
 */
export default function PeopleScreen() {
  const { colors, spacing } = useTheme();
  const router = useRouter();
  const toast = useToast();
  const { user } = useAuth();

  const [tab, setTab] = useState<'members' | 'invites'>('members');
  const [search, setSearch] = useState('');
  const [detail, setDetail] = useState<Profile | null>(null);
  const [roleSheet, setRoleSheet] = useState(false);
  const [regionSheet, setRegionSheet] = useState(false);
  const [pendingRegions, setPendingRegions] = useState<string[]>([]);
  const [deactivateTarget, setDeactivateTarget] = useState<Profile | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<Invite | null>(null);
  const [busy, setBusy] = useState(false);

  const now = useNow(60_000);

  const members = useQuery({
    key: 'org.members',
    fetcher: () => orgApi.members(),
    watch: ['profiles'],
  });

  const invites = useQuery({
    key: 'org.invites',
    fetcher: () => orgApi.invites(),
    watch: ['invites'],
  });

  const filtered = useMemo(() => {
    const list = members.data ?? [];
    const q = search.trim().toLowerCase();
    if (!q) return list;
    return list.filter(
      (m) => m.fullName.toLowerCase().includes(q) || m.email.toLowerCase().includes(q) || (m.jobTitle ?? '').toLowerCase().includes(q),
    );
  }, [members.data, search]);

  const grouped = useMemo(() => {
    const byRole: Record<Role, Profile[]> = { admin: [], officer: [], worker: [] };
    for (const member of filtered) byRole[member.role].push(member);
    return byRole;
  }, [filtered]);

  const activeAdmins = (members.data ?? []).filter((m) => m.role === 'admin' && m.status === 'active').length;
  const pendingInvites = (invites.data ?? []).filter((i) => !i.acceptedAt);

  const run = async (action: () => Promise<unknown>, success: string) => {
    setBusy(true);
    try {
      await action();
      toast.success(success);
      await Promise.all([members.refetch(), invites.refetch()]);
    } catch (e) {
      const error = e as { userMessage?: string };
      toast.error('Could not complete that', error.userMessage ?? 'Try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Screen
        refreshing={members.isRefreshing}
        onRefresh={() => void (tab === 'members' ? members.refetch() : invites.refetch())}
        extraBottomPadding={40}
      >
        <Header
          title="People"
          subtitle={`${members.data?.length ?? 0} in ${user!.organization.acronym}`}
          right={<Button label="Invite" icon="user-plus" size="sm" onPress={() => router.push('/people/invite')} />}
        />

        <View style={{ gap: spacing.xl }}>
          <Segmented
            options={[
              { value: 'members', label: 'Members' },
              { value: 'invites', label: 'Invites', badge: pendingInvites.length },
            ]}
            value={tab}
            onChange={setTab}
          />

          {tab === 'members' ? (
            <>
              <Field
                placeholder="Search by name, email or role"
                value={search}
                onChangeText={setSearch}
                icon="search"
                autoCapitalize="none"
              />

              {members.isLoading && !members.data ? (
                <SkeletonCard lines={4} />
              ) : filtered.length === 0 ? (
                <EmptyState icon="users" title="Nobody matches that search" message="Try a different name or email." />
              ) : (
                (['admin', 'officer', 'worker'] as Role[]).map((role) =>
                  grouped[role].length ? (
                    <Section
                      key={role}
                      title={`${ROLE_META[role].label}s (${grouped[role].length})`}
                      subtitle={ROLE_META[role].description}
                    >
                      <Card padded={false}>
                        <View style={{ paddingHorizontal: spacing.lg }}>
                          {grouped[role].map((member, index) => (
                            <View key={member.id}>
                              {index > 0 ? <View style={{ height: 1, backgroundColor: colors.divider }} /> : null}
                              <Pressable
                                onPress={() => {
                                  setDetail(member);
                                  setPendingRegions(member.operatingRegions);
                                }}
                                accessibilityRole="button"
                                accessibilityLabel={`${member.fullName}, ${member.role}`}
                                style={({ pressed }) => ({
                                  flexDirection: 'row',
                                  alignItems: 'center',
                                  gap: spacing.md,
                                  paddingVertical: spacing.md,
                                  opacity: pressed ? 0.7 : member.status === 'deactivated' ? 0.5 : 1,
                                })}
                              >
                                <Avatar name={member.fullName} color={member.avatarColor} size={40} />
                                <View style={{ flex: 1, gap: 3 }}>
                                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                                    <Text variant="body" weight="600">
                                      {member.fullName}
                                    </Text>
                                    {member.id === user!.profile.id ? <Badge label="You" size="sm" /> : null}
                                    {member.status === 'deactivated' ? (
                                      <Badge label="Deactivated" size="sm" color={colors.danger} background={colors.dangerMuted} />
                                    ) : null}
                                  </View>
                                  <Text variant="caption" tone="tertiary" numberOfLines={1}>
                                    {member.jobTitle ?? member.email}
                                  </Text>
                                  {member.operatingRegions.length ? (
                                    <Text variant="caption" tone="tertiary" numberOfLines={1}>
                                      {regionNames(member.operatingRegions)}
                                    </Text>
                                  ) : member.role === 'worker' ? (
                                    <Text variant="caption" tone="warning">
                                      No regions set - will miss region alerts
                                    </Text>
                                  ) : null}
                                </View>
                                <Feather name="chevron-right" size={17} color={colors.textTertiary} />
                              </Pressable>
                            </View>
                          ))}
                        </View>
                      </Card>
                    </Section>
                  ) : null,
                )
              )}
            </>
          ) : (
            <>
              {invites.isLoading && !invites.data ? (
                <SkeletonCard lines={3} />
              ) : pendingInvites.length === 0 ? (
                <EmptyState
                  icon="mail"
                  title="No outstanding invites"
                  message="Invite someone to add them to your organisation. The code they receive sets their role and their initial regions."
                  action={{ label: 'Invite someone', onPress: () => router.push('/people/invite'), icon: 'user-plus' }}
                />
              ) : (
                <View style={{ gap: spacing.md }}>
                  {pendingInvites.map((invite) => {
                    const expired = Date.parse(invite.expiresAt) < now;
                    return (
                      <Card key={invite.id} style={{ opacity: expired ? 0.6 : 1 }}>
                        <View style={{ gap: spacing.md }}>
                          <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.md }}>
                            <Avatar name={invite.fullName} size={38} />
                            <View style={{ flex: 1, gap: 2 }}>
                              <Text variant="bodyStrong">{invite.fullName}</Text>
                              <Text variant="caption" tone="tertiary">
                                {invite.email}
                              </Text>
                            </View>
                            <RoleBadge role={invite.role} />
                          </View>

                          <View
                            style={{
                              flexDirection: 'row',
                              alignItems: 'center',
                              justifyContent: 'space-between',
                              padding: spacing.md,
                              borderRadius: 10,
                              backgroundColor: colors.surfaceSunken,
                            }}
                          >
                            <View style={{ gap: 2 }}>
                              <Text variant="micro" tone="tertiary">
                                Invite code
                              </Text>
                              <Text variant="title3" tabular weight="700">
                                {invite.code}
                              </Text>
                            </View>
                            <Badge
                              label={expired ? 'Expired' : `Expires ${timeUntil(invite.expiresAt)}`}
                              size="sm"
                              color={expired ? colors.danger : colors.textSecondary}
                            />
                          </View>

                          {invite.operatingRegions.length ? (
                            <Text variant="caption" tone="tertiary">
                              Regions: {regionNames(invite.operatingRegions)}
                            </Text>
                          ) : null}

                          <Text variant="caption" tone="tertiary">
                            Created {timeAgo(invite.createdAt)}
                          </Text>

                          <Button
                            label="Revoke invite"
                            icon="trash-2"
                            variant="ghost"
                            size="sm"
                            onPress={() => setRevokeTarget(invite)}
                          />
                        </View>
                      </Card>
                    );
                  })}
                </View>
              )}

              <Banner
                tone="neutral"
                icon="key"
                title="Invite codes bind role and organisation"
                message="Nobody can self-register into your organisation. The code is what grants membership, so treat it as a credential and send it to the named person directly."
              />
            </>
          )}
        </View>
      </Screen>

      {/* Member detail */}
      <Sheet
        visible={!!detail}
        onClose={() => setDetail(null)}
        title={detail?.fullName}
        subtitle={detail?.email}
      >
        {detail ? (
          <View style={{ gap: spacing.lg }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.md }}>
              <Avatar name={detail.fullName} color={detail.avatarColor} size={52} />
              <View style={{ flex: 1, gap: 4 }}>
                <RoleBadge role={detail.role} size="md" />
                <Text variant="caption" tone="tertiary">
                  {detail.jobTitle ?? 'No role title set'}
                </Text>
                <Text variant="caption" tone="tertiary">
                  Last seen {detail.lastSeenAt ? timeAgo(detail.lastSeenAt) : 'never'}
                </Text>
              </View>
            </View>

            <Card level={0} style={{ backgroundColor: colors.surfaceSunken }}>
              <View style={{ gap: 2 }}>
                <Text variant="micro" tone="tertiary">
                  Operating regions
                </Text>
                <Text variant="footnote">
                  {detail.operatingRegions.length ? regionNames(detail.operatingRegions) : 'None set'}
                </Text>
              </View>
            </Card>

            {detail.role === 'worker' && !detail.operatingRegions.length ? (
              <Banner
                tone="warning"
                compact
                message="Without regions, this worker is only alerted when a threat falls inside its radius of their last known position."
              />
            ) : null}

            <View style={{ gap: 2 }}>
              <ListRow
                icon="shield"
                title="Change role"
                subtitle={ROLE_META[detail.role].label}
                onPress={
                  detail.id === user!.profile.id
                    ? undefined
                    : () => setRoleSheet(true)
                }
                right={
                  detail.id === user!.profile.id ? (
                    <Badge label="Not your own" size="sm" />
                  ) : undefined
                }
              />
              <ListRow
                icon="map"
                title="Set operating regions"
                subtitle={`${detail.operatingRegions.length} selected`}
                onPress={() => setRegionSheet(true)}
              />
              <ListRow
                icon={detail.status === 'active' ? 'user-x' : 'user-check'}
                title={detail.status === 'active' ? 'Deactivate account' : 'Reactivate account'}
                subtitle={
                  detail.status === 'active'
                    ? 'Revokes all their sessions immediately'
                    : 'Restores access with the same role'
                }
                destructive={detail.status === 'active'}
                onPress={
                  detail.id === user!.profile.id
                    ? undefined
                    : () =>
                        detail.status === 'active'
                          ? setDeactivateTarget(detail)
                          : void run(() => orgApi.setStatus(detail.id, 'active'), 'Account reactivated')
                }
              />
            </View>

            {detail.role === 'admin' && activeAdmins <= 1 ? (
              <Banner
                tone="warning"
                compact
                icon="alert-triangle"
                message="This is the only active admin. Their role and status cannot be changed until another admin exists."
              />
            ) : null}
          </View>
        ) : null}
      </Sheet>

      {/* Role picker */}
      <OptionSheet
        visible={roleSheet}
        onClose={() => setRoleSheet(false)}
        title="Change role"
        subtitle="This takes effect immediately and is recorded in the audit log."
        value={detail?.role ?? null}
        onSelect={(role) => {
          if (!detail) return;
          void run(() => orgApi.setRole(detail.id, role), 'Role updated').then(() => setDetail(null));
        }}
        options={(['worker', 'officer', 'admin'] as Role[]).map((role) => ({
          value: role,
          label: ROLE_META[role].label,
          description: ROLE_META[role].description,
          icon: role === 'admin' ? 'settings' : role === 'officer' ? 'shield' : 'user',
          color: colors[ROLE_META[role].colorKey],
        }))}
      />

      {/* Region editor */}
      <Sheet
        visible={regionSheet}
        onClose={() => setRegionSheet(false)}
        title="Operating regions"
        subtitle={detail?.fullName}
        footer={
          <Button
            label="Save regions"
            fullWidth
            size="lg"
            loading={busy}
            onPress={() => {
              if (!detail) return;
              void run(() => orgApi.setMemberRegions(detail.id, pendingRegions), 'Regions updated').then(() => {
                setRegionSheet(false);
                setDetail(null);
              });
            }}
          />
        }
      >
        <MultiSelect
          options={REGIONS.map((r) => ({ value: r.id, label: r.name, group: r.county }))}
          selected={pendingRegions}
          onChange={setPendingRegions}
          searchPlaceholder="Search regions"
          groupBy
        />
      </Sheet>

      <ConfirmSheet
        visible={!!deactivateTarget}
        onClose={() => setDeactivateTarget(null)}
        onConfirm={() => {
          if (!deactivateTarget) return;
          void run(() => orgApi.setStatus(deactivateTarget.id, 'deactivated'), 'Account deactivated').then(() => {
            setDeactivateTarget(null);
            setDetail(null);
          });
        }}
        loading={busy}
        title={`Deactivate ${deactivateTarget?.fullName}?`}
        confirmLabel="Deactivate"
        message="Every active session is revoked immediately and they can no longer sign in. Their past reports and the audit trail are kept. You can reactivate them later."
      />

      <ConfirmSheet
        visible={!!revokeTarget}
        onClose={() => setRevokeTarget(null)}
        onConfirm={() => {
          if (!revokeTarget) return;
          void run(() => orgApi.revokeInvite(revokeTarget.id), 'Invite revoked').then(() => setRevokeTarget(null));
        }}
        loading={busy}
        title="Revoke this invite?"
        confirmLabel="Revoke"
        message={`The code ${revokeTarget?.code} will stop working. ${revokeTarget?.fullName} will not be able to create an account with it.`}
      />
    </>
  );
}
