import {
  Card,
  DetailRow,
  LinkChips,
  TitleHero,
} from '@app/components/Allseerr/Title';
import Biography from '@app/components/Allseerr/Title/Biography';
import StatusPill from '@app/components/Allseerr/Title/StatusPill';
import {
  chip,
  pillPrimary,
  pillSecondaryCollapse,
} from '@app/components/Allseerr/Title/styles';
import ComicVolumes, {
  listComicVolumes,
} from '@app/components/ComicDetails/ComicVolumes';
import Button from '@app/components/Common/Button';
import FormatIcon, { useFormatLabel } from '@app/components/Common/FormatIcon';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import PageTitle from '@app/components/Common/PageTitle';
import NotifyMeButton from '@app/components/NotifyMeButton';
import {
  getComicStatus,
  getMissingVolumes,
} from '@app/components/TitleCard/ComicTitleCard';
import useComicsEnabled from '@app/hooks/useComicsEnabled';
import useReadingAppPrompt from '@app/hooks/useReadingAppPrompt';
import useToasts from '@app/hooks/useToasts';
import { Permission, useUser } from '@app/hooks/useUser';
import globalMessages from '@app/i18n/globalMessages';
import ErrorPage from '@app/pages/_error';
import defineMessages from '@app/utils/defineMessages';
import { ArrowDownTrayIcon } from '@heroicons/react/24/outline';
import { ChatBubbleOvalLeftIcon } from '@heroicons/react/24/solid';
import type { ComicKind } from '@server/constants/media';
import { MediaStatus } from '@server/constants/media';
import { getRequestedComicVolumes } from '@server/lib/comicVolumes';
import type { ComicDetails as ComicDetailsType } from '@server/models/Comic';
import axios from 'axios';
import { useRouter } from 'next/router';
import { useState } from 'react';
import { useIntl } from 'react-intl';
import useSWR from 'swr';

const messages = defineMessages('components.ComicDetails', {
  byauthors: 'by {authors}',
  volumes: '{count, plural, one {# volume} other {# volumes}}',
  inlibrary:
    '{downloaded} of {total, plural, one {# volume} other {# volumes}} in the library',
  details: 'Details',
  kind: 'Kind',
  status: 'Status',
  agerating: 'Age rating',
  alsoknownas: 'Also known as',
  fileas: 'File as',
  fileashint:
    'Only Hardcover knows this series, so it is not certain whether it is manga or a comic. Pick how Talearr files it.',
  requestseries: 'Request Series',
  requestmissing: 'Request Missing Volumes',
  requestallvolumes:
    '{count, plural, one {Request # Volume} other {Request All # Volumes}}',
  requestmissingvolumes:
    '{count, plural, one {Request # Missing Volume} other {Request # Missing Volumes}}',
  requestselectedvolumes:
    '{count, plural, one {Request # Volume} other {Request # Volumes}}',
  selectedcount:
    '{count, plural, one {# volume selected} other {# volumes selected}}',
  volumescount: 'Volumes',
  year: 'Year',
  format: 'Format',
  genres: 'Genres',
  authors: 'Authors',
  library: 'In library',
  requestsuccess: '<strong>{title}</strong> requested successfully!',
  requesterror: 'Something went wrong while requesting the series.',
  overviewunavailable: 'No description available.',
  comicsoff: 'Comics are not turned on.',
});

// Talearr's lookup says unrated series are Unknown
const isRated = (rating?: string) => !!rating && rating !== 'Unknown';

// AniList descriptions carry simple markup, such as <br> and <i>
const plainText = (text: string) =>
  text
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

const KindChoice = ({
  value,
  onChange,
}: {
  value: ComicKind;
  onChange: (kind: ComicKind) => void;
}) => {
  const intl = useIntl();
  const kinds: ComicKind[] = ['manga', 'comic'];

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <span className="text-sm font-semibold text-as-ink">
          {intl.formatMessage(messages.fileas)}
        </span>
        <div role="radiogroup" className="flex gap-1.5">
          {kinds.map((kind) => (
            <button
              key={kind}
              type="button"
              role="radio"
              aria-checked={value === kind}
              onClick={() => onChange(kind)}
              className={`${chip} ${
                value === kind
                  ? '!border-transparent !bg-as-accent font-semibold !text-as-ground'
                  : ''
              }`}
            >
              {intl.formatMessage(globalMessages[kind])}
            </button>
          ))}
        </div>
      </div>
      <p className="max-w-[560px] text-[13px] text-as-ink-faint">
        {intl.formatMessage(messages.fileashint)}
      </p>
    </div>
  );
};

/**
 * Page of a comic or manga series from Talearr's comics lookup, with what
 * Talearr's library holds of it and a request button
 */
const ComicDetails = () => {
  const intl = useIntl();
  const router = useRouter();
  const { addToast } = useToasts();
  const { hasPermission } = useUser();
  const comicsEnabled = useComicsEnabled();
  const promptReadingApp = useReadingAppPrompt('comic');
  const comicId = router.query.comicId as string;
  const { data, error, mutate } = useSWR<ComicDetailsType>(
    comicId ? `/api/v1/comic/${comicId}` : null
  );
  const [kindChoice, setKindChoice] = useState<ComicKind | undefined>();
  const [isRequesting, setIsRequesting] = useState(false);
  const [selectedVolumes, setSelectedVolumes] = useState<number[]>([]);
  const kindLabel = useFormatLabel(kindChoice ?? data?.kind ?? 'manga');

  if (!data && !error) {
    return <LoadingSpinner />;
  }

  if (!data) {
    return <ErrorPage statusCode={404} />;
  }

  const kind = kindChoice ?? data.kind;
  const status = getComicStatus(data);
  // What standing requests ask for: the whole series or some volumes
  const requested = getRequestedComicVolumes(data.mediaInfo?.requests ?? []);
  const someRequested = !requested.wholeSeries && requested.volumes.length > 0;
  const listedVolumes = listComicVolumes(data.volumeList, data.volumes);
  // Volumes Talearr has, is fetching or that were asked for already cannot
  // be picked
  const selectableVolumes = requested.wholeSeries
    ? []
    : listedVolumes
        .filter(
          (volume) =>
            volume.state !== 'downloaded' &&
            volume.state !== 'downloading' &&
            !requested.volumes.includes(volume.number)
        )
        .map((volume) => volume.number);
  const selected = selectedVolumes.filter((number) =>
    selectableVolumes.includes(number)
  );
  const missingVolumes = getMissingVolumes(data);
  const canRequest =
    comicsEnabled &&
    hasPermission([Permission.REQUEST, Permission.REQUEST_BOOK], {
      type: 'or',
    }) &&
    !requested.wholeSeries &&
    // More volumes of a series with some asked for already are requested
    // on their own. A series Talearr has already is requested for its
    // missing volumes.
    (someRequested
      ? selectableVolumes.length > 0
      : data.library
        ? missingVolumes > 0
        : !status ||
          status === MediaStatus.UNKNOWN ||
          status === MediaStatus.DELETED);
  // Volumes are picked once the series lists them
  const canSelect = canRequest && selectableVolumes.length > 0;

  // Says what a request asks Talearr for, when the volumes are counted
  const requestLabel =
    selected.length > 0
      ? {
          message: messages.requestselectedvolumes,
          values: { count: selected.length },
        }
      : someRequested
        ? {
            message: messages.requestmissingvolumes,
            values: { count: selectableVolumes.length },
          }
        : data.library
          ? missingVolumes > 0
            ? {
                message: messages.requestmissingvolumes,
                values: { count: missingVolumes },
              }
            : { message: messages.requestmissing }
          : data.volumes
            ? {
                message: messages.requestallvolumes,
                values: { count: data.volumes },
              }
            : { message: messages.requestseries };

  // The volumes a request asks for: the ones picked, or with some asked
  // for already, every one that is left. None asks for the whole series.
  const requestVolumes =
    selected.length > 0
      ? selected
      : someRequested
        ? selectableVolumes
        : undefined;

  const sourceLinks = data.aniListId
    ? [
        {
          key: 'anilist',
          href: `https://anilist.co/manga/${data.aniListId}`,
          label: 'AniList',
        },
      ]
    : [];

  // Requests the volumes given, or else what the request button says
  const request = async (volumes = requestVolumes): Promise<boolean> => {
    setIsRequesting(true);

    try {
      await axios.post('/api/v1/request', {
        mediaType: 'comic',
        mediaId: data.id,
        ...(data.kindKnown ? {} : { comicKind: kind }),
        ...(volumes ? { volumes } : {}),
      });
      setSelectedVolumes([]);
      await mutate();
      addToast(
        intl.formatMessage(messages.requestsuccess, {
          title: data.title,
          strong: (msg: React.ReactNode) => <strong>{msg}</strong>,
        }),
        { appearance: 'success', autoDismiss: true }
      );
      promptReadingApp();
      return true;
    } catch (e) {
      addToast(
        axios.isAxiosError(e) && e.response?.data?.message
          ? e.response.data.message
          : intl.formatMessage(messages.requesterror),
        { appearance: 'error', autoDismiss: true }
      );
      return false;
    } finally {
      setIsRequesting(false);
    }
  };

  const overview = data.overview ? plainText(data.overview) : '';

  const requestButton = (
    <Button
      className={pillPrimary}
      onClick={() => request()}
      disabled={isRequesting}
    >
      <ArrowDownTrayIcon />
      <span>
        {intl.formatMessage(
          isRequesting ? globalMessages.requesting : requestLabel.message,
          requestLabel.values
        )}
      </span>
    </Button>
  );

  return (
    <div className="relative -mx-4 -mt-20 pb-10 lg:-mt-28">
      <PageTitle title={data.title} />
      <TitleHero
        imageType="book"
        backdropPath={data.bannerPath ?? data.posterPath}
        blurBackdrop={!data.bannerPath}
        posterPath={data.posterPath}
        posterAlt={data.title}
        posterShape="book"
        posterFallback={<ChatBubbleOvalLeftIcon />}
        badges={
          <>
            <span className="inline-flex items-center gap-2 text-sm font-semibold text-as-ink-soft">
              <FormatIcon format={kind} size="inline" />
              {kindLabel}
            </span>
            {isRated(data.ageRating) && (
              <span className={chip}>{data.ageRating}</span>
            )}
            <StatusPill status={status} />
          </>
        }
      >
        <div className="flex flex-col gap-1.5">
          <h1
            className="font-display text-3xl font-bold leading-[1.05] tracking-[-1px] text-as-ink sm:text-4xl lg:text-5xl"
            data-testid="media-title"
          >
            {data.title}{' '}
            {!!data.year && (
              <span className="font-medium text-as-ink-faint">
                ({data.year})
              </span>
            )}
          </h1>
          {data.authors && (
            <span className="text-lg text-as-ink-muted">
              {intl.formatMessage(messages.byauthors, {
                authors: data.authors,
              })}
            </span>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-as-ink-muted">
          {!!data.volumes && (
            <span>
              {intl.formatMessage(messages.volumes, { count: data.volumes })}
            </span>
          )}
          {data.status && (
            <>
              {!!data.volumes && <span aria-hidden="true">·</span>}
              <span>{data.status}</span>
            </>
          )}
          {data.library && (
            <>
              {(!!data.volumes || !!data.status) && (
                <span aria-hidden="true">·</span>
              )}
              <span>
                {intl.formatMessage(messages.inlibrary, {
                  downloaded: data.library.downloadedCount,
                  total: data.library.volumeCount,
                })}
              </span>
            </>
          )}
        </div>

        {data.genres.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {data.genres.slice(0, 5).map((genre) => (
              <span key={`genre-chip-${genre}`} className={chip}>
                {genre}
              </span>
            ))}
          </div>
        )}

        <Biography
          text={overview || intl.formatMessage(messages.overviewunavailable)}
        />

        {canRequest && !data.kindKnown && (
          <KindChoice value={kind} onChange={setKindChoice} />
        )}

        <div className="flex flex-wrap items-center gap-2.5">
          {canRequest && requestButton}
          <NotifyMeButton
            media={data.mediaInfo}
            title={data.title}
            className={pillSecondaryCollapse}
            ambient
          />
          {comicsEnabled === false && (
            <span className="text-sm text-as-ink-faint">
              {intl.formatMessage(messages.comicsoff)}
            </span>
          )}
        </div>
      </TitleHero>

      <div className="px-4 lg:px-10">
        <section className="grid items-start gap-6 pt-7 lg:grid-cols-[minmax(0,1fr)_340px]">
          <div className="flex min-w-0 flex-col gap-6">
            {data.volumeList.length > 0 && (
              <ComicVolumes
                volumes={data.volumeList}
                count={data.volumes}
                selection={
                  canSelect
                    ? {
                        selectable: selectableVolumes,
                        requested: requested.volumes,
                        selected,
                        onChange: setSelectedVolumes,
                        onRequest: request,
                        requesting: isRequesting,
                        requestBar: (
                          <>
                            <span
                              className="text-sm font-semibold text-as-ink"
                              aria-live="polite"
                            >
                              {intl.formatMessage(messages.selectedcount, {
                                count: selected.length,
                              })}
                            </span>
                            {requestButton}
                          </>
                        ),
                      }
                    : requested.volumes.length > 0
                      ? {
                          selectable: [],
                          requested: requested.volumes,
                          selected: [],
                          onChange: () => undefined,
                        }
                      : undefined
                }
              />
            )}
          </div>

          <div className="flex min-w-0 flex-col gap-6">
            <Card title={intl.formatMessage(messages.details)}>
              <div>
                {!!data.volumes && (
                  <DetailRow label={intl.formatMessage(messages.volumescount)}>
                    {intl.formatNumber(data.volumes)}
                  </DetailRow>
                )}
                {data.library && (
                  <DetailRow label={intl.formatMessage(messages.library)}>
                    {intl.formatMessage(messages.inlibrary, {
                      downloaded: data.library.downloadedCount,
                      total: data.library.volumeCount,
                    })}
                  </DetailRow>
                )}
                {data.status && (
                  <DetailRow label={intl.formatMessage(messages.status)}>
                    {data.status}
                  </DetailRow>
                )}
                {!!data.year && (
                  <DetailRow label={intl.formatMessage(messages.year)}>
                    {data.year}
                  </DetailRow>
                )}
                <DetailRow label={intl.formatMessage(messages.kind)}>
                  {kindLabel}
                </DetailRow>
                {data.format && (
                  <DetailRow label={intl.formatMessage(messages.format)}>
                    {data.format.charAt(0) +
                      data.format.slice(1).toLowerCase().replace(/_/g, ' ')}
                  </DetailRow>
                )}
                {isRated(data.ageRating) && (
                  <DetailRow label={intl.formatMessage(messages.agerating)}>
                    {data.ageRating}
                  </DetailRow>
                )}
                {data.genres.length > 0 && (
                  <DetailRow label={intl.formatMessage(messages.genres)}>
                    {data.genres.join(', ')}
                  </DetailRow>
                )}
                {data.authors && (
                  <DetailRow label={intl.formatMessage(messages.authors)}>
                    {data.authors}
                  </DetailRow>
                )}
                {data.alternateTitles.length > 0 && (
                  <DetailRow label={intl.formatMessage(messages.alsoknownas)}>
                    {data.alternateTitles.slice(0, 6).map((title) => (
                      <span key={title} className="break-words">
                        {title}
                      </span>
                    ))}
                  </DetailRow>
                )}
              </div>
              {sourceLinks.length > 0 && <LinkChips links={sourceLinks} />}
            </Card>
          </div>
        </section>
      </div>
    </div>
  );
};

export default ComicDetails;
