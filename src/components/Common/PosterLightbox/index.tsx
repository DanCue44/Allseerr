import type { CachedImageProps } from '@app/components/Common/CachedImage';
import CachedImage from '@app/components/Common/CachedImage';
import { useLockBodyScroll } from '@app/hooks/useLockBodyScroll';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import { Transition } from '@headlessui/react';
import { XMarkIcon } from '@heroicons/react/24/outline';
import { useEffect, useState } from 'react';
import ReactDOM from 'react-dom';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.PosterLightbox', {
  viewfullsize: 'View full size',
});

/**
 * The largest copy of a music or book cover: Cover Art Archive thumbnails come
 * in 250, 500 and 1200. Other covers are already full size.
 */
export const fullSizeCover = (src: string): string =>
  src.replace(/_thumb(250|500)\.jpg$/, '_thumb1200.jpg');

interface PosterLightboxProps {
  /** The image the poster shows. */
  src: string;
  /** A larger copy for the lightbox; the poster's own image if it fails. */
  fullSrc?: string;
  type: CachedImageProps['type'];
  alt?: string;
  /** No cover to show (a placeholder): the poster stays a plain image. */
  disabled?: boolean;
  children: React.ReactNode;
}

/**
 * Wraps a details page poster so a tap opens the cover full size over the
 * page. A tap anywhere, the close button or Escape closes it.
 */
const PosterLightbox = ({
  src,
  fullSrc,
  type,
  alt = '',
  disabled = false,
  children,
}: PosterLightboxProps) => {
  const intl = useIntl();
  const [open, setOpen] = useState(false);
  const [failed, setFailed] = useState(false);
  // Width over height of the cover, known once it loads
  const [ratio, setRatio] = useState(2 / 3);
  useLockBodyScroll(open);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  if (disabled) return <>{children}</>;

  return (
    <>
      <button
        type="button"
        className="block h-full w-full cursor-zoom-in"
        onClick={() => setOpen(true)}
        aria-label={intl.formatMessage(messages.viewfullsize)}
      >
        {children}
      </button>
      {typeof document !== 'undefined' &&
        ReactDOM.createPortal(
          <Transition
            show={open}
            as="div"
            className="fixed inset-0 z-50 flex cursor-zoom-out items-center justify-center bg-black/90 p-4 pb-[calc(1rem+env(safe-area-inset-bottom))] pt-[calc(1rem+env(safe-area-inset-top))] backdrop-blur-sm"
            enter="transition-opacity duration-200"
            enterFrom="opacity-0"
            enterTo="opacity-100"
            leave="transition-opacity duration-200"
            leaveFrom="opacity-100"
            leaveTo="opacity-0"
            onClick={() => setOpen(false)}
            role="dialog"
            aria-modal="true"
          >
            <CachedImage
              type={type}
              src={failed || !fullSrc ? src : fullSrc}
              alt={alt}
              width={1000}
              height={1500}
              onError={() => setFailed(true)}
              onLoad={(e) => {
                const img = e.currentTarget;
                if (img.naturalHeight) {
                  setRatio(img.naturalWidth / img.naturalHeight);
                }
              }}
              className="rounded-lg shadow-2xl"
              style={{
                // As large as the screen allows, small covers scaled up too
                width: `min(100%, (100dvh - 2rem - env(safe-area-inset-top) - env(safe-area-inset-bottom)) * ${ratio})`,
                height: 'auto',
              }}
            />
            <button
              type="button"
              className="absolute right-4 top-[calc(1rem+env(safe-area-inset-top))] rounded-full bg-gray-800/80 p-2 text-gray-200 hover:text-white"
              onClick={() => setOpen(false)}
              aria-label={intl.formatMessage(globalMessages.close)}
            >
              <XMarkIcon className="h-6 w-6" />
            </button>
          </Transition>,
          document.body
        )}
    </>
  );
};

export default PosterLightbox;
