import Modal from '@app/components/Common/Modal';
import { Permission, useUser } from '@app/hooks/useUser';
import defineMessages from '@app/utils/defineMessages';
import { Transition } from '@headlessui/react';
import axios from 'axios';
import { useRouter } from 'next/router';
import { useState } from 'react';
import { useIntl } from 'react-intl';
import useSWR from 'swr';

const messages = defineMessages('components.NoBookEndsSyncNotice', {
  title: 'New: Set Up NoBookEnds Sync from Allseerr',
  body: 'Settings now has a NoBookEnds Sync page. Allseerr can install the Sync server for you, make its Audiobookshelf account, and serve it to phones under the Allseerr address, so it needs no reverse proxy. NoBookEnds then finds it by itself.',
  open: 'Open NoBookEnds Sync',
  dismiss: 'Dismiss',
});

export const NOBOOKENDS_SYNC_SETTINGS_PATH = '/settings/nobookends-sync';

/**
 * A one time notice for admins about the NoBookEnds Sync settings page.
 * Closing it, either way, is remembered for that admin on the server.
 */
const NoBookEndsSyncNotice = () => {
  const intl = useIntl();
  const router = useRouter();
  const { user, hasPermission } = useUser();
  const isAdmin = !!user && hasPermission(Permission.ADMIN);
  const [closed, setClosed] = useState(false);
  const { data } = useSWR<{ show: boolean }>(
    isAdmin ? '/api/v1/settings/nobookends-sync/notice' : null,
    { revalidateOnFocus: false, shouldRetryOnError: false }
  );
  const onSettingsPage = router.pathname.startsWith(
    NOBOOKENDS_SYNC_SETTINGS_PATH
  );
  const show = isAdmin && !!data?.show && !closed && !onSettingsPage;

  const dismiss = async () => {
    setClosed(true);
    try {
      await axios.post('/api/v1/settings/nobookends-sync/notice/dismiss');
    } catch {
      // Shown again next time, which is better than never
    }
  };

  return (
    <Transition
      as="div"
      show={show}
      enter="transition-opacity ease-in-out duration-300"
      enterFrom="opacity-0"
      enterTo="opacity-100"
      leave="transition-opacity ease-in-out duration-300"
      leaveFrom="opacity-100"
      leaveTo="opacity-0"
    >
      <Modal
        title={intl.formatMessage(messages.title)}
        okText={intl.formatMessage(messages.open)}
        okButtonType="primary"
        cancelText={intl.formatMessage(messages.dismiss)}
        onOk={async () => {
          await dismiss();
          router.push(NOBOOKENDS_SYNC_SETTINGS_PATH);
        }}
        onCancel={() => dismiss()}
      >
        <p data-testid="nobookends-sync-notice">
          {intl.formatMessage(messages.body)}
        </p>
      </Modal>
    </Transition>
  );
};

export default NoBookEndsSyncNotice;
