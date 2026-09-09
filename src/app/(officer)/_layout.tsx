import { Redirect } from 'expo-router';
import { Tabs } from 'expo-router/js-tabs';
import { useCallback } from 'react';

import { sosApi } from '@/api/endpoints/sos';
import { analyticsApi } from '@/api/endpoints/analytics';
import { TabBar, type TabItem } from '@/components/domain/TabBar';
import { useQuery } from '@/hooks/use-query';
import { useAuth } from '@/state/auth';

const TABS: TabItem[] = [
  { name: 'index', label: 'Queue', icon: 'inbox' },
  { name: 'sos', label: 'SOS', icon: 'radio' },
  { name: 'map', label: 'Map', icon: 'map' },
  { name: 'advisories', label: 'Advisories', icon: 'volume-2' },
  { name: 'activity', label: 'Activity', icon: 'activity' },
];

export default function OfficerLayout() {
  const { status, user } = useAuth();

  // Badges are live: an officer must see a new SOS without opening the tab.
  const summary = useQuery({
    key: user ? `officer.summary.${user.profile.id}` : null,
    fetcher: () => analyticsApi.officerSummary(),
    watch: ['reports', 'sosEvents'],
    pollMs: 30_000,
    enabled: !!user && user.profile.role === 'officer',
  });

  const sos = useQuery({
    key: user ? 'sos.active' : null,
    fetcher: () => sosApi.active(),
    watch: ['sosEvents'],
    pollMs: 15_000,
    enabled: !!user && user.profile.role === 'officer',
  });

  const getBadge = useCallback(
    (name: string) => {
      if (name === 'index') return summary.data?.pendingCount ?? 0;
      if (name === 'sos') return sos.data?.length ?? 0;
      return 0;
    },
    [summary.data, sos.data],
  );


  if (status === 'signed-out') return <Redirect href="/(auth)/sign-in" />;
  if (user && user.profile.role !== 'officer') return <Redirect href="/" />;

  return (
    <Tabs tabBar={(props) => <TabBar {...props} items={TABS} getBadge={getBadge} />} screenOptions={{ headerShown: false }}>
      {TABS.map((tab) => (
        <Tabs.Screen key={tab.name} name={tab.name} options={{ title: tab.label }} />
      ))}
    </Tabs>
  );
}
