import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import { APP_NAMES } from '@app/components/Settings/SettingsUserAccess/common';
import useToasts from '@app/hooks/useToasts';
import defineMessages from '@app/utils/defineMessages';
import type {
  ReadingAppChoices as Choices,
  ReadingKind,
  UserAccessApp,
} from '@server/constants/userAccess';
import axios from 'axios';
import { useIntl } from 'react-intl';
import useSWR from 'swr';

const messages = defineMessages(
  'components.Settings.SettingsUserAccess.ReadingAppChoices',
  {
    readingApps: 'Reading apps',
    readingAppsDescription:
      'The app each kind of book is read or heard in. After someone requests one, Allseerr offers to set up that app when their account there is not ready.',
    audiobook: 'Audiobooks',
    ebook: 'Ebooks',
    comic: 'Comics and manga',
    saved: 'Reading apps saved.',
    saveFailure: 'Something went wrong while saving the reading apps.',
  }
);

// The apps each kind can be read or heard in
const OPTIONS: Record<ReadingKind, UserAccessApp[]> = {
  audiobook: ['audiobookshelf', 'grimmory'],
  ebook: ['audiobookshelf', 'kavita', 'grimmory'],
  comic: ['kavita', 'komga'],
};

/**
 * Which app serves audiobooks, ebooks and comics, for the Reading apps
 * settings and the prompt after a request
 */
const ReadingAppChoices = () => {
  const intl = useIntl();
  const { addToast } = useToasts();
  const { data, mutate } = useSWR<Choices>(
    '/api/v1/settings/user-access/reading-apps'
  );

  if (!data) {
    return <LoadingSpinner />;
  }

  const save = async (kind: ReadingKind, app: UserAccessApp) => {
    try {
      const response = await axios.post<Choices>(
        '/api/v1/settings/user-access/reading-apps',
        { [kind]: app }
      );
      mutate(response.data, { revalidate: false });
      addToast(intl.formatMessage(messages.saved), {
        appearance: 'success',
        autoDismiss: true,
      });
    } catch {
      addToast(intl.formatMessage(messages.saveFailure), {
        appearance: 'error',
        autoDismiss: true,
      });
    }
  };

  return (
    <div className="mb-10">
      <h3 className="heading">{intl.formatMessage(messages.readingApps)}</h3>
      <p className="description">
        {intl.formatMessage(messages.readingAppsDescription)}
      </p>
      {(Object.keys(OPTIONS) as ReadingKind[]).map((kind) => (
        <div className="form-row" key={kind}>
          <label htmlFor={`readingApp-${kind}`} className="text-label">
            {intl.formatMessage(messages[kind])}
          </label>
          <div className="form-input-area">
            <div className="form-input-field">
              <select
                id={`readingApp-${kind}`}
                value={data[kind]}
                disabled={OPTIONS[kind].length < 2}
                onChange={(e) => save(kind, e.target.value as UserAccessApp)}
              >
                {OPTIONS[kind].map((app) => (
                  <option key={app} value={app}>
                    {APP_NAMES[app]}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
};

export default ReadingAppChoices;
