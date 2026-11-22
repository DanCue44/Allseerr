import WatchedCleanupList from '@app/components/WatchedCleanupList';
import useRouteGuard from '@app/hooks/useRouteGuard';
import { Permission } from '@app/hooks/useUser';
import type { NextPage } from 'next';

const WatchedCleanupPage: NextPage = () => {
  useRouteGuard(Permission.ADMIN);
  return <WatchedCleanupList />;
};

export default WatchedCleanupPage;
