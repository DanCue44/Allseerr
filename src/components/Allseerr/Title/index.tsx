import { softChip } from '@app/components/Allseerr/Title/styles';
import CachedImage from '@app/components/Common/CachedImage';
import PosterLightbox, {
  fullSizeCover,
} from '@app/components/Common/PosterLightbox';
import Tooltip from '@app/components/Common/Tooltip';
import Link from 'next/link';
import type { ReactNode } from 'react';

export type PosterShape = 'portrait' | 'square' | 'book' | 'round';

// Size and corners of the lifted poster for each shape, phone first
const posterShapeClasses: Record<PosterShape, string> = {
  portrait:
    'h-[168px] w-[112px] rounded-[14px] lg:h-[375px] lg:w-[250px] lg:rounded-[18px]',
  square:
    'h-[140px] w-[140px] rounded-[14px] lg:h-[250px] lg:w-[250px] lg:rounded-[18px]',
  // Rounded on the open side only, like the spine of a book
  book: 'h-[168px] w-[112px] rounded-[6px_14px_14px_6px] lg:h-[375px] lg:w-[250px] lg:rounded-[8px_18px_18px_8px]',
  round: 'h-[140px] w-[140px] rounded-full lg:h-[250px] lg:w-[250px]',
};

/**
 * Backdrop across the top of a title page with the raised details sheet
 * overlapping it, poster lifted out of the sheet.
 *
 * TMDB titles pass image paths; music and book pages pass full image URLs
 * with their `imageType`.
 */
export const TitleHero = ({
  backdropPath,
  posterPath,
  posterAlt,
  posterShape = 'portrait',
  posterFallback,
  imageType = 'tmdb',
  blurBackdrop = false,
  badges,
  children,
}: {
  backdropPath?: string | null;
  posterPath?: string | null;
  posterAlt: string;
  posterShape?: PosterShape;
  // Shown in place of the poster when there is no image (non-TMDB only)
  posterFallback?: ReactNode;
  imageType?: 'tmdb' | 'music' | 'book';
  // Blur and enlarge the backdrop, for pages that only have a small cover
  blurBackdrop?: boolean;
  // Status pills: beside the poster on phones, above the title on desktop
  badges?: ReactNode;
  children: ReactNode;
}) => {
  const isTmdb = imageType === 'tmdb';
  const backdropSrc = backdropPath
    ? isTmdb
      ? `https://image.tmdb.org/t/p/w1920_and_h800_multi_faces/${backdropPath}`
      : backdropPath
    : undefined;
  const posterSrc = posterPath
    ? isTmdb
      ? `https://image.tmdb.org/t/p/w600_and_h900_bestv2${posterPath}`
      : posterPath
    : isTmdb
      ? '/images/allseerr_poster_not_found.png'
      : undefined;
  const posterFullSrc = posterPath
    ? isTmdb
      ? `https://image.tmdb.org/t/p/original${posterPath}`
      : fullSizeCover(posterPath)
    : undefined;

  return (
    <>
      <section className="relative h-[330px] overflow-hidden bg-as-tile lg:h-[600px]">
        {backdropSrc && (
          <CachedImage
            type={imageType}
            alt=""
            src={backdropSrc}
            style={{
              width: '100%',
              height: '100%',
              objectFit: 'cover',
              objectPosition: 'center 25%',
              ...(blurBackdrop
                ? { filter: 'blur(28px)', transform: 'scale(1.2)' }
                : {}),
            }}
            fill
            priority
          />
        )}
        <div
          className="absolute inset-0"
          style={{
            background:
              'linear-gradient(to top, rgb(var(--as-ground) / 0.9), rgb(var(--as-ground) / 0.05) 60%)',
          }}
        />
      </section>
      <section className="relative -mt-[100px] flex flex-col gap-3 rounded-t-[26px] bg-as-surface px-4 pb-5 lg:mx-10 lg:-mt-[250px] lg:flex-row lg:gap-9 lg:rounded-[28px] lg:p-8 lg:shadow-[0_30px_60px_rgba(0,0,0,0.4)]">
        <div className="flex items-end gap-3.5 lg:block">
          <div
            className={`relative -mt-14 flex-none overflow-hidden border-[3px] border-as-surface bg-as-tile lg:-mt-[100px] lg:border-4 ${posterShapeClasses[posterShape]}`}
          >
            {posterSrc ? (
              <PosterLightbox
                type={imageType}
                src={posterSrc}
                fullSrc={posterFullSrc}
                alt={posterAlt}
                disabled={!posterPath}
              >
                <CachedImage
                  type={imageType}
                  src={posterSrc}
                  alt={posterAlt}
                  style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                  fill
                  priority
                />
              </PosterLightbox>
            ) : (
              <div className="flex h-full w-full items-center justify-center text-as-ink-faint [&_svg]:h-1/2 [&_svg]:w-1/2">
                {posterFallback}
              </div>
            )}
            {posterShape === 'book' && (
              <span
                className="pointer-events-none absolute inset-y-0 left-0 w-3 lg:w-4"
                style={{
                  background:
                    'linear-gradient(to right, rgba(0,0,0,0.35), rgba(255,255,255,0.08) 45%, transparent)',
                }}
              />
            )}
          </div>
          {badges && (
            <div className="mb-1 flex flex-col items-start gap-1.5 lg:hidden">
              {badges}
            </div>
          )}
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-3.5">
          {badges && (
            <div className="hidden flex-wrap items-center gap-2.5 lg:flex">
              {badges}
            </div>
          )}
          {children}
        </div>
      </section>
    </>
  );
};

export interface RatingItem {
  key: string;
  label: string;
  value: string;
  caption: string;
  href?: string;
  tooltip?: string;
  icon?: ReactNode;
}

/** The ratings strip at the bottom of the details sheet. */
export const RatingsStrip = ({ items }: { items: RatingItem[] }) => {
  if (!items.length) {
    return null;
  }

  // On phones everything is sized in em from one font size that shrinks
  // with the screen and the number of scores, so they always fit one row
  const phoneSize =
    items.length >= 4
      ? 'clamp(12px, 3.8vw, 19px)'
      : items.length === 3
        ? 'clamp(14px, 4.6vw, 19px)'
        : '19px';

  return (
    <div
      className="flex w-fit max-w-full flex-nowrap items-center gap-x-[0.75em] self-center whitespace-nowrap rounded-[18px] bg-as-tile px-[0.85em] py-3.5 text-[length:var(--ratings-size)] sm:flex-wrap sm:gap-x-7 sm:gap-y-3 sm:self-start sm:px-[22px] sm:text-[22px]"
      style={{ '--ratings-size': phoneSize } as React.CSSProperties}
    >
      {items.map((item) => {
        const content = (
          <span
            className="flex items-center gap-[0.4em] font-display font-bold text-as-ink sm:gap-2"
            aria-label={`${item.label}: ${item.value}, ${item.caption}`}
          >
            {item.icon && (
              <span className="flex h-[1.05em] w-auto shrink-0 items-center sm:h-6 [&_svg]:h-[1.05em] [&_svg]:w-auto sm:[&_svg]:h-6">
                {item.icon}
              </span>
            )}
            {item.value}
          </span>
        );
        const body = item.href ? (
          <a
            href={item.href}
            target="_blank"
            rel="noreferrer"
            className="transition hover:opacity-80"
          >
            {content}
          </a>
        ) : (
          content
        );

        return (
          <Tooltip
            key={item.key}
            content={item.tooltip ?? `${item.label} · ${item.caption}`}
          >
            {body}
          </Tooltip>
        );
      })}
    </div>
  );
};

/** A content card in the page body. */
export const Card = ({
  title,
  action,
  children,
}: {
  title: ReactNode;
  action?: ReactNode;
  children: ReactNode;
}) => (
  <section className="flex flex-col gap-3.5 rounded-[22px] bg-as-surface px-6 py-[22px]">
    <div className="flex items-baseline justify-between gap-4">
      <h2 className="font-display text-[17px] font-medium text-as-ink">
        {title}
      </h2>
      {action}
    </div>
    {children}
  </section>
);

/** Label and value row inside the Details card. */
export const DetailRow = ({
  label,
  children,
}: {
  label: ReactNode;
  children: ReactNode;
}) => (
  <div className="flex justify-between gap-4 border-t border-as-line py-3">
    <span className="flex-shrink-0 font-semibold text-as-ink">{label}</span>
    <div className="flex min-w-0 flex-col items-end gap-1.5 text-right text-as-ink-soft">
      {children}
    </div>
  </div>
);

export interface CrewGroup {
  job: string;
  people: { id?: number; name?: string }[];
}

/** Crew grouped by job, three to a row. */
export const CrewGrid = ({ groups }: { groups: CrewGroup[] }) => (
  <div className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-3">
    {groups.map((group) => (
      <div key={`crew-${group.job}`}>
        <div className="text-xs text-as-ink-faint">{group.job}</div>
        <div className="mt-[3px] font-semibold text-as-ink">
          {group.people.map((person, i) => (
            <span key={`crew-${group.job}-${person.id}`}>
              {i > 0 && ', '}
              <Link href={`/person/${person.id}`} className="hover:underline">
                {person.name}
              </Link>
            </span>
          ))}
        </div>
      </div>
    ))}
  </div>
);

/** Rounded keyword or tag links. */
export const ChipLinks = ({
  items,
}: {
  items: { key: string; href: string; label: string }[];
}) => (
  <div className="flex flex-wrap gap-2">
    {items.map((item) => (
      <Link key={item.key} href={item.href} className={softChip}>
        {item.label}
      </Link>
    ))}
  </div>
);

/** Logo links to other sites, shown at the bottom of the Details card. */
export const LinkChips = ({
  links,
}: {
  links: { key: string; href: string; label: string; icon?: ReactNode }[];
}) => (
  // One row for all the logos, each shrinking to its slot, at every width
  // (the Details card sits in a narrow column on desktop too)
  <div className="flex flex-nowrap items-center justify-between gap-x-3 border-t border-as-line pt-4">
    {links.map((link) => (
      <Tooltip key={link.key} content={link.label}>
        <a
          href={link.href}
          target="_blank"
          rel="noreferrer"
          aria-label={link.label}
          className="flex h-6 min-w-0 flex-1 items-center justify-center truncate text-[13px] font-semibold text-as-ink opacity-50 transition duration-300 hover:opacity-100 [&_svg]:h-auto [&_svg]:max-h-6 [&_svg]:w-full [&_svg]:max-w-[52px]"
        >
          {link.icon ?? link.label}
        </a>
      </Tooltip>
    ))}
  </div>
);

/** Collection banner above the Details card. */
export const CollectionBanner = ({
  href,
  name,
  backdropPath,
  viewLabel,
  description,
}: {
  href: string;
  name: string;
  backdropPath?: string;
  viewLabel: string;
  // Optional line of text under the name, clamped to two lines
  description?: string;
}) => (
  <Link
    href={href}
    className="group relative flex h-[130px] items-center justify-between gap-4 overflow-hidden rounded-[22px] bg-as-tile px-[22px]"
  >
    {backdropPath && (
      <CachedImage
        type="tmdb"
        src={`https://image.tmdb.org/t/p/w1440_and_h320_multi_faces/${backdropPath}`}
        alt=""
        style={{ width: '100%', height: '100%', objectFit: 'cover' }}
        fill
      />
    )}
    <span
      className="absolute inset-0"
      style={{
        background:
          'linear-gradient(to right, rgb(var(--as-ground) / 0.88), rgb(var(--as-ground) / 0.3))',
      }}
    />
    <span className="relative flex min-w-0 flex-col gap-1">
      <span className="font-display text-[17px] font-medium text-as-ink">
        {name}
      </span>
      {description && (
        <span className="line-clamp-2 text-[13px] text-as-ink-soft">
          {description}
        </span>
      )}
    </span>
    <span className="relative flex-none rounded-full bg-as-ground/80 px-3.5 py-2 text-[13px] font-bold text-as-ink transition group-hover:bg-as-ground">
      {viewLabel}
    </span>
  </Link>
);

/** Section heading with a "See all" link, used above rails. */
export const RailHeader = ({
  title,
  href,
  seeAllLabel,
}: {
  title: string;
  href?: string;
  seeAllLabel: string;
}) => (
  <div className="flex items-baseline justify-between">
    <h2 className="font-display text-[22px] font-medium text-as-ink">
      {title}
    </h2>
    {href && (
      <Link
        href={href}
        className="text-sm text-as-accent transition hover:text-as-accent-soft"
      >
        {seeAllLabel}
      </Link>
    )}
  </div>
);

/** Round cast portraits in a horizontally scrolling row. */
export const CastRail = ({
  people,
}: {
  people: {
    id: number;
    name: string;
    character?: string;
    profilePath?: string;
  }[];
}) => (
  <div className="-mx-4 flex gap-[22px] overflow-x-auto px-4 pb-2 lg:-mx-10 lg:px-10">
    {people.map((person) => (
      <Link
        key={`cast-${person.id}`}
        href={`/person/${person.id}`}
        className="group w-[110px] flex-none sm:w-[140px]"
      >
        <div className="relative h-[110px] w-[110px] overflow-hidden rounded-full bg-as-tile sm:h-[140px] sm:w-[140px]">
          {person.profilePath && (
            <CachedImage
              type="tmdb"
              src={`https://image.tmdb.org/t/p/w600_and_h900_bestv2${person.profilePath}`}
              alt={person.name}
              style={{
                width: '100%',
                height: '100%',
                objectFit: 'cover',
                objectPosition: 'center 20%',
              }}
              fill
            />
          )}
        </div>
        <div className="mt-2.5 text-center text-sm font-bold text-as-ink group-hover:underline">
          {person.name}
        </div>
        {person.character && (
          <div className="text-center text-xs text-as-ink-faint">
            {person.character}
          </div>
        )}
      </Link>
    ))}
  </div>
);
