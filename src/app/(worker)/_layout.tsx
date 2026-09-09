import { Redirect, useRouter, usePathname } from 'expo-router';
import { Tabs } from 'expo-router/js-tabs';
import { useCallback, useState } from 'react';
import { View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { sosApi } from '@/api/endpoints/sos';
import { FloatingSos } from '@/components/domain/SosButton';
import { TabBar, type TabItem } from '@/components/domain/TabBar';
import { Banner, ConfirmSheet, Text } from '@/components/ui';
import { useQuery } from '@/hooks/use-query';
import { useSosTrigger } from '@/hooks/use-sos';
import { useAuth } from '@/state/auth';
import { useConnectivity } from '@/state/connectivity';
import { useNotifications } from '@/state/notifications';

const TABS: TabItem[] = [
  { name: 'index', label: 'Home', icon: 'home' },
  { name: 'map', label: 'Threat map', icon: 'map' },
  { name: 'report', label: 'Report', icon: 'plus-circle' },
  { name: 'route', label: 'Safe route', icon: 'navigation' },
  { name: 'alerts', label: 'Alerts', icon: 'bell' },
];

/** Tab bar height plus a comfortable gap, so SOS never overlaps a tab target. */
const TAB_BAR_HEIGHT = 58;

export default function WorkerLayout() {
  const { status, user } = useAuth();
  const { unreadCount } = useNotifications();
  const { counts, online } = useConnectivity();
  const insets = useSafeAreaInsets();
  const pathname = usePathname();
  const router = useRouter();
  const sos = useSosTrigger();

  const [confirmOpen, setConfirmOpen] = useState(false);

  const activeSos = useQuery({
    key: user ? `sos.mine.${user.profile.id}` : null,
    fetcher: () => sosApi.mine(),
    watch: ['sosEvents'],
    pollMs: 25_000,
    enabled: !!user && user.profile.role === 'worker',
  });

  const getBadge = useCallback(
    (name: string) => {
      if (name === 'alerts') return unreadCount;
      // Anything still in the outbox shows on Report, so a worker who filed
      // offline can see it has not left the device yet.
      if (name === 'report') return counts.pending + counts.sending + counts.failed;
      return 0;
    },
    [unreadCount, counts],
  );


  if (status === 'signed-out') return <Redirect href="/(auth)/sign-in" />;
  if (status === 'onboarding') return <Redirect href="/onboarding" />;
  // Officers and admins have their own tab sets; keep the roles cleanly apart.
  if (user && user.profile.role !== 'worker') return <Redirect href="/" />;

  // Home carries its own labelled SOS card, which doubles as the explanation of
  // what the button does. Everywhere else gets the floating one, so the control
  // is genuinely always within reach.
  const showFloatingSos = !pathname.endsWith('/(worker)') && pathname !== '/';

  return (
    <View style={{ flex: 1 }}>
      <Tabs tabBar={(props) => <TabBar {...props} items={TABS} getBadge={getBadge} />} screenOptions={{ headerShown: false }}>
        {TABS.map((tab) => (
          <Tabs.Screen key={tab.name} name={tab.name} options={{ title: tab.label }} />
        ))}
      </Tabs>

      {showFloatingSos ? (
        <FloatingSos
          active={!!activeSos.data}
          bottom={TAB_BAR_HEIGHT + insets.bottom + 14}
          onActivate={() => {
            // An SOS is already live - take them to it rather than raising a second.
            if (activeSos.data) {
              router.push({ pathname: '/sos/[id]', params: { id: activeSos.data.id } });
              return;
            }
            setConfirmOpen(true);
          }}
        />
      ) : null}

      <ConfirmSheet
        visible={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        onConfirm={async () => {
          setConfirmOpen(false);
          await sos.trigger(null);
          await activeSos.refetch();
        }}
        loading={sos.pending}
        title="Send an SOS?"
        confirmLabel="Yes, send SOS now"
        message={
          online
            ? 'Your security officers will be alerted immediately and will see your live location until they resolve it.'
            : 'You have no signal. The SOS will be saved on this device and sent automatically the moment you reconnect.'
        }
      >
        <Banner
          tone="neutral"
          compact
          icon="map-pin"
          message={
            sos.location.point
              ? `Position: ${sos.location.point.lat.toFixed(4)}, ${sos.location.point.lng.toFixed(4)}${
                  sos.location.accuracyMeters ? ` (±${Math.round(sos.location.accuracyMeters)} m)` : ''
                }`
              : 'No position yet - we will try to get one when you confirm.'
          }
        />
        <Text variant="caption" tone="tertiary" style={{ marginTop: 8 }}>
          You can stand down your own SOS at any time if it was raised by mistake.
        </Text>
      </ConfirmSheet>
    </View>
  );
}
