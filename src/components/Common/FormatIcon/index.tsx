import HeadphonesIcon from '@app/components/Common/HeadphonesIcon';
import useInterfaceStyle from '@app/hooks/useInterfaceStyle';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import {
  BookOpenIcon,
  ChatBubbleOvalLeftIcon,
  FilmIcon,
  MusicalNoteIcon,
  RectangleStackIcon,
  TvIcon,
  UserIcon,
} from '@heroicons/react/24/solid';
import type { ComponentType, SVGProps } from 'react';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.Common.FormatIcon', {
  person: 'Person',
});

/**
 * What a card or row is: the kind of title, or the person behind it
 */
export type ItemFormat =
  | 'movie'
  | 'tv'
  | 'collection'
  | 'album'
  | 'artist'
  | 'book'
  | 'ebook'
  | 'audiobook'
  | 'comic'
  | 'manga'
  | 'author'
  | 'narrator'
  | 'person';

type FormatIconSize = 'card' | 'inline' | 'small';

interface FormatStyle {
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  // Filled chip beside the classic look's colored pills
  classic: string;
  // Dark chip with a tinted icon, for the ambient look
  ambient: string;
}

// The colors follow the classic type pills: blue movies, purple series,
// emerald music and amber books
const formatStyles: Record<ItemFormat, FormatStyle> = {
  movie: {
    icon: FilmIcon,
    classic: 'bg-blue-600/85 ring-blue-500 text-white',
    ambient: 'text-sky-300',
  },
  collection: {
    icon: RectangleStackIcon,
    classic: 'bg-blue-600/85 ring-blue-500 text-white',
    ambient: 'text-sky-300',
  },
  tv: {
    icon: TvIcon,
    classic: 'bg-purple-600/85 ring-purple-500 text-white',
    ambient: 'text-violet-300',
  },
  album: {
    icon: MusicalNoteIcon,
    classic: 'bg-emerald-600/85 ring-emerald-500 text-white',
    ambient: 'text-emerald-300',
  },
  artist: {
    icon: UserIcon,
    classic: 'bg-emerald-600/85 ring-emerald-500 text-white',
    ambient: 'text-emerald-300',
  },
  book: {
    icon: BookOpenIcon,
    classic: 'bg-amber-600/85 ring-amber-500 text-white',
    ambient: 'text-amber-300',
  },
  ebook: {
    icon: BookOpenIcon,
    classic: 'bg-amber-600/85 ring-amber-500 text-white',
    ambient: 'text-amber-300',
  },
  audiobook: {
    icon: HeadphonesIcon,
    classic: 'bg-orange-600/85 ring-orange-500 text-white',
    ambient: 'text-orange-300',
  },
  author: {
    icon: UserIcon,
    classic: 'bg-amber-600/85 ring-amber-500 text-white',
    ambient: 'text-amber-300',
  },
  narrator: {
    icon: HeadphonesIcon,
    classic: 'bg-orange-600/85 ring-orange-500 text-white',
    ambient: 'text-orange-300',
  },
  comic: {
    icon: ChatBubbleOvalLeftIcon,
    classic: 'bg-rose-600/85 ring-rose-500 text-white',
    ambient: 'text-rose-300',
  },
  manga: {
    icon: ChatBubbleOvalLeftIcon,
    classic: 'bg-rose-600/85 ring-rose-500 text-white',
    ambient: 'text-rose-300',
  },
  person: {
    icon: UserIcon,
    classic: 'bg-gray-600/85 ring-gray-500 text-white',
    ambient: 'text-slate-300',
  },
};

const sizeClasses: Record<FormatIconSize, { chip: string; icon: string }> = {
  card: { chip: 'h-6 w-6 sm:h-7 sm:w-7', icon: 'h-3.5 w-3.5 sm:h-4 sm:w-4' },
  inline: { chip: 'h-6 w-6', icon: 'h-3.5 w-3.5' },
  small: { chip: 'h-5 w-5', icon: 'h-3 w-3' },
};

/**
 * The format of a request: a book request is for its ebook or its
 * audiobook, a comic request for a comic or a manga series
 */
export const getRequestFormat = (request: {
  type: string;
  isAudiobook?: boolean;
  media?: { comicKind?: string | null } | null;
}): ItemFormat => {
  switch (request.type) {
    case 'movie':
      return 'movie';
    case 'tv':
      return 'tv';
    case 'music':
      return 'album';
    case 'book':
      return request.isAudiobook ? 'audiobook' : 'ebook';
    case 'comic':
      return request.media?.comicKind === 'manga' ? 'manga' : 'comic';
    default:
      return 'movie';
  }
};

export const useFormatLabel = (format: ItemFormat): string => {
  const intl = useIntl();

  return intl.formatMessage(
    {
      movie: globalMessages.movie,
      collection: globalMessages.collection,
      tv: globalMessages.tvshow,
      album: globalMessages.album,
      artist: globalMessages.artist,
      book: globalMessages.book,
      ebook: globalMessages.ebook,
      audiobook: globalMessages.audiobook,
      author: globalMessages.author,
      narrator: globalMessages.narrator,
      comic: globalMessages.comic,
      manga: globalMessages.manga,
      person: messages.person,
    }[format]
  );
};

interface FormatIconProps {
  format: ItemFormat;
  size?: FormatIconSize;
  className?: string;
}

/**
 * Small round chip that says what an item is, such as a film for a movie or
 * headphones for an audiobook. Shown on the cards in the ambient look, where
 * the classic type pill is hidden, and in rows that mix kinds of titles.
 */
const FormatIcon = ({
  format,
  size = 'inline',
  className = '',
}: FormatIconProps) => {
  const [interfaceStyle] = useInterfaceStyle();
  const label = useFormatLabel(format);
  const style = formatStyles[format];
  const Icon = style.icon;
  const tone =
    interfaceStyle === 'ambient'
      ? `bg-as-ground/85 ring-as-line-strong ${style.ambient}`
      : style.classic;

  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className={`inline-flex flex-none items-center justify-center rounded-full shadow-md ring-1 backdrop-blur-sm ${sizeClasses[size].chip} ${tone} ${className}`}
      data-testid="format-icon"
      data-format={format}
    >
      <Icon className={sizeClasses[size].icon} aria-hidden="true" />
    </span>
  );
};

export default FormatIcon;
