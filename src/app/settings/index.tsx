import Constants from 'expo-constants';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';

import { RoleBadge } from '@/components/domain/Badges';
import { OfflineBanner } from '@/components/domain/StatusBanners';
import {
  Avatar,
  Badge,
  Banner,
  Button,
  Card,
  ConfirmSheet,
  Header,
  ListRow,
  Screen,
  Section,
  Segmented,
  Text,
  Toggle,
} from '@/components/ui';
import { regionNames } from '@/constants/regions';

import { timeAgo } from '@/lib/format';
import { useAuth } from '@/state/auth';
import { useConnectivity } from '@/state/connectivity';
import { useNotifications } from '@/state/notifications';
import { useToast } from '@/state/toast';
import { useTheme, type ThemePreference } from '@/theme';

/**
 * Settings hub.
 *
 * Grouped by what the user is trying to change - themselves, what reaches them,
 * how the app looks, what is on the device - rather than by which subsystem
 * owns the setting.
 */
export default function SettingsScreen() {
  const { colors, spacing, preference, setPreference } = useTheme();
  const router = useRouter();
  const toast = useToast();
  const { user, signOut, refresh } = useAuth();
  const notifications = useNotifications();
  const { counts, online } = useConnectivity();

  const [signOutOpen, setSignOutOpen] = useState(false);
  const [savingPrefs, setSavingPrefs] = useState(false);

  const profile = user!.profile;
  const prefs = profile.notificationPreferences;

  const updatePrefs = async (next: Partial<typeof prefs>) => {
    setSavingPrefs(true);
    try {
      const { authApi } = await import('@/api/endpoints/auth');
      await authApi.updateProfile({ notificationPreferences: { ...prefs, ...next } });
      await refresh();
    } catch (e) {
      const error = e as { userMessage?: string };
      toast.error('Could not save', error.userMessage ?? 'Try again.');
    } finally {
      setSavingPrefs(false);
    }
  };

  return (
    <>
      <Screen>
        <Header title="Settings" onBack />

        <View style={{ gap: spacing.xxl }}>
          <OfflineBanner />

          {/* Identity */}
          <Card>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.lg }}>
              <Avatar name={profile.fullName} color={profile.avatarColor} size={56} />
              <View style={{ flex: 1, gap: 4 }}>
                <Text variant="title3">{profile.fullName}</Text>
                <Text variant="caption" tone="tertiary">
                  {profile.email}
                </Text>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 2 }}>
                  <RoleBadge role={profile.role} size="md" />
                  <Badge label={user!.organization.acronym} size="sm" />
                </View>
              </View>
            </View>
          </Card>

          {/* Account */}
          <Section title="Account">
            <Card padded={false}>
              <View style={{ paddingHorizontal: spacing.lg }}>
                <ListRow
                  icon="user"
                  title="Profile"
                  subtitle={profile.jobTitle ?? 'No role title set'}
                  onPress={() => router.push('/settings/profile')}
                />
                {profile.role === 'worker' || profile.role === 'officer' ? (
                  <ListRow
                    icon="map"
                    title="Operating regions"
                    subtitle={
                      profile.operatingRegions.length
                        ? regionNames(profile.operatingRegions)
                        : 'None set - you will miss region alerts'
                    }
                    onPress={() => router.push('/settings/regions')}
                  />
                ) : null}
                <ListRow
                  icon="lock"
                  title="Password"
                  subtitle="Change your password"
                  onPress={() => router.push('/settings/security')}
                />
              </View>
            </Card>
          </Section>

          {/* Alerts */}
          <Section title="Alerts">
            <Card>
              <View style={{ gap: spacing.md }}>
                {notifications.permission === 'unavailable' ? (
                  <Banner
                    tone="neutral"
                    compact
                    icon="bell-off"
                    message={notifications.unavailableMessage ?? ''}
                  />
                ) : notifications.permission !== 'granted' ? (
                  <Banner
                    tone="warning"
                    compact
                    icon="bell-off"
                    message="Push notifications are disabled for this app. You will only see alerts when you open it."
                    action={{ label: 'Enable', onPress: () => void notifications.requestPermission() }}
                  />
                ) : null}

                <Toggle
                  icon="bell"
                  label="Push notifications"
                  description="Verified threats near you or in your regions."
                  value={prefs.push}
                  disabled={savingPrefs}
                  onChange={(v) => void updatePrefs({ push: v })}
                />

                <View style={{ height: 1, backgroundColor: colors.divider }} />

                <Toggle
                  icon="filter"
                  label="Only high and critical"
                  description="Quieter feed. Anything inside its alert radius still reaches you regardless."
                  value={prefs.criticalOnly}
                  disabled={savingPrefs}
                  onChange={(v) => void updatePrefs({ criticalOnly: v })}
                />

                <View style={{ height: 1, backgroundColor: colors.divider }} />

                <Toggle
                  icon="moon"
                  label="Quiet hours"
                  description={`Silence non-critical alerts between ${prefs.quietHours.startHour}:00 and ${prefs.quietHours.endHour}:00. Critical alerts always come through.`}
                  value={prefs.quietHours.enabled}
                  disabled={savingPrefs}
                  onChange={(v) => void updatePrefs({ quietHours: { ...prefs.quietHours, enabled: v } })}
                />
              </View>
            </Card>
          </Section>

          {/* Appearance */}
          <Section title="Appearance">
            <Card>
              <View style={{ gap: spacing.md }}>
                <Text variant="footnote" tone="secondary">
                  Theme
                </Text>
                <Segmented
                  options={[
                    { value: 'dark', label: 'Dark' },
                    { value: 'light', label: 'Light' },
                    { value: 'system', label: 'System' },
                  ]}
                  value={preference}
                  onChange={(v) => setPreference(v as ThemePreference)}
                />
                <Text variant="caption" tone="tertiary">
                  Dark is the default. A bright screen at night is both uncomfortable and, in the field, a way of
                  making yourself visible.
                </Text>
              </View>
            </Card>
          </Section>

          {/* Device */}
          <Section title="This device">
            <Card padded={false}>
              <View style={{ paddingHorizontal: spacing.lg }}>
                <ListRow
                  icon="upload-cloud"
                  title="Outbox"
                  subtitle={
                    counts.total
                      ? `${counts.total} item(s) waiting${counts.failed ? `, ${counts.failed} failed` : ''}`
                      : 'Nothing waiting to send'
                  }
                  onPress={() => router.push('/queue')}
                  right={
                    counts.failed ? (
                      <Badge label={String(counts.failed)} size="sm" color={colors.danger} background={colors.dangerMuted} />
                    ) : counts.total ? (
                      <Badge label={String(counts.total)} size="sm" color={colors.warning} background={colors.warningMuted} />
                    ) : undefined
                  }
                />
                <ListRow
                  icon="activity"
                  title="Diagnostics"
                  subtitle="Connection, request performance, logs"
                  onPress={() => router.push('/diagnostics')}
                  right={
                    !online ? <Badge label="Offline" size="sm" color={colors.warning} background={colors.warningMuted} /> : undefined
                  }
                />
              </View>
            </Card>
          </Section>

          {/* Privacy note - this app handles location data about people at risk */}
          <Banner
            tone="neutral"
            icon="shield"
            title="What this app knows about you"
            message={
              profile.role === 'worker'
                ? 'Your last known position, so alerts can find you. Your reports, visible to your officers with your name and to other workers anonymously. Your live location, but only while you have an SOS active.'
                : 'Your last known position, your verification decisions, and every alert you issue - all recorded in the audit log against your name.'
            }
          />

          <View style={{ gap: spacing.sm }}>
            <Button label="Sign out" variant="secondary" fullWidth icon="log-out" onPress={() => setSignOutOpen(true)} />
            <Text variant="caption" tone="tertiary" align="center">
              Safe Route AI {Constants.expoConfig?.version ?? '1.0.0'} · Last seen{' '}
              {profile.lastSeenAt ? timeAgo(profile.lastSeenAt) : 'now'}
            </Text>
          </View>
        </View>
      </Screen>

      <ConfirmSheet
        visible={signOutOpen}
        onClose={() => setSignOutOpen(false)}
        onConfirm={() => {
          setSignOutOpen(false);
          void signOut();
        }}
        title="Sign out?"
        confirmLabel="Sign out"
        message={
          counts.total
            ? `You have ${counts.total} item(s) still waiting to send. Signing out keeps them on this device, but they will not send until you sign in again.`
            : 'You will need your password to sign back in. Anything saved on this device stays here.'
        }
        tone={counts.total ? 'danger' : 'primary'}
      />
    </>
  );
}
