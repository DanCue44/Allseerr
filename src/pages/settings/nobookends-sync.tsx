import SettingsLayout from '@app/components/Settings/SettingsLayout';
import SettingsNoBookEndsSync from '@app/components/Settings/SettingsNoBookEndsSync';
import useRouteGuard from '@app/hooks/useRouteGuard';
import { Permission } from '@app/hooks/useUser';
import type { NextPage } from 'next';

const NoBookEndsSyncSettingsPage: NextPage = () => {
  useRouteGuard(Permission.ADMIN);
  return (
    <SettingsLayout>
      <SettingsNoBookEndsSync />
    </SettingsLayout>
  );
};

export default NoBookEndsSyncSettingsPage;
