import SearchPill from '@app/components/Allseerr/Layout/SearchPill';
import {
  SPACE_LINK_KEYS,
  getMoreSheetLinks,
  getTabBarLinks,
  overflowLinks,
  primaryLinks,
} from '@app/components/Allseerr/Layout/navigation';
import Tour from '@app/components/Allseerr/Tour';
import PullToRefresh from '@app/components/Layout/PullToRefresh';
import type { SidebarLinkProps } from '@app/components/Layout/Sidebar';
import { menuMessages } from '@app/components/Layout/Sidebar';
import UserDropdown from '@app/components/Layout/UserDropdown';
import UserWarnings from '@app/components/Layout/UserWarnings';
import VersionStatus from '@app/components/Layout/VersionStatus';
import NoBookEndsSyncNotice from '@app/components/NoBookEndsSyncNotice';
import { AMBIENT_PALETTE } from '@app/context/InterfaceStyleContext';
import { TourProvider } from '@app/context/TourContext';
import useBranding from '@app/hooks/useBranding';
import useLocale from '@app/hooks/useLocale';
import useSettings from '@app/hooks/useSettings';
import { Permission, useUser } from '@app/hooks/useUser';
import defineMessages from '@app/utils/defineMessages';
import {
  SPACE_KEYS,
  getAvailableSpaces,
  getPhoneTabs,
} from '@app/utils/spaces';
import {
  Menu,
  MenuButton,
  MenuItem,
  MenuItems,
  Transition,
  TransitionChild,
} from '@headlessui/react';
import {
  ArrowLeftIcon,
  ClockIcon,
  EllipsisHorizontalIcon,
  MagnifyingGlassIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline';
import type { AvailableLocale } from '@server/types/languages';
import Link from 'next/link';
import { useRouter } from 'next/router';
import type { ReactElement } from 'react';
import { Fragment, cloneElement, useEffect, useState } from 'react';
import { useIntl } from 'react-intl';
import useSWR from 'swr';

// Shown in the bar on wide screens and under More on narrower ones
const COMPACT_KEYS: SidebarLinkProps['messagesKey'][] = ['library', 'calendar'];

const messages = defineMessages('components.Allseerr.Layout', {
  more: 'More',
  close: 'Close',
  back: 'Back',
  search: 'Search',
});

// Translucent ground behind every floating pill
// Phones redraw a backdrop blur on every scroll frame under fixed controls,
// which stutters and heats the phone, so they get a near-solid fill instead
const glass = 'bg-as-ground/95 lg:bg-as-ground/80 lg:backdrop-blur-xl';

const LogoMark = ({ className }: { className?: string }) => {
  const { logoUrl } = useBranding();

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={logoUrl}
      alt=""
      aria-hidden="true"
      className={`object-contain ${className ?? ''}`}
    />
  );
};

type LayoutProps = {
  children: React.ReactNode;
};

const icon = (link: SidebarLinkProps, className: string) =>
  cloneElement(link.svgIcon as ReactElement<{ className?: string }>, {
    className,
  });

// Marks a link for the guided tour, which finds what to light up by these
const tourProps = (link: SidebarLinkProps) => ({
  'data-tour': `nav-${link.messagesKey}`,
  'data-tour-space': Object.values(SPACE_LINK_KEYS).includes(link.messagesKey)
    ? ''
    : undefined,
});

const CountBadge = ({ count }: { count: number }) => (
  <span className="ml-1.5 inline-flex min-w-[1.25rem] items-center justify-center rounded-full bg-as-accent px-1.5 text-[11px] font-bold leading-5 text-as-ground">
    {count}
  </span>
);

const AmbientShell = ({ children }: LayoutProps) => {
  const intl = useIntl();
  const router = useRouter();
  const { user, hasPermission } = useUser();
  const { currentSettings } = useSettings();
  const { setLocale } = useLocale();
  const [isMoreOpen, setMoreOpen] = useState(false);
  const [isSearchOpen, setSearchOpen] = useState(false);
  const { data: requestResponse } = useSWR('/api/v1/request/count', {
    revalidateOnMount: true,
  });
  const { data: issueResponse } = useSWR('/api/v1/issue/count', {
    revalidateOnMount: true,
  });

  // Only admins see downloads, and the count reads every arr's queue
  const { data: downloadsResponse } = useSWR<{
    attention: number;
    seedingAtRisk?: number;
  }>(hasPermission(Permission.ADMIN) ? '/api/v1/downloads/count' : null, {
    revalidateOnMount: true,
    refreshInterval: 60_000,
  });

  const pendingRequestsCount: number = requestResponse?.pending ?? 0;
  const openIssuesCount: number = issueResponse?.open ?? 0;
  // Downloads needing attention and torrents that may break a tracker's
  // seeding rules
  const downloadsBadgeCount =
    (downloadsResponse?.attention ?? 0) +
    (downloadsResponse?.seedingAtRisk ?? 0);

  useEffect(() => {
    if (setLocale && user) {
      setLocale(
        (user?.settings?.locale
          ? user.settings.locale
          : currentSettings.locale) as AvailableLocale
      );
    }
  }, [setLocale, currentSettings.locale, user]);

  // Typing opens and updates /search, so the phone search box stays open
  // there and only closes on other pages
  const onSearchPage = router.pathname.startsWith('/search');
  const showPhoneSearch = isSearchOpen || onSearchPage;

  useEffect(() => {
    setMoreOpen(false);
    if (!router.pathname.startsWith('/search')) {
      setSearchOpen(false);
    }
  }, [router.asPath, router.pathname]);

  const closePhoneSearch = () => {
    setSearchOpen(false);
    if (onSearchPage) {
      if (window.history.length > 1) {
        router.back();
      } else {
        router.push('/');
      }
    }
  };

  const canSee = (link: SidebarLinkProps) =>
    link.requiredPermission
      ? hasPermission(link.requiredPermission, {
          type: link.permissionType ?? 'and',
        })
      : true;

  // The space links also match their title pages, so Movies stays lit on a
  // movie page and Music or Books on album, artist, book and author pages
  const isActive = (link: SidebarLinkProps) =>
    !!router.pathname.match(link.activeRegExp);

  // Music needs Lidarr and books need LazyLibrarian; without them their
  // spaces leave the navigation
  const availableSpaces = getAvailableSpaces({
    musicEnabled: currentSettings.musicEnabled,
    booksEnabled: currentSettings.booksEnabled,
  });
  const hiddenSpaceKeys = SPACE_KEYS.filter(
    (space) => !availableSpaces.includes(space)
  ).map((space) => SPACE_LINK_KEYS[space]);
  const isShown = (link: SidebarLinkProps) =>
    canSee(link) && !hiddenSpaceKeys.includes(link.messagesKey);
  const phoneTabs = getPhoneTabs(availableSpaces);
  const tabBarLinks = getTabBarLinks(phoneTabs).filter(canSee);

  const badgeFor = (link: SidebarLinkProps) => {
    if (
      link.messagesKey === 'requests' &&
      pendingRequestsCount > 0 &&
      hasPermission(Permission.MANAGE_REQUESTS)
    ) {
      return pendingRequestsCount;
    }

    if (link.messagesKey === 'downloads' && downloadsBadgeCount > 0) {
      return downloadsBadgeCount;
    }

    if (
      link.messagesKey === 'issues' &&
      openIssuesCount > 0 &&
      hasPermission(Permission.MANAGE_ISSUES)
    ) {
      return openIssuesCount;
    }

    return 0;
  };

  const requestsLink = primaryLinks.find(
    (link) => link.messagesKey === 'requests'
  );
  const visibleOverflow = overflowLinks.filter(canSee);
  const compactLinks = primaryLinks
    .filter((link) => COMPACT_KEYS.includes(link.messagesKey))
    .filter(canSee);
  const overflowActive = visibleOverflow.some(isActive);
  const overflowBadge = visibleOverflow.reduce(
    (total, link) => total + badgeFor(link),
    0
  );
  const visibleSheetLinks = getMoreSheetLinks(phoneTabs, hiddenSpaceKeys)
    .filter(canSee)
    // Requests has its own button in the top bar
    .filter((link) => link.messagesKey !== 'requests');
  const sheetActive = visibleSheetLinks.some(isActive);
  const sheetBadge = visibleSheetLinks.reduce(
    (total, link) => total + badgeFor(link),
    0
  );
  const phoneRequestsLink =
    requestsLink && !phoneTabs.includes('requests') ? requestsLink : undefined;

  // The app name only shows on For You; other pages keep just the icon
  const showAppName = router.pathname === '/';

  const wordmark = (
    <Link
      href="/"
      className="font-display text-lg font-semibold tracking-tight text-as-ink"
    >
      {currentSettings.applicationTitle}
    </Link>
  );

  return (
    <div
      className="as-shell min-h-full bg-as-ground font-body text-as-ink"
      data-palette={AMBIENT_PALETTE}
    >
      <div className="pwa-only fixed inset-0 z-20 h-1 w-full border-as-line md:border-t" />
      <div className="pointer-events-none absolute inset-x-0 top-0 h-80 bg-gradient-to-b from-as-surface/70 to-transparent" />

      {/* Desktop: separate floating pills, as in the design */}
      <header
        className="fixed inset-x-0 z-30 hidden px-6 lg:block xl:px-10"
        style={{ top: 'calc(1.5rem + env(safe-area-inset-top))' }}
      >
        <div className="max-w-8xl mx-auto flex items-center gap-3 xl:gap-4">
          <Link
            href="/"
            aria-label={currentSettings.applicationTitle}
            className={`${glass} flex h-[52px] items-center gap-2.5 rounded-full pl-2 text-as-ink ${
              showAppName ? 'pr-2 min-[1360px]:pr-5' : 'pr-2'
            }`}
          >
            <LogoMark className="h-10 w-10" />
            {showAppName && (
              <span className="hidden font-display text-xl font-bold min-[1360px]:inline">
                {currentSettings.applicationTitle}
              </span>
            )}
          </Link>
          <nav
            className={`${glass} flex h-[52px] items-center gap-0.5 rounded-full px-2`}
          >
            {primaryLinks
              .filter((link) => link.messagesKey !== 'requests')
              .filter(isShown)
              .map((link) => (
                <Link
                  key={`ambient-${link.messagesKey}`}
                  href={link.href}
                  as={link.as}
                  className={`whitespace-nowrap rounded-full px-3 py-2.5 text-[15px] transition xl:px-4 ${
                    COMPACT_KEYS.includes(link.messagesKey)
                      ? 'hidden min-[1440px]:block'
                      : ''
                  } ${
                    isActive(link)
                      ? 'bg-as-accent font-bold text-as-ground'
                      : 'text-as-ink-soft hover:text-as-ink'
                  }`}
                  data-testid={link.dataTestId}
                  {...tourProps(link)}
                >
                  {intl.formatMessage(menuMessages[link.messagesKey])}
                </Link>
              ))}
          </nav>
          <div
            className="w-full min-w-[220px] max-w-[420px] flex-1"
            data-tour="search"
          >
            <SearchPill />
          </div>
          {requestsLink && (
            <Link
              href={requestsLink.href}
              data-tour="nav-requests"
              className={`${glass} ml-auto flex h-[52px] items-center gap-2 rounded-full px-[18px] font-semibold transition ${
                isActive(requestsLink)
                  ? 'text-as-accent'
                  : 'text-as-ink hover:text-as-accent-soft'
              }`}
            >
              {intl.formatMessage(menuMessages.requests)}
              {badgeFor(requestsLink) > 0 && (
                <CountBadge count={badgeFor(requestsLink)} />
              )}
            </Link>
          )}
          {(visibleOverflow.length > 0 || compactLinks.length > 0) && (
            <Menu as="div" className="relative">
              <MenuButton
                aria-label={intl.formatMessage(messages.more)}
                data-tour="nav-more"
                className={`${glass} relative flex h-[52px] w-[52px] items-center justify-center rounded-full transition focus:outline-none ${
                  overflowActive
                    ? 'text-as-accent'
                    : 'text-as-ink hover:text-as-accent-soft'
                }`}
              >
                <EllipsisHorizontalIcon className="h-6 w-6" />
                {overflowBadge > 0 && (
                  <span className="absolute -right-1 -top-1">
                    <CountBadge count={overflowBadge} />
                  </span>
                )}
              </MenuButton>
              <Transition
                as={Fragment}
                enter="transition ease-out duration-100"
                enterFrom="transform opacity-0 scale-95"
                enterTo="transform opacity-100 scale-100"
                leave="transition ease-in duration-75"
                leaveFrom="transform opacity-100 scale-100"
                leaveTo="transform opacity-0 scale-95"
              >
                <MenuItems className="absolute right-0 mt-2 w-56 origin-top-right rounded-2xl bg-as-surface p-1.5 shadow-xl shadow-black/40 focus:outline-none">
                  {/* On narrower screens Library and Calendar move in here */}
                  {compactLinks.map((link) => (
                    <MenuItem key={`ambient-compact-${link.messagesKey}`}>
                      {({ focus }) => (
                        <Link
                          href={link.href}
                          as={link.as}
                          className={`flex items-center rounded-xl px-3 py-2 text-sm font-semibold min-[1440px]:hidden ${
                            isActive(link)
                              ? 'text-as-accent'
                              : focus
                                ? 'bg-as-raised text-as-ink'
                                : 'text-as-ink-soft'
                          }`}
                        >
                          {icon(link, 'mr-2.5 h-5 w-5')}
                          {intl.formatMessage(menuMessages[link.messagesKey])}
                        </Link>
                      )}
                    </MenuItem>
                  ))}
                  {visibleOverflow.map((link) => {
                    const badge = badgeFor(link);

                    return (
                      <MenuItem key={`ambient-more-${link.messagesKey}`}>
                        {({ focus }) => (
                          <Link
                            href={link.href}
                            as={link.as}
                            className={`flex items-center rounded-xl px-3 py-2 text-sm font-semibold ${
                              isActive(link)
                                ? 'text-as-accent'
                                : focus
                                  ? 'bg-as-raised text-as-ink'
                                  : 'text-as-ink-soft'
                            }`}
                            data-testid={link.dataTestId}
                          >
                            {icon(link, 'mr-2.5 h-5 w-5')}
                            {intl.formatMessage(menuMessages[link.messagesKey])}
                            {badge > 0 && (
                              <span className="ml-auto">
                                <CountBadge count={badge} />
                              </span>
                            )}
                          </Link>
                        )}
                      </MenuItem>
                    );
                  })}
                  {hasPermission(Permission.ADMIN) && (
                    <div className="mt-1 border-t border-as-line px-1 pt-1">
                      <VersionStatus />
                    </div>
                  )}
                </MenuItems>
              </Transition>
            </Menu>
          )}
          <div
            className={`${glass} flex h-[52px] w-[52px] items-center justify-center rounded-full [&>div]:ml-0`}
            data-tour="user-menu"
          >
            <UserDropdown />
          </div>
        </div>
      </header>

      {/* Phone and tablet: circle buttons up top, icon tab bar below */}
      <header
        className="fixed inset-x-0 top-0 z-30 px-3.5 lg:hidden"
        // Clears the status bar when added to the home screen, where the
        // page runs underneath it
        style={{ paddingTop: 'calc(0.875rem + env(safe-area-inset-top))' }}
      >
        {showPhoneSearch ? (
          <div className="flex items-center gap-2">
            <div className={`${glass} flex-1 rounded-full`} data-tour="search">
              <SearchPill focusOnMount />
            </div>
            <button
              className={`${glass} flex h-11 w-11 flex-none items-center justify-center rounded-full text-as-ink`}
              onClick={closePhoneSearch}
              aria-label={intl.formatMessage(messages.close)}
            >
              <XMarkIcon className="h-5 w-5" />
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            {router.pathname !== '/' && (
              <button
                className={`${glass} flex h-11 w-11 items-center justify-center rounded-full text-as-ink`}
                onClick={() => router.back()}
                aria-label={intl.formatMessage(messages.back)}
              >
                <ArrowLeftIcon className="h-5 w-5" />
              </button>
            )}
            <Link
              href="/"
              aria-label={currentSettings.applicationTitle}
              className={`${glass} flex h-11 min-w-0 items-center gap-2 rounded-full font-display text-base font-bold text-as-ink ${
                showAppName ? 'pl-1.5 pr-4' : 'w-11 flex-none justify-center'
              }`}
            >
              <LogoMark className="h-8 w-8 flex-none" />
              {showAppName && (
                <span className="truncate">
                  {currentSettings.applicationTitle}
                </span>
              )}
            </Link>
            <div className="ml-auto flex flex-none items-center gap-2">
              {phoneRequestsLink && (
                <Link
                  href={phoneRequestsLink.href}
                  aria-label={intl.formatMessage(menuMessages.requests)}
                  className={`${glass} relative flex h-11 w-11 items-center justify-center rounded-full ${
                    isActive(phoneRequestsLink)
                      ? 'text-as-accent'
                      : 'text-as-ink'
                  }`}
                  data-testid="ambient-requests-mobile"
                  data-tour="nav-requests"
                >
                  <ClockIcon className="h-5 w-5" />
                  {badgeFor(phoneRequestsLink) > 0 && (
                    <span className="absolute -right-1.5 -top-1.5">
                      <CountBadge count={badgeFor(phoneRequestsLink)} />
                    </span>
                  )}
                </Link>
              )}
              <button
                className={`${glass} flex h-11 w-11 items-center justify-center rounded-full text-as-ink`}
                onClick={() => setSearchOpen(true)}
                aria-label={intl.formatMessage(messages.search)}
                data-tour="search"
              >
                <MagnifyingGlassIcon className="h-5 w-5" />
              </button>
              {visibleSheetLinks.length > 0 && (
                <button
                  className={`${glass} relative flex h-11 w-11 items-center justify-center rounded-full focus:outline-none ${
                    sheetActive || isMoreOpen ? 'text-as-accent' : 'text-as-ink'
                  }`}
                  onClick={() => setMoreOpen(true)}
                  aria-label={intl.formatMessage(messages.more)}
                  data-testid="ambient-more-mobile"
                  data-tour="nav-more"
                >
                  <EllipsisHorizontalIcon className="h-6 w-6" />
                  {sheetBadge > 0 && (
                    <span className="absolute -right-1.5 -top-1.5">
                      <CountBadge count={sheetBadge} />
                    </span>
                  )}
                </button>
              )}
              <div
                className={`${glass} flex h-11 w-11 items-center justify-center rounded-full [&>div]:ml-0`}
                data-tour="user-menu"
              >
                <UserDropdown />
              </div>
            </div>
          </div>
        )}
      </header>

      <nav
        className="fixed inset-x-3 bottom-3.5 z-40 lg:hidden"
        style={{ marginBottom: 'env(safe-area-inset-bottom)' }}
      >
        {/* For You and every space; Requests and More sit in the top bar */}
        <div
          className="grid h-16 items-center rounded-[32px] bg-as-surface shadow-[0_10px_30px_rgba(0,0,0,0.45)]"
          style={{
            gridTemplateColumns: `repeat(${tabBarLinks.length}, minmax(0, 1fr))`,
          }}
        >
          {tabBarLinks.map((link) => {
            const badge = badgeFor(link);

            return (
              <Link
                key={`ambient-tab-${link.messagesKey}`}
                href={link.href}
                as={link.as}
                aria-current={isActive(link) ? 'page' : undefined}
                className={`relative flex min-w-0 flex-col items-center gap-1 transition ${
                  isActive(link) ? 'text-as-accent' : 'text-as-ink-faint'
                }`}
                data-testid={`${link.dataTestId}-mobile`}
                {...tourProps(link)}
              >
                {icon(link, 'h-6 w-6')}
                {/* Five look-alike media icons read better with a word */}
                <span className="max-w-full truncate px-0.5 text-[10px] font-semibold leading-none">
                  {intl.formatMessage(menuMessages[link.messagesKey])}
                </span>
                {badge > 0 && (
                  <span className="absolute -top-2 left-1/2 ml-1">
                    <CountBadge count={badge} />
                  </span>
                )}
              </Link>
            );
          })}
        </div>
      </nav>

      <Transition as={Fragment} show={isMoreOpen}>
        <div className="fixed inset-0 z-50 lg:hidden">
          <TransitionChild
            as="div"
            enter="transition-opacity ease-out duration-200"
            enterFrom="opacity-0"
            enterTo="opacity-100"
            leave="transition-opacity ease-in duration-150"
            leaveFrom="opacity-100"
            leaveTo="opacity-0"
            className="absolute inset-0 bg-black/60"
            onClick={() => setMoreOpen(false)}
          />
          <TransitionChild
            as="div"
            enter="transition-transform ease-out duration-200"
            enterFrom="translate-y-full"
            enterTo="translate-y-0"
            leave="transition-transform ease-in duration-150"
            leaveFrom="translate-y-0"
            leaveTo="translate-y-full"
            className="absolute inset-x-0 bottom-0 rounded-t-3xl border-t border-as-line bg-as-surface p-4"
            style={{
              paddingBottom: 'calc(env(safe-area-inset-bottom) + 1rem)',
            }}
          >
            <div className="mb-3 flex items-center justify-between">
              {wordmark}
              <button
                className="rounded-full p-2 text-as-ink-muted hover:bg-as-raised hover:text-as-ink focus:outline-none"
                onClick={() => setMoreOpen(false)}
                aria-label={intl.formatMessage(messages.close)}
              >
                <XMarkIcon className="h-6 w-6" />
              </button>
            </div>
            <div className="grid grid-cols-2 gap-2">
              {visibleSheetLinks.map((link) => {
                const badge = badgeFor(link);

                return (
                  <Link
                    key={`ambient-sheet-${link.messagesKey}`}
                    href={link.href}
                    as={link.as}
                    className={`flex items-center rounded-2xl border px-3 py-3 text-sm font-semibold ${
                      isActive(link)
                        ? 'border-as-accent/50 bg-as-raised text-as-accent'
                        : 'border-as-line bg-as-tile text-as-ink-soft'
                    }`}
                    data-testid={`${link.dataTestId}-mobile`}
                  >
                    {icon(link, 'mr-2.5 h-5 w-5')}
                    {intl.formatMessage(menuMessages[link.messagesKey])}
                    {badge > 0 && (
                      <span className="ml-auto">
                        <CountBadge count={badge} />
                      </span>
                    )}
                  </Link>
                );
              })}
            </div>
            {hasPermission(Permission.ADMIN) && (
              <div className="mt-3">
                <VersionStatus onClick={() => setMoreOpen(false)} />
              </div>
            )}
          </TransitionChild>
        </div>
      </Transition>

      <div className="relative">
        <PullToRefresh />
        <main
          className="relative z-0 pb-28 pt-20 focus:outline-none lg:pb-10 lg:pt-28"
          tabIndex={0}
        >
          <div className="max-w-8xl mx-auto px-4">
            <UserWarnings />
            <NoBookEndsSyncNotice />
            {children}
          </div>
        </main>
      </div>
    </div>
  );
};

// The guided tour needs the shell's navigation on screen to point at, and
// the account menu inside it can replay the tour
const AmbientLayout = ({ children }: LayoutProps) => (
  <TourProvider>
    <AmbientShell>{children}</AmbientShell>
    <Tour />
  </TourProvider>
);

export default AmbientLayout;
