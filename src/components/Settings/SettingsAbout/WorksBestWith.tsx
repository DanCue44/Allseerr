import useInterfaceStyle from '@app/hooks/useInterfaceStyle';
import defineMessages from '@app/utils/defineMessages';
import { ArrowTopRightOnSquareIcon } from '@heroicons/react/24/outline';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.Settings.SettingsAbout', {
  worksbestwith: 'Works best with',
  nobookendsdescription:
    'Listen and read your Audiobookshelf library on iPhone and Android.',
  talearrdescription: 'Finds and organizes your ebooks and audiobooks.',
});

interface Companion {
  name: string;
  url: string;
  host: string;
  description: string;
  logo: React.ReactNode;
}

const WorksBestWith = () => {
  const intl = useIntl();
  const [interfaceStyle] = useInterfaceStyle();
  const ambient = interfaceStyle === 'ambient';

  const companions: Companion[] = [
    {
      name: 'NoBookEnds',
      url: 'https://nobookends.com',
      host: 'nobookends.com',
      description: intl.formatMessage(messages.nobookendsdescription),
      logo: (
        <picture>
          <source
            type="image/webp"
            srcSet="/companions/nobookends.webp 1x, /companions/nobookends@2x.webp 2x"
          />
          <img
            src="/companions/nobookends.png"
            srcSet="/companions/nobookends.png 1x, /companions/nobookends@2x.png 2x"
            alt=""
            width={48}
            height={48}
            className="h-12 w-12 rounded-[22%]"
          />
        </picture>
      ),
    },
    {
      name: 'Talearr',
      url: 'https://talearr.com',
      host: 'talearr.com',
      description: intl.formatMessage(messages.talearrdescription),
      logo: (
        <picture>
          <source
            type="image/webp"
            srcSet="/companions/talearr.webp 1x, /companions/talearr@2x.webp 2x"
          />
          <img
            src="/companions/talearr.png"
            srcSet="/companions/talearr.png 1x, /companions/talearr@2x.png 2x"
            alt=""
            width={48}
            height={48}
            className="h-12 w-12"
          />
        </picture>
      ),
    },
  ];

  return (
    <>
      <div>
        <h3 className="heading">
          {intl.formatMessage(messages.worksbestwith)}
        </h3>
      </div>
      <div
        className={`section grid grid-cols-1 gap-3 sm:grid-cols-2 ${
          ambient ? '' : 'border-t border-gray-800 pt-4'
        }`}
      >
        {companions.map((companion) => (
          <a
            key={companion.name}
            href={companion.url}
            target="_blank"
            rel="noopener noreferrer"
            className={`group flex items-center gap-4 p-4 transition duration-150 ${
              ambient
                ? 'rounded-[22px] bg-as-surface hover:bg-as-raised'
                : 'rounded-lg border border-gray-700 bg-gray-800/50 hover:border-gray-500 hover:bg-gray-800'
            }`}
          >
            <span className="shrink-0">{companion.logo}</span>
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-1.5 text-sm font-bold text-white">
                {companion.name}
                <ArrowTopRightOnSquareIcon className="h-3.5 w-3.5 text-gray-400 transition group-hover:text-white" />
              </span>
              <span
                className={`mt-0.5 block text-sm ${
                  ambient ? 'text-as-ink-soft' : 'text-gray-400'
                }`}
              >
                {companion.description}
              </span>
              <span className="mt-1 block text-xs text-[#F7B091]">
                {companion.host}
              </span>
            </span>
          </a>
        ))}
      </div>
    </>
  );
};

export default WorksBestWith;
