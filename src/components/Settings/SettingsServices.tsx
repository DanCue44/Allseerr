import LidarrLogo from '@app/assets/services/lidarr.svg';
import RadarrLogo from '@app/assets/services/radarr.svg';
import SonarrLogo from '@app/assets/services/sonarr.svg';
import Alert from '@app/components/Common/Alert';
import Badge from '@app/components/Common/Badge';
import Button from '@app/components/Common/Button';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import Modal from '@app/components/Common/Modal';
import PageTitle from '@app/components/Common/PageTitle';
import AudiobookshelfModal from '@app/components/Settings/AudiobookshelfModal';
import BazarrModal from '@app/components/Settings/BazarrModal';
import ChaptarrModal from '@app/components/Settings/ChaptarrModal';
import LazyLibrarianModal from '@app/components/Settings/LazyLibrarianModal';
import LidarrModal from '@app/components/Settings/LidarrModal';
import NoBookEndsSyncModal from '@app/components/Settings/NoBookEndsSyncModal';
import OverrideRuleModal from '@app/components/Settings/OverrideRule/OverrideRuleModal';
import OverrideRuleTiles from '@app/components/Settings/OverrideRule/OverrideRuleTiles';
import RadarrModal from '@app/components/Settings/RadarrModal';
import SonarrModal from '@app/components/Settings/SonarrModal';
import useToasts from '@app/hooks/useToasts';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import { Transition } from '@headlessui/react';
import {
  BookOpenIcon,
  LanguageIcon,
  PencilIcon,
  PlayCircleIcon,
  PlusIcon,
  TrashIcon,
} from '@heroicons/react/24/solid';
import type { AudiobookVersionsMode } from '@server/constants/audiobookVersion';
import {
  DEFAULT_AUDIOBOOK_VERSIONS_MODE,
  isAudiobookVersionsMode,
} from '@server/constants/audiobookVersion';
import type { ChaptarrBookService } from '@server/constants/bookService';
import { bookServiceName, usesChaptarr } from '@server/constants/bookService';
import type OverrideRule from '@server/entity/OverrideRule';
import type { OverrideRuleResultsResponse } from '@server/interfaces/api/overrideRuleInterfaces';
import type {
  AudiobookshelfSettingsResponse,
  NoBookEndsSyncSettingsResponse,
} from '@server/interfaces/api/settingsInterfaces';
import type {
  BazarrSettings,
  BookService,
  ChaptarrSettings,
  LazyLibrarianSettings,
  LidarrSettings,
  MainSettings,
  RadarrSettings,
  SonarrSettings,
} from '@server/lib/settings';
import axios from 'axios';
import Link from 'next/link';
import { Fragment, useState } from 'react';
import { useIntl } from 'react-intl';
import useSWR, { mutate } from 'swr';

const messages = defineMessages('components.Settings', {
  services: 'Services',
  radarrsettings: 'Radarr Settings',
  sonarrsettings: 'Sonarr Settings',
  lidarrsettings: 'Lidarr Settings',
  audiobookshelfsettings: 'Audiobookshelf Settings',
  audiobookshelfSettingsDescription:
    'Link available books to your Audiobookshelf server, so users can open them from book pages.',
  configureaudiobookshelf: 'Configure Audiobookshelf',
  deleteaudiobookshelf: 'Remove Audiobookshelf',
  deleteaudiobookshelfconfirm:
    'Are you sure you want to remove Audiobookshelf? Book pages will no longer link to it.',
  library: 'Library',
  homepage: 'Home page',
  nobookendssyncsettings: 'NoBookEnds Sync Settings',
  nobookendsSyncSettingsDescription:
    'Connect a NoBookEnds Sync server, which aligns audiobooks to their EPUBs so the NoBookEnds app can highlight the words as they are read. Books are queued there once both formats are in Audiobookshelf.',
  nobookendsSyncRecommended:
    'Recommended for the full NoBookEnds experience. <SyncLink>How to set it up</SyncLink>',
  nobookendsSyncSetupPage:
    'Allseerr can install and connect it for you on the <PageLink>NoBookEnds Sync</PageLink> page.',
  configurenobookendssync: 'Configure NoBookEnds Sync',
  deletenobookendssync: 'Remove NoBookEnds Sync',
  deletenobookendssyncconfirm:
    'Are you sure you want to remove NoBookEnds Sync? Books will no longer be queued there, and NoBookEnds will fall back to chapter-level Listen and Read.',
  syncStatus: 'Status',
  syncEnabled: 'Enabled',
  syncDisabled: 'Disabled',
  syncNoToken: 'Enabled, no admin token',
  bazarrsettings: 'Bazarr Settings',
  bazarrSettingsDescription:
    'Configure your Bazarr server below to show downloaded, wanted and missing subtitles on title pages and let users search for or request a subtitle language.',
  configurebazarr: 'Configure Bazarr',
  deletebazarr: 'Remove Bazarr',
  deletebazarrconfirm:
    'Are you sure you want to remove Bazarr? Subtitle details and requests will no longer be available.',
  lazylibrariansettings: 'LazyLibrarian Settings',
  lazylibrarianSettingsDescription:
    'Configure your LazyLibrarian server below to enable ebook and audiobook requests. Approved book requests are added to LazyLibrarian, which searches for the requested format.',
  configurelazylibrarian: 'Configure LazyLibrarian',
  lazylibrarianLimits: 'LazyLibrarian has fewer features than Chaptarr',
  lazylibrarianLimitsDetail:
    'Approved book removals cannot delete files, because LazyLibrarian has no way to do that through its API. The book only stops being searched for, and its file stays on disk until it is deleted in LazyLibrarian, which may then find it again. Chaptarr deletes the files and tracks ebooks and audiobooks separately, so it is recommended for book requests.',
  deletelazylibrarian: 'Remove LazyLibrarian',
  deletelazylibrarianconfirm:
    'Are you sure you want to remove LazyLibrarian? Books can no longer be requested.',
  videoServiceSettingsDescription:
    'Configure your {serverType} server(s) below. You can connect multiple {serverType} servers, but only two of them can be marked as defaults (one non-4K and one 4K). Administrators are able to override the server used to process new requests prior to approval.',
  chaptarrsettings: 'Chaptarr Settings',
  chaptarrSettingsDescription:
    'Configure your Chaptarr server(s) below to enable ebook and audiobook requests. Approved book requests are added to Chaptarr in the requested format and searched for. You can connect multiple Chaptarr servers, but only one of them can be marked as default. Other Readarr compatible servers work too.',
  addchaptarr: 'Add Chaptarr Server',
  talearrsettings: 'Talearr Settings',
  talearrSettingsDescription:
    'Configure your Talearr server(s) below to enable ebook and audiobook requests. Talearr is a fork of Chaptarr, so approved book requests are added the same way, and its rejection labels show in manual searches. You can connect multiple Talearr servers, but only one of them can be marked as default.',
  addtalearr: 'Add Talearr Server',
  mediaTypeBook: 'book',
  bookService: 'Book Requests',
  bookServiceTip:
    'Choose where book requests are sent. Chaptarr and Talearr both use the servers above, so pick the one they run. Test a server to check.',
  bookServiceSaved: 'Book requests are now sent to {service}.',
  bookServiceFailed: 'Something went wrong while saving the book service.',
  audiobookVersions: 'Audiobook Versions',
  audiobookVersionsTip:
    'Which readings of an audiobook Talearr is asked for when a request is approved. Both adds the unabridged reading and asks for the abridged one as a recording of its own.',
  audiobookVersionsBoth: 'Both',
  audiobookVersionsUnabridged: 'Unabridged',
  audiobookVersionsAbridged: 'Abridged',
  audiobookVersionsRequester: 'The requester chooses',
  audiobookVersionsSaved: 'Audiobook versions saved.',
  audiobookVersionsFailed:
    'Something went wrong while saving the audiobook versions.',
  musicServiceSettingsDescription:
    'Configure your {serverType} server(s) below. You can connect multiple {serverType} servers, but only one of them can be marked as default. Administrators are able to override the server used to process new requests prior to approval.',
  deleteserverconfirm: 'Are you sure you want to delete this server?',
  ssl: 'SSL',
  default: 'Default',
  default4k: 'Default 4K',
  is4k: '4K',
  address: 'Address',
  activeProfile: 'Active Profile',
  addradarr: 'Add Radarr Server',
  addsonarr: 'Add Sonarr Server',
  addlidarr: 'Add Lidarr Server',
  noDefaultServer:
    'At least one {serverType} server must be marked as default in order for {mediaType} requests to be processed.',
  noDefaultNon4kServer:
    'If you only have a single {serverType} server for both non-4K and 4K content (or if you only download 4K content), your {serverType} server should <strong>NOT</strong> be designated as a 4K server.',
  noDefault4kServer:
    'A 4K {serverType} server must be marked as default in order to enable users to submit 4K {mediaType} requests.',
  mediaTypeMovie: 'movie',
  mediaTypeSeries: 'series',
  mediaTypeMusic: 'music',
  deleteServer: 'Delete {serverType} Server',
  overrideRules: 'Override Rules',
  overrideRulesDescription:
    'Override rules allow you to specify properties that will be replaced if a request matches the rule.',
  addrule: 'New Override Rule',
});

interface ServerInstanceProps {
  name: string;
  isDefault?: boolean;
  is4k?: boolean;
  hostname: string;
  port: number;
  isSSL?: boolean;
  externalUrl?: string;
  profileName: string;
  isSonarr?: boolean;
  isLidarr?: boolean;
  isLazyLibrarian?: boolean;
  isChaptarr?: boolean;
  isTalearr?: boolean;
  isBazarr?: boolean;
  isAudiobookshelf?: boolean;
  isNoBookEndsSync?: boolean;
  /** The address to show and link, for services set up by URL */
  url?: string;
  /** Shown in place of the active profile */
  detail?: { label: string; value: string };
  onEdit: () => void;
  onDelete: () => void;
}

export interface DVRTestResponse {
  profiles: {
    id: number;
    name: string;
  }[];
  rootFolders: {
    id: number;
    path: string;
  }[];
  tags: {
    id: number;
    label: string;
  }[];
  urlBase?: string;
}

export type RadarrTestResponse = DVRTestResponse;

export type SonarrTestResponse = DVRTestResponse & {
  languageProfiles:
    | {
        id: number;
        name: string;
      }[]
    | null;
};

export type LidarrTestResponse = DVRTestResponse & {
  metadataProfiles: {
    id: number;
    name: string;
  }[];
};

const ServerInstance = ({
  name,
  hostname,
  port,
  profileName,
  is4k = false,
  isDefault = false,
  isSSL = false,
  isSonarr = false,
  isLidarr = false,
  isLazyLibrarian = false,
  isChaptarr = false,
  isTalearr = false,
  isBazarr = false,
  isAudiobookshelf = false,
  isNoBookEndsSync = false,
  url,
  detail,
  externalUrl,
  onEdit,
  onDelete,
}: ServerInstanceProps) => {
  const intl = useIntl();

  const internalUrl =
    url ?? (isSSL ? 'https://' : 'http://') + hostname + ':' + String(port);
  const serviceUrl = externalUrl ?? internalUrl;

  return (
    <li className="service-card col-span-1 rounded-lg bg-gray-800 shadow ring-1 ring-gray-500">
      <div className="flex w-full items-center justify-between space-x-6 p-6">
        <div className="flex-1 truncate">
          <div className="mb-2 flex items-center space-x-2">
            <h3 className="truncate font-medium leading-5 text-white">
              <a
                href={serviceUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="transition duration-300 hover:text-white hover:underline"
              >
                {name}
              </a>
            </h3>
            {isDefault && !is4k && (
              <Badge>{intl.formatMessage(messages.default)}</Badge>
            )}
            {isDefault && is4k && (
              <Badge>{intl.formatMessage(messages.default4k)}</Badge>
            )}
            {!isDefault && is4k && (
              <Badge badgeType="warning">
                {intl.formatMessage(messages.is4k)}
              </Badge>
            )}
            {isSSL && (
              <Badge badgeType="success">
                {intl.formatMessage(messages.ssl)}
              </Badge>
            )}
          </div>
          <p className="mt-1 truncate text-sm leading-5 text-gray-300">
            <span className="mr-2 font-bold">
              {intl.formatMessage(messages.address)}
            </span>
            <a
              href={internalUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="transition duration-300 hover:text-white hover:underline"
            >
              {internalUrl}
            </a>
          </p>
          {detail ? (
            <p className="mt-1 truncate text-sm leading-5 text-gray-300">
              <span className="mr-2 font-bold">{detail.label}</span>
              {detail.value}
            </p>
          ) : (
            !isLazyLibrarian &&
            !isBazarr &&
            !isAudiobookshelf &&
            !isNoBookEndsSync && (
              <p className="mt-1 truncate text-sm leading-5 text-gray-300">
                <span className="mr-2 font-bold">
                  {intl.formatMessage(messages.activeProfile)}
                </span>
                {profileName}
              </p>
            )
          )}
        </div>
        <a
          href={serviceUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="opacity-50 hover:opacity-100"
        >
          {isTalearr ? (
            <picture>
              <source
                type="image/webp"
                srcSet="/companions/talearr.webp 1x, /companions/talearr@2x.webp 2x"
              />
              <img
                src="/companions/talearr.png"
                srcSet="/companions/talearr.png 1x, /companions/talearr@2x.png 2x"
                alt="Talearr"
                width={40}
                height={40}
                className="h-10 w-10 flex-shrink-0"
              />
            </picture>
          ) : isBazarr ? (
            <LanguageIcon className="h-10 w-10 flex-shrink-0" />
          ) : isNoBookEndsSync ? (
            <PlayCircleIcon className="h-10 w-10 flex-shrink-0" />
          ) : isLazyLibrarian || isChaptarr || isAudiobookshelf ? (
            <BookOpenIcon className="h-10 w-10 flex-shrink-0" />
          ) : isSonarr ? (
            <SonarrLogo className="h-10 w-10 flex-shrink-0" />
          ) : isLidarr ? (
            <LidarrLogo className="h-10 w-10 flex-shrink-0" />
          ) : (
            <RadarrLogo className="h-10 w-10 flex-shrink-0" />
          )}
        </a>
      </div>
      <div className="service-card-actions border-t border-gray-500">
        <div className="-mt-px flex">
          <div className="flex w-0 flex-1 border-r border-gray-500">
            <button
              onClick={() => onEdit()}
              className="focus:ring-blue relative -mr-px inline-flex w-0 flex-1 items-center justify-center rounded-bl-lg border border-transparent py-4 text-sm font-medium leading-5 text-gray-200 transition duration-150 ease-in-out hover:text-white focus:z-10 focus:border-gray-500 focus:outline-none"
            >
              <PencilIcon className="mr-2 h-5 w-5" />
              <span>{intl.formatMessage(globalMessages.edit)}</span>
            </button>
          </div>
          <div className="-ml-px flex w-0 flex-1">
            <button
              onClick={() => onDelete()}
              className="focus:ring-blue relative inline-flex w-0 flex-1 items-center justify-center rounded-br-lg border border-transparent py-4 text-sm font-medium leading-5 text-gray-200 transition duration-150 ease-in-out hover:text-white focus:z-10 focus:border-gray-500 focus:outline-none"
            >
              <TrashIcon className="mr-2 h-5 w-5" />
              <span>{intl.formatMessage(globalMessages.delete)}</span>
            </button>
          </div>
        </div>
      </div>
    </li>
  );
};

const SettingsServices = () => {
  const intl = useIntl();
  const {
    data: radarrData,
    error: radarrError,
    mutate: revalidateRadarr,
  } = useSWR<RadarrSettings[]>('/api/v1/settings/radarr');
  const {
    data: sonarrData,
    error: sonarrError,
    mutate: revalidateSonarr,
  } = useSWR<SonarrSettings[]>('/api/v1/settings/sonarr');
  const {
    data: lidarrData,
    error: lidarrError,
    mutate: revalidateLidarr,
  } = useSWR<LidarrSettings[]>('/api/v1/settings/lidarr');
  const {
    data: lazyLibrarianData,
    error: lazyLibrarianError,
    mutate: revalidateLazyLibrarian,
  } = useSWR<LazyLibrarianSettings>('/api/v1/settings/lazylibrarian');
  const {
    data: chaptarrData,
    error: chaptarrError,
    mutate: revalidateChaptarr,
  } = useSWR<ChaptarrSettings[]>('/api/v1/settings/chaptarr');
  const { data: mainData, mutate: revalidateMain } = useSWR<MainSettings>(
    '/api/v1/settings/main'
  );
  const { data: publicData } = useSWR<{ bookService?: BookService }>(
    '/api/v1/settings/public'
  );
  const {
    data: bazarrData,
    error: bazarrError,
    mutate: revalidateBazarr,
  } = useSWR<BazarrSettings>('/api/v1/settings/bazarr');
  const { addToast } = useToasts();
  const {
    data: audiobookshelfData,
    error: audiobookshelfError,
    mutate: revalidateAudiobookshelf,
  } = useSWR<AudiobookshelfSettingsResponse>('/api/v1/settings/audiobookshelf');
  const [editAudiobookshelfModal, setEditAudiobookshelfModal] = useState(false);
  const [deleteAudiobookshelfModal, setDeleteAudiobookshelfModal] =
    useState(false);
  const {
    data: nobookendsSyncData,
    error: nobookendsSyncError,
    mutate: revalidateNoBookEndsSync,
  } = useSWR<NoBookEndsSyncSettingsResponse>(
    '/api/v1/settings/nobookends-sync'
  );
  const [editNoBookEndsSyncModal, setEditNoBookEndsSyncModal] = useState(false);
  const [deleteNoBookEndsSyncModal, setDeleteNoBookEndsSyncModal] =
    useState(false);
  const [editBazarrModal, setEditBazarrModal] = useState(false);
  const [deleteBazarrModal, setDeleteBazarrModal] = useState(false);
  const [editLazyLibrarianModal, setEditLazyLibrarianModal] = useState(false);
  const [deleteLazyLibrarianModal, setDeleteLazyLibrarianModal] =
    useState(false);
  const { data: rules, mutate: revalidate } =
    useSWR<OverrideRuleResultsResponse>('/api/v1/overrideRule');
  const [editRadarrModal, setEditRadarrModal] = useState<{
    open: boolean;
    radarr: RadarrSettings | null;
  }>({
    open: false,
    radarr: null,
  });
  const [editSonarrModal, setEditSonarrModal] = useState<{
    open: boolean;
    sonarr: SonarrSettings | null;
  }>({
    open: false,
    sonarr: null,
  });
  const [editLidarrModal, setEditLidarrModal] = useState<{
    open: boolean;
    lidarr: LidarrSettings | null;
  }>({
    open: false,
    lidarr: null,
  });
  const [editChaptarrModal, setEditChaptarrModal] = useState<{
    open: boolean;
    chaptarr: ChaptarrSettings | null;
  }>({
    open: false,
    chaptarr: null,
  });
  const [deleteServerModal, setDeleteServerModal] = useState<{
    open: boolean;
    type: 'radarr' | 'sonarr' | 'lidarr' | 'chaptarr';
    serverId: number | null;
  }>({
    open: false,
    type: 'radarr',
    serverId: null,
  });
  const [overrideRuleModal, setOverrideRuleModal] = useState<{
    open: boolean;
    rule: OverrideRule | null;
  }>({
    open: false,
    rule: null,
  });

  const deleteServer = async () => {
    await axios.delete(
      `/api/v1/settings/${deleteServerModal.type}/${deleteServerModal.serverId}`
    );
    setDeleteServerModal({ open: false, serverId: null, type: 'radarr' });
    revalidateRadarr();
    revalidateSonarr();
    revalidateLidarr();
    revalidateChaptarr();
    mutate('/api/v1/settings/public');
  };

  // Saves where book requests go; the caller tells the user
  const applyBookService = async (bookService: BookService) => {
    await axios.post('/api/v1/settings/main', { bookService });
    await Promise.all([revalidateMain(), mutate('/api/v1/settings/public')]);
  };

  const saveBookService = async (bookService: BookService) => {
    try {
      await applyBookService(bookService);
      addToast(
        intl.formatMessage(messages.bookServiceSaved, {
          service: bookServiceName(bookService),
        }),
        { appearance: 'success', autoDismiss: true }
      );
    } catch {
      addToast(intl.formatMessage(messages.bookServiceFailed), {
        appearance: 'error',
        autoDismiss: true,
      });
    }
  };

  const saveAudiobookVersions = async (
    audiobookVersions: AudiobookVersionsMode
  ) => {
    try {
      await axios.post('/api/v1/settings/main', { audiobookVersions });
      await Promise.all([revalidateMain(), mutate('/api/v1/settings/public')]);
      addToast(intl.formatMessage(messages.audiobookVersionsSaved), {
        appearance: 'success',
        autoDismiss: true,
      });
    } catch {
      addToast(intl.formatMessage(messages.audiobookVersionsFailed), {
        appearance: 'error',
        autoDismiss: true,
      });
    }
  };

  // LazyLibrarian is a single server, removing it clears its connection
  const deleteLazyLibrarian = async () => {
    await axios.post('/api/v1/settings/lazylibrarian', {
      hostname: '',
      apiKey: '',
    });
    setDeleteLazyLibrarianModal(false);
    revalidateLazyLibrarian();
    mutate('/api/v1/settings/public');
  };

  // Audiobookshelf is a single link, removing it clears the address
  const deleteAudiobookshelf = async () => {
    await axios.post('/api/v1/settings/audiobookshelf', {
      url: '',
      libraryId: '',
      apiKey: '',
      adminApiKey: '',
    });
    setDeleteAudiobookshelfModal(false);
    revalidateAudiobookshelf();
  };

  // NoBookEnds Sync is a single server, removing it clears and disables it
  const deleteNoBookEndsSync = async () => {
    await axios.post('/api/v1/settings/nobookends-sync', {
      enabled: false,
      url: '',
      internalUrl: '',
      adminToken: '',
    });
    setDeleteNoBookEndsSyncModal(false);
    revalidateNoBookEndsSync();
  };

  // Bazarr is a single server, removing it clears its connection
  const deleteBazarr = async () => {
    await axios.post('/api/v1/settings/bazarr', {
      hostname: '',
      apiKey: '',
    });
    setDeleteBazarrModal(false);
    revalidateBazarr();
  };

  const isBazarrConfigured = !!bazarrData?.hostname && !!bazarrData.apiKey;

  const isLazyLibrarianConfigured =
    !!lazyLibrarianData?.hostname && !!lazyLibrarianData.apiKey;

  const hasDefaultChaptarr = !!chaptarrData?.some(
    (chaptarr) => chaptarr.isDefault || chaptarrData.length === 1
  );

  // Chaptarr and Talearr share the servers below, so there is always a
  // choice once one is set up
  const showBookService = hasDefaultChaptarr;

  const currentBookService: BookService =
    publicData?.bookService ?? mainData?.bookService ?? 'chaptarr';

  // What the Chaptarr servers are: Talearr when it is picked, even before
  // a server is set up, otherwise Chaptarr
  const chaptarrService: ChaptarrBookService = usesChaptarr(
    publicData?.bookService
  )
    ? publicData.bookService
    : mainData?.bookService === 'talearr'
      ? 'talearr'
      : 'chaptarr';
  const chaptarrServiceName = bookServiceName(chaptarrService);
  const isTalearr = chaptarrService === 'talearr';

  return (
    <>
      <PageTitle
        title={[
          intl.formatMessage(messages.services),
          intl.formatMessage(globalMessages.settings),
        ]}
      />
      <div className="mb-6">
        <h3 className="heading">
          {intl.formatMessage(messages.radarrsettings)}
        </h3>
        <p className="description">
          {intl.formatMessage(messages.videoServiceSettingsDescription, {
            serverType: 'Radarr',
          })}
        </p>
      </div>
      {editRadarrModal.open && (
        <RadarrModal
          radarr={editRadarrModal.radarr}
          onClose={() => {
            if (!overrideRuleModal.open)
              setEditRadarrModal({ open: false, radarr: null });
          }}
          onSave={() => {
            revalidateRadarr();
            mutate('/api/v1/settings/public');
            setEditRadarrModal({ open: false, radarr: null });
          }}
        />
      )}
      {editSonarrModal.open && (
        <SonarrModal
          sonarr={editSonarrModal.sonarr}
          onClose={() => {
            if (!overrideRuleModal.open)
              setEditSonarrModal({ open: false, sonarr: null });
          }}
          onSave={() => {
            revalidateSonarr();
            mutate('/api/v1/settings/public');
            setEditSonarrModal({ open: false, sonarr: null });
          }}
        />
      )}
      {editLidarrModal.open && (
        <LidarrModal
          lidarr={editLidarrModal.lidarr}
          onClose={() => setEditLidarrModal({ open: false, lidarr: null })}
          onSave={() => {
            revalidateLidarr();
            mutate('/api/v1/settings/public');
            setEditLidarrModal({ open: false, lidarr: null });
          }}
        />
      )}
      <Transition
        as={Fragment}
        show={deleteServerModal.open}
        enter="transition-opacity ease-in-out duration-300"
        enterFrom="opacity-0"
        enterTo="opacity-100"
        leave="transition-opacity ease-in-out duration-300"
        leaveFrom="opacity-100"
        leaveTo="opacity-0"
      >
        <Modal
          okText={intl.formatMessage(globalMessages.delete)}
          okButtonType="danger"
          onOk={() => deleteServer()}
          onCancel={() =>
            setDeleteServerModal({
              open: false,
              serverId: null,
              type: 'radarr',
            })
          }
          title={intl.formatMessage(messages.deleteServer, {
            serverType:
              deleteServerModal.type === 'radarr'
                ? 'Radarr'
                : deleteServerModal.type === 'sonarr'
                  ? 'Sonarr'
                  : deleteServerModal.type === 'chaptarr'
                    ? chaptarrServiceName
                    : 'Lidarr',
          })}
        >
          {intl.formatMessage(messages.deleteserverconfirm)}
        </Modal>
      </Transition>
      <div className="section">
        {!radarrData && !radarrError && <LoadingSpinner />}
        {radarrData && !radarrError && (
          <>
            {radarrData.length > 0 &&
              (!radarrData.some((radarr) => radarr.isDefault) ? (
                <Alert
                  title={intl.formatMessage(messages.noDefaultServer, {
                    serverType: 'Radarr',
                    mediaType: intl.formatMessage(messages.mediaTypeMovie),
                  })}
                />
              ) : !radarrData.some(
                  (radarr) => radarr.isDefault && !radarr.is4k
                ) ? (
                <Alert
                  title={intl.formatMessage(messages.noDefaultNon4kServer, {
                    serverType: 'Radarr',
                    strong: (msg: React.ReactNode) => (
                      <strong className="font-semibold text-white">
                        {msg}
                      </strong>
                    ),
                  })}
                />
              ) : (
                radarrData.some((radarr) => radarr.is4k) &&
                !radarrData.some(
                  (radarr) => radarr.isDefault && radarr.is4k
                ) && (
                  <Alert
                    title={intl.formatMessage(messages.noDefault4kServer, {
                      serverType: 'Radarr',
                      mediaType: intl.formatMessage(messages.mediaTypeMovie),
                    })}
                  />
                )
              ))}
            <ul className="grid max-w-6xl grid-cols-1 gap-6 lg:grid-cols-2 xl:grid-cols-3">
              {radarrData.map((radarr) => (
                <ServerInstance
                  key={`radarr-config-${radarr.id}`}
                  name={radarr.name}
                  hostname={radarr.hostname}
                  port={radarr.port}
                  profileName={radarr.activeProfileName}
                  isSSL={radarr.useSsl}
                  isDefault={radarr.isDefault}
                  is4k={radarr.is4k}
                  externalUrl={radarr.externalUrl}
                  onEdit={() => setEditRadarrModal({ open: true, radarr })}
                  onDelete={() =>
                    setDeleteServerModal({
                      open: true,
                      serverId: radarr.id,
                      type: 'radarr',
                    })
                  }
                />
              ))}
              <li className="col-span-1 h-32 rounded-lg border-2 border-dashed border-gray-400 shadow sm:h-44">
                <div className="flex h-full w-full items-center justify-center">
                  <Button
                    buttonType="ghost"
                    className="mb-3 mt-3"
                    onClick={() =>
                      setEditRadarrModal({ open: true, radarr: null })
                    }
                  >
                    <PlusIcon />
                    <span>{intl.formatMessage(messages.addradarr)}</span>
                  </Button>
                </div>
              </li>
            </ul>
          </>
        )}
      </div>
      <div className="mb-6 mt-10">
        <h3 className="heading">
          {intl.formatMessage(messages.sonarrsettings)}
        </h3>
        <p className="description">
          {intl.formatMessage(messages.videoServiceSettingsDescription, {
            serverType: 'Sonarr',
          })}
        </p>
      </div>
      <div className="section">
        {!sonarrData && !sonarrError && <LoadingSpinner />}
        {sonarrData && !sonarrError && (
          <>
            {sonarrData.length > 0 &&
              (!sonarrData.some((sonarr) => sonarr.isDefault) ? (
                <Alert
                  title={intl.formatMessage(messages.noDefaultServer, {
                    serverType: 'Sonarr',
                    mediaType: intl.formatMessage(messages.mediaTypeSeries),
                  })}
                />
              ) : !sonarrData.some(
                  (sonarr) => sonarr.isDefault && !sonarr.is4k
                ) ? (
                <Alert
                  title={intl.formatMessage(messages.noDefaultNon4kServer, {
                    serverType: 'Sonarr',
                    strong: (msg: React.ReactNode) => (
                      <strong className="font-semibold text-white">
                        {msg}
                      </strong>
                    ),
                  })}
                />
              ) : (
                sonarrData.some((sonarr) => sonarr.is4k) &&
                !sonarrData.some(
                  (sonarr) => sonarr.isDefault && sonarr.is4k
                ) && (
                  <Alert
                    title={intl.formatMessage(messages.noDefault4kServer, {
                      serverType: 'Sonarr',
                      mediaType: intl.formatMessage(messages.mediaTypeSeries),
                    })}
                  />
                )
              ))}
            <ul className="grid max-w-6xl grid-cols-1 gap-6 lg:grid-cols-2 xl:grid-cols-3">
              {sonarrData.map((sonarr) => (
                <ServerInstance
                  key={`sonarr-config-${sonarr.id}`}
                  name={sonarr.name}
                  hostname={sonarr.hostname}
                  port={sonarr.port}
                  profileName={sonarr.activeProfileName}
                  isSSL={sonarr.useSsl}
                  isSonarr
                  isDefault={sonarr.isDefault}
                  is4k={sonarr.is4k}
                  externalUrl={sonarr.externalUrl}
                  onEdit={() => setEditSonarrModal({ open: true, sonarr })}
                  onDelete={() =>
                    setDeleteServerModal({
                      open: true,
                      serverId: sonarr.id,
                      type: 'sonarr',
                    })
                  }
                />
              ))}
              <li className="col-span-1 h-32 rounded-lg border-2 border-dashed border-gray-400 shadow sm:h-44">
                <div className="flex h-full w-full items-center justify-center">
                  <Button
                    buttonType="ghost"
                    onClick={() =>
                      setEditSonarrModal({ open: true, sonarr: null })
                    }
                  >
                    <PlusIcon />
                    <span>{intl.formatMessage(messages.addsonarr)}</span>
                  </Button>
                </div>
              </li>
            </ul>
          </>
        )}
      </div>
      <div className="mb-6 mt-10">
        <h3 className="heading">
          {intl.formatMessage(messages.lidarrsettings)}
        </h3>
        <p className="description">
          {intl.formatMessage(messages.musicServiceSettingsDescription, {
            serverType: 'Lidarr',
          })}
        </p>
      </div>
      <div className="section">
        {!lidarrData && !lidarrError && <LoadingSpinner />}
        {lidarrData && !lidarrError && (
          <>
            {lidarrData.length > 0 &&
              (!lidarrData.some((lidarr) => lidarr.isDefault) ? (
                <Alert
                  title={intl.formatMessage(messages.noDefaultServer, {
                    serverType: 'Lidarr',
                    mediaType: intl.formatMessage(messages.mediaTypeMusic),
                  })}
                />
              ) : null)}
            <ul className="grid max-w-6xl grid-cols-1 gap-6 lg:grid-cols-2 xl:grid-cols-3">
              {lidarrData.map((lidarr) => (
                <ServerInstance
                  key={`lidarr-config-${lidarr.id}`}
                  name={lidarr.name}
                  hostname={lidarr.hostname}
                  port={lidarr.port}
                  profileName={lidarr.activeProfileName}
                  isSSL={lidarr.useSsl}
                  isLidarr={true}
                  isDefault={lidarr.isDefault}
                  externalUrl={lidarr.externalUrl}
                  onEdit={() => setEditLidarrModal({ open: true, lidarr })}
                  onDelete={() =>
                    setDeleteServerModal({
                      open: true,
                      serverId: lidarr.id,
                      type: 'lidarr',
                    })
                  }
                />
              ))}
              <li className="col-span-1 h-32 rounded-lg border-2 border-dashed border-gray-400 shadow sm:h-44">
                <div className="flex h-full w-full items-center justify-center">
                  <Button
                    buttonType="ghost"
                    onClick={() =>
                      setEditLidarrModal({ open: true, lidarr: null })
                    }
                  >
                    <PlusIcon />
                    <span>{intl.formatMessage(messages.addlidarr)}</span>
                  </Button>
                </div>
              </li>
            </ul>
          </>
        )}
      </div>
      <div className="mb-6 mt-10">
        <h3 className="heading">
          {intl.formatMessage(
            isTalearr ? messages.talearrsettings : messages.chaptarrsettings
          )}
        </h3>
        <p className="description">
          {intl.formatMessage(
            isTalearr
              ? messages.talearrSettingsDescription
              : messages.chaptarrSettingsDescription
          )}
        </p>
      </div>
      {editChaptarrModal.open && (
        <ChaptarrModal
          chaptarr={editChaptarrModal.chaptarr}
          service={chaptarrService}
          // A LazyLibrarian pick is left alone
          canSwitchService={mainData?.bookService !== 'lazylibrarian'}
          onSwitchService={applyBookService}
          onClose={() => setEditChaptarrModal({ open: false, chaptarr: null })}
          onSave={() => {
            revalidateChaptarr();
            mutate('/api/v1/settings/public');
            setEditChaptarrModal({ open: false, chaptarr: null });
          }}
        />
      )}
      <div className="section">
        {!chaptarrData && !chaptarrError && <LoadingSpinner />}
        {chaptarrData && !chaptarrError && (
          <>
            {chaptarrData.length > 1 &&
              !chaptarrData.some((chaptarr) => chaptarr.isDefault) && (
                <Alert
                  title={intl.formatMessage(messages.noDefaultServer, {
                    serverType: chaptarrServiceName,
                    mediaType: intl.formatMessage(messages.mediaTypeBook),
                  })}
                />
              )}
            <ul className="grid max-w-6xl grid-cols-1 gap-6 lg:grid-cols-2 xl:grid-cols-3">
              {chaptarrData.map((chaptarr) => (
                <ServerInstance
                  key={`chaptarr-config-${chaptarr.id}`}
                  name={chaptarr.name}
                  hostname={chaptarr.hostname}
                  port={chaptarr.port}
                  profileName={[
                    chaptarr.activeProfileName,
                    chaptarr.activeAudiobookProfileName,
                  ]
                    .filter(Boolean)
                    .join(', ')}
                  isSSL={chaptarr.useSsl}
                  isChaptarr
                  isTalearr={isTalearr}
                  isDefault={chaptarr.isDefault}
                  externalUrl={chaptarr.externalUrl}
                  onEdit={() => setEditChaptarrModal({ open: true, chaptarr })}
                  onDelete={() =>
                    setDeleteServerModal({
                      open: true,
                      serverId: chaptarr.id,
                      type: 'chaptarr',
                    })
                  }
                />
              ))}
              <li className="col-span-1 h-32 rounded-lg border-2 border-dashed border-gray-400 shadow sm:h-44">
                <div className="flex h-full w-full items-center justify-center">
                  <Button
                    buttonType="ghost"
                    onClick={() =>
                      setEditChaptarrModal({ open: true, chaptarr: null })
                    }
                  >
                    <PlusIcon />
                    <span>
                      {intl.formatMessage(
                        isTalearr ? messages.addtalearr : messages.addchaptarr
                      )}
                    </span>
                  </Button>
                </div>
              </li>
            </ul>
          </>
        )}
        {showBookService && (
          <div className="form-row mt-6 max-w-6xl">
            <label htmlFor="bookService" className="text-label">
              {intl.formatMessage(messages.bookService)}
              <span className="label-tip">
                {intl.formatMessage(messages.bookServiceTip)}
              </span>
            </label>
            <div className="form-input-area">
              <div className="form-input-field">
                <select
                  id="bookService"
                  name="bookService"
                  value={currentBookService}
                  onChange={(e) =>
                    saveBookService(e.target.value as BookService)
                  }
                >
                  <option value="chaptarr">Chaptarr</option>
                  <option value="talearr">Talearr</option>
                  {isLazyLibrarianConfigured && (
                    <option value="lazylibrarian">LazyLibrarian</option>
                  )}
                </select>
              </div>
            </div>
          </div>
        )}
        {showBookService && currentBookService === 'talearr' && (
          <div className="form-row max-w-6xl">
            <label htmlFor="audiobookVersions" className="text-label">
              {intl.formatMessage(messages.audiobookVersions)}
              <span className="label-tip">
                {intl.formatMessage(messages.audiobookVersionsTip)}
              </span>
            </label>
            <div className="form-input-area">
              <div className="form-input-field">
                <select
                  id="audiobookVersions"
                  name="audiobookVersions"
                  value={
                    isAudiobookVersionsMode(mainData?.audiobookVersions)
                      ? mainData.audiobookVersions
                      : DEFAULT_AUDIOBOOK_VERSIONS_MODE
                  }
                  onChange={(e) =>
                    saveAudiobookVersions(
                      e.target.value as AudiobookVersionsMode
                    )
                  }
                >
                  <option value="both">
                    {intl.formatMessage(messages.audiobookVersionsBoth)}
                  </option>
                  <option value="unabridged">
                    {intl.formatMessage(messages.audiobookVersionsUnabridged)}
                  </option>
                  <option value="abridged">
                    {intl.formatMessage(messages.audiobookVersionsAbridged)}
                  </option>
                  <option value="requester">
                    {intl.formatMessage(messages.audiobookVersionsRequester)}
                  </option>
                </select>
              </div>
            </div>
          </div>
        )}
      </div>
      <div className="mb-6 mt-10">
        <h3 className="heading">
          {intl.formatMessage(messages.audiobookshelfsettings)}
        </h3>
        <p className="description">
          {intl.formatMessage(messages.audiobookshelfSettingsDescription)}
        </p>
      </div>
      {editAudiobookshelfModal && audiobookshelfData && (
        <AudiobookshelfModal
          audiobookshelf={audiobookshelfData}
          onClose={() => setEditAudiobookshelfModal(false)}
          onSave={() => {
            revalidateAudiobookshelf();
            setEditAudiobookshelfModal(false);
          }}
        />
      )}
      <Transition
        as={Fragment}
        show={deleteAudiobookshelfModal}
        enter="transition-opacity ease-in-out duration-300"
        enterFrom="opacity-0"
        enterTo="opacity-100"
        leave="transition-opacity ease-in-out duration-300"
        leaveFrom="opacity-100"
        leaveTo="opacity-0"
      >
        <Modal
          okText={intl.formatMessage(globalMessages.delete)}
          okButtonType="danger"
          onOk={() => deleteAudiobookshelf()}
          onCancel={() => setDeleteAudiobookshelfModal(false)}
          title={intl.formatMessage(messages.deleteaudiobookshelf)}
        >
          {intl.formatMessage(messages.deleteaudiobookshelfconfirm)}
        </Modal>
      </Transition>
      <div className="section">
        {!audiobookshelfData && !audiobookshelfError && <LoadingSpinner />}
        {audiobookshelfData && !audiobookshelfError && (
          <ul className="grid max-w-6xl grid-cols-1 gap-6 lg:grid-cols-2 xl:grid-cols-3">
            {audiobookshelfData.url ? (
              <ServerInstance
                name="Audiobookshelf"
                hostname=""
                port={0}
                url={audiobookshelfData.url}
                profileName="-"
                isSSL={audiobookshelfData.url.startsWith('https://')}
                isAudiobookshelf
                detail={{
                  label: intl.formatMessage(messages.library),
                  value:
                    audiobookshelfData.libraryId ||
                    intl.formatMessage(messages.homepage),
                }}
                onEdit={() => setEditAudiobookshelfModal(true)}
                onDelete={() => setDeleteAudiobookshelfModal(true)}
              />
            ) : (
              <li className="col-span-1 h-32 rounded-lg border-2 border-dashed border-gray-400 shadow sm:h-44">
                <div className="flex h-full w-full items-center justify-center">
                  <Button
                    buttonType="ghost"
                    onClick={() => setEditAudiobookshelfModal(true)}
                  >
                    <PlusIcon />
                    <span>
                      {intl.formatMessage(messages.configureaudiobookshelf)}
                    </span>
                  </Button>
                </div>
              </li>
            )}
          </ul>
        )}
      </div>
      <div className="mb-6 mt-10">
        <h3 className="heading">
          {intl.formatMessage(messages.nobookendssyncsettings)}
        </h3>
        <p className="description">
          {intl.formatMessage(messages.nobookendsSyncSettingsDescription)}
        </p>
        <p className="description">
          {intl.formatMessage(messages.nobookendsSyncRecommended, {
            SyncLink: (msg: React.ReactNode) => (
              <a
                href="https://nobookends.com/sync"
                className="text-white transition duration-300 hover:underline"
                target="_blank"
                rel="noreferrer"
              >
                {msg}
              </a>
            ),
          })}
        </p>
        <p className="description">
          {intl.formatMessage(messages.nobookendsSyncSetupPage, {
            PageLink: (msg: React.ReactNode) => (
              <Link
                href="/settings/nobookends-sync"
                className="text-white transition duration-300 hover:underline"
              >
                {msg}
              </Link>
            ),
          })}
        </p>
      </div>
      {editNoBookEndsSyncModal && nobookendsSyncData && (
        <NoBookEndsSyncModal
          nobookendsSync={nobookendsSyncData}
          onClose={() => setEditNoBookEndsSyncModal(false)}
          onSave={() => {
            revalidateNoBookEndsSync();
            setEditNoBookEndsSyncModal(false);
          }}
        />
      )}
      <Transition
        as={Fragment}
        show={deleteNoBookEndsSyncModal}
        enter="transition-opacity ease-in-out duration-300"
        enterFrom="opacity-0"
        enterTo="opacity-100"
        leave="transition-opacity ease-in-out duration-300"
        leaveFrom="opacity-100"
        leaveTo="opacity-0"
      >
        <Modal
          okText={intl.formatMessage(globalMessages.delete)}
          okButtonType="danger"
          onOk={() => deleteNoBookEndsSync()}
          onCancel={() => setDeleteNoBookEndsSyncModal(false)}
          title={intl.formatMessage(messages.deletenobookendssync)}
        >
          {intl.formatMessage(messages.deletenobookendssyncconfirm)}
        </Modal>
      </Transition>
      <div className="section">
        {!nobookendsSyncData && !nobookendsSyncError && <LoadingSpinner />}
        {nobookendsSyncData && !nobookendsSyncError && (
          <ul className="grid max-w-6xl grid-cols-1 gap-6 lg:grid-cols-2 xl:grid-cols-3">
            {nobookendsSyncData.url || nobookendsSyncData.internalUrl ? (
              <ServerInstance
                name="NoBookEnds Sync"
                hostname=""
                port={0}
                url={nobookendsSyncData.url || nobookendsSyncData.internalUrl}
                profileName="-"
                isSSL={(
                  nobookendsSyncData.url || nobookendsSyncData.internalUrl
                ).startsWith('https://')}
                isNoBookEndsSync
                detail={{
                  label: intl.formatMessage(messages.syncStatus),
                  value: intl.formatMessage(
                    !nobookendsSyncData.enabled
                      ? messages.syncDisabled
                      : nobookendsSyncData.adminTokenSet
                        ? messages.syncEnabled
                        : messages.syncNoToken
                  ),
                }}
                onEdit={() => setEditNoBookEndsSyncModal(true)}
                onDelete={() => setDeleteNoBookEndsSyncModal(true)}
              />
            ) : (
              <li className="col-span-1 h-32 rounded-lg border-2 border-dashed border-gray-400 shadow sm:h-44">
                <div className="flex h-full w-full items-center justify-center">
                  <Button
                    buttonType="ghost"
                    onClick={() => setEditNoBookEndsSyncModal(true)}
                  >
                    <PlusIcon />
                    <span>
                      {intl.formatMessage(messages.configurenobookendssync)}
                    </span>
                  </Button>
                </div>
              </li>
            )}
          </ul>
        )}
      </div>
      <div className="mb-6 mt-10">
        <h3 className="heading">
          {intl.formatMessage(messages.lazylibrariansettings)}
        </h3>
        <p className="description">
          {intl.formatMessage(messages.lazylibrarianSettingsDescription)}
        </p>
      </div>
      <Alert
        type="warning"
        title={intl.formatMessage(messages.lazylibrarianLimits)}
      >
        {intl.formatMessage(messages.lazylibrarianLimitsDetail)}
      </Alert>
      {editLazyLibrarianModal && lazyLibrarianData && (
        <LazyLibrarianModal
          lazyLibrarian={lazyLibrarianData}
          onClose={() => setEditLazyLibrarianModal(false)}
          onSave={() => {
            revalidateLazyLibrarian();
            mutate('/api/v1/settings/public');
            setEditLazyLibrarianModal(false);
          }}
        />
      )}
      <Transition
        as={Fragment}
        show={deleteLazyLibrarianModal}
        enter="transition-opacity ease-in-out duration-300"
        enterFrom="opacity-0"
        enterTo="opacity-100"
        leave="transition-opacity ease-in-out duration-300"
        leaveFrom="opacity-100"
        leaveTo="opacity-0"
      >
        <Modal
          okText={intl.formatMessage(globalMessages.delete)}
          okButtonType="danger"
          onOk={() => deleteLazyLibrarian()}
          onCancel={() => setDeleteLazyLibrarianModal(false)}
          title={intl.formatMessage(messages.deletelazylibrarian)}
        >
          {intl.formatMessage(messages.deletelazylibrarianconfirm)}
        </Modal>
      </Transition>
      <div className="section">
        {!lazyLibrarianData && !lazyLibrarianError && <LoadingSpinner />}
        {lazyLibrarianData && !lazyLibrarianError && (
          <ul className="grid max-w-6xl grid-cols-1 gap-6 lg:grid-cols-2 xl:grid-cols-3">
            {isLazyLibrarianConfigured ? (
              <ServerInstance
                name="LazyLibrarian"
                hostname={lazyLibrarianData.hostname ?? ''}
                port={lazyLibrarianData.port ?? 5299}
                profileName="-"
                isSSL={lazyLibrarianData.useSsl}
                isLazyLibrarian
                externalUrl={lazyLibrarianData.externalUrl || undefined}
                onEdit={() => setEditLazyLibrarianModal(true)}
                onDelete={() => setDeleteLazyLibrarianModal(true)}
              />
            ) : (
              <li className="col-span-1 h-32 rounded-lg border-2 border-dashed border-gray-400 shadow sm:h-44">
                <div className="flex h-full w-full items-center justify-center">
                  <Button
                    buttonType="ghost"
                    onClick={() => setEditLazyLibrarianModal(true)}
                  >
                    <PlusIcon />
                    <span>
                      {intl.formatMessage(messages.configurelazylibrarian)}
                    </span>
                  </Button>
                </div>
              </li>
            )}
          </ul>
        )}
      </div>
      <div className="mb-6 mt-10">
        <h3 className="heading">
          {intl.formatMessage(messages.bazarrsettings)}
        </h3>
        <p className="description">
          {intl.formatMessage(messages.bazarrSettingsDescription)}
        </p>
      </div>
      {editBazarrModal && bazarrData && (
        <BazarrModal
          bazarr={bazarrData}
          onClose={() => setEditBazarrModal(false)}
          onSave={() => {
            revalidateBazarr();
            setEditBazarrModal(false);
          }}
        />
      )}
      <Transition
        as={Fragment}
        show={deleteBazarrModal}
        enter="transition-opacity ease-in-out duration-300"
        enterFrom="opacity-0"
        enterTo="opacity-100"
        leave="transition-opacity ease-in-out duration-300"
        leaveFrom="opacity-100"
        leaveTo="opacity-0"
      >
        <Modal
          okText={intl.formatMessage(globalMessages.delete)}
          okButtonType="danger"
          onOk={() => deleteBazarr()}
          onCancel={() => setDeleteBazarrModal(false)}
          title={intl.formatMessage(messages.deletebazarr)}
        >
          {intl.formatMessage(messages.deletebazarrconfirm)}
        </Modal>
      </Transition>
      <div className="section">
        {!bazarrData && !bazarrError && <LoadingSpinner />}
        {bazarrData && !bazarrError && (
          <ul className="grid max-w-6xl grid-cols-1 gap-6 lg:grid-cols-2 xl:grid-cols-3">
            {isBazarrConfigured ? (
              <ServerInstance
                name="Bazarr"
                hostname={bazarrData.hostname ?? ''}
                port={bazarrData.port ?? 6767}
                profileName="-"
                isSSL={bazarrData.useSsl}
                isBazarr
                externalUrl={bazarrData.externalUrl || undefined}
                onEdit={() => setEditBazarrModal(true)}
                onDelete={() => setDeleteBazarrModal(true)}
              />
            ) : (
              <li className="col-span-1 h-32 rounded-lg border-2 border-dashed border-gray-400 shadow sm:h-44">
                <div className="flex h-full w-full items-center justify-center">
                  <Button
                    buttonType="ghost"
                    onClick={() => setEditBazarrModal(true)}
                  >
                    <PlusIcon />
                    <span>{intl.formatMessage(messages.configurebazarr)}</span>
                  </Button>
                </div>
              </li>
            )}
          </ul>
        )}
      </div>
      <div className="mb-6 mt-10">
        <h3 className="heading">
          {intl.formatMessage(messages.overrideRules)}
        </h3>
        <p className="description">
          {intl.formatMessage(messages.overrideRulesDescription, {
            serverType: 'Sonarr',
          })}
        </p>
      </div>
      <div className="section">
        <ul className="grid max-w-6xl grid-cols-1 gap-6 lg:grid-cols-2 xl:grid-cols-3">
          {rules && radarrData && sonarrData && (
            <OverrideRuleTiles
              rules={rules}
              radarrServices={radarrData}
              sonarrServices={sonarrData}
              lidarrServices={lidarrData ?? []}
              setOverrideRuleModal={setOverrideRuleModal}
              revalidate={revalidate}
            />
          )}
          <li className="min-h-[8rem] rounded-lg border-2 border-dashed border-gray-400 shadow sm:min-h-[11rem]">
            <div className="flex h-full w-full items-center justify-center">
              <Button
                buttonType="ghost"
                disabled={
                  !radarrData?.length &&
                  !sonarrData?.length &&
                  !lidarrData?.length
                }
                onClick={() =>
                  setOverrideRuleModal({
                    open: true,
                    rule: null,
                  })
                }
              >
                <PlusIcon />
                <span>{intl.formatMessage(messages.addrule)}</span>
              </Button>
            </div>
          </li>
        </ul>
      </div>
      {overrideRuleModal.open && radarrData && sonarrData && (
        <OverrideRuleModal
          rule={overrideRuleModal.rule}
          onClose={() => {
            setOverrideRuleModal({
              open: false,
              rule: null,
            });
            revalidate();
          }}
          radarrServices={radarrData}
          sonarrServices={sonarrData}
          lidarrServices={lidarrData ?? []}
        />
      )}
    </>
  );
};

export default SettingsServices;
