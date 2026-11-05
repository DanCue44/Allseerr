import Alert from '@app/components/Common/Alert';
import Badge from '@app/components/Common/Badge';
import List from '@app/components/Common/List';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import PageTitle from '@app/components/Common/PageTitle';
import Releases from '@app/components/Settings/SettingsAbout/Releases';
import WorksBestWith from '@app/components/Settings/SettingsAbout/WorksBestWith';
import useSettings from '@app/hooks/useSettings';
import globalMessages from '@app/i18n/globalMessages';
import ErrorPage from '@app/pages/_error';
import defineMessages from '@app/utils/defineMessages';
import {
  ALLSEERR_BRANCH,
  ALLSEERR_REPO_URL,
  ALLSEERR_TIP_URL,
  SEERR_REPO_URL,
} from '@server/constants/repository';
import type {
  SettingsAboutResponse,
  StatusResponse,
} from '@server/interfaces/api/settingsInterfaces';
import { useIntl } from 'react-intl';
import useSWR from 'swr';

const messages = defineMessages('components.Settings.SettingsAbout', {
  about: 'About',
  aboutseerr: 'About Allseerr',
  version: 'Version',
  totalmedia: 'Total Media',
  totalrequests: 'Total Requests',
  gettingsupport: 'Getting Support',
  githubdiscussions: 'GitHub Discussions',
  githubissues: 'Report an Issue',
  timezone: 'Time Zone',
  appDataPath: 'Data Directory',
  documentation: 'Documentation',
  credits: 'Credits',
  supportallseerr: 'Support Allseerr',
  leaveatip: 'Leave a Tip',
  tipdescription: 'Any amount, one time. Tips do not unlock anything.',
  basedonseerr: 'Based on Seerr',
  outofdate: 'Out of Date',
  uptodate: 'Up to Date',
  versionCheckDisabled: 'Version Check Disabled',
  runningBranch:
    'You are running a build of the <code>{branch}</code> branch of Allseerr rather than a release.',
});

const SettingsAbout = () => {
  const settings = useSettings();
  const intl = useIntl();
  const { data, error } = useSWR<SettingsAboutResponse>(
    '/api/v1/settings/about'
  );

  const { data: status } = useSWR<StatusResponse>(
    settings.currentSettings.versionCheck ? '/api/v1/status' : null
  );

  if (!data && !error) {
    return <LoadingSpinner />;
  }

  if (!data) {
    return <ErrorPage statusCode={500} />;
  }

  const latestUrl = data.releaseBuild
    ? `${ALLSEERR_REPO_URL}/releases`
    : `${ALLSEERR_REPO_URL}/commits/${ALLSEERR_BRANCH}`;
  const updateUrl =
    data.releaseBuild || !status
      ? `${ALLSEERR_REPO_URL}/releases`
      : `${ALLSEERR_REPO_URL}/compare/${status.commitTag}...${ALLSEERR_BRANCH}`;

  const link = (href: string) => (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="text-indigo-500 transition duration-300 hover:underline"
    >
      {href}
    </a>
  );

  return (
    <>
      <PageTitle
        title={[
          intl.formatMessage(messages.about),
          intl.formatMessage(globalMessages.settings),
        ]}
      />
      <div className="section">
        <List title={intl.formatMessage(messages.aboutseerr)}>
          {!data.releaseBuild && (
            <Alert
              title={intl.formatMessage(messages.runningBranch, {
                branch: ALLSEERR_BRANCH,
                code: (msg: React.ReactNode) => (
                  <code className="bg-gray-800/50">{msg}</code>
                ),
              })}
            />
          )}
          <List.Item
            title={intl.formatMessage(messages.version)}
            className="flex flex-row items-center truncate"
          >
            <code className="truncate">
              {data.version.replace('develop-', '')}
            </code>
            {settings.currentSettings.versionCheck ? (
              status && status.commitTag !== 'local' ? (
                status.updateAvailable ? (
                  <a href={updateUrl} target="_blank" rel="noopener noreferrer">
                    <Badge
                      badgeType="warning"
                      className="ml-2 !cursor-pointer transition hover:bg-yellow-400"
                    >
                      {intl.formatMessage(messages.outofdate)}
                    </Badge>
                  </a>
                ) : (
                  <a href={latestUrl} target="_blank" rel="noopener noreferrer">
                    <Badge
                      badgeType="success"
                      className="ml-2 !cursor-pointer transition hover:bg-green-400"
                    >
                      {intl.formatMessage(messages.uptodate)}
                    </Badge>
                  </a>
                )
              ) : null
            ) : (
              <a href={latestUrl} target="_blank" rel="noopener noreferrer">
                <Badge
                  badgeType="primary"
                  className="ml-2 !cursor-pointer transition hover:bg-yellow-400"
                >
                  {intl.formatMessage(messages.versionCheckDisabled)}
                </Badge>
              </a>
            )}
          </List.Item>
          <List.Item title={intl.formatMessage(messages.totalmedia)}>
            {intl.formatNumber(data.totalMediaItems)}
          </List.Item>
          <List.Item title={intl.formatMessage(messages.totalrequests)}>
            {intl.formatNumber(data.totalRequests)}
          </List.Item>
          <List.Item title={intl.formatMessage(messages.appDataPath)}>
            <code>{data.appDataPath}</code>
          </List.Item>
          {data.tz && (
            <List.Item title={intl.formatMessage(messages.timezone)}>
              <code>{data.tz}</code>
            </List.Item>
          )}
        </List>
      </div>
      <div className="section">
        <List title={intl.formatMessage(messages.gettingsupport)}>
          <List.Item title={intl.formatMessage(messages.documentation)}>
            {link(`${ALLSEERR_REPO_URL}#readme`)}
          </List.Item>
          <List.Item title={intl.formatMessage(messages.githubissues)}>
            {link(`${ALLSEERR_REPO_URL}/issues`)}
          </List.Item>
          <List.Item title={intl.formatMessage(messages.githubdiscussions)}>
            {link(`${ALLSEERR_REPO_URL}/discussions`)}
          </List.Item>
        </List>
      </div>
      <div className="section">
        <List title={intl.formatMessage(messages.supportallseerr)}>
          <List.Item title={intl.formatMessage(messages.leaveatip)}>
            <a
              href={ALLSEERR_TIP_URL}
              target="_blank"
              rel="noreferrer"
              className="text-indigo-500 transition duration-300 hover:underline"
            >
              {intl.formatMessage(messages.tipdescription)}
            </a>
          </List.Item>
        </List>
      </div>
      <div className="section">
        <List title={intl.formatMessage(messages.credits)}>
          <List.Item title={intl.formatMessage(messages.basedonseerr)}>
            {link(SEERR_REPO_URL)}
          </List.Item>
        </List>
      </div>
      <div className="section">
        <WorksBestWith />
      </div>
      <div className="section">
        <Releases currentVersion={data.version} />
      </div>
    </>
  );
};

export default SettingsAbout;
