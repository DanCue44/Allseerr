import ImdbLogo from '@app/assets/services/imdb.svg';
import TmdbLogo from '@app/assets/tmdb_logo.svg';
import { ambientGrid, PillTabs } from '@app/components/Allseerr/ListPage';
import {
  Card,
  DetailRow,
  LinkChips,
  TitleHero,
} from '@app/components/Allseerr/Title';
import Biography from '@app/components/Allseerr/Title/Biography';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import PageTitle from '@app/components/Common/PageTitle';
import TitleCard from '@app/components/TitleCard';
import useLocale from '@app/hooks/useLocale';
import globalMessages from '@app/i18n/globalMessages';
import ErrorPage from '@app/pages/_error';
import defineMessages from '@app/utils/defineMessages';
import {
  ChevronDoubleDownIcon,
  ChevronDoubleUpIcon,
} from '@heroicons/react/24/solid';
import type { PersonCombinedCreditsResponse } from '@server/interfaces/api/personInterfaces';
import type {
  PersonCreditCast,
  PersonCreditCrew,
  PersonDetails as PersonDetailsType,
} from '@server/models/Person';
import { groupBy } from 'lodash';
import { useRouter } from 'next/router';
import type { ReactNode } from 'react';
import { useMemo, useState } from 'react';
import { useIntl } from 'react-intl';
import useSWR from 'swr';

const messages = defineMessages('components.Allseerr.PersonDetails', {
  born: 'Born',
  died: 'Died',
  birthplace: 'Birthplace',
  knownfor: 'Known For',
  department: 'Department',
  alsoknownas: 'Also Known As',
  biography: 'Biography',
  details: 'Details',
  appearsin: 'Appearances',
  crewmember: 'Crew',
  ascharacter: 'as {character}',
  age: '{age} years old',
  agedied: 'aged {age}',
  mediatype: 'Media type',
  homepage: 'Homepage',
  showmore: 'Show more',
  showless: 'Show less',
  series: 'Series',
});

type MediaType = 'all' | 'movie' | 'tv';

// Names past this many are behind "Show more" in the Details card
const MIN_NAMES = 4;

type Credit = (PersonCreditCast | PersonCreditCrew) & { caption?: string };

const sortByVotes = <T extends { voteCount?: number }>(list: T[]): T[] =>
  list.sort((a, b) => ((a.voteCount ?? 0) > (b.voteCount ?? 0) ? -1 : 1));

const formatAge = (from: string, to: Date): number => {
  const birth = new Date(from);
  let age = to.getUTCFullYear() - birth.getUTCFullYear();
  const beforeBirthday =
    to.getUTCMonth() < birth.getUTCMonth() ||
    (to.getUTCMonth() === birth.getUTCMonth() &&
      to.getUTCDate() < birth.getUTCDate());
  if (beforeBirthday) {
    age -= 1;
  }
  return age;
};

/** Credits as Ambient cards, with the role or job under each one. */
const CreditGrid = ({
  credits,
  className = ambientGrid,
}: {
  credits: Credit[];
  className?: string;
}) => (
  <ul className={className}>
    {credits.map((media, index) => (
      <li key={`credit-${media.id}-${index}`}>
        <TitleCard
          id={media.id}
          title={media.mediaType === 'movie' ? media.title : media.name}
          userScore={media.voteAverage}
          year={
            media.mediaType === 'movie' ? media.releaseDate : media.firstAirDate
          }
          image={media.posterPath}
          summary={media.overview}
          mediaType={media.mediaType as 'movie' | 'tv'}
          status={media.mediaInfo?.status}
          watched={media.mediaInfo?.watched}
          canExpand
        />
        {media.caption && (
          <div className="mt-0.5 line-clamp-2 text-[13px] text-as-ink-soft">
            {media.caption}
          </div>
        )}
      </li>
    ))}
  </ul>
);

const Section = ({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) => (
  <section className="flex flex-col gap-4 pt-[34px]">
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <h2 className="font-display text-[22px] font-medium text-as-ink">
        {title}
      </h2>
      {action}
    </div>
    {children}
  </section>
);

/**
 * Ambient person page: round portrait in the hero, biography, a details
 * card and the credits as card grids. Same data as the classic page.
 */
const AmbientPersonDetails = () => {
  const intl = useIntl();
  const router = useRouter();
  const { locale } = useLocale();
  const [currentMediaType, setCurrentMediaType] = useState<MediaType>('all');
  const [showAllNames, setShowAllNames] = useState(false);
  const { data, error } = useSWR<PersonDetailsType>(
    `/api/v1/person/${router.query.personId}`
  );

  const { data: combinedCredits, error: errorCombinedCredits } =
    useSWR<PersonCombinedCreditsResponse>(
      `/api/v1/person/${router.query.personId}/combined_credits`
    );

  const sortedCast = useMemo(() => {
    const filtered = (combinedCredits?.cast ?? []).filter(
      (media) =>
        currentMediaType === 'all' || media.mediaType === currentMediaType
    );
    const grouped = groupBy(filtered, 'id');

    return sortByVotes(
      Object.values(grouped).map((objs) => ({
        ...objs[0],
        character: objs.map((pos) => pos.character).join(', '),
      }))
    );
  }, [combinedCredits, currentMediaType]);

  const sortedCrew = useMemo(() => {
    const filtered = (combinedCredits?.crew ?? []).filter(
      (media) =>
        currentMediaType === 'all' || media.mediaType === currentMediaType
    );
    const grouped = groupBy(filtered, 'id');

    return sortByVotes(
      Object.values(grouped).map((objs) => ({
        ...objs[0],
        job: objs.map((pos) => pos.job).join(', '),
      }))
    );
  }, [combinedCredits, currentMediaType]);

  if (!data && !error) {
    return <LoadingSpinner />;
  }

  if (!data) {
    return <ErrorPage statusCode={404} />;
  }

  const isActor = data.knownForDepartment === 'Acting';
  const isLoading = !combinedCredits && !errorCombinedCredits;

  // Their best known work: the most voted titles in their main department
  const knownFor: Credit[] = (isActor ? sortedCast : sortedCrew)
    .slice(0, 8)
    .map((media) => ({
      ...media,
      caption:
        'character' in media
          ? media.character
            ? intl.formatMessage(messages.ascharacter, {
                character: media.character,
              })
            : undefined
          : media.job,
    }));

  const castCredits: Credit[] = sortedCast.map((media) => ({
    ...media,
    caption: media.character
      ? intl.formatMessage(messages.ascharacter, {
          character: media.character,
        })
      : undefined,
  }));
  const crewCredits: Credit[] = sortedCrew.map((media) => ({
    ...media,
    caption: media.job,
  }));

  const backdrop = [...sortedCast, ...sortedCrew].find(
    (media) => media.backdropPath
  )?.backdropPath;

  const formatDate = (date: string) =>
    intl.formatDate(date, {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      timeZone: 'UTC',
    });

  const lifeLine = [
    data.birthday &&
      (data.deathday
        ? `${formatDate(data.birthday)} - ${formatDate(data.deathday)}`
        : formatDate(data.birthday)),
    data.placeOfBirth,
  ]
    .filter(Boolean)
    .join(' · ');

  const alsoKnownAs = data.alsoKnownAs ?? [];

  const links = [
    {
      key: 'tmdb',
      href: `https://www.themoviedb.org/person/${data.id}?language=${locale}`,
      label: 'TMDB',
      icon: <TmdbLogo />,
    },
    ...(data.imdbId
      ? [
          {
            key: 'imdb',
            href: `https://www.imdb.com/name/${data.imdbId}`,
            label: 'IMDb',
            icon: <ImdbLogo />,
          },
        ]
      : []),
    ...(data.homepage
      ? [
          {
            key: 'homepage',
            href: data.homepage,
            label: intl.formatMessage(messages.homepage),
          },
        ]
      : []),
  ];

  const mediaTypeTabs = (
    <PillTabs
      label={intl.formatMessage(messages.mediatype)}
      tabs={(
        [
          ['all', intl.formatMessage(globalMessages.all)],
          ['movie', intl.formatMessage(globalMessages.movies)],
          ['tv', intl.formatMessage(messages.series)],
        ] as [MediaType, string][]
      ).map(([type, label]) => ({
        key: type,
        label,
        active: currentMediaType === type,
        onClick: () => setCurrentMediaType(type),
      }))}
    />
  );

  const castSection = castCredits.length > 0 && (
    <Section
      key="cast"
      title={intl.formatMessage(messages.appearsin)}
      action={isActor || crewCredits.length === 0 ? mediaTypeTabs : undefined}
    >
      <CreditGrid credits={castCredits} />
    </Section>
  );

  const crewSection = crewCredits.length > 0 && (
    <Section
      key="crew"
      title={intl.formatMessage(messages.crewmember)}
      action={!isActor || castCredits.length === 0 ? mediaTypeTabs : undefined}
    >
      <CreditGrid credits={crewCredits} />
    </Section>
  );

  return (
    <div className="relative -mx-4 -mt-20 pb-10 lg:-mt-28">
      <PageTitle title={data.name} />

      <TitleHero
        backdropPath={backdrop}
        posterPath={data.profilePath}
        posterAlt={data.name}
        posterShape="round"
      >
        <h1
          className="font-display text-3xl font-bold leading-[1.05] tracking-[-1px] text-as-ink sm:text-4xl lg:text-5xl"
          data-testid="media-title"
        >
          {data.name}
        </h1>
        {lifeLine && <div className="text-as-ink-muted">{lifeLine}</div>}
        {data.biography && (
          <Biography
            title={intl.formatMessage(messages.biography)}
            text={data.biography}
          />
        )}
      </TitleHero>

      <div className="px-4 lg:px-10">
        <section className="grid items-start gap-6 pt-7 lg:grid-cols-[minmax(0,1fr)_340px]">
          <div className="min-w-0">
            {knownFor.length > 0 ? (
              <Card title={intl.formatMessage(messages.knownfor)}>
                <CreditGrid
                  credits={knownFor}
                  className="grid grid-cols-2 gap-x-4 gap-y-7 sm:grid-cols-3 md:grid-cols-4 lg:gap-x-5"
                />
              </Card>
            ) : (
              isLoading && <LoadingSpinner />
            )}
          </div>
          <Card title={intl.formatMessage(messages.details)}>
            <div>
              {data.birthday && (
                <DetailRow label={intl.formatMessage(messages.born)}>
                  <span>{formatDate(data.birthday)}</span>
                  {!data.deathday && (
                    <span className="text-[13px] text-as-ink-faint">
                      {intl.formatMessage(messages.age, {
                        age: formatAge(data.birthday, new Date()),
                      })}
                    </span>
                  )}
                </DetailRow>
              )}
              {data.deathday && (
                <DetailRow label={intl.formatMessage(messages.died)}>
                  <span>{formatDate(data.deathday)}</span>
                  {data.birthday && (
                    <span className="text-[13px] text-as-ink-faint">
                      {intl.formatMessage(messages.agedied, {
                        age: formatAge(data.birthday, new Date(data.deathday)),
                      })}
                    </span>
                  )}
                </DetailRow>
              )}
              {data.placeOfBirth && (
                <DetailRow label={intl.formatMessage(messages.birthplace)}>
                  {data.placeOfBirth}
                </DetailRow>
              )}
              {data.knownForDepartment && (
                <DetailRow label={intl.formatMessage(messages.department)}>
                  {data.knownForDepartment}
                </DetailRow>
              )}
              {alsoKnownAs.length > 0 && (
                <DetailRow label={intl.formatMessage(messages.alsoknownas)}>
                  {alsoKnownAs
                    .slice(0, showAllNames ? alsoKnownAs.length : MIN_NAMES)
                    .map((name) => (
                      <span key={`aka-${name}`}>{name}</span>
                    ))}
                  {alsoKnownAs.length > MIN_NAMES && (
                    <button
                      type="button"
                      className="flex items-center text-sm text-as-ink-faint hover:text-as-ink"
                      onClick={() => setShowAllNames(!showAllNames)}
                      aria-expanded={showAllNames}
                    >
                      {intl.formatMessage(
                        showAllNames ? messages.showless : messages.showmore
                      )}
                      {showAllNames ? (
                        <ChevronDoubleUpIcon className="ml-1 h-4 w-4" />
                      ) : (
                        <ChevronDoubleDownIcon className="ml-1 h-4 w-4" />
                      )}
                    </button>
                  )}
                </DetailRow>
              )}
            </div>
            <LinkChips links={links} />
          </Card>
        </section>

        {isActor ? [castSection, crewSection] : [crewSection, castSection]}
        {isLoading && knownFor.length > 0 && <LoadingSpinner />}
      </div>
    </div>
  );
};

export default AmbientPersonDetails;
