# Changelog

Notable Allseerr changes are listed here, newest first. Versions are the Seerr version Allseerr is based on plus an Allseerr revision (for example 3.5.2.1); Seerr's own changes are in Seerr's release notes.

## 3.5.2.8 - 2026-11-27

### Fixed

- Saving a user's settings through the API no longer fails for users who follow the server's blocked genres.

## 3.5.2.7 - 2026-11-27

### Fixed

- A custom accent color (Settings > General, or your own profile settings) now shows across the Ambient interface instead of the default orange ([#8](https://github.com/DanCue44/Allseerr/issues/8)).

## 3.5.2.6 - 2026-11-27

### Added

- Narrator names on book pages link to a narrator page that lists the audiobooks they read, grouped by author and series in series order, with request status and filters.
- Searching for a narrator's name now shows the narrator, both in the combined search and in the book search.
- Grimmory (formerly BookLore) can be added under Settings > Services and chosen for ebooks, audiobooks or both. Book pages then link to the book in Grimmory, and requested books show as available once Grimmory has them ([#7](https://github.com/DanCue44/Allseerr/issues/7)).
- Grimmory joins Audiobookshelf, Kavita and Komga in User Access, so Allseerr can create and manage people's Grimmory accounts and offer it as the reading app for ebooks or audiobooks.

## 3.5.2.5 - 2026-11-22

### Added

- Sign in with your own OpenID Connect provider (Authentik, Authelia, Keycloak, Pocket ID and others), set up under Settings > Users. Off by default; matching existing users by email is on and creating new users is off.
- Add as many webhooks as you like, each with its own URL, headers, payload and notification types. Your existing webhook stays as the first one.
- Notify Me Too: on a title someone else already requested, ask to be told when it becomes available, without using a request.
- A new setting (off by default) marks approved requests that found nothing after a set number of days as Not Found and tells the requester why. Another option can also stop the search in the arr or Talearr.
- A new Settings > Users option (off by default) lets people remove a title only they requested without waiting for an admin, unless someone else has watched it.
- Requests can be blocked by genre for movies, series, music and books, with an optional list per user.
- Unwatched Request Limit (off by default): holds new movie and series requests while a user has too many requested titles sitting available and unwatched, and the request window lists them.
- Watched Cleanup page for admins (off by default): lists requested titles everyone who asked for them has watched, so you can create removal requests or remove them in one step.
- Tracearr can provide watch history for profiles and media pages, including on Jellyfin and Emby servers.

### Changed

- Advanced Requests can be narrowed per user to the server, quality profile, root folder and tags. Users who have it today keep all of them.
- Music requests from users without Advanced Requests no longer accept a server, profile, folder or tags sent through the API, as movie and series requests already did.

## 3.5.2.4 - 2026-11-19

### Fixed

- Book requests no longer fail when Chaptarr has not prepared the book yet ("Metadata for ... is not ready"). Allseerr goes on to add the book, and Chaptarr adds it or holds it until it is ready ([#5](https://github.com/DanCue44/Allseerr/issues/5)).
- A refused request now says why, for example that the title is on a blocked streaming service, the request limit is reached or the rating is over the limit, instead of "Something went wrong while submitting the request."
- The NoBookEnds Sync notice no longer shows on a server already using Sync.
- Letters that dip below the line (g, p, y) are no longer cut off in the featured title on the home page.

## 3.5.2.3 - 2026-11-18

### Changed

- Search is faster. In the combined search, movies, series and people show as soon as they are found, and music, books and comics join the list when they arrive instead of holding up the page. A source that takes more than five seconds is left out of that search, and comic lookups are remembered for 15 minutes, so a search typed again answers almost at once.

## 3.5.2.2 - 2026-11-17

### Added

- With Talearr, an audiobook request can ask for the unabridged or the abridged reading as the only one or by preference (taking the other when none is found), or for both. The Audiobook Versions setting offers the same choices for every request, or lets the requester choose in the request window.

### Changed

- Author pages are more compact: the photo sits beside the name, a strip shows how many works are in the library or requested, Request All Books and the watch button share one row, the biography starts at three lines, links scroll sideways in one row, and works can be filtered (all, in library, not owned, requested) and sorted (popular, newest, oldest). A name too long for one line scrolls instead of wrapping.

## 3.5.2.1 - 2026-11-17

### Changed

- Updated to Seerr 3.5.2, including its security and bug fixes.
- Request edits for music, books and comics follow the stored request type, as movie and series requests do.

### Security

- Users with Manage Users can no longer change another admin's Allseerr settings: revoking an admin's personal API key, disconnecting their NoBookEnds devices, or making or resetting their reading app passwords now needs the owner or that admin.
- Updated Next.js to 16.4.6 for a published security advisory.

## 3.5.1.22 - 2026-11-14

### Fixed

- When Chaptarr holds the same book twice under one author, requests now use the entry that already has the file (or is already monitored) instead of an empty duplicate, so the book shows as available (#4).

## 3.5.1.21 - 2026-11-11

### Added

- A new Settings > Users option, Hide What Users Can't Request (off by default), hides the movie, series, music or book spaces and search results a user has no permission to request.

### Fixed

- The guided tour leaves out media types that are hidden from the user.

## 3.5.1.20 - 2026-11-08

### Fixed

- Books requested while Chaptarr was still importing the author are now linked by the recent scan instead of waiting for a full library scan.

## 3.5.1.19 - 2026-11-08

### Fixed

- Co-written books that OpenLibrary lists under the other author first now match the library.

## 3.5.1.18 - 2026-11-04

### Added

- A tip link on the About page.

### Changed

- Updated the Talearr description.

## 3.5.1.17 - 2026-11-04

### Fixed

- The Chaptarr library scan keeps using the page size that worked instead of timing out on every page, and its log counts books read rather than pages.

## 3.5.1.16 - 2026-11-04

### Fixed

- A stopped Chaptarr full library scan now keeps its progress on disk and resumes where it failed, asking for fewer books at a time on slow pages.
- Very large Chaptarr libraries (up to 500,000 books) fit in memory during a full scan.

## 3.5.1.15 - 2026-11-03

### Added

- A Settings > NoBookEnds Sync page that shows the connected Sync server and can set one up: it creates the read-only Audiobookshelf account and keys, and can install the container through the Docker socket.

### Fixed

- The installed Sync container is forgotten once another Sync server is connected.
- Oversized uploads to NoBookEnds Sync get a proper "too large" answer.
- The NoBookEnds Sync admin notice uses the Allseerr layout.
- Chaptarr library pages get more time during the full scan, and each page is logged.

## 3.5.1.14 - 2026-11-02

### Added

- Books added to Chaptarr or Talearr directly, without OpenLibrary ids, are now matched by the full scan and appear in Books > Library.
- The release picker marks releases that were grabbed before, lists them first and says what became of them.
- A Retry Import action on the Downloads page, and in NoBookEnds' attention list, for book downloads whose import is stuck.

### Changed

- The jobs list shows only the jobs in use and says what each one does (#2).
- The current season cleanup setting says plainly what it deletes (#2).

## 3.5.1.13 - 2026-11-01

### Changed

- The Chaptarr scan is split into a frequent recent scan (only books Allseerr is waiting on) and a daily full library scan, so large libraries finish (#2).
- The book scan job is called Talearr Scan when Talearr is the book service.

### Fixed

- A long Chaptarr or LazyLibrarian scan is no longer cut off by the next scheduled run (#2).
- A new artist added by an album request stays monitored in Lidarr (#1).

## 3.5.1.12 - 2026-11-01

### Added

- Tap the cover on a details page to see it full size.

## 3.5.1.11 - 2026-10-31

### Added

- Books in the library show their Audiobookshelf cover on cards and on the book page.

## 3.5.1.10 - 2026-10-28

### Added

- Watched state: each person's Plex, Jellyfin or Emby watch history is shown as an eye on cards and pages, titles can be marked watched or unwatched, and a user setting hides watched titles from Discover and search.
- Episode and season watched marks on series pages, in green for watched and orange for in progress.
- A notice when a person's Plex sign in has expired.

### Changed

- The Requests page uses the same layout as the Downloads page, with a sticky summary and layout switch.
- Request cards load smaller, card-sized posters and backdrops.

### Fixed

- Recent request cards all have the same height and art.
- Watched sync for shared Plex users uses the server token plex.tv lists for them, and gives up quietly on accounts plex.tv no longer knows.

## 3.5.1.9 - 2026-10-24

### Added

- A featured hero banner on the comics and manga page.

### Changed

- The reading app setup prompt keeps asking until the person ticks "don't show again".

### Fixed

- NoBookEnds signs in to the admin's own Kavita account without asking for a password.

## 3.5.1.8 - 2026-10-24

### Added

- Discover rows of trending manga and popular comics.
- A rich comic detail page from Talearr's series preview.
- Requests for single volumes of a comic or manga series, with volume details on tap.

### Fixed

- Unreleased volumes, a stray volume 0 and the format label on comic pages.
- Discover lists that Talearr cut short are asked for again soon.

## 3.5.1.7 - 2026-10-22

### Added

- Sign in with Plex from the NoBookEnds app without a popup or a server address.

### Fixed

- A Plex token that Plex refuses or cannot read is treated as a refused sign in.
- The stored Plex token is kept when NoBookEnds signs in.
- A connection keeps signing in when its own app account is renamed.

## 3.5.1.6 - 2026-10-22

### Added

- Comics and manga in the books space, with search and series requests sent to Talearr.
- A format icon on every card and in rows that mix kinds of titles.
- People can be linked to the reading app accounts they already have, and app usernames stay the same as their Plex username.

### Fixed

- Comic series that Talearr has some volumes of can be requested for the rest.
- Comic search ranks close matches first and drops duplicate series.
- OpenID Connect discovery gives the public address behind a reverse proxy.

## 3.5.1.5 - 2026-10-22

### Added

- People can set up their own reading apps, including after access is granted.

### Changed

- Unused reading apps are hidden.

### Security

- The key NoBookEnds signs in with is stored encrypted, and accounts people already had are never given new passwords by Allseerr.

## 3.5.1.4 - 2026-10-22

### Added

- A list layout for the Downloads queue and seeding views, and activity-panel style cards with covers, progress and time left.
- A slim sticky summary on the Downloads page that keeps the numbers and view switches in reach while scrolling.
- Seeding shows who requested each book, names seeding torrents that have no book, and explains filler torrents and seeding time left.
- An Allseerr placeholder when a poster is missing.

### Changed

- Public catalogs (TMDB, OpenLibrary, MusicBrainz, Audible and others) pause for a while after an outage and serve the last good answer, so pages no longer hang waiting on them.
- Book and album pages wait at most 1.5 seconds for data on the server before loading.
- The Plex device is named Allseerr.

### Fixed

- Downloads page layout on phones.
- Book covers on seeding cards.
- Padding around the favicon.

## 3.5.1.3 - 2026-10-21

### Added

- Default app access for everyone the Plex server is shared with: Audiobookshelf, Kavita and Komga with default libraries and an optional age limit.

## 3.5.1.2 - 2026-10-21

### Added

- User Access: manage Audiobookshelf, Kavita and Komga accounts from Allseerr, with a settings page.
- Invite links that grant apps when someone signs in with Plex.
- Sign in to other apps with Allseerr through OpenID Connect.
- Age-limited readers can't request books marked for adults, and their book requests always need approval.

### Security

- Sign in and tokens for an app stop as soon as a person's access to it is taken away.

## 3.5.1.1 - 2026-10-21

### Changed

- Updated to Seerr 3.5.1.

### Fixed

- Toasts stay below the iPhone notch.

## 3.5.0.2 - 2026-10-19

### Changed

- The app name, wordmark and Talearr labels use their final spelling.
- The Unraid template's support link points to the forum thread.

## 3.5.0.1 - 2026-10-19

First Allseerr release, based on Seerr 3.5.0. Allseerr keeps everything Seerr does and adds:

### Added

- Music: album, artist and discography requests through Lidarr, with metadata from MusicBrainz, Cover Art Archive, TheAudioDB and ListenBrainz, and availability from Lidarr and media server music libraries.
- Books and audiobooks: one title with ebook and audiobook formats, each with its own status, sent to Talearr, Chaptarr or LazyLibrarian, with per-language requests, download progress and admin release actions.
- Talearr as a book service, including its rejection labels in manual searches and requests for another recording of an audiobook (such as the abridged version).
- Audiobookshelf links that open the book itself, and author photos matched from Audiobookshelf.
- Ebook and audiobook existence checks through Google Books and Audible's public catalog.
- A Bazarr subtitles panel on movie and series pages.
- More request options: single-episode, future-seasons-only and current-season-only series requests, removal requests, decline with a reason, auto-approve rules, age rating limits and blocking titles on chosen streaming services.
- A For You home, a space each for movies, series, music and books, a release calendar, and following artists and authors for new releases.
- A weekly Recently Added newsletter, new episode notifications, and alerts for failing library scans and stuck book downloads.
- An admin Downloads page for every arr queue, with a seeding view.
- NoBookEnds support: a connect page, a key per connected device, book links, request management and NoBookEnds Sync queueing.
- Ambient, a redesigned interface (the default), alongside the classic interface, plus a guided tour for first-time users.
- Custom name, logo and accent color, personal API keys for every user, and a "works best with" card on the About page.
- Redesigned notification emails that follow the mail app's light or dark appearance.

### Fixed

- Chaptarr requests survive a busy Chaptarr and use the existing entry when Chaptarr has a book twice.
- Lidarr is asked to monitor new releases until the artist exists.
- The top bar stays below the status bar when added to the home screen.
