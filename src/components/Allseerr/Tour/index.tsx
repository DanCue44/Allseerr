import { menuMessages } from '@app/components/Layout/Sidebar';
import { useTour } from '@app/context/TourContext';
import useHiddenMediaTypes from '@app/hooks/useHiddenMediaTypes';
import useSettings from '@app/hooks/useSettings';
import { Permission, UserType, useUser } from '@app/hooks/useUser';
import defineMessages from '@app/utils/defineMessages';
import type { ErrorInfo, ReactNode } from 'react';
import {
  Component,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.Allseerr.Tour', {
  tour: 'Guided tour',
  stepof: 'Step {current} of {total}',
  back: 'Back',
  next: 'Next',
  done: 'Done',
  skip: 'Skip',
  movies: 'movies',
  series: 'series',
  music: 'music',
  books: 'books',
  audiobooks: 'audiobooks',
  subtitles: 'subtitles for what is already in the library',
  welcomeTitle: 'Welcome to {appTitle}',
  welcomeBody:
    'Ask for {kinds}, all in one place. Here is a quick look at where everything is. It takes about a minute.',
  newTitle: 'Been here before?',
  newBody:
    'Everything you used to do still works, with a fresh new look. New this time: {features}.',
  newBodyPlain:
    'Everything you used to do still works, with a fresh new look and easier ways to find things.',
  homeTitle: 'For You',
  homeBody:
    'Your home page. Trending and popular picks, recently added titles and what is coming soon, all mixed together.',
  spacesTitle: 'A space for each kind',
  spacesBody:
    '{spaces} each have their own space. Discover new things, browse with filters, see what is in the library and what is coming up.',
  searchTitle: 'Search everything',
  searchBody:
    'One search looks through {kinds}. Use the pills above the results to narrow it down.',
  people: 'people',
  requestTitle: 'Asking for something',
  requestBody:
    'Open any title and press Request. For a series, pick the seasons you want. For a book, choose ebook, audiobook or both. You get a notification when it is ready.',
  requestBodyNoBooks:
    'Open any title and press Request. For a series, pick the seasons you want. You get a notification when it is ready.',
  requestsTitle: 'Track your requests',
  requestsBody:
    'Everything you have asked for, and where it stands: waiting for approval, approved, downloading or ready.',
  libraryTitle: 'Library',
  libraryBody:
    'Everything already on the server, ready to watch, read or listen to.',
  libraryMoreBody:
    'The Library, under this menu: everything already on the server, ready to watch, read or listen to.',
  calendarTitle: 'Calendar',
  calendarBody:
    'Upcoming releases and new episodes by date, including the ones you asked for.',
  calendarMoreBody:
    'The Calendar is in this menu too: upcoming releases and new episodes by date.',
  watchlistTitle: 'Save it for later',
  watchlistBody:
    'Use the watchlist button on a title to keep it for later, and follow artists and authors to hear about their new releases.',
  watchlistPlexBody:
    'Your Plex Watchlist shows up on For You. Turn on auto-request in your settings and anything you add there is requested for you.',
  issueTitle: 'Something not right?',
  issueBody:
    'If something in the library plays badly or has the wrong audio, open it and use the warning button to report an issue.',
  issueSubtitlesBody:
    'Missing subtitles? The title page lets you ask for another language.',
  accountTitle: 'Your account',
  accountBody:
    'Your profile, request limits and settings live here. Set up notifications, your language and more.',
  doneTitle: 'You are all set',
  doneBody:
    'Want to see this again? Pick Take the Tour from this menu any time. Enjoy!',
});

// Space between the highlighted element and the edge of its spotlight
const SPOTLIGHT_PAD = 6;
// Keeps the card off the screen edges, as the page gutter does
const EDGE_GAP = 16;
const CARD_GAP = 14;
const CARD_MAX_WIDTH = 360;

interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}

interface TourStep {
  key: string;
  title: string;
  body: string;
  /**
   * Selectors tried in order; the first with a visible match is highlighted.
   * A step with targets but none visible is left out.
   */
  targets?: string[];
  /** Body used when a later selector than the first one matched */
  fallbackBody?: string;
  /** Highlight every visible match of the selector together */
  group?: boolean;
}

const isVisible = (element: Element): boolean => {
  const rect = element.getBoundingClientRect();

  if (rect.width === 0 || rect.height === 0) {
    return false;
  }

  const style = window.getComputedStyle(element);
  return style.visibility !== 'hidden' && style.display !== 'none';
};

interface ResolvedTarget {
  rect: Rect;
  fallback: boolean;
}

const resolveTarget = (step: TourStep): ResolvedTarget | null => {
  if (!step.targets) {
    return null;
  }

  for (const [index, selector] of step.targets.entries()) {
    const visible = Array.from(document.querySelectorAll(selector)).filter(
      isVisible
    );

    if (visible.length === 0) {
      continue;
    }

    const rects = (step.group ? visible : visible.slice(0, 1)).map((element) =>
      element.getBoundingClientRect()
    );
    const top = Math.min(...rects.map((rect) => rect.top));
    const left = Math.min(...rects.map((rect) => rect.left));
    const bottom = Math.max(...rects.map((rect) => rect.bottom));
    const right = Math.max(...rects.map((rect) => rect.right));

    return {
      rect: { top, left, width: right - left, height: bottom - top },
      fallback: index > 0,
    };
  }

  return null;
};

const tourTarget = (name: string) => `[data-tour="${name}"]`;

/**
 * A short guided tour of the Ambient interface. It dims the page, lights up
 * one part of the navigation at a time and explains it in a small card.
 * Steps follow whatever is on screen, so phones get the tab bar and header
 * buttons while wide screens get the floating pills, and a step whose
 * element is missing (no permission, service not set up) is left out.
 */
const Tour = () => {
  const intl = useIntl();
  const { isOpen, closeTour } = useTour();
  const { currentSettings } = useSettings();
  const hiddenMediaTypes = useHiddenMediaTypes();
  const { user, hasPermission } = useUser();
  const [index, setIndex] = useState(0);
  const [visibleSteps, setVisibleSteps] = useState<TourStep[]>([]);
  const [target, setTarget] = useState<ResolvedTarget | null>(null);
  const [cardSize, setCardSize] = useState({ width: 0, height: 0 });
  const [viewport, setViewport] = useState(() =>
    typeof window === 'undefined'
      ? { width: 0, height: 0 }
      : { width: window.innerWidth, height: window.innerHeight }
  );
  const cardRef = useRef<HTMLDivElement>(null);
  const primaryRef = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);

  // Plain values, so the steps are only rebuilt when one of them changes
  const canRequest = hasPermission(Permission.REQUEST);
  const canReport = hasPermission(
    [Permission.CREATE_ISSUES, Permission.MANAGE_ISSUES],
    { type: 'or' }
  );
  const canAutoRequest =
    user?.userType === UserType.PLEX &&
    hasPermission(
      [
        Permission.AUTO_REQUEST,
        Permission.AUTO_REQUEST_MOVIE,
        Permission.AUTO_REQUEST_TV,
      ],
      { type: 'or' }
    );

  const steps = useMemo<TourStep[]>(() => {
    const { subtitlesEnabled, applicationTitle } = currentSettings;
    // Media types kept from the user while the admin hides what they cannot
    // request are left out of the tour too
    const moviesShown = !hiddenMediaTypes.includes('movie');
    const seriesShown = !hiddenMediaTypes.includes('tv');
    const musicEnabled =
      currentSettings.musicEnabled && !hiddenMediaTypes.includes('music');
    const booksEnabled =
      currentSettings.booksEnabled && !hiddenMediaTypes.includes('book');
    const list = (items: string[]) =>
      intl.formatList(items, { type: 'conjunction' });

    const kinds = [
      ...(moviesShown ? [intl.formatMessage(messages.movies)] : []),
      ...(seriesShown ? [intl.formatMessage(messages.series)] : []),
      ...(musicEnabled ? [intl.formatMessage(messages.music)] : []),
      ...(booksEnabled
        ? [
            intl.formatMessage(messages.books),
            intl.formatMessage(messages.audiobooks),
          ]
        : []),
    ];
    const newFeatures = [
      ...(musicEnabled ? [intl.formatMessage(messages.music)] : []),
      ...(booksEnabled
        ? [
            intl.formatMessage(messages.books),
            intl.formatMessage(messages.audiobooks),
          ]
        : []),
      ...(subtitlesEnabled ? [intl.formatMessage(messages.subtitles)] : []),
    ];
    // The navigation names of the spaces, as shown in the tab bar
    const spaceNames = [
      ...(moviesShown ? [intl.formatMessage(menuMessages.browsemovies)] : []),
      ...(seriesShown ? [intl.formatMessage(menuMessages.browsetv)] : []),
      ...(musicEnabled ? [intl.formatMessage(menuMessages.browsemusic)] : []),
      ...(booksEnabled ? [intl.formatMessage(menuMessages.browsebooks)] : []),
    ];

    const all: (TourStep | false)[] = [
      {
        key: 'welcome',
        title: intl.formatMessage(messages.welcomeTitle, {
          appTitle: applicationTitle,
        }),
        body: intl.formatMessage(messages.welcomeBody, { kinds: list(kinds) }),
      },
      {
        key: 'new',
        title: intl.formatMessage(messages.newTitle),
        body: newFeatures.length
          ? intl.formatMessage(messages.newBody, {
              features: list(newFeatures),
            })
          : intl.formatMessage(messages.newBodyPlain),
      },
      {
        key: 'home',
        title: intl.formatMessage(messages.homeTitle),
        body: intl.formatMessage(messages.homeBody),
        targets: [tourTarget('nav-dashboard')],
      },
      {
        key: 'spaces',
        title: intl.formatMessage(messages.spacesTitle),
        body: intl.formatMessage(messages.spacesBody, {
          spaces: list(spaceNames),
        }),
        targets: ['[data-tour-space]'],
        group: true,
      },
      {
        key: 'search',
        title: intl.formatMessage(messages.searchTitle),
        body: intl.formatMessage(messages.searchBody, {
          kinds: list([...kinds, intl.formatMessage(messages.people)]),
        }),
        targets: [tourTarget('search')],
      },
      canRequest && {
        key: 'request',
        title: intl.formatMessage(messages.requestTitle),
        body: intl.formatMessage(
          booksEnabled ? messages.requestBody : messages.requestBodyNoBooks
        ),
      },
      {
        key: 'requests',
        title: intl.formatMessage(messages.requestsTitle),
        body: intl.formatMessage(messages.requestsBody),
        targets: [tourTarget('nav-requests')],
      },
      {
        key: 'library',
        title: intl.formatMessage(messages.libraryTitle),
        body: intl.formatMessage(messages.libraryBody),
        fallbackBody: intl.formatMessage(messages.libraryMoreBody),
        targets: [tourTarget('nav-library'), tourTarget('nav-more')],
      },
      {
        key: 'calendar',
        title: intl.formatMessage(messages.calendarTitle),
        body: intl.formatMessage(messages.calendarBody),
        fallbackBody: intl.formatMessage(messages.calendarMoreBody),
        targets: [tourTarget('nav-calendar'), tourTarget('nav-more')],
      },
      {
        key: 'watchlist',
        title: intl.formatMessage(messages.watchlistTitle),
        body: [
          intl.formatMessage(messages.watchlistBody),
          canAutoRequest ? intl.formatMessage(messages.watchlistPlexBody) : '',
        ]
          .filter(Boolean)
          .join(' '),
      },
      (canReport || (subtitlesEnabled && canRequest)) && {
        key: 'issue',
        title: intl.formatMessage(messages.issueTitle),
        body: [
          canReport ? intl.formatMessage(messages.issueBody) : '',
          subtitlesEnabled && canRequest
            ? intl.formatMessage(messages.issueSubtitlesBody)
            : '',
        ]
          .filter(Boolean)
          .join(' '),
      },
      {
        key: 'account',
        title: intl.formatMessage(messages.accountTitle),
        body: intl.formatMessage(messages.accountBody),
        targets: [tourTarget('user-menu')],
      },
      {
        key: 'done',
        title: intl.formatMessage(messages.doneTitle),
        body: intl.formatMessage(messages.doneBody),
        targets: [tourTarget('user-menu')],
      },
    ];

    return all.filter((step): step is TourStep => !!step);
  }, [
    currentSettings,
    hiddenMediaTypes,
    intl,
    canRequest,
    canReport,
    canAutoRequest,
  ]);

  // Works out which steps have something to show at the current size
  const refreshSteps = useCallback(() => {
    setVisibleSteps((previous) => {
      const next = steps.filter(
        (step) => !step.targets || resolveTarget(step) !== null
      );
      const same =
        previous.length === next.length &&
        previous.every(
          (step, i) =>
            step.key === next[i].key &&
            step.title === next[i].title &&
            step.body === next[i].body
        );
      return same ? previous : next;
    });
  }, [steps]);

  const step = visibleSteps[Math.min(index, visibleSteps.length - 1)];
  const total = visibleSteps.length;
  const current = Math.min(index, total - 1);
  const isLast = current === total - 1;

  const measure = useCallback(() => {
    setViewport({ width: window.innerWidth, height: window.innerHeight });
    setTarget(step ? resolveTarget(step) : null);
  }, [step]);

  const finish = useCallback(() => {
    closeTour();
  }, [closeTour]);

  const goNext = useCallback(() => {
    if (isLast) {
      finish();
    } else {
      setIndex(current + 1);
    }
  }, [current, finish, isLast]);

  const goBack = useCallback(() => {
    setIndex(Math.max(0, current - 1));
  }, [current]);

  // Start from the top each time the tour opens
  useEffect(() => {
    if (isOpen) {
      setIndex(0);
      returnFocus.current = document.activeElement as HTMLElement | null;
    } else if (returnFocus.current) {
      returnFocus.current.focus?.();
      returnFocus.current = null;
    }
  }, [isOpen]);

  useEffect(() => {
    if (isOpen) {
      refreshSteps();
    }
  }, [isOpen, refreshSteps]);

  // Re-measure when the window changes, as the layout swaps between the
  // phone and the wide navigation
  useEffect(() => {
    if (!isOpen) {
      return;
    }

    let frame = 0;
    const onChange = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        refreshSteps();
        measure();
      });
    };

    measure();
    window.addEventListener('resize', onChange);
    window.addEventListener('scroll', onChange, true);

    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', onChange);
      window.removeEventListener('scroll', onChange, true);
    };
  }, [isOpen, measure, refreshSteps]);

  // The card's height decides whether it fits above or below the spotlight
  useLayoutEffect(() => {
    const card = cardRef.current;

    if (!card) {
      return;
    }

    const update = () => {
      const { offsetWidth, offsetHeight } = card;
      setCardSize((previous) =>
        previous.width === offsetWidth && previous.height === offsetHeight
          ? previous
          : { width: offsetWidth, height: offsetHeight }
      );
    };

    update();
    const observer = new ResizeObserver(update);
    observer.observe(card);

    return () => observer.disconnect();
  }, [isOpen, step]);

  // Move focus to the card's main button on every step. Waits a moment, as
  // a menu the tour was started from hands focus back to its button first.
  useEffect(() => {
    if (!isOpen || !step) {
      return;
    }

    const timer = window.setTimeout(
      () => primaryRef.current?.focus({ preventScroll: true }),
      50
    );
    return () => window.clearTimeout(timer);
  }, [isOpen, step]);

  // Listens on the document, so the keys work wherever focus has gone
  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        finish();
      } else if (event.key === 'ArrowRight') {
        event.preventDefault();
        goNext();
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault();
        goBack();
      } else if (
        event.key === 'Enter' &&
        !(event.target instanceof HTMLButtonElement)
      ) {
        event.preventDefault();
        goNext();
      } else if (event.key === 'Tab' && cardRef.current) {
        // Keep focus inside the card while it is open
        const focusable = Array.from(
          cardRef.current.querySelectorAll<HTMLElement>('button')
        );
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        const inside = cardRef.current.contains(document.activeElement);

        if (event.shiftKey && (!inside || document.activeElement === first)) {
          event.preventDefault();
          last?.focus();
        } else if (
          !event.shiftKey &&
          (!inside || document.activeElement === last)
        ) {
          event.preventDefault();
          first?.focus();
        }
      }
    };

    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [isOpen, finish, goNext, goBack]);

  if (!isOpen || !step || typeof document === 'undefined') {
    return null;
  }

  const spotlight = target
    ? {
        top: target.rect.top - SPOTLIGHT_PAD,
        left: target.rect.left - SPOTLIGHT_PAD,
        width: target.rect.width + SPOTLIGHT_PAD * 2,
        height: target.rect.height + SPOTLIGHT_PAD * 2,
      }
    : null;

  const cardWidth = Math.min(
    CARD_MAX_WIDTH,
    Math.max(0, viewport.width - EDGE_GAP * 2)
  );

  let cardStyle: React.CSSProperties;

  if (spotlight) {
    const below = spotlight.top + spotlight.height + CARD_GAP;
    const above = spotlight.top - CARD_GAP - cardSize.height;
    const fitsBelow = below + cardSize.height <= viewport.height - EDGE_GAP;
    const top = fitsBelow
      ? below
      : above >= EDGE_GAP
        ? above
        : Math.max(EDGE_GAP, (viewport.height - cardSize.height) / 2);
    const centered = spotlight.left + spotlight.width / 2 - cardWidth / 2;
    const left = Math.min(
      Math.max(EDGE_GAP, centered),
      viewport.width - EDGE_GAP - cardWidth
    );
    cardStyle = { top, left, width: cardWidth };
  } else {
    cardStyle = {
      top: Math.max(EDGE_GAP, (viewport.height - cardSize.height) / 2),
      left: Math.max(EDGE_GAP, (viewport.width - cardWidth) / 2),
      width: cardWidth,
    };
  }

  const body =
    target?.fallback && step.fallbackBody ? step.fallbackBody : step.body;
  const titleId = 'allseerr-tour-title';
  const bodyId = 'allseerr-tour-body';

  return createPortal(
    <div className="fixed inset-0 z-[9000] font-body" data-testid="tour">
      {/* Catches clicks so the page underneath stays put during the tour */}
      <div
        className={`absolute inset-0 ${spotlight ? '' : 'bg-black/70'}`}
        aria-hidden="true"
      />
      {spotlight && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute rounded-[28px] ring-2 ring-as-accent transition-all duration-300 ease-out motion-reduce:transition-none"
          style={{
            ...spotlight,
            borderRadius: Math.min(spotlight.height / 2, 28),
            boxShadow: '0 0 0 9999px rgba(0, 0, 0, 0.7)',
          }}
        />
      )}
      <div
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        className="absolute rounded-3xl border border-as-line bg-as-surface p-5 text-as-ink shadow-2xl shadow-black/50 transition-[top,left] duration-300 ease-out motion-reduce:transition-none"
        style={{
          ...cardStyle,
          // Hidden until it has been measured once, so it does not jump
          visibility: cardSize.height ? 'visible' : 'hidden',
        }}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase tracking-wider text-as-ink-faint">
              <span className="sr-only">
                {intl.formatMessage(messages.tour)}:{' '}
              </span>
              {intl.formatMessage(messages.stepof, {
                current: current + 1,
                total,
              })}
            </p>
            <h2
              id={titleId}
              className="mt-1 font-display text-lg font-bold leading-snug text-as-ink"
            >
              {step.title}
            </h2>
          </div>
          {!isLast && (
            <button
              type="button"
              onClick={finish}
              className="-mr-2 -mt-1 flex-none rounded-full px-2.5 py-1 text-sm font-semibold text-as-ink-muted transition hover:bg-as-raised hover:text-as-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-as-accent motion-reduce:transition-none"
            >
              {intl.formatMessage(messages.skip)}
            </button>
          )}
        </div>
        <p
          id={bodyId}
          className="mt-2 text-[15px] leading-relaxed text-as-ink-soft"
        >
          {body}
        </p>
        <div className="mt-4 flex items-center justify-between gap-3">
          <div className="flex items-center gap-1.5" aria-hidden="true">
            {visibleSteps.map((dot, i) => (
              <span
                key={dot.key}
                className={`h-1.5 rounded-full transition-all duration-300 motion-reduce:transition-none ${
                  i === current ? 'w-4 bg-as-accent' : 'w-1.5 bg-as-line-strong'
                }`}
              />
            ))}
          </div>
          <div className="flex flex-none items-center gap-1">
            {current > 0 && (
              <button
                type="button"
                onClick={goBack}
                className="rounded-full px-3 py-2 text-sm font-semibold text-as-ink-muted transition hover:text-as-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-as-accent motion-reduce:transition-none"
              >
                {intl.formatMessage(messages.back)}
              </button>
            )}
            <button
              ref={primaryRef}
              type="button"
              onClick={goNext}
              className="rounded-full bg-as-accent px-4 py-2 text-sm font-bold text-as-ground transition hover:brightness-110 focus:outline-none focus-visible:ring-2 focus-visible:ring-as-ink focus-visible:ring-offset-2 focus-visible:ring-offset-as-surface motion-reduce:transition-none"
            >
              {intl.formatMessage(isLast ? messages.done : messages.next)}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
};

/**
 * The tour is a nice extra, so if it ever breaks it quietly steps aside
 * instead of taking the page down with it.
 */
class TourBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // eslint-disable-next-line no-console
    console.error('Guided tour failed', error, info.componentStack);
  }

  render() {
    return this.state.failed ? null : this.props.children;
  }
}

const SafeTour = () => (
  <TourBoundary>
    <Tour />
  </TourBoundary>
);

export default SafeTour;
