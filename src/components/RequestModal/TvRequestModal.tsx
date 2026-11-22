import Alert from '@app/components/Common/Alert';
import Badge from '@app/components/Common/Badge';
import Modal from '@app/components/Common/Modal';
import type { RequestOverrides } from '@app/components/RequestModal/AdvancedRequester';
import AdvancedRequester from '@app/components/RequestModal/AdvancedRequester';
import EpisodeSelector from '@app/components/RequestModal/EpisodeSelector';
import QuotaDisplay from '@app/components/RequestModal/QuotaDisplay';
import SearchByNameModal from '@app/components/RequestModal/SearchByNameModal';
import UnwatchedQuotaNotice from '@app/components/RequestModal/UnwatchedQuotaNotice';
import { formatEpisodeNumbers } from '@app/components/RequestSeasonBadges';
import useSettings from '@app/hooks/useSettings';
import useToasts from '@app/hooks/useToasts';
import { useUser } from '@app/hooks/useUser';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import { getRequestErrorMessage } from '@app/utils/requestErrorMessage';
import { ChevronDownIcon, ChevronUpIcon } from '@heroicons/react/24/solid';
import { ANIME_KEYWORD_ID } from '@server/api/themoviedb/constants';
import {
  MediaRequestMonitorMode,
  MediaRequestStatus,
  MediaStatus,
} from '@server/constants/media';
import type { MediaRequest } from '@server/entity/MediaRequest';
import type SeasonRequest from '@server/entity/SeasonRequest';
import type { NonFunctionProperties } from '@server/interfaces/api/common';
import type { QuotaResponse } from '@server/interfaces/api/userInterfaces';
import {
  TV_RATINGS,
  exceedsRatingLimit,
  getTvContentRating,
} from '@server/lib/contentRatingLimit';
import type { RequestedEpisodes } from '@server/lib/episodeRequests';
import {
  getCurrentSeasonNumber,
  getFutureSeasonNumbers,
} from '@server/lib/episodeRequests';
import { Permission } from '@server/lib/permissions';
import type { TvDetails } from '@server/models/Tv';
import axios from 'axios';
import { Fragment, useState } from 'react';
import { useIntl } from 'react-intl';
import useSWR, { mutate } from 'swr';

const messages = defineMessages('components.RequestModal', {
  requestadmin: 'This request will be approved automatically.',
  requestSuccess: '<strong>{title}</strong> requested successfully!',
  requestseriestitle: 'Request Series',
  requestseries4ktitle: 'Request Series in 4K',
  edit: 'Edit Request',
  approve: 'Approve Request',
  cancel: 'Cancel Request',
  pendingrequest: 'Pending Request',
  pending4krequest: 'Pending 4K Request',
  requestfrom: "{username}'s request is pending approval.",
  requestseasons:
    'Request {seasonCount} {seasonCount, plural, one {Season} other {Seasons}}',
  requestseasons4k:
    'Request {seasonCount} {seasonCount, plural, one {Season} other {Seasons}} in 4K',
  alreadyrequested: 'Already Requested',
  selectseason: 'Select Season(s)',
  season: 'Season',
  numberofepisodes: '# of Episodes',
  seasonnumber: 'Season {number}',
  errorediting: 'Something went wrong while editing the request.',
  requestedited: 'Request for <strong>{title}</strong> edited successfully!',
  requestApproved: 'Request for <strong>{title}</strong> approved!',
  requestcancelled: 'Request for <strong>{title}</strong> canceled.',
  autoapproval: 'Automatic Approval',
  requesterror: 'Something went wrong while submitting the request.',
  noSeasonsAvailable:
    'All of the selected seasons are already requested or available.',
  pendingapproval: 'Your request is pending approval.',
  ratingrestricted: 'This title is not available for your profile.',
  requestepisodes:
    'Request {episodeCount} {episodeCount, plural, one {Episode} other {Episodes}}',
  requestepisodes4k:
    'Request {episodeCount} {episodeCount, plural, one {Episode} other {Episodes}} in 4K',
  requestfutureseasons: 'Request Future Seasons',
  requestfutureseasons4k: 'Request Future Seasons in 4K',
  futureonly: 'Only future seasons',
  futureonlydescription:
    'Monitor only episodes that have not aired yet. Episodes that already aired are not searched for.',
  nofutureseasons: 'This series has no airing or announced seasons to follow.',
  monitormode: 'Seasons to request',
  selectedseasons: 'All selected seasons',
  allseasons: 'All seasons',
  currentonly: 'Only the current season',
  currentonlydescription:
    'Keeps only the airing season. Older seasons are deleted when a new season starts.',
  nocurrentseason:
    'The current season of this series is already requested or available.',
  requestcurrentseason: 'Request Current Season',
  requestcurrentseason4k: 'Request Current Season in 4K',
  selectedepisodes: '{selected} of {total}',
  showepisodes: 'Show episodes of season {number}',
  hideepisodes: 'Hide episodes of season {number}',
});

interface RequestModalProps extends React.HTMLAttributes<HTMLDivElement> {
  tmdbId: number;
  onCancel?: () => void;
  onComplete?: (newStatus: MediaStatus) => void;
  onUpdating?: (isUpdating: boolean) => void;
  is4k?: boolean;
  editRequest?: NonFunctionProperties<MediaRequest>;
}

const TvRequestModal = ({
  onCancel,
  onComplete,
  tmdbId,
  onUpdating,
  editRequest,
  is4k = false,
}: RequestModalProps) => {
  const settings = useSettings();
  const { addToast } = useToasts();
  const editingSeasons: number[] = (editRequest?.seasons ?? []).map(
    (season) => season.seasonNumber
  );
  const editingEpisodes: Record<number, number[]> = Object.fromEntries(
    (editRequest?.seasons ?? [])
      .filter((season) => !!season.episodes?.length)
      .map((season) => [season.seasonNumber, season.episodes ?? []])
  );
  const { data, error } = useSWR<TvDetails>(`/api/v1/tv/${tmdbId}`);
  const [requestOverrides, setRequestOverrides] =
    useState<RequestOverrides | null>(null);
  const [selectedSeasons, setSelectedSeasons] = useState<number[]>(
    editRequest
      ? editingSeasons.filter((season) => !editingEpisodes[season])
      : []
  );
  const [selectedEpisodes, setSelectedEpisodes] =
    useState<Record<number, number[]>>(editingEpisodes);
  const [expandedSeasons, setExpandedSeasons] = useState<number[]>([]);
  const [monitorMode, setMonitorMode] = useState<MediaRequestMonitorMode>(
    editRequest?.monitorMode ?? MediaRequestMonitorMode.SEASONS
  );
  const isFutureOnly = monitorMode === MediaRequestMonitorMode.FUTURE;
  const isCurrentOnly = monitorMode === MediaRequestMonitorMode.CURRENT;
  // Both pick their seasons themselves, so seasons cannot be toggled
  const isRollingMode = isFutureOnly || isCurrentOnly;
  // Without partial series requests, a regular request takes every season
  const isAllSeasonsRequest =
    !settings.currentSettings.partialRequestsEnabled && !isRollingMode;
  const intl = useIntl();
  const { user, hasPermission } = useUser();
  const [searchModal, setSearchModal] = useState<{
    show: boolean;
  }>({
    show: true,
  });
  const [tvdbId, setTvdbId] = useState<number | undefined>(undefined);
  const { data: quota } = useSWR<QuotaResponse>(
    user &&
      (!requestOverrides?.user?.id || hasPermission(Permission.MANAGE_USERS))
      ? `/api/v1/user/${requestOverrides?.user?.id ?? user.id}/quota`
      : null
  );

  // Only seasons other requests hold as a whole block episode requests
  const otherActiveRequests = (data?.mediaInfo?.requests ?? []).filter(
    (request) =>
      request.is4k === is4k &&
      request.id !== editRequest?.id &&
      request.status !== MediaRequestStatus.DECLINED &&
      request.status !== MediaRequestStatus.COMPLETED
  );

  const getRequestedEpisodes = (seasonNumber: number): number[] =>
    otherActiveRequests
      .flatMap((request) => request.seasons)
      .filter((season) => season.seasonNumber === seasonNumber)
      .flatMap((season) => season.episodes ?? []);

  const isWholeSeasonRequested = (seasonNumber: number): boolean =>
    otherActiveRequests.some((request) =>
      request.seasons.some(
        (season) =>
          season.seasonNumber === seasonNumber && !season.episodes?.length
      )
    );

  const getMediaSeason = (seasonNumber: number) =>
    data?.mediaInfo?.seasons.find(
      (season) => season.seasonNumber === seasonNumber
    );

  const episodeSeasons = Object.keys(selectedEpisodes)
    .map(Number)
    .filter((seasonNumber) => selectedEpisodes[seasonNumber]?.length > 0)
    .sort((a, b) => a - b);

  const getRequestedEpisodesBody = (): RequestedEpisodes[] =>
    episodeSeasons.map((seasonNumber) => ({
      seasonNumber,
      episodeNumbers: selectedEpisodes[seasonNumber],
    }));

  const updateRequest = async (alsoApproveRequest = false) => {
    if (!editRequest) {
      return;
    }

    if (onUpdating) {
      onUpdating(true);
      mutate('/api/v1/request/count');
    }

    try {
      if (getSelectionCount() > 0) {
        const response = await axios.put(`/api/v1/request/${editRequest.id}`, {
          mediaType: 'tv',
          serverId: requestOverrides?.server,
          profileId: requestOverrides?.profile,
          rootFolder: requestOverrides?.folder,
          languageProfileId: requestOverrides?.language,
          userId: requestOverrides?.user?.id,
          tags: requestOverrides?.tags,
          seasons: isRollingMode ? [] : selectedSeasons.sort((a, b) => a - b),
          episodes: isRollingMode ? [] : getRequestedEpisodesBody(),
          monitorMode,
        });

        // 202: the edit left no seasons to request, so nothing was changed
        if (response.status === 202) {
          addToast(intl.formatMessage(messages.noSeasonsAvailable), {
            appearance: 'info',
            autoDismiss: true,
          });
          return;
        }

        if (alsoApproveRequest) {
          await axios.post(`/api/v1/request/${editRequest.id}/approve`);
        }
      } else {
        await axios.delete(`/api/v1/request/${editRequest.id}`);
      }
      mutate('/api/v1/request?filter=all&take=10&sort=modified&skip=0');
      mutate('/api/v1/request/count');

      addToast(
        <span>
          {getSelectionCount() > 0
            ? intl.formatMessage(
                alsoApproveRequest
                  ? messages.requestApproved
                  : messages.requestedited,
                {
                  title: data?.name,
                  strong: (msg: React.ReactNode) => <strong>{msg}</strong>,
                }
              )
            : intl.formatMessage(messages.requestcancelled, {
                title: data?.name,
                strong: (msg: React.ReactNode) => <strong>{msg}</strong>,
              })}
        </span>,
        {
          appearance: 'success',
          autoDismiss: true,
        }
      );
      if (onComplete) {
        onComplete(MediaStatus.PENDING);
      }
    } catch {
      addToast(<span>{intl.formatMessage(messages.errorediting)}</span>, {
        appearance: 'error',
        autoDismiss: true,
      });
    } finally {
      if (onUpdating) {
        onUpdating(false);
      }
    }
  };

  const sendRequest = async () => {
    if (
      (settings.currentSettings.partialRequestsEnabled || isCurrentOnly) &&
      getSelectionCount() === 0
    ) {
      return;
    }

    if (onUpdating) {
      onUpdating(true);
      mutate('/api/v1/request/count');
    }

    try {
      let overrideParams = {};
      if (requestOverrides) {
        overrideParams = {
          serverId: requestOverrides.server,
          profileId: requestOverrides.profile,
          rootFolder: requestOverrides.folder,
          languageProfileId: requestOverrides.language,
          userId: requestOverrides?.user?.id,
          tags: requestOverrides.tags,
        };
      }
      const response = await axios.post<MediaRequest | { message: string }>(
        '/api/v1/request',
        {
          mediaId: data?.id,
          tvdbId: tvdbId ?? data?.externalIds.tvdbId,
          mediaType: 'tv',
          is4k,
          ignoreQuota: requestOverrides?.ignoreQuota,
          seasons: isCurrentOnly
            ? getCurrentSeasons()
            : settings.currentSettings.partialRequestsEnabled
              ? isFutureOnly
                ? getFutureSeasons()
                : selectedSeasons.sort((a, b) => a - b)
              : getAllSeasons().filter(
                  (season) => !getAllRequestedSeasons().includes(season)
                ),
          episodes:
            settings.currentSettings.partialRequestsEnabled &&
            !isRollingMode &&
            episodeSeasons.length > 0
              ? getRequestedEpisodesBody()
              : undefined,
          monitorMode: isRollingMode ? monitorMode : undefined,
          ...overrideParams,
        }
      );
      mutate('/api/v1/request?filter=all&take=10&sort=modified&skip=0');

      if (response.data && 'media' in response.data) {
        if (onComplete) {
          onComplete(response.data.media.status);
        }
        addToast(
          <span>
            {intl.formatMessage(messages.requestSuccess, {
              title: data?.name,
              strong: (msg: React.ReactNode) => <strong>{msg}</strong>,
            })}
          </span>,
          { appearance: 'success', autoDismiss: true }
        );
      } else if (response.status === 202) {
        // 202: every requested season is already covered, nothing new to request
        addToast(intl.formatMessage(messages.noSeasonsAvailable), {
          appearance: 'info',
          autoDismiss: true,
        });
      }
    } catch (e) {
      addToast(
        getRequestErrorMessage(e) ?? intl.formatMessage(messages.requesterror),
        {
          appearance: 'error',
          autoDismiss: true,
        }
      );
    } finally {
      if (onUpdating) {
        onUpdating(false);
      }
    }
  };

  const getAllSeasons = (): number[] => {
    let allSeasons = (data?.seasons ?? []).filter(
      (season) => season.episodeCount !== 0
    );
    if (!settings.currentSettings.enableSpecialEpisodes) {
      allSeasons = allSeasons.filter((season) => season.seasonNumber > 0);
    }
    return allSeasons.map((season) => season.seasonNumber);
  };

  const getAllRequestedSeasons = (): number[] => {
    const requestedSeasons = (data?.mediaInfo?.requests ?? [])
      .filter(
        (request) =>
          request.is4k === is4k &&
          request.status !== MediaRequestStatus.DECLINED &&
          request.status !== MediaRequestStatus.COMPLETED
      )
      .reduce((requestedSeasons, request) => {
        return [
          ...requestedSeasons,
          ...request.seasons
            .filter((season) => !editingSeasons.includes(season.seasonNumber))
            .map((sr) => sr.seasonNumber),
        ];
      }, [] as number[]);

    const availableSeasons = (data?.mediaInfo?.seasons ?? [])
      .filter(
        (season) =>
          (season[is4k ? 'status4k' : 'status'] === MediaStatus.AVAILABLE ||
            season[is4k ? 'status4k' : 'status'] ===
              MediaStatus.PARTIALLY_AVAILABLE ||
            season[is4k ? 'status4k' : 'status'] === MediaStatus.PROCESSING) &&
          !requestedSeasons.includes(season.seasonNumber)
      )
      .map((season) => season.seasonNumber);

    return [...requestedSeasons, ...availableSeasons];
  };

  const getFutureSeasons = (): number[] => {
    if (!data) {
      return [];
    }

    return getFutureSeasonNumbers(data).filter(
      (season) => !getAllRequestedSeasons().includes(season)
    );
  };

  const getCurrentSeasons = (): number[] => {
    const currentSeason = data ? getCurrentSeasonNumber(data) : null;

    return currentSeason !== null &&
      !getAllRequestedSeasons().includes(currentSeason)
      ? [currentSeason]
      : [];
  };

  // An episode request counts as one season, like it does for quotas
  const getSelectionCount = (): number =>
    isFutureOnly
      ? getFutureSeasons().length
      : isCurrentOnly
        ? getCurrentSeasons().length
        : selectedSeasons.length + episodeSeasons.length;

  const canSelectEpisodes = (seasonNumber: number): boolean =>
    settings.currentSettings.partialRequestsEnabled &&
    !isRollingMode &&
    !isWholeSeasonRequested(seasonNumber) &&
    getMediaSeason(seasonNumber)?.[is4k ? 'status4k' : 'status'] !==
      MediaStatus.AVAILABLE;

  const toggleExpandedSeason = (seasonNumber: number): void => {
    setExpandedSeasons((seasons) =>
      seasons.includes(seasonNumber)
        ? seasons.filter((sn) => sn !== seasonNumber)
        : [...seasons, seasonNumber]
    );
  };

  const toggleEpisode = (seasonNumber: number, episodeNumber: number): void => {
    if (!canSelectEpisodes(seasonNumber)) {
      return;
    }

    // A season that is not part of the request yet needs room in the quota
    if (
      quota?.tv.limit &&
      currentlyRemaining <= 0 &&
      !isSelectedSeason(seasonNumber) &&
      !selectedEpisodes[seasonNumber]
    ) {
      return;
    }

    setSelectedSeasons((seasons) =>
      seasons.filter((sn) => sn !== seasonNumber)
    );
    setSelectedEpisodes((episodes) => {
      const current = episodes[seasonNumber] ?? [];
      const next = current.includes(episodeNumber)
        ? current.filter((ep) => ep !== episodeNumber)
        : [...current, episodeNumber].sort((a, b) => a - b);
      const updated = { ...episodes };

      if (next.length > 0) {
        updated[seasonNumber] = next;
      } else {
        delete updated[seasonNumber];
      }

      return updated;
    });
  };

  const getModeSeasons = (mode: MediaRequestMonitorMode): number[] =>
    mode === MediaRequestMonitorMode.FUTURE
      ? getFutureSeasons()
      : mode === MediaRequestMonitorMode.CURRENT
        ? getCurrentSeasons()
        : [];

  // Future and current season requests need seasons to follow and room for
  // them in the quota
  const canSelectMonitorMode = (mode: MediaRequestMonitorMode): boolean =>
    mode === MediaRequestMonitorMode.SEASONS ||
    mode === monitorMode ||
    (getModeSeasons(mode).length > 0 &&
      !(
        quota?.tv.limit &&
        (quota.tv.remaining ?? 0) + (editRequest?.seasons ?? []).length <
          getModeSeasons(mode).length
      ));

  const selectMonitorMode = (mode: MediaRequestMonitorMode): void => {
    if (!canSelectMonitorMode(mode)) {
      return;
    }

    setMonitorMode(mode);
    setExpandedSeasons([]);
  };

  const monitorModes = [
    {
      mode: MediaRequestMonitorMode.SEASONS,
      label: settings.currentSettings.partialRequestsEnabled
        ? messages.selectedseasons
        : messages.allseasons,
      unavailable: null,
    },
    ...(settings.currentSettings.partialRequestsEnabled
      ? [
          {
            mode: MediaRequestMonitorMode.FUTURE,
            label: messages.futureonly,
            unavailable:
              getFutureSeasons().length === 0 ? messages.nofutureseasons : null,
          },
        ]
      : []),
    // Managers can always request only the current season
    ...(settings.currentSettings.allowCurrentSeasonRequests ||
    hasPermission(Permission.MANAGE_REQUESTS) ||
    editRequest?.monitorMode === MediaRequestMonitorMode.CURRENT
      ? [
          {
            mode: MediaRequestMonitorMode.CURRENT,
            label: messages.currentonly,
            unavailable:
              getCurrentSeasons().length === 0
                ? messages.nocurrentseason
                : null,
          },
        ]
      : []),
  ];

  const isSelectedSeason = (seasonNumber: number): boolean =>
    selectedSeasons.includes(seasonNumber);

  const toggleSeason = (seasonNumber: number): void => {
    // If this season already has a pending request, don't allow it to be toggled
    if (isRollingMode || getAllRequestedSeasons().includes(seasonNumber)) {
      return;
    }

    // If there are no more remaining requests available, block toggle
    if (
      quota?.tv.limit &&
      currentlyRemaining <= 0 &&
      !isSelectedSeason(seasonNumber) &&
      !selectedEpisodes[seasonNumber]
    ) {
      return;
    }

    // The whole season replaces any episodes picked from it
    setSelectedEpisodes((episodes) => {
      const updated = { ...episodes };
      delete updated[seasonNumber];
      return updated;
    });

    if (selectedSeasons.includes(seasonNumber)) {
      setSelectedSeasons((seasons) =>
        seasons.filter((sn) => sn !== seasonNumber)
      );
    } else {
      setSelectedSeasons((seasons) => [...seasons, seasonNumber]);
    }
  };

  const currentlyRemaining =
    (quota?.tv.remaining ?? 0) -
    getSelectionCount() +
    (editRequest?.seasons ?? []).length;

  const unrequestedSeasons = getAllSeasons().filter(
    (season) => !getAllRequestedSeasons().includes(season)
  );

  const toggleAllSeasons = (): void => {
    // If the user has a quota and not enough requests for all seasons, block toggleAllSeasons
    if (
      isRollingMode ||
      (quota?.tv.limit &&
        (quota?.tv.remaining ?? 0) < unrequestedSeasons.length)
    ) {
      return;
    }

    if (
      data &&
      selectedSeasons.length >= 0 &&
      selectedSeasons.length < unrequestedSeasons.length
    ) {
      setSelectedSeasons(unrequestedSeasons);
      setSelectedEpisodes((episodes) =>
        Object.fromEntries(
          Object.entries(episodes).filter(
            ([seasonNumber]) =>
              !unrequestedSeasons.includes(Number(seasonNumber))
          )
        )
      );
    } else {
      setSelectedSeasons([]);
      setSelectedEpisodes({});
    }
  };

  const isAllSeasons = (): boolean => {
    if (!data) {
      return false;
    }
    return (
      selectedSeasons.filter((season) => season !== 0).length ===
      getAllSeasons().filter(
        (season) => !getAllRequestedSeasons().includes(season) && season !== 0
      ).length
    );
  };

  const getSeasonRequest = (
    seasonNumber: number
  ): SeasonRequest | undefined => {
    let seasonRequest: SeasonRequest | undefined;

    if (
      data?.mediaInfo &&
      (data.mediaInfo.requests || []).filter(
        (request) =>
          request.is4k === is4k &&
          request.status !== MediaRequestStatus.DECLINED &&
          request.status !== MediaRequestStatus.COMPLETED
      ).length > 0
    ) {
      data.mediaInfo.requests
        .filter(
          (request) =>
            request.is4k === is4k &&
            request.status !== MediaRequestStatus.DECLINED &&
            request.status !== MediaRequestStatus.COMPLETED
        )
        .forEach((request) => {
          if (!seasonRequest) {
            seasonRequest = request.seasons.find(
              (season) =>
                season.seasonNumber === seasonNumber &&
                season.status !== MediaRequestStatus.COMPLETED
            );
          }
        });
    }

    return seasonRequest;
  };

  const isOwner = editRequest && editRequest.requestedBy.id === user?.id;

  // Mirrors the content rating limit checked when the request is created
  const ratingRestricted =
    !hasPermission(Permission.MANAGE_REQUESTS) &&
    exceedsRatingLimit(
      TV_RATINGS,
      getTvContentRating(data?.contentRatings),
      user?.tvRatingLimit
    );

  return data && !error && !data.externalIds.tvdbId && searchModal.show ? (
    <SearchByNameModal
      tvdbId={tvdbId}
      setTvdbId={setTvdbId}
      closeModal={() => setSearchModal({ show: false })}
      onCancel={onCancel}
      modalTitle={intl.formatMessage(
        is4k ? messages.requestseries4ktitle : messages.requestseriestitle
      )}
      modalSubTitle={data.name}
      tmdbId={tmdbId}
      backdrop={`https://image.tmdb.org/t/p/w1920_and_h800_multi_faces/${data?.backdropPath}`}
    />
  ) : (
    <Modal
      loading={!data && !error}
      backgroundClickable
      onCancel={tvdbId ? () => setSearchModal({ show: true }) : onCancel}
      onOk={() =>
        editRequest
          ? hasPermission(Permission.MANAGE_REQUESTS)
            ? updateRequest(true)
            : updateRequest()
          : sendRequest()
      }
      title={intl.formatMessage(
        editRequest
          ? is4k
            ? messages.pending4krequest
            : messages.pendingrequest
          : is4k
            ? messages.requestseries4ktitle
            : messages.requestseriestitle
      )}
      subTitle={data?.name}
      okText={
        editRequest
          ? getSelectionCount() === 0
            ? intl.formatMessage(messages.cancel)
            : hasPermission(Permission.MANAGE_REQUESTS)
              ? intl.formatMessage(messages.approve)
              : intl.formatMessage(messages.edit)
          : unrequestedSeasons.length === 0 && getSelectionCount() === 0
            ? intl.formatMessage(messages.alreadyrequested)
            : isCurrentOnly
              ? intl.formatMessage(
                  is4k
                    ? messages.requestcurrentseason4k
                    : messages.requestcurrentseason
                )
              : !settings.currentSettings.partialRequestsEnabled
                ? intl.formatMessage(
                    is4k ? globalMessages.request4k : globalMessages.request
                  )
                : isFutureOnly
                  ? intl.formatMessage(
                      is4k
                        ? messages.requestfutureseasons4k
                        : messages.requestfutureseasons
                    )
                  : getSelectionCount() === 0
                    ? intl.formatMessage(messages.selectseason)
                    : selectedSeasons.length === 0
                      ? intl.formatMessage(
                          is4k
                            ? messages.requestepisodes4k
                            : messages.requestepisodes,
                          {
                            episodeCount: episodeSeasons.reduce(
                              (count, seasonNumber) =>
                                count + selectedEpisodes[seasonNumber].length,
                              0
                            ),
                          }
                        )
                      : intl.formatMessage(
                          is4k
                            ? messages.requestseasons4k
                            : messages.requestseasons,
                          {
                            seasonCount: getSelectionCount(),
                          }
                        )
      }
      okDisabled={
        editRequest
          ? false
          : ratingRestricted ||
              (quota?.unwatched?.restricted && !requestOverrides?.ignoreQuota)
            ? true
            : isCurrentOnly
              ? getSelectionCount() === 0
              : !settings.currentSettings.partialRequestsEnabled &&
                  quota?.tv.limit &&
                  unrequestedSeasons.length > quota.tv.limit &&
                  !requestOverrides?.ignoreQuota
                ? true
                : settings.currentSettings.partialRequestsEnabled
                  ? getSelectionCount() === 0
                  : unrequestedSeasons.length === 0
      }
      okButtonType={
        editRequest
          ? (settings.currentSettings.partialRequestsEnabled ||
              isCurrentOnly) &&
            getSelectionCount() === 0
            ? 'danger'
            : hasPermission(Permission.MANAGE_REQUESTS)
              ? 'success'
              : 'primary'
          : 'primary'
      }
      cancelText={
        editRequest
          ? intl.formatMessage(globalMessages.close)
          : tvdbId
            ? intl.formatMessage(globalMessages.back)
            : intl.formatMessage(globalMessages.cancel)
      }
      backdrop={`https://image.tmdb.org/t/p/w1920_and_h800_multi_faces/${data?.backdropPath}`}
    >
      {editRequest
        ? isOwner
          ? intl.formatMessage(messages.pendingapproval)
          : intl.formatMessage(messages.requestfrom, {
              username: editRequest?.requestedBy.displayName,
            })
        : null}
      {ratingRestricted && !editRequest && (
        <div className="mt-6">
          <Alert
            title={intl.formatMessage(messages.ratingrestricted)}
            type="warning"
          />
        </div>
      )}
      {hasPermission(
        [
          Permission.MANAGE_REQUESTS,
          is4k ? Permission.AUTO_APPROVE_4K : Permission.AUTO_APPROVE,
          is4k ? Permission.AUTO_APPROVE_4K_TV : Permission.AUTO_APPROVE_TV,
        ],
        { type: 'or' }
      ) &&
        !ratingRestricted &&
        !(
          quota?.tv.limit &&
          isAllSeasonsRequest &&
          unrequestedSeasons.length > (quota?.tv.remaining ?? 0)
        ) &&
        getAllRequestedSeasons().length < getAllSeasons().length &&
        !editRequest && (
          <div className="mt-6">
            <Alert
              title={intl.formatMessage(messages.requestadmin)}
              type="info"
            />
          </div>
        )}
      {quota?.unwatched?.restricted && (
        <UnwatchedQuotaNotice
          quota={quota.unwatched}
          userOverride={
            requestOverrides?.user && requestOverrides.user.id !== user?.id
              ? requestOverrides?.user?.id
              : undefined
          }
        />
      )}
      {(quota?.tv.limit ?? 0) > 0 && (
        <QuotaDisplay
          mediaType="tv"
          quota={quota?.tv}
          remaining={
            isAllSeasonsRequest &&
            unrequestedSeasons.length > (quota?.tv.remaining ?? 0)
              ? 0
              : currentlyRemaining
          }
          userOverride={
            requestOverrides?.user && requestOverrides.user.id !== user?.id
              ? requestOverrides?.user?.id
              : undefined
          }
          overLimit={
            isAllSeasonsRequest &&
            unrequestedSeasons.length > (quota?.tv.remaining ?? 0)
              ? unrequestedSeasons.length
              : undefined
          }
        />
      )}
      {monitorModes.length > 1 && (
        <div className="mb-4 rounded-lg border border-gray-700 bg-gray-800/60 p-4 backdrop-blur">
          <div
            role="radiogroup"
            aria-label={intl.formatMessage(messages.monitormode)}
            className="flex flex-col gap-1 rounded-md bg-gray-900/60 p-1 sm:flex-row"
          >
            {monitorModes.map(({ mode, label, unavailable }) => {
              const isSelected = monitorMode === mode;
              const isUnavailable = !canSelectMonitorMode(mode);

              return (
                <button
                  key={mode}
                  type="button"
                  role="radio"
                  aria-checked={isSelected}
                  aria-disabled={isUnavailable}
                  title={
                    isUnavailable && unavailable
                      ? intl.formatMessage(unavailable)
                      : undefined
                  }
                  onClick={() => selectMonitorMode(mode)}
                  className={`flex-1 rounded px-3 py-1.5 text-sm font-medium transition-colors duration-200 focus:outline-none focus-visible:ring focus-visible:ring-indigo-500 ${
                    isSelected
                      ? 'bg-indigo-500 text-white shadow'
                      : isUnavailable
                        ? 'cursor-not-allowed text-gray-500'
                        : 'text-gray-300 hover:bg-gray-700/70 hover:text-white'
                  }`}
                >
                  {intl.formatMessage(label)}
                </button>
              );
            })}
          </div>
          {isRollingMode && (
            <div className="mt-3 text-sm text-gray-400">
              {intl.formatMessage(
                isCurrentOnly
                  ? messages.currentonlydescription
                  : messages.futureonlydescription
              )}
            </div>
          )}
        </div>
      )}
      <div className="flex flex-col">
        <div className="-mx-4 sm:mx-0">
          <div className="inline-block min-w-full py-2 align-middle">
            <div className="overflow-hidden border border-gray-700 shadow backdrop-blur sm:rounded-lg">
              <table className="min-w-full">
                <thead>
                  <tr>
                    <th
                      className={`w-16 bg-gray-700/80 px-4 py-3 ${
                        !settings.currentSettings.partialRequestsEnabled &&
                        'hidden'
                      }`}
                    >
                      <span
                        role="checkbox"
                        tabIndex={0}
                        aria-checked={isAllSeasons()}
                        onClick={() => toggleAllSeasons()}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === 'Space') {
                            toggleAllSeasons();
                          }
                        }}
                        className={`relative inline-flex h-5 w-10 flex-shrink-0 cursor-pointer items-center justify-center pt-2 focus:outline-none ${
                          isRollingMode ||
                          (quota?.tv.remaining &&
                            quota.tv.limit &&
                            quota.tv.remaining < unrequestedSeasons.length)
                            ? 'opacity-50'
                            : ''
                        }`}
                      >
                        <span
                          aria-hidden="true"
                          className={`${
                            isAllSeasons() ? 'bg-indigo-500' : 'bg-gray-800'
                          } absolute mx-auto h-4 w-9 rounded-full transition-colors duration-200 ease-in-out`}
                        />
                        <span
                          aria-hidden="true"
                          className={`${
                            isAllSeasons() ? 'translate-x-5' : 'translate-x-0'
                          } absolute left-0 inline-block h-5 w-5 rounded-full border border-gray-200 bg-white shadow transition-transform duration-200 ease-in-out group-focus:border-blue-300 group-focus:ring`}
                        />
                      </span>
                    </th>
                    <th className="bg-gray-700/80 px-1 py-3 text-left text-xs font-medium uppercase leading-4 tracking-wider text-gray-200 md:px-6">
                      {intl.formatMessage(messages.season)}
                    </th>
                    <th className="bg-gray-700/80 px-5 py-3 text-left text-xs font-medium uppercase leading-4 tracking-wider text-gray-200 md:px-6">
                      {intl.formatMessage(messages.numberofepisodes)}
                    </th>
                    <th className="bg-gray-700/80 px-2 py-3 text-left text-xs font-medium uppercase leading-4 tracking-wider text-gray-200 md:px-6">
                      {intl.formatMessage(globalMessages.status)}
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-700">
                  {data?.seasons
                    .filter(
                      (season) =>
                        season.episodeCount !== 0 &&
                        (settings.currentSettings.enableSpecialEpisodes ||
                          season.seasonNumber !== 0)
                    )
                    .map((season) => {
                      const seasonRequest = getSeasonRequest(
                        season.seasonNumber
                      );
                      const mediaSeason = data?.mediaInfo?.seasons.find(
                        (sn) =>
                          sn.seasonNumber === season.seasonNumber &&
                          sn[is4k ? 'status4k' : 'status'] !==
                            MediaStatus.UNKNOWN &&
                          sn[is4k ? 'status4k' : 'status'] !==
                            MediaStatus.DELETED
                      );
                      const requestedEpisodes = getRequestedEpisodes(
                        season.seasonNumber
                      );
                      const pickedEpisodes =
                        selectedEpisodes[season.seasonNumber] ?? [];
                      const isExpanded =
                        expandedSeasons.includes(season.seasonNumber) &&
                        canSelectEpisodes(season.seasonNumber);
                      // Episode requests leave the rest of the season open
                      const isSeasonOn =
                        !!mediaSeason ||
                        (!!seasonRequest &&
                          !seasonRequest.episodes?.length &&
                          !editingSeasons.includes(season.seasonNumber)) ||
                        isSelectedSeason(season.seasonNumber) ||
                        (isRollingMode &&
                          getModeSeasons(monitorMode).includes(
                            season.seasonNumber
                          ));
                      return (
                        <Fragment key={`season-${season.id}`}>
                          <tr>
                            <td
                              className={`whitespace-nowrap px-4 py-4 text-sm font-medium leading-5 text-gray-100 ${
                                !settings.currentSettings
                                  .partialRequestsEnabled && 'hidden'
                              }`}
                            >
                              <span
                                role="checkbox"
                                tabIndex={0}
                                aria-checked={isSeasonOn}
                                onClick={() =>
                                  toggleSeason(season.seasonNumber)
                                }
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter' || e.key === 'Space') {
                                    toggleSeason(season.seasonNumber);
                                  }
                                }}
                                className={`relative inline-flex h-5 w-10 flex-shrink-0 cursor-pointer items-center justify-center pt-2 focus:outline-none ${
                                  mediaSeason ||
                                  isRollingMode ||
                                  (quota?.tv.limit &&
                                    currentlyRemaining <= 0 &&
                                    !isSelectedSeason(season.seasonNumber)) ||
                                  (!!seasonRequest &&
                                    !editingSeasons.includes(
                                      season.seasonNumber
                                    ))
                                    ? 'opacity-50'
                                    : ''
                                }`}
                              >
                                <span
                                  aria-hidden="true"
                                  className={`${
                                    isSeasonOn ? 'bg-indigo-500' : 'bg-gray-700'
                                  } absolute mx-auto h-4 w-9 rounded-full transition-colors duration-200 ease-in-out`}
                                />
                                <span
                                  aria-hidden="true"
                                  className={`${
                                    isSeasonOn
                                      ? 'translate-x-5'
                                      : 'translate-x-0'
                                  } absolute left-0 inline-block h-5 w-5 rounded-full border border-gray-200 bg-white shadow transition-transform duration-200 ease-in-out group-focus:border-blue-300 group-focus:ring`}
                                />
                              </span>
                            </td>
                            <td className="whitespace-nowrap px-1 py-4 text-sm font-medium leading-5 text-gray-100 md:px-6">
                              {canSelectEpisodes(season.seasonNumber) ? (
                                <button
                                  type="button"
                                  className="flex items-center gap-1 hover:text-white focus:outline-none"
                                  aria-expanded={isExpanded}
                                  aria-label={intl.formatMessage(
                                    isExpanded
                                      ? messages.hideepisodes
                                      : messages.showepisodes,
                                    { number: season.seasonNumber }
                                  )}
                                  onClick={() =>
                                    toggleExpandedSeason(season.seasonNumber)
                                  }
                                >
                                  {season.seasonNumber === 0
                                    ? intl.formatMessage(
                                        globalMessages.specials
                                      )
                                    : intl.formatMessage(
                                        messages.seasonnumber,
                                        {
                                          number: season.seasonNumber,
                                        }
                                      )}
                                  {isExpanded ? (
                                    <ChevronUpIcon className="h-4 w-4" />
                                  ) : (
                                    <ChevronDownIcon className="h-4 w-4" />
                                  )}
                                </button>
                              ) : season.seasonNumber === 0 ? (
                                intl.formatMessage(globalMessages.specials)
                              ) : (
                                intl.formatMessage(messages.seasonnumber, {
                                  number: season.seasonNumber,
                                })
                              )}
                            </td>
                            <td className="whitespace-nowrap px-5 py-4 text-sm leading-5 text-gray-200 md:px-6">
                              {pickedEpisodes.length > 0
                                ? intl.formatMessage(
                                    messages.selectedepisodes,
                                    {
                                      selected: pickedEpisodes.length,
                                      total: season.episodeCount,
                                    }
                                  )
                                : season.episodeCount}
                            </td>
                            <td className="whitespace-nowrap py-4 pr-2 text-sm leading-5 text-gray-200 md:px-6">
                              {!seasonRequest && !mediaSeason && (
                                <Badge>
                                  {intl.formatMessage(
                                    globalMessages.notrequested
                                  )}
                                </Badge>
                              )}
                              {!mediaSeason &&
                                seasonRequest?.status ===
                                  MediaRequestStatus.PENDING && (
                                  <Badge badgeType="warning">
                                    {intl.formatMessage(globalMessages.pending)}
                                  </Badge>
                                )}
                              {((!mediaSeason &&
                                seasonRequest?.status ===
                                  MediaRequestStatus.APPROVED) ||
                                mediaSeason?.[is4k ? 'status4k' : 'status'] ===
                                  MediaStatus.PROCESSING) && (
                                <Badge badgeType="primary">
                                  {intl.formatMessage(globalMessages.requested)}
                                </Badge>
                              )}
                              {mediaSeason?.[is4k ? 'status4k' : 'status'] ===
                                MediaStatus.PARTIALLY_AVAILABLE && (
                                <Badge badgeType="success">
                                  {intl.formatMessage(
                                    globalMessages.partiallyavailable
                                  )}
                                </Badge>
                              )}
                              {mediaSeason?.[is4k ? 'status4k' : 'status'] ===
                                MediaStatus.AVAILABLE && (
                                <Badge badgeType="success">
                                  {intl.formatMessage(globalMessages.available)}
                                </Badge>
                              )}
                              {requestedEpisodes.length > 0 && (
                                <span className="ml-2 text-xs text-gray-400">
                                  {formatEpisodeNumbers(requestedEpisodes)}
                                </span>
                              )}
                            </td>
                          </tr>
                          {isExpanded && (
                            <tr>
                              <td colSpan={4} className="bg-gray-800/40 p-0">
                                <EpisodeSelector
                                  tmdbId={tmdbId}
                                  seasonNumber={season.seasonNumber}
                                  selectedEpisodes={pickedEpisodes}
                                  requestedEpisodes={requestedEpisodes}
                                  availableEpisodes={
                                    getMediaSeason(season.seasonNumber)?.[
                                      is4k
                                        ? 'availableEpisodes4k'
                                        : 'availableEpisodes'
                                    ] ?? []
                                  }
                                  onToggle={(episodeNumber) =>
                                    toggleEpisode(
                                      season.seasonNumber,
                                      episodeNumber
                                    )
                                  }
                                />
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      );
                    })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
      {hasPermission(
        [Permission.REQUEST_ADVANCED, Permission.MANAGE_REQUESTS],
        { type: 'or' }
      ) && (
        <AdvancedRequester
          type="tv"
          tmdbId={tmdbId}
          is4k={is4k}
          isAnime={data?.keywords.some(
            (keyword) => keyword.id === ANIME_KEYWORD_ID
          )}
          quota={quota}
          onChange={(overrides) => setRequestOverrides(overrides)}
          requestUser={editRequest?.requestedBy}
          requestId={editRequest?.id}
          defaultOverrides={
            editRequest
              ? {
                  folder: editRequest.rootFolder,
                  profile: editRequest.profileId,
                  server: editRequest.serverId,
                  language: editRequest.languageProfileId,
                  tags: editRequest.tags,
                }
              : undefined
          }
        />
      )}
    </Modal>
  );
};

export default TvRequestModal;
