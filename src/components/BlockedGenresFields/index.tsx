import { GenreSelector } from '@app/components/Selector';
import useSettings from '@app/hooks/useSettings';
import defineMessages from '@app/utils/defineMessages';
import type { BlockedGenres } from '@server/lib/genreBlock';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.BlockedGenresFields', {
  movieGenres: 'Blocked Movie Genres',
  tvGenres: 'Blocked Series Genres',
  musicGenres: 'Blocked Music Genres',
  musicGenresTip:
    'Names separated by commas, matched against MusicBrainz genres and tags. "metal" also blocks "black metal".',
  bookGenres: 'Blocked Book Subjects',
  bookGenresTip:
    'Names separated by commas, matched against OpenLibrary subjects. "horror" also blocks "Horror fiction".',
  namesPlaceholder: 'christmas, horror',
});

interface BlockedGenresFieldsProps {
  id: string;
  value: BlockedGenres;
  onChange: (value: BlockedGenres) => void;
  isDisabled?: boolean;
}

/**
 * Form rows for picking the genres that cannot be requested, one per media
 * type. Music and books appear only when they are set up.
 */
const BlockedGenresFields = ({
  id,
  value,
  onChange,
  isDisabled,
}: BlockedGenresFieldsProps) => {
  const intl = useIntl();
  const { currentSettings } = useSettings();

  const tmdbRow = (type: 'movie' | 'tv') => (
    <div className="form-row" key={type}>
      <label htmlFor={`${id}-${type}`} className="text-label">
        {intl.formatMessage(
          type === 'movie' ? messages.movieGenres : messages.tvGenres
        )}
      </label>
      <div className="form-input-area">
        <div className="form-input-field" id={`${id}-${type}`}>
          <GenreSelector
            type={type}
            isMulti
            isDisabled={isDisabled}
            defaultValue={value[type]}
            onChange={(genres) =>
              onChange({
                ...value,
                [type]: ((genres ?? []) as readonly { value: number }[])
                  .map((genre) => genre.value)
                  .join(','),
              })
            }
          />
        </div>
      </div>
    </div>
  );

  const namesRow = (type: 'music' | 'book') => (
    <div className="form-row" key={type}>
      <label htmlFor={`${id}-${type}`} className="text-label">
        <span>
          {intl.formatMessage(
            type === 'music' ? messages.musicGenres : messages.bookGenres
          )}
        </span>
        <span className="label-tip">
          {intl.formatMessage(
            type === 'music' ? messages.musicGenresTip : messages.bookGenresTip
          )}
        </span>
      </label>
      <div className="form-input-area">
        <div className="form-input-field">
          <input
            type="text"
            id={`${id}-${type}`}
            disabled={isDisabled}
            value={value[type].split(',').join(', ')}
            placeholder={intl.formatMessage(messages.namesPlaceholder)}
            onChange={(e) =>
              onChange({
                ...value,
                [type]: e.target.value
                  .split(',')
                  .map((name) => name.trimStart())
                  .join(','),
              })
            }
          />
        </div>
      </div>
    </div>
  );

  return (
    <>
      {tmdbRow('movie')}
      {tmdbRow('tv')}
      {currentSettings.musicEnabled && namesRow('music')}
      {currentSettings.booksEnabled && namesRow('book')}
    </>
  );
};

export default BlockedGenresFields;
