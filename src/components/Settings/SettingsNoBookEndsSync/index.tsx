import Alert from '@app/components/Common/Alert';
import Button from '@app/components/Common/Button';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import Modal from '@app/components/Common/Modal';
import PageTitle from '@app/components/Common/PageTitle';
import CopyButton from '@app/components/Settings/CopyButton';
import NoBookEndsSyncModal, {
  NOBOOKENDS_SYNC_INSTALL_URL,
} from '@app/components/Settings/NoBookEndsSyncModal';
import useToasts from '@app/hooks/useToasts';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import { Transition } from '@headlessui/react';
import {
  ArrowDownTrayIcon,
  CloudArrowDownIcon,
  PencilIcon,
  SignalIcon,
  TrashIcon,
} from '@heroicons/react/24/solid';
import type {
  NoBookEndsSyncBackfillResponse,
  NoBookEndsSyncManualResponse,
  NoBookEndsSyncSettingsResponse,
  NoBookEndsSyncSetupResponse,
  NoBookEndsSyncTestResponse,
} from '@server/interfaces/api/settingsInterfaces';
import type { InstallState } from '@server/lib/nobookendsSyncSetup';
import axios, { isAxiosError } from 'axios';
import Link from 'next/link';
import { Fragment, useEffect, useState } from 'react';
import { useIntl } from 'react-intl';
import useSWR from 'swr';

const messages = defineMessages('components.Settings.SettingsNoBookEndsSync', {
  nobookendsSync: 'NoBookEnds Sync',
  description:
    'NoBookEnds Sync runs next to Audiobookshelf. It aligns audiobooks to their EPUBs, so the NoBookEnds app can highlight the words as they are read, and keeps ratings, highlights and clips in sync across a reader’s devices. Allseerr can install it, give it its own Audiobookshelf account, and serve it to phones under the Allseerr address, so it needs no reverse proxy.',
  learnMore: 'More about NoBookEnds Sync',
  status: 'Status',
  notSetUp: 'No Sync server is connected yet. Set one up below.',
  unreachable:
    'Allseerr cannot reach the Sync server at {url}. It may be stopped or still starting.',
  statusLine: 'NoBookEnds Sync {version} on the {device}',
  gpu: 'GPU',
  cpu: 'CPU',
  workerStopped: 'The alignment worker is not running.',
  disabled: 'Queueing books is turned off.',
  queueLength:
    '{total, plural, =0 {Nothing is waiting} one {# book is waiting} other {# books are waiting}} ({user} requested, {auto} in the background).',
  windowLine:
    'Background alignments run {start} to {end}{active, select, true { (running now)} other {}}.',
  noWindow: 'Background alignments run at any time.',
  processing: 'Aligning {title}.',
  processingProgress: 'Aligning {title} ({progress}%).',
  unknownTitle: 'a book',
  tokenInvalid:
    'The Sync server refused the admin token, so the queue cannot be read.',
  statusUnavailable:
    'This Sync server does not report its queue. It may be an older version, or have no ADMIN_TOKEN.',
  reachedAt: 'Allseerr reaches it at {url}.',
  installedContainer:
    'Installed by Allseerr: container {name} ({image}), data in {dataPath}.',
  absAccountLine:
    'It reads Audiobookshelf as {username}, a read only account{created, select, true { Allseerr made} other {}}.',
  editConnection: 'Edit Connection',
  queueAll: 'Queue All Books',
  queueing: 'Queueing...',
  removeContainer: 'Remove Container',
  removeContainerTitle: 'Remove the Sync container?',
  removeContainerText:
    'Allseerr stops and removes the container it installed and turns NoBookEnds Sync off. The data folder ({dataPath}) is kept, so installing again picks up where it left off.',
  phones: 'Phones',
  proxy: 'Serve NoBookEnds Sync through Allseerr',
  proxyHelp:
    'Phones reach the Sync server at the Allseerr address, so it needs no public address or reverse proxy of its own. Allseerr passes each reader’s Audiobookshelf token on, and the Sync server checks it with Audiobookshelf. The admin token never leaves this server.',
  proxyAddress: 'The NoBookEnds app uses {url}.',
  proxyNoAppUrl:
    'The NoBookEnds app uses the Allseerr address it connected with, followed by {path}. Set the Application URL in General settings to show the full address here.',
  publicAddress: 'The NoBookEnds app uses {url}.',
  noPublicAddress:
    'The app is not told about the Sync server: there is no public address, and Allseerr does not serve it.',
  setUp: 'Set Up',
  setUpAnother: 'Set Up a New Sync Server',
  setUpDescription:
    'Allseerr makes a read only Audiobookshelf account for the Sync server and an admin token, then installs the container for you, or writes the instructions to install it yourself.',
  absMissing:
    'Allseerr needs an Audiobookshelf admin API key to make the account. Add it under <UserAccessLink>User Access</UserAccessLink>.',
  absUsername: 'Audiobookshelf Account',
  absUsernameHelp:
    'Made for the Sync server: it can download from every library and change nothing. An existing account with this name gets a new key.',
  image: 'Image',
  imageGpu: 'NVIDIA GPU ({image})',
  imageCpu: 'CPU only ({image})',
  imageHelpGpuFound:
    'Docker has the NVIDIA runtime, so the GPU image is picked. It aligns a book many times faster.',
  imageHelpNoDocker:
    'Allseerr cannot see Docker, so it cannot tell whether this server has an NVIDIA card. Pick the GPU image only if it has one with the NVIDIA Container Toolkit (Unraid: the Nvidia Driver plugin). The CPU image works everywhere and aligns overnight.',
  imageHelpNoGpu:
    'No NVIDIA runtime was found. Pick the GPU image only if this server has an NVIDIA card with the NVIDIA Container Toolkit (Unraid: the Nvidia Driver plugin). The CPU image works everywhere and aligns overnight.',
  containerName: 'Container Name',
  dataPath: 'Data Folder',
  dataPathHelp:
    'Folder on the server for the database, alignments and models (a few GB for a large library).',
  network: 'Docker Network',
  networkHelp:
    'The network Allseerr is on is picked, so Allseerr reaches the container by name. On Docker’s default bridge, set a host port.',
  networkDefault: 'Docker default (bridge)',
  absUrl: 'Audiobookshelf Address',
  absUrlHelp:
    'Audiobookshelf as the Sync container reaches it, such as http://audiobookshelf:80 on a shared network, or the server address with the Audiobookshelf port.',
  timezone: 'Time Zone',
  autoWindow: 'Overnight Window',
  autoWindowHelp:
    'Background alignments of the library only run inside this window, such as 01:00-06:00. Use always for any time. Books readers ask for start right away.',
  hostPort: 'Host Port',
  hostPortHelp:
    'Optional. Publishes the Sync server on this port of the host, for Docker’s default bridge or to reach it from other machines.',
  automatic: 'Install Automatically',
  manual: 'Install by Hand',
  dockerTitle: 'What the Docker socket gives Allseerr',
  dockerExplain:
    'With /var/run/docker.sock mounted, Allseerr can do anything Docker can on this server: start, stop, remove or create any container and read their settings, which is close to full control of the server. Allseerr only uses it here, when you press Install, to pull the Sync image and create and start one container. You can remove the mount again afterwards; the Sync server keeps running.',
  dockerMissing:
    'Allseerr cannot reach Docker, so it cannot install the container itself. That is fine: install it by hand below. To let Allseerr install it, add a path to the Allseerr container with /var/run/docker.sock as both the container and the host path, restart Allseerr and reload this page.',
  dockerNoPermission:
    'The Docker socket is mounted, but Allseerr runs as a normal user (uid {uid}) and may not open it. Add the group that owns the socket to the Allseerr container: on Unraid, edit the container, switch to Advanced View and add --group-add {gid} to Extra Parameters; with Docker Compose, add group_add: ["{gid}"]. Then restart Allseerr and reload this page.',
  dockerNoAnswer:
    'The Docker socket is mounted, but Docker does not answer on it. Check that the path is /var/run/docker.sock and that Allseerr may read and write it.',
  install: 'Install',
  installing: 'Installing...',
  stepPull:
    'Downloading the image{progress, select, none {} other { ({progress}%)}}',
  stepCreate: 'Creating the container',
  stepStart: 'Starting the container',
  stepHealth: 'Waiting for the Sync server to answer',
  stepConnect: 'Connecting',
  installDone: 'NoBookEnds Sync is installed and connected.',
  installFailed: 'The install stopped: {error}',
  writeInstructions: 'Write Install Instructions',
  writing: 'Writing...',
  instructionsHelp:
    'Every value is filled in, including the Audiobookshelf key and the admin token, so keep these to yourself. Use one of them, then connect below.',
  compose: 'Docker Compose',
  dockerRun: 'docker run',
  unraid: 'Unraid template',
  unraidHelp:
    'Save it as {path} on the Unraid server, then Docker > Add Container and pick it under Template.',
  downloadTemplate: 'Download Template',
  copied: 'Copied',
  connectUrl: 'Address Allseerr Reaches It At',
  connectUrlHelp:
    'Such as http://nobookends-sync:8000 on the same Docker network, or the server address with the host port.',
  connect: 'Test and Connect',
  connecting: 'Connecting...',
  connected: 'NoBookEnds Sync is connected.',
  toastQueued:
    'NoBookEnds Sync accepted {accepted, plural, one {# book} other {# books}}{rejected, plural, =0 {} other {, # rejected}}{failed, plural, =0 {} other {, # tried again later}}.',
  toastQueueFailure: 'Failed to queue the books on NoBookEnds Sync.',
  toastSaveFailure: 'Something went wrong while saving.',
  toastRemoved: 'The Sync container was removed.',
});

type SetupForm = {
  gpu: boolean;
  containerName: string;
  dataPath: string;
  network: string;
  absUrl: string;
  timezone: string;
  autoWindow: string;
  hostPort: string;
  absUsername: string;
};

const errorMessage = (e: unknown, fallback: string): string =>
  (isAxiosError(e) && (e.response?.data as { message?: string })?.message) ||
  fallback;

const SettingsNoBookEndsSync = () => {
  const intl = useIntl();
  const { addToast } = useToasts();
  const {
    data: settings,
    error: settingsError,
    mutate: revalidateSettings,
  } = useSWR<NoBookEndsSyncSettingsResponse>(
    '/api/v1/settings/nobookends-sync'
  );
  const configured = !!(settings?.internalUrl || settings?.url);
  const {
    data: status,
    error: statusError,
    mutate: revalidateStatus,
  } = useSWR<NoBookEndsSyncTestResponse>(
    configured ? '/api/v1/settings/nobookends-sync/status' : null,
    { refreshInterval: 15000, shouldRetryOnError: false }
  );
  const { data: setup, mutate: revalidateSetup } =
    useSWR<NoBookEndsSyncSetupResponse>(
      '/api/v1/settings/nobookends-sync/setup'
    );

  const [showSetup, setShowSetup] = useState(false);
  const [form, setForm] = useState<SetupForm | null>(null);
  const [method, setMethod] = useState<'automatic' | 'manual'>('automatic');
  const [install, setInstall] = useState<InstallState | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [manual, setManual] = useState<NoBookEndsSyncManualResponse | null>(
    null
  );
  const [connectUrl, setConnectUrl] = useState('');
  const [editModal, setEditModal] = useState(false);
  const [removeModal, setRemoveModal] = useState(false);

  // Fill the form with the defaults once they are known
  useEffect(() => {
    if (setup && !form) {
      const d = setup.defaults;
      setForm({
        gpu: d.gpu,
        containerName: d.containerName,
        dataPath: d.dataPath,
        network: d.network,
        absUrl: d.absUrl,
        timezone: d.timezone,
        autoWindow: d.autoWindow,
        hostPort: '',
        absUsername: d.absUsername,
      });
      setMethod(setup.docker.available ? 'automatic' : 'manual');
      if (setup.install.state !== 'idle') {
        setInstall(setup.install);
      }
    }
  }, [setup, form]);

  // Follow a running install
  const running = install?.state === 'running';
  useEffect(() => {
    if (!running) {
      return;
    }

    const timer = setInterval(async () => {
      try {
        const response = await axios.get<InstallState>(
          '/api/v1/settings/nobookends-sync/install'
        );
        setInstall(response.data);

        if (response.data.state === 'done') {
          addToast(intl.formatMessage(messages.installDone), {
            appearance: 'success',
            autoDismiss: true,
          });
          setShowSetup(false);
          revalidateSettings();
          revalidateStatus();
        }
      } catch {
        // Try again on the next tick
      }
    }, 2000);

    return () => clearInterval(timer);
  }, [running, addToast, intl, revalidateSettings, revalidateStatus]);

  if (!settings && !settingsError) {
    return <LoadingSpinner />;
  }

  const setField = <K extends keyof SetupForm>(key: K, value: SetupForm[K]) =>
    setForm((current) => (current ? { ...current, [key]: value } : current));

  const formBody = () =>
    form
      ? {
          ...form,
          hostPort: form.hostPort.trim() ? Number(form.hostPort) : null,
        }
      : {};

  const startInstall = async () => {
    setBusy('install');
    try {
      const response = await axios.post<InstallState>(
        '/api/v1/settings/nobookends-sync/install',
        formBody()
      );
      setInstall(response.data);
    } catch (e) {
      addToast(errorMessage(e, intl.formatMessage(messages.toastSaveFailure)), {
        appearance: 'error',
        autoDismiss: true,
      });
    } finally {
      setBusy(null);
      revalidateSettings();
    }
  };

  const writeInstructions = async () => {
    setBusy('manual');
    try {
      const response = await axios.post<NoBookEndsSyncManualResponse>(
        '/api/v1/settings/nobookends-sync/manual',
        formBody()
      );
      setManual(response.data);
      setConnectUrl((url) => url || response.data.suggestedInternalUrl);
      revalidateSettings();
    } catch (e) {
      addToast(errorMessage(e, intl.formatMessage(messages.toastSaveFailure)), {
        appearance: 'error',
        autoDismiss: true,
      });
    } finally {
      setBusy(null);
    }
  };

  const connect = async () => {
    setBusy('connect');
    try {
      await axios.post('/api/v1/settings/nobookends-sync/connect', {
        internalUrl: connectUrl,
      });
      addToast(intl.formatMessage(messages.connected), {
        appearance: 'success',
        autoDismiss: true,
      });
      setShowSetup(false);
      setManual(null);
      revalidateSettings();
      revalidateStatus();
    } catch (e) {
      addToast(errorMessage(e, intl.formatMessage(messages.toastSaveFailure)), {
        appearance: 'error',
        autoDismiss: true,
      });
    } finally {
      setBusy(null);
    }
  };

  const setProxy = async (proxy: boolean) => {
    try {
      await axios.post('/api/v1/settings/nobookends-sync', { proxy });
      revalidateSettings();
    } catch (e) {
      addToast(errorMessage(e, intl.formatMessage(messages.toastSaveFailure)), {
        appearance: 'error',
        autoDismiss: true,
      });
    }
  };

  const queueAll = async () => {
    setBusy('queue');
    try {
      const response = await axios.post<NoBookEndsSyncBackfillResponse>(
        '/api/v1/settings/nobookends-sync/backfill'
      );
      const { accepted, rejected, failed } = response.data;
      addToast(
        intl.formatMessage(messages.toastQueued, {
          accepted,
          rejected,
          failed,
        }),
        {
          appearance: rejected || failed ? 'warning' : 'success',
          autoDismiss: true,
        }
      );
      revalidateStatus();
    } catch {
      addToast(intl.formatMessage(messages.toastQueueFailure), {
        appearance: 'error',
        autoDismiss: true,
      });
    } finally {
      setBusy(null);
    }
  };

  const removeContainer = async () => {
    setBusy('remove');
    try {
      await axios.delete('/api/v1/settings/nobookends-sync/container');
      addToast(intl.formatMessage(messages.toastRemoved), {
        appearance: 'success',
        autoDismiss: true,
      });
      setRemoveModal(false);
      setInstall(null);
      revalidateSettings();
      revalidateSetup();
    } catch (e) {
      addToast(errorMessage(e, intl.formatMessage(messages.toastSaveFailure)), {
        appearance: 'error',
        autoDismiss: true,
      });
    } finally {
      setBusy(null);
    }
  };

  const downloadTemplate = () => {
    if (!manual || !form) {
      return;
    }
    const blob = new Blob([manual.unraidTemplate], { type: 'application/xml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `my-${form.containerName}.xml`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const statusLines = (): string[] => {
    if (!status) {
      return [];
    }

    const lines = [
      intl.formatMessage(messages.statusLine, {
        version: status.version ?? '',
        device: intl.formatMessage(status.gpu ? messages.gpu : messages.cpu),
      }),
    ];

    if (!status.ok) {
      lines.push(intl.formatMessage(messages.workerStopped));
    }

    if (status.tokenValid === false) {
      lines.push(intl.formatMessage(messages.tokenInvalid));
    } else if (status.status) {
      const { current, queue, window } = status.status;

      if (current) {
        const title =
          current.title ?? intl.formatMessage(messages.unknownTitle);
        lines.push(
          current.progress !== null
            ? intl.formatMessage(messages.processingProgress, {
                title,
                progress: Math.round(current.progress * 100),
              })
            : intl.formatMessage(messages.processing, { title })
        );
      }

      lines.push(
        intl.formatMessage(messages.queueLength, {
          total: queue.total,
          user: queue.user,
          auto: queue.auto,
        })
      );
      lines.push(
        window.start && window.end
          ? intl.formatMessage(messages.windowLine, {
              start: window.start,
              end: window.end,
              active: String(window.active),
            })
          : intl.formatMessage(messages.noWindow)
      );
    } else if (status.statusUnavailable) {
      lines.push(intl.formatMessage(messages.statusUnavailable));
    }

    return lines;
  };

  const stepText = (state: InstallState): string => {
    switch (state.step) {
      case 'pull':
        return intl.formatMessage(messages.stepPull, {
          progress:
            typeof state.progress === 'number'
              ? String(Math.round(state.progress * 100))
              : 'none',
        });
      case 'create':
        return intl.formatMessage(messages.stepCreate);
      case 'start':
        return intl.formatMessage(messages.stepStart);
      case 'health':
        return intl.formatMessage(messages.stepHealth);
      default:
        return intl.formatMessage(messages.stepConnect);
    }
  };

  const setupVisible = !configured || showSetup;
  const docker = setup?.docker;

  const textField = (
    key: keyof SetupForm,
    label: string,
    help?: string,
    inputMode?: 'url' | 'numeric'
  ) => (
    <div className="form-row">
      <label htmlFor={`nbe-${key}`} className="text-label">
        {label}
        {help && <span className="label-tip">{help}</span>}
      </label>
      <div className="form-input-area">
        <div className="form-input-field">
          <input
            id={`nbe-${key}`}
            type="text"
            inputMode={inputMode}
            autoComplete="off"
            data-1pignore="true"
            data-lpignore="true"
            data-bwignore="true"
            value={String(form?.[key] ?? '')}
            onChange={(e) => setField(key, e.target.value as never)}
          />
        </div>
      </div>
    </div>
  );

  const snippet = (title: string, value: string, rows: number) => (
    <div className="mb-4">
      <p className="mb-1 text-sm font-bold text-gray-200">{title}</p>
      <div className="form-input-field">
        <textarea
          readOnly
          rows={rows}
          value={value}
          className="rounded-l-only font-mono text-xs"
          aria-label={title}
        />
        <CopyButton
          textToCopy={value}
          toastMessage={intl.formatMessage(messages.copied)}
        />
      </div>
    </div>
  );

  return (
    <>
      <PageTitle
        title={[
          intl.formatMessage(messages.nobookendsSync),
          intl.formatMessage(globalMessages.settings),
        ]}
      />
      <div className="mb-6">
        <h3 className="heading">
          {intl.formatMessage(messages.nobookendsSync)}
        </h3>
        <p className="description">
          {intl.formatMessage(messages.description)}{' '}
          <a
            href={NOBOOKENDS_SYNC_INSTALL_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="text-white transition duration-300 hover:underline"
          >
            {intl.formatMessage(messages.learnMore)}
          </a>
        </p>
      </div>

      <div className="mb-6">
        <h3 className="heading">{intl.formatMessage(messages.status)}</h3>
      </div>
      <div className="section" data-testid="nobookends-sync-status">
        {!configured ? (
          <p className="text-sm text-gray-300">
            {intl.formatMessage(messages.notSetUp)}
          </p>
        ) : (
          <div className="space-y-1 text-sm text-gray-300">
            {statusError ? (
              <Alert
                type="warning"
                title={intl.formatMessage(messages.unreachable, {
                  url: settings?.internalUrl || settings?.url,
                })}
              />
            ) : !status ? (
              <LoadingSpinner />
            ) : (
              statusLines().map((line) => <p key={line}>{line}</p>)
            )}
            {!settings?.enabled && (
              <p>{intl.formatMessage(messages.disabled)}</p>
            )}
            <p>
              {intl.formatMessage(messages.reachedAt, {
                url: settings?.internalUrl || settings?.url,
              })}
            </p>
            {settings?.container && (
              <p>
                {intl.formatMessage(messages.installedContainer, {
                  name: settings.container.name,
                  image: settings.container.image,
                  dataPath: settings.container.dataPath,
                })}
              </p>
            )}
            {settings?.absAccount && (
              <p>
                {intl.formatMessage(messages.absAccountLine, {
                  username: settings.absAccount.username,
                  created: String(settings.absAccount.created),
                })}
              </p>
            )}
            <div className="flex flex-wrap gap-2 pt-3">
              <Button buttonType="default" onClick={() => setEditModal(true)}>
                <PencilIcon />
                <span>{intl.formatMessage(messages.editConnection)}</span>
              </Button>
              {settings?.enabled && settings.adminTokenSet && (
                <Button
                  buttonType="default"
                  disabled={busy === 'queue'}
                  onClick={() => queueAll()}
                >
                  <CloudArrowDownIcon />
                  <span>
                    {intl.formatMessage(
                      busy === 'queue' ? messages.queueing : messages.queueAll
                    )}
                  </span>
                </Button>
              )}
              {settings?.container && (
                <Button
                  buttonType="danger"
                  onClick={() => setRemoveModal(true)}
                >
                  <TrashIcon />
                  <span>{intl.formatMessage(messages.removeContainer)}</span>
                </Button>
              )}
              {!showSetup && (
                <Button buttonType="ghost" onClick={() => setShowSetup(true)}>
                  <span>{intl.formatMessage(messages.setUpAnother)}</span>
                </Button>
              )}
            </div>
          </div>
        )}
      </div>

      {configured && (
        <>
          <div className="mb-6 mt-10">
            <h3 className="heading">{intl.formatMessage(messages.phones)}</h3>
          </div>
          <div className="section">
            <div className="form-row">
              <label htmlFor="nbe-proxy" className="checkbox-label">
                {intl.formatMessage(messages.proxy)}
                <span className="label-tip">
                  {intl.formatMessage(messages.proxyHelp)}
                </span>
              </label>
              <div className="form-input-area">
                <input
                  type="checkbox"
                  id="nbe-proxy"
                  checked={!!settings?.proxy}
                  onChange={() => setProxy(!settings?.proxy)}
                />
              </div>
            </div>
            <p
              className="text-sm text-gray-300"
              data-testid="nobookends-sync-address"
            >
              {settings?.proxy
                ? settings.proxyUrl
                  ? intl.formatMessage(messages.proxyAddress, {
                      url: settings.proxyUrl,
                    })
                  : intl.formatMessage(messages.proxyNoAppUrl, {
                      path: settings.proxyPath,
                    })
                : settings?.url
                  ? intl.formatMessage(messages.publicAddress, {
                      url: settings.url,
                    })
                  : intl.formatMessage(messages.noPublicAddress)}
            </p>
          </div>
        </>
      )}

      {setupVisible && (
        <>
          <div className="mb-6 mt-10">
            <h3 className="heading">{intl.formatMessage(messages.setUp)}</h3>
            <p className="description">
              {intl.formatMessage(messages.setUpDescription)}
            </p>
          </div>
          <div className="section" data-testid="nobookends-sync-setup">
            {!setup || !form ? (
              <LoadingSpinner />
            ) : (
              <>
                {!setup.absConnected && (
                  <Alert
                    type="warning"
                    title={intl.formatMessage(messages.absMissing, {
                      UserAccessLink: (msg: React.ReactNode) => (
                        <Link
                          href="/settings/user-access"
                          className="text-white underline"
                        >
                          {msg}
                        </Link>
                      ),
                    })}
                  />
                )}
                {textField(
                  'absUsername',
                  intl.formatMessage(messages.absUsername),
                  intl.formatMessage(messages.absUsernameHelp)
                )}
                <div className="form-row">
                  <label htmlFor="nbe-gpu" className="text-label">
                    {intl.formatMessage(messages.image)}
                    <span className="label-tip">
                      {intl.formatMessage(
                        docker?.nvidiaRuntime
                          ? messages.imageHelpGpuFound
                          : docker?.available
                            ? messages.imageHelpNoGpu
                            : messages.imageHelpNoDocker
                      )}
                    </span>
                  </label>
                  <div className="form-input-area">
                    <div className="form-input-field">
                      <select
                        id="nbe-gpu"
                        value={form.gpu ? 'gpu' : 'cpu'}
                        onChange={(e) =>
                          setField('gpu', e.target.value === 'gpu')
                        }
                      >
                        <option value="cpu">
                          {intl.formatMessage(messages.imageCpu, {
                            image: setup.defaults.images.cpu,
                          })}
                        </option>
                        <option value="gpu">
                          {intl.formatMessage(messages.imageGpu, {
                            image: setup.defaults.images.gpu,
                          })}
                        </option>
                      </select>
                    </div>
                  </div>
                </div>
                {textField(
                  'containerName',
                  intl.formatMessage(messages.containerName)
                )}
                {textField(
                  'dataPath',
                  intl.formatMessage(messages.dataPath),
                  intl.formatMessage(messages.dataPathHelp)
                )}
                <div className="form-row">
                  <label htmlFor="nbe-network" className="text-label">
                    {intl.formatMessage(messages.network)}
                    <span className="label-tip">
                      {intl.formatMessage(messages.networkHelp)}
                    </span>
                  </label>
                  <div className="form-input-area">
                    <div className="form-input-field">
                      {docker?.available && docker.networks.length > 0 ? (
                        <select
                          id="nbe-network"
                          value={form.network}
                          onChange={(e) => setField('network', e.target.value)}
                        >
                          <option value="">
                            {intl.formatMessage(messages.networkDefault)}
                          </option>
                          {docker.networks
                            .filter((n) => n !== 'bridge')
                            .map((n) => (
                              <option key={n} value={n}>
                                {n}
                              </option>
                            ))}
                        </select>
                      ) : (
                        <input
                          id="nbe-network"
                          type="text"
                          autoComplete="off"
                          value={form.network}
                          onChange={(e) => setField('network', e.target.value)}
                        />
                      )}
                    </div>
                  </div>
                </div>
                {textField(
                  'absUrl',
                  intl.formatMessage(messages.absUrl),
                  intl.formatMessage(messages.absUrlHelp),
                  'url'
                )}
                {textField('timezone', intl.formatMessage(messages.timezone))}
                {textField(
                  'autoWindow',
                  intl.formatMessage(messages.autoWindow),
                  intl.formatMessage(messages.autoWindowHelp)
                )}
                {textField(
                  'hostPort',
                  intl.formatMessage(messages.hostPort),
                  intl.formatMessage(messages.hostPortHelp),
                  'numeric'
                )}

                <div className="mb-4 mt-6 flex flex-wrap gap-2">
                  <Button
                    buttonType={method === 'automatic' ? 'primary' : 'default'}
                    onClick={() => setMethod('automatic')}
                  >
                    <span>{intl.formatMessage(messages.automatic)}</span>
                  </Button>
                  <Button
                    buttonType={method === 'manual' ? 'primary' : 'default'}
                    onClick={() => setMethod('manual')}
                  >
                    <span>{intl.formatMessage(messages.manual)}</span>
                  </Button>
                </div>

                {method === 'automatic' ? (
                  <div data-testid="nobookends-sync-automatic">
                    <Alert
                      type="info"
                      title={intl.formatMessage(messages.dockerTitle)}
                    >
                      {intl.formatMessage(messages.dockerExplain)}
                    </Alert>
                    {!docker?.available ? (
                      <Alert type="warning">
                        {docker?.reason === 'no_permission'
                          ? intl.formatMessage(messages.dockerNoPermission, {
                              uid: docker.processUser?.uid ?? 1000,
                              gid: docker.socketGroup ?? 'docker',
                            })
                          : intl.formatMessage(
                              docker?.reason === 'no_answer'
                                ? messages.dockerNoAnswer
                                : messages.dockerMissing
                            )}
                      </Alert>
                    ) : (
                      <>
                        {install && install.state !== 'idle' && (
                          <div
                            className="mb-4 rounded-md bg-gray-700 p-3 text-sm text-gray-200"
                            data-testid="nobookends-sync-install-state"
                          >
                            {install.state === 'running' && (
                              <p>{stepText(install)}</p>
                            )}
                            {install.state === 'running' &&
                              install.step === 'pull' &&
                              typeof install.progress === 'number' && (
                                <div className="mt-2 h-2 w-full rounded bg-gray-600">
                                  <div
                                    className="h-2 rounded bg-indigo-500"
                                    style={{
                                      width: `${Math.round(install.progress * 100)}%`,
                                    }}
                                  />
                                </div>
                              )}
                            {install.state === 'done' && (
                              <p>{intl.formatMessage(messages.installDone)}</p>
                            )}
                            {install.state === 'failed' && (
                              <p className="text-red-300">
                                {intl.formatMessage(messages.installFailed, {
                                  error: install.error ?? '',
                                })}
                              </p>
                            )}
                          </div>
                        )}
                        <Button
                          buttonType="primary"
                          disabled={
                            running || busy === 'install' || !setup.absConnected
                          }
                          onClick={() => startInstall()}
                        >
                          <ArrowDownTrayIcon />
                          <span>
                            {intl.formatMessage(
                              running || busy === 'install'
                                ? messages.installing
                                : messages.install
                            )}
                          </span>
                        </Button>
                      </>
                    )}
                  </div>
                ) : (
                  <div data-testid="nobookends-sync-manual">
                    <Button
                      buttonType="primary"
                      disabled={busy === 'manual' || !setup.absConnected}
                      onClick={() => writeInstructions()}
                    >
                      <span>
                        {intl.formatMessage(
                          busy === 'manual'
                            ? messages.writing
                            : messages.writeInstructions
                        )}
                      </span>
                    </Button>
                    {manual && (
                      <div className="mt-4">
                        <Alert type="warning">
                          {intl.formatMessage(messages.instructionsHelp)}
                        </Alert>
                        {snippet(
                          intl.formatMessage(messages.compose),
                          manual.compose,
                          16
                        )}
                        {snippet(
                          intl.formatMessage(messages.dockerRun),
                          manual.dockerRun,
                          10
                        )}
                        {snippet(
                          intl.formatMessage(messages.unraid),
                          manual.unraidTemplate,
                          10
                        )}
                        <p className="mb-2 text-sm text-gray-300">
                          {intl.formatMessage(messages.unraidHelp, {
                            path: manual.unraidTemplatePath,
                          })}
                        </p>
                        <Button
                          buttonType="default"
                          onClick={() => downloadTemplate()}
                        >
                          <ArrowDownTrayIcon />
                          <span>
                            {intl.formatMessage(messages.downloadTemplate)}
                          </span>
                        </Button>
                        <div className="form-row mt-6">
                          <label htmlFor="nbe-connect" className="text-label">
                            {intl.formatMessage(messages.connectUrl)}
                            <span className="label-tip">
                              {intl.formatMessage(messages.connectUrlHelp)}
                            </span>
                          </label>
                          <div className="form-input-area">
                            <div className="form-input-field">
                              <input
                                id="nbe-connect"
                                type="text"
                                inputMode="url"
                                autoComplete="off"
                                value={connectUrl}
                                onChange={(e) => setConnectUrl(e.target.value)}
                              />
                            </div>
                          </div>
                        </div>
                        <Button
                          buttonType="primary"
                          disabled={busy === 'connect' || !connectUrl.trim()}
                          onClick={() => connect()}
                        >
                          <SignalIcon />
                          <span>
                            {intl.formatMessage(
                              busy === 'connect'
                                ? messages.connecting
                                : messages.connect
                            )}
                          </span>
                        </Button>
                      </div>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        </>
      )}

      {editModal && settings && (
        <NoBookEndsSyncModal
          nobookendsSync={settings}
          onClose={() => setEditModal(false)}
          onSave={() => {
            revalidateSettings();
            revalidateStatus();
            setEditModal(false);
          }}
        />
      )}
      <Transition
        as={Fragment}
        show={removeModal}
        enter="transition-opacity ease-in-out duration-300"
        enterFrom="opacity-0"
        enterTo="opacity-100"
        leave="transition-opacity ease-in-out duration-300"
        leaveFrom="opacity-100"
        leaveTo="opacity-0"
      >
        <Modal
          okText={intl.formatMessage(messages.removeContainer)}
          okButtonType="danger"
          okDisabled={busy === 'remove'}
          onOk={() => removeContainer()}
          onCancel={() => setRemoveModal(false)}
          title={intl.formatMessage(messages.removeContainerTitle)}
        >
          {intl.formatMessage(messages.removeContainerText, {
            dataPath: settings?.container?.dataPath ?? '',
          })}
        </Modal>
      </Transition>
    </>
  );
};

export default SettingsNoBookEndsSync;
