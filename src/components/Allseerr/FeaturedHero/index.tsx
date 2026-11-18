import CachedImage from '@app/components/Common/CachedImage';
import StatusBadgeMini from '@app/components/Common/StatusBadgeMini';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import type { DiscoverMediaFilter } from '@app/utils/discoverMediaFilter';
import type { MediaStatus } from '@server/constants/media';
import type {
  AlbumResult,
  BookResult,
  ComicResult,
  MovieResult,
  PersonResult,
  TvResult,
} from '@server/models/Search';
import Link from 'next/link';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { useIntl } from 'react-intl';
import useSWR from 'swr';
import {
  relativeSlot,
  releaseVelocity,
  settleDuration,
  snapDirection,
  wrapIndex,
} from './swipe';

const messages = defineMessages('components.Allseerr.FeaturedHero', {
  trending: 'Trending Now',
  popular: 'Popular Now',
  details: 'View Details',
  featured: 'Featured',
  volumes: '{count, plural, one {# volume} other {# volumes}}',
});

const ROTATE_MS = 8000;
const SLIDES = 6;
// Movement before a gesture is read as a swipe or a scroll
const DRAG_LOCK = 6;
// How long rotation waits after a finger lifts before it starts again
const RESUME_MS = 3000;
// Settle after a release: quick to start, long soft landing
const SETTLE_EASE = 'cubic-bezier(0.22, 1, 0.36, 1)';
// An automatic turn eases in and out, as nothing is carrying it
const ROTATE_EASE = 'cubic-bezier(0.65, 0, 0.35, 1)';
const ROTATE_SLIDE_MS = 700;
// Dot widths in px, matching w-6 and w-1.5
const DOT_ACTIVE = 24;
const DOT_IDLE = 6;

// Layout effects only run in the browser; on the server they would warn
const useBrowserLayoutEffect =
  typeof window === 'undefined' ? useEffect : useLayoutEffect;

interface HeroResponse {
  results: (
    | MovieResult
    | TvResult
    | PersonResult
    | AlbumResult
    | BookResult
    | ComicResult
  )[];
  /** Other trending book covers, laid behind the book slides */
  collage?: string[];
}

interface HeroSlide {
  key: string;
  title: string;
  href: string;
  /** Media type, and year or artist/author */
  meta: string;
  overview?: string;
  status?: MediaStatus;
  /** TMDB backdrop path, for movies and series */
  backdrop?: string;
  /** TheAudioDB fanart of the album's artist */
  artistBackdrop?: string;
  /** Dominant cover colours, for albums without fanart and for books */
  palette?: string[];
  /** Square album or portrait book cover */
  cover?: { src: string; type: 'music' | 'book' };
}

// Comics and manga have a banner of their own on the Comics & Manga page
type HeroFilter = DiscoverMediaFilter | 'comic';

const HERO_SOURCES: Record<HeroFilter, string> = {
  all: '/api/v1/discover/trending?page=1',
  movie: '/api/v1/discover/trending?page=1&mediaType=movie',
  tv: '/api/v1/discover/trending?page=1&mediaType=tv',
  music: '/api/v1/discover/music/hero',
  book: '/api/v1/discover/books/hero',
  comic: '/api/v1/discover/comics/hero',
};

/**
 * A backdrop painted from a cover's colours: two soft glows over a diagonal
 * wash, cheap to draw as it is plain CSS gradients
 */
const paletteBackground = ([first, second = first, third = second]: string[]) =>
  [
    `radial-gradient(110% 90% at 85% 10%, ${first} 0%, transparent 62%)`,
    `radial-gradient(80% 90% at 10% 100%, ${second} 0%, transparent 60%)`,
    `linear-gradient(150deg, ${third} 0%, ${first} 55%, ${second} 100%)`,
  ].join(', ');

const prefersReducedMotion = () =>
  typeof window !== 'undefined' &&
  !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

interface FeaturedHeroProps {
  /**
   * The media type of the space the banner tops, or all on the For You
   * home; null shows the placeholder
   */
  mediaFilter?: HeroFilter | null;
}

/**
 * Rotating artwork banner of what is trending, shown at the top of the For
 * You home and of each space in the Ambient interface. Album and book covers
 * stand in for backdrops in the music and books spaces.
 *
 * The slides sit side by side on one track, so a swipe drags the whole slide
 * and its neighbour comes in from the edge under the finger, then settles
 * with the release's momentum. Drags move the track straight from pointer
 * events, once per frame, without re-rendering.
 */
const FeaturedHero = ({ mediaFilter = 'all' }: FeaturedHeroProps) => {
  const intl = useIntl();
  const [index, setIndex] = useState(0);
  // A mouse over the banner, or a finger on it until shortly after it lifts
  const [paused, setPaused] = useState(false);
  const [holding, setHolding] = useState(false);
  const { data } = useSWR<HeroResponse>(
    mediaFilter ? HERO_SOURCES[mediaFilter] : null
  );

  useEffect(() => {
    setIndex(0);
  }, [mediaFilter]);

  const slides: HeroSlide[] = (mediaFilter ? (data?.results ?? []) : [])
    .flatMap((item): HeroSlide[] => {
      switch (item.mediaType) {
        case 'movie':
          return item.backdropPath
            ? [
                {
                  key: `hero-movie-${item.id}`,
                  title: item.title,
                  href: `/movie/${item.id}`,
                  meta: `${intl.formatMessage(globalMessages.movie)}${
                    item.releaseDate ? ` · ${item.releaseDate.slice(0, 4)}` : ''
                  }`,
                  overview: item.overview,
                  status: item.mediaInfo?.status,
                  backdrop: item.backdropPath,
                },
              ]
            : [];
        case 'tv':
          return item.backdropPath
            ? [
                {
                  key: `hero-tv-${item.id}`,
                  title: item.name,
                  href: `/tv/${item.id}`,
                  meta: `${intl.formatMessage(globalMessages.tvshow)}${
                    item.firstAirDate
                      ? ` · ${item.firstAirDate.slice(0, 4)}`
                      : ''
                  }`,
                  overview: item.overview,
                  status: item.mediaInfo?.status,
                  backdrop: item.backdropPath,
                },
              ]
            : [];
        case 'album':
          return item.posterPath
            ? [
                {
                  key: `hero-album-${item.id}`,
                  title: item.title,
                  href: `/music/${item.id}`,
                  meta: [
                    intl.formatMessage(globalMessages.album),
                    item.artistName,
                  ]
                    .filter(Boolean)
                    .join(' · '),
                  status: item.mediaInfo?.status,
                  artistBackdrop: item.artistBackdrop ?? undefined,
                  palette: item.palette,
                  cover: { src: item.posterPath, type: 'music' },
                },
              ]
            : [];
        case 'book':
          return item.posterPath
            ? [
                {
                  key: `hero-book-${item.id}`,
                  title: item.title,
                  href: `/book/${item.id}`,
                  meta: [
                    intl.formatMessage(globalMessages.book),
                    item.authorName,
                    item.firstPublishYear,
                  ]
                    .filter(Boolean)
                    .join(' · '),
                  overview: item.subtitle,
                  status: item.mediaInfo?.status,
                  palette: item.palette,
                  cover: { src: item.posterPath, type: 'book' },
                },
              ]
            : [];
        case 'comic':
          return item.posterPath
            ? [
                {
                  key: `hero-comic-${item.id}`,
                  title: item.title,
                  href: `/comic/${item.id}`,
                  meta: [
                    intl.formatMessage(
                      item.kind === 'manga'
                        ? globalMessages.manga
                        : globalMessages.comic
                    ),
                    item.authors,
                    item.year,
                  ]
                    .filter(Boolean)
                    .join(' · '),
                  overview: item.volumes
                    ? intl.formatMessage(messages.volumes, {
                        count: item.volumes,
                      })
                    : undefined,
                  status: item.mediaInfo?.status,
                  palette: item.palette,
                  cover: { src: item.posterPath, type: 'book' },
                },
              ]
            : [];
        default:
          return [];
      }
    })
    .slice(0, SLIDES);

  const count = slides.length;
  const active = wrapIndex(index, count);
  const slideKeys = slides.map((slide) => slide.key).join();

  // Only rotate while the banner is on screen and the page is in front, so
  // the slides do not keep the GPU busy after scrolling past it
  const sectionRef = useRef<HTMLElement>(null);
  const [onScreen, setOnScreen] = useState(true);
  const [pageVisible, setPageVisible] = useState(true);

  useEffect(() => {
    const node = sectionRef.current;
    if (!node || typeof IntersectionObserver === 'undefined') {
      return;
    }
    const observer = new IntersectionObserver(
      ([entry]) => setOnScreen(entry.isIntersecting),
      { threshold: 0.25 }
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [count]);

  useEffect(() => {
    const update = () => setPageVisible(document.visibilityState !== 'hidden');
    update();
    document.addEventListener('visibilitychange', update);
    return () => document.removeEventListener('visibilitychange', update);
  }, []);

  const trackRef = useRef<HTMLDivElement>(null);
  const slideRefs = useRef<(HTMLDivElement | null)[]>([]);
  const dotRefs = useRef<(HTMLButtonElement | null)[]>([]);
  // Read by the handlers below, which outlive the render that made them
  const activeRef = useRef(active);
  const countRef = useRef(count);
  // The settle or turn in flight: the slide it is heading to, 0 for back
  const animation = useRef<{ direction: -1 | 0 | 1; timer: number } | null>(
    null
  );
  const drag = useRef<{
    id: number;
    x: number;
    y: number;
    /** Where the track was when the finger came down */
    base: number;
    offset: number;
    width: number;
    samples: { x: number; time: number }[];
    locked: 'x' | 'y' | null;
    /** The finger stopped a settle that was still moving */
    caught: boolean;
    touch: boolean;
  } | null>(null);
  const frame = useRef(0);
  const holdTimer = useRef(0);
  // Set after a swipe so the click that ends it does not open the slide
  const swiped = useRef(false);

  const setTrack = (x: number, duration = 0, easing = SETTLE_EASE) => {
    const track = trackRef.current;
    if (!track) {
      return;
    }
    track.style.transition = duration
      ? `transform ${duration}ms ${easing}`
      : 'none';
    track.style.transform = `translate3d(${x}px, 0, 0)`;
  };

  /**
   * Puts each slide in its place beside the active one. The neighbours are
   * the only others drawn; with two slides the other one goes to whichever
   * side the track is heading.
   */
  const placeSlides = (heading: -1 | 0 | 1 = 0) => {
    slideRefs.current.forEach((node, i) => {
      if (!node) {
        return;
      }
      let slot = relativeSlot(i, activeRef.current, countRef.current);
      if (countRef.current === 2 && slot !== 0 && heading !== 0) {
        slot = heading;
      }
      node.style.transform = `translate3d(${slot * 100}%, 0, 0)`;
      node.style.visibility = Math.abs(slot) <= 1 ? '' : 'hidden';
    });
  };

  /**
   * Grows the dot of the slide coming in and shrinks the active one along
   * with the drag, from 0 (nothing moved) to 1 (a whole slide)
   */
  const setDots = (progress: number, heading: -1 | 1, duration = 0) => {
    const p = Math.min(1, Math.max(0, progress));
    const target = wrapIndex(activeRef.current + heading, countRef.current);
    dotRefs.current.forEach((dot, i) => {
      if (!dot) {
        return;
      }
      const share = i === activeRef.current ? 1 - p : i === target ? p : 0;
      dot.style.transition = duration
        ? `width ${duration}ms ${SETTLE_EASE}, opacity ${duration}ms ${SETTLE_EASE}`
        : 'none';
      dot.style.width = `${DOT_IDLE + (DOT_ACTIVE - DOT_IDLE) * share}px`;
      dot.style.opacity = String(0.4 + 0.6 * share);
    });
  };

  const clearDots = () => {
    dotRefs.current.forEach((dot) => {
      if (dot) {
        dot.style.transition = '';
        dot.style.width = '';
        dot.style.opacity = '';
      }
    });
  };

  // Every change of slide, by whatever means, lands with the new slide in
  // the middle and the track at rest, before the browser paints
  useBrowserLayoutEffect(() => {
    activeRef.current = active;
    countRef.current = count;
    placeSlides();
    clearDots();
    setTrack(0);
    if (trackRef.current) {
      trackRef.current.style.willChange = '';
    }
  }, [active, count, slideKeys]);

  // The neighbours are decoded ahead, so they never come in blank
  useEffect(() => {
    if (count < 2) {
      return;
    }
    [wrapIndex(active + 1, count), wrapIndex(active - 1, count)].forEach((i) =>
      slideRefs.current[i]?.querySelectorAll('img').forEach((img) => {
        img.decode?.().catch(() => undefined);
      })
    );
  }, [active, count, slideKeys]);

  useEffect(
    () => () => {
      if (animation.current) {
        clearTimeout(animation.current.timer);
      }
      cancelAnimationFrame(frame.current);
      clearTimeout(holdTimer.current);
    },
    []
  );

  /** Moves the track a whole slide to one side, then makes that slide active */
  const slideTo = (
    direction: -1 | 1,
    { from = 0, velocity = 0, auto = false } = {}
  ) => {
    if (animation.current) {
      from = catchAnimation();
    }
    const track = trackRef.current;
    if (!track || countRef.current < 2) {
      return;
    }
    if (prefersReducedMotion()) {
      setIndex(wrapIndex(activeRef.current + direction, countRef.current));
      return;
    }
    const width = track.offsetWidth;
    const target = -direction * width;
    const duration = auto
      ? ROTATE_SLIDE_MS
      : settleDuration(target - from, velocity, width);
    placeSlides(direction);
    track.style.willChange = 'transform';
    setTrack(target, duration, auto ? ROTATE_EASE : SETTLE_EASE);
    setDots(1, direction, duration);
    animation.current = {
      direction,
      timer: window.setTimeout(() => {
        animation.current = null;
        // Synchronous, so the layout effect puts the track back at 0 in
        // the same frame the new slide becomes the active one
        flushSync(() =>
          setIndex(wrapIndex(activeRef.current + direction, countRef.current))
        );
      }, duration),
    };
  };

  const snapBack = (from: number, velocity = 0) => {
    const track = trackRef.current;
    if (!track) {
      return;
    }
    const duration = settleDuration(from, velocity, track.offsetWidth);
    setTrack(0, duration);
    if (from) {
      setDots(0, from < 0 ? 1 : -1, duration);
    }
    animation.current = {
      direction: 0,
      timer: window.setTimeout(() => {
        animation.current = null;
        setTrack(0);
        track.style.willChange = '';
        clearDots();
      }, duration),
    };
  };

  /**
   * Stops a settle where it is, so a finger can pick the slide up mid-flight.
   * Returns where the track now sits relative to the active slide.
   */
  const catchAnimation = (): number => {
    const track = trackRef.current;
    const current = animation.current;
    if (!track || !current) {
      return 0;
    }
    clearTimeout(current.timer);
    animation.current = null;
    const transform = getComputedStyle(track).transform;
    let x =
      transform && transform !== 'none'
        ? new DOMMatrixReadOnly(transform).m41
        : 0;
    if (current.direction) {
      // The slide it was heading for becomes the active one, and the track
      // is moved by a slide width so nothing on screen jumps
      flushSync(() =>
        setIndex(
          wrapIndex(activeRef.current + current.direction, countRef.current)
        )
      );
      x += current.direction * track.offsetWidth;
    }
    track.style.willChange = 'transform';
    setTrack(x);
    return x;
  };

  // Restarted on every change of slide, so a swipe or a dot gives the new
  // slide its full time
  useEffect(() => {
    if (paused || holding || !onScreen || !pageVisible || count < 2) {
      return;
    }
    const timer = setTimeout(() => slideTo(1, { auto: true }), ROTATE_MS);
    return () => clearTimeout(timer);
    // slideTo only reads refs
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paused, holding, onScreen, pageVisible, count, index]);

  const goTo = (target: number) => {
    if (target === activeRef.current || count < 2) {
      return;
    }
    catchAnimation();
    const slot = relativeSlot(target, activeRef.current, count);
    if (Math.abs(slot) === 1 && count > 2) {
      slideTo(slot as -1 | 1);
      return;
    }
    if (count === 2) {
      slideTo(target === wrapIndex(activeRef.current + 1, 2) ? 1 : -1);
      return;
    }
    // Further away there is no neighbour to slide in, so it fades in
    setIndex(target);
    if (!prefersReducedMotion()) {
      trackRef.current?.animate?.([{ opacity: 0.3 }, { opacity: 1 }], {
        duration: 250,
        easing: 'ease-out',
      });
    }
  };

  const step = (direction: -1 | 1) => {
    catchAnimation();
    slideTo(direction);
  };

  const holdRotation = (touch: boolean) => {
    if (!touch) {
      return;
    }
    clearTimeout(holdTimer.current);
    setHolding(true);
  };

  const releaseRotation = (touch: boolean) => {
    if (!touch) {
      return;
    }
    clearTimeout(holdTimer.current);
    holdTimer.current = window.setTimeout(() => setHolding(false), RESUME_MS);
  };

  const swallowClick = () => {
    swiped.current = true;
    window.setTimeout(() => (swiped.current = false), 400);
  };

  /** Draws the drag at most once a frame */
  const drawDrag = () => {
    frame.current = 0;
    const state = drag.current;
    if (!state || state.locked !== 'x') {
      return;
    }
    const heading = state.offset < 0 ? 1 : -1;
    if (countRef.current === 2) {
      placeSlides(heading);
    }
    setTrack(state.offset);
    setDots(Math.abs(state.offset) / (state.width || 1), heading);
  };

  /**
   * Decides between swipe and scroll once the finger has moved far enough.
   * Shared by the pointer and touch handlers, as either can arrive first.
   */
  const lockDirection = (clientX: number, clientY: number) => {
    const state = drag.current;
    if (!state || state.locked) {
      return;
    }
    const dx = clientX - state.x;
    const dy = clientY - state.y;
    if (Math.abs(dx) < DRAG_LOCK && Math.abs(dy) < DRAG_LOCK) {
      return;
    }
    state.locked = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
    if (state.locked === 'y') {
      return;
    }
    // The slide starts from where it is rather than jumping by the lock
    // distance, so it moves exactly with the finger from here on
    state.x += Math.sign(dx) * DRAG_LOCK;
    try {
      // Keeps the swipe going when the finger leaves the banner
      sectionRef.current?.setPointerCapture(state.id);
    } catch {
      // The pointer is already gone, the swipe still ends on pointerup
    }
    if (trackRef.current) {
      trackRef.current.style.willChange = 'transform';
    }
  };

  // touch-action: pan-y leaves vertical scrolling to the browser, but iOS
  // Safari still scrolls the page when a sideways swipe drifts up or down.
  // Once a gesture is a swipe its touch moves are kept from the page. This
  // has to be a native listener, as React's touch listeners are passive.
  useEffect(() => {
    const node = sectionRef.current;
    if (!node) {
      return;
    }
    const onTouchMove = (event: TouchEvent) => {
      if (!drag.current || event.touches.length !== 1) {
        return;
      }
      lockDirection(event.touches[0].clientX, event.touches[0].clientY);
      if (drag.current.locked === 'x' && event.cancelable) {
        event.preventDefault();
      }
    };
    node.addEventListener('touchmove', onTouchMove, { passive: false });
    return () => node.removeEventListener('touchmove', onTouchMove);
    // The handler only reads refs; it is attached once the banner is drawn
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [count > 0]);

  const onPointerDown = (event: React.PointerEvent<HTMLElement>) => {
    swiped.current = false;
    if (count < 2 || !event.isPrimary || event.button !== 0) {
      return;
    }
    const touch = event.pointerType !== 'mouse';
    const caught = !!animation.current;
    const base = catchAnimation();
    drag.current = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      base,
      offset: base,
      width: trackRef.current?.offsetWidth ?? 0,
      samples: [{ x: event.clientX, time: event.timeStamp }],
      locked: null,
      caught,
      touch,
    };
    holdRotation(touch);
  };

  const onPointerMove = (event: React.PointerEvent<HTMLElement>) => {
    const state = drag.current;
    if (!state || state.id !== event.pointerId || state.locked === 'y') {
      return;
    }
    lockDirection(event.clientX, event.clientY);
    if (state.locked !== 'x') {
      return;
    }
    const width = state.width;
    state.offset = Math.max(
      -width,
      Math.min(width, state.base + event.clientX - state.x)
    );
    state.samples.push({ x: event.clientX, time: event.timeStamp });
    if (state.samples.length > 8) {
      state.samples.shift();
    }
    if (!prefersReducedMotion() && !frame.current) {
      frame.current = requestAnimationFrame(drawDrag);
    }
  };

  const endDrag = (
    event: React.PointerEvent<HTMLElement>,
    cancelled = false
  ) => {
    const state = drag.current;
    if (!state || state.id !== event.pointerId) {
      return;
    }
    drag.current = null;
    cancelAnimationFrame(frame.current);
    frame.current = 0;
    releaseRotation(state.touch);

    if (state.locked !== 'x') {
      // A tap that stopped a moving slide settles it, without opening it
      if (state.caught) {
        swallowClick();
        const direction = snapDirection(state.base, 0, state.width);
        if (direction) {
          slideTo(direction, { from: state.base });
        } else {
          snapBack(state.base);
        }
      }
      return;
    }
    // Swallows the click some browsers send at the end of the swipe
    swallowClick();

    // The lift counts as a sample, so pausing before letting go reads as slow
    const velocity = releaseVelocity(
      cancelled
        ? state.samples
        : [...state.samples, { x: event.clientX, time: event.timeStamp }]
    );
    const direction = cancelled
      ? 0
      : snapDirection(state.offset, velocity, state.width);

    if (prefersReducedMotion()) {
      if (direction) {
        setIndex(wrapIndex(activeRef.current + direction, count));
      }
      return;
    }
    if (direction) {
      slideTo(direction, { from: state.offset, velocity });
    } else {
      snapBack(state.offset, velocity);
    }
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key === 'ArrowRight') {
      event.preventDefault();
      step(1);
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      step(-1);
    }
  };

  if (!count) {
    return (
      <div className="-mx-4 -mt-20 mb-8 h-[27rem] animate-pulse bg-as-surface/40 lg:mx-0 lg:mt-0 lg:h-[28rem] lg:rounded-3xl" />
    );
  }

  const current = slides[active];
  const collage = data?.collage ?? [];

  return (
    // The banner is a focusable carousel: arrows and swipes change slide
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
    <section
      ref={sectionRef}
      tabIndex={0}
      aria-roledescription="carousel"
      aria-label={intl.formatMessage(messages.featured)}
      className="relative -mx-4 -mt-20 mb-8 h-[27rem] touch-pan-y select-none overflow-hidden bg-as-ground outline-none focus-visible:ring-2 focus-visible:ring-as-accent lg:mx-0 lg:mt-0 lg:h-[28rem] lg:rounded-3xl lg:border lg:border-as-line"
      onPointerEnter={(event) =>
        event.pointerType === 'mouse' && setPaused(true)
      }
      onPointerLeave={(event) =>
        event.pointerType === 'mouse' && setPaused(false)
      }
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={(event) => endDrag(event)}
      onPointerCancel={(event) => endDrag(event, true)}
      onClickCapture={(event) => {
        if (swiped.current) {
          swiped.current = false;
          event.preventDefault();
          event.stopPropagation();
        }
      }}
      onDragStart={(event) => event.preventDefault()}
      onKeyDown={onKeyDown}
    >
      <div ref={trackRef} className="absolute inset-0">
        {slides.map((slide, i) => {
          const slot = relativeSlot(i, active, count);
          const near = Math.abs(slot) <= 1;
          return (
            <div
              key={slide.key}
              ref={(node) => {
                slideRefs.current[i] = node;
              }}
              className="absolute inset-0 overflow-hidden"
              style={{
                transform: `translate3d(${slot * 100}%, 0, 0)`,
                visibility: near ? undefined : 'hidden',
              }}
              aria-hidden={i !== active}
              inert={i !== active}
            >
              <SlideBackdrop slide={slide} priority={i === 0} />
              {near &&
                collage.length > 0 &&
                slide.cover?.type === 'book' &&
                !slide.backdrop && <BookCollage covers={collage} />}
              <div className="absolute inset-0 bg-gradient-to-t from-as-ground via-as-ground/50 to-transparent" />
              <div className="absolute inset-0 bg-gradient-to-r from-as-ground/90 via-as-ground/30 to-transparent" />
              <SlideContent
                slide={slide}
                label={intl.formatMessage(
                  mediaFilter === 'music' ? messages.popular : messages.trending
                )}
                details={intl.formatMessage(messages.details)}
              />
            </div>
          );
        })}
      </div>

      {/* The dots stay put while the slides move, level with View Details
          and left of the cover on wide screens */}
      <div
        className={`absolute bottom-5 right-5 flex h-10 items-center gap-1.5 lg:bottom-10 ${
          current.cover
            ? current.cover.type === 'music'
              ? 'lg:right-[23.5rem]'
              : 'lg:right-[18rem]'
            : 'lg:right-10'
        }`}
      >
        {slides.map((slide, i) => (
          <button
            key={`${slide.key}-dot`}
            ref={(node) => {
              dotRefs.current[i] = node;
            }}
            type="button"
            aria-label={slide.title}
            aria-current={i === active}
            onClick={() => goTo(i)}
            className={`h-1.5 rounded-full bg-as-ink transition-all ${
              i === active ? 'w-6' : 'w-1.5 opacity-40 hover:opacity-70'
            }`}
          />
        ))}
      </div>
    </section>
  );
};

/** A slide's artwork: backdrop, artist fanart, cover colours or blown up cover */
const SlideBackdrop = ({
  slide,
  priority,
}: {
  slide: HeroSlide;
  priority: boolean;
}) => {
  // Neighbours load straight away rather than when they come into view
  const loading = priority ? undefined : 'eager';
  if (slide.backdrop) {
    return (
      <CachedImage
        type="tmdb"
        alt=""
        src={`https://image.tmdb.org/t/p/w1920_and_h800_multi_faces/${slide.backdrop}`}
        style={{ width: '100%', height: '100%', objectFit: 'cover' }}
        fill
        priority={priority}
        loading={loading}
      />
    );
  }
  if (slide.artistBackdrop) {
    return (
      <CachedImage
        type="music"
        alt=""
        src={slide.artistBackdrop}
        style={{
          width: '100%',
          height: '100%',
          objectFit: 'cover',
          objectPosition: 'center 30%',
        }}
        fill
        priority={priority}
        loading={loading}
      />
    );
  }
  if (slide.palette?.length) {
    return (
      <div
        className="absolute inset-0 opacity-90"
        style={{ background: paletteBackground(slide.palette) }}
      />
    );
  }
  if (slide.cover) {
    // Without fanart or colours, the cover is blown up and blurred into a
    // wash of its colours behind the sharp cover
    return (
      <div className="absolute inset-0 scale-125 opacity-70 blur-3xl">
        <CachedImage
          type={slide.cover.type}
          alt=""
          src={slide.cover.src}
          style={{ width: '100%', height: '100%', objectFit: 'cover' }}
          fill
          loading="eager"
        />
      </div>
    );
  }
  return null;
};

/**
 * Other trending covers tiled at an angle behind a book slide, drawn only on
 * the slides in view and never animated
 */
const BookCollage = ({ covers }: { covers: string[] }) => (
  <div
    aria-hidden="true"
    className="absolute inset-0 overflow-hidden opacity-25 lg:opacity-30"
  >
    <div className="absolute -right-10 -top-16 grid rotate-[-12deg] grid-cols-4 gap-3 lg:-top-24 lg:right-0 lg:grid-cols-6 lg:gap-4">
      {covers.map((src) => (
        <div
          key={src}
          className="relative aspect-[2/3] w-20 overflow-hidden rounded-md bg-as-surface lg:w-28"
        >
          <CachedImage
            type="book"
            alt=""
            src={src}
            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
            fill
            sizes="112px"
          />
        </div>
      ))}
    </div>
  </div>
);

/** A slide's words, cover and View Details button */
const SlideContent = ({
  slide,
  label,
  details,
}: {
  slide: HeroSlide;
  label: string;
  details: string;
}) => (
  <div className="relative flex h-full items-end gap-8 p-5 lg:p-10">
    <div className="flex min-w-0 flex-1 flex-col justify-end">
      {slide.cover && (
        <Link
          href={slide.href}
          aria-hidden="true"
          tabIndex={-1}
          className={`relative mb-4 block shrink-0 overflow-hidden rounded-xl shadow-[0_16px_40px_rgba(0,0,0,0.55)] ring-1 ring-white/10 lg:hidden ${
            slide.cover.type === 'music' ? 'h-24 w-24' : 'h-28 w-[4.75rem]'
          }`}
        >
          <CachedImage
            type={slide.cover.type}
            alt=""
            src={slide.cover.src}
            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
            fill
            loading="eager"
          />
        </Link>
      )}
      <span className="mb-2 text-xs font-semibold uppercase tracking-widest text-as-accent">
        {label}
      </span>
      <div className="mb-2 flex min-w-0 items-center gap-2">
        {slide.status && <StatusBadgeMini status={slide.status} />}
        <span className="truncate text-sm text-as-ink-muted">{slide.meta}</span>
      </div>
      <Link href={slide.href}>
        <h2 className="line-clamp-2 max-w-3xl pb-[0.1em] font-display text-3xl font-semibold leading-tight tracking-tight text-as-ink hover:underline lg:text-5xl">
          {slide.title}
        </h2>
      </Link>
      {slide.overview && (
        <p className="mt-3 line-clamp-2 max-w-2xl text-sm text-as-ink-soft lg:line-clamp-3 lg:text-base">
          {slide.overview}
        </p>
      )}
      <div className="mt-5 flex items-center">
        <Link
          href={slide.href}
          className="rounded-full bg-as-ink px-5 py-2.5 text-sm font-semibold text-as-ground transition hover:bg-as-ink-soft"
        >
          {details}
        </Link>
      </div>
    </div>
    {slide.cover && (
      <Link
        href={slide.href}
        aria-hidden="true"
        tabIndex={-1}
        className={`relative hidden shrink-0 overflow-hidden rounded-2xl shadow-[0_24px_60px_rgba(0,0,0,0.6)] ring-1 ring-white/10 transition-transform duration-500 hover:scale-[1.02] lg:block ${
          slide.cover.type === 'music'
            ? 'h-[19rem] w-[19rem]'
            : 'h-[20rem] w-[13.5rem]'
        }`}
      >
        <CachedImage
          type={slide.cover.type}
          alt=""
          src={slide.cover.src}
          style={{ width: '100%', height: '100%', objectFit: 'cover' }}
          fill
          loading="eager"
        />
      </Link>
    )}
  </div>
);

export default FeaturedHero;
