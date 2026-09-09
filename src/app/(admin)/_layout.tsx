import { Redirect } from 'expo-router';
import { Tabs } from 'expo-router/js-tabs';

import { TabBar, type TabItem } from '@/components/domain/TabBar';
import { useAuth } from '@/state/auth';

const TABS: TabItem[] = [
  { name: 'index', label: 'Overview', icon: 'bar-chart-2' },
  { name: 'people', label: 'People', icon: 'users' },
  { name: 'organization', label: 'Organisation', icon: 'briefcase' },
  { name: 'audit', label: 'Audit', icon: 'list' },
];

export default function AdminLayout() {
  const { status, user } = useAuth();

  if (status === 'signed-out') return <Redirect href="/(auth)/sign-in" />;
  if (user && user.profile.role !== 'admin') return <Redirect href="/" />;

  return (
    <Tabs tabBar={(props) => <TabBar {...props} items={TABS} />} screenOptions={{ headerShown: false }}>
      {TABS.map((tab) => (
        <Tabs.Screen key={tab.name} name={tab.name} options={{ title: tab.label }} />
      ))}
    </Tabs>
  );
}
