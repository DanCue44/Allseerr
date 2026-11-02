---
title: General
description: Configure global and default settings for Allseerr.
sidebar_position: 1
---

# General

## API Key

This is your Allseerr API key, which can be used to integrate Allseerr with third-party applications. Do **not** share this key publicly, as it can be used to gain administrator access!

If you need to generate a new API key for any reason, simply click the button to the right of the text box.

If you want to set the API key, rather than letting it be randomly generated, you can use the API_KEY environment variable. Whatever that variable is set to will be your API key.

## Application Title, Logo and Accent Color

Give Allseerr your own name, a square logo and an accent color. See [Custom Branding](/using-seerr/features/custom-branding) for details, including why phones keep the old name and logo until the app is added to the home screen again.

## Application URL

Set this to the externally-accessible URL of your Allseerr instance.

You must configure this setting in order to enable password reset and generation emails.

## Enable Image Caching

When enabled, Allseerr will proxy and cache images from pre-configured sources (such as TMDB). This can use a significant amount of disk space.

Images are saved in the `config/cache/images` and stale images are cleared out every 24 hours.

You should enable this if you are having issues with loading images directly from TMDB in your browser.

## Display Language

Set the default display language for Allseerr. Users can override this setting in their user settings.

## Discover Region, Discover Language & Streaming Region

These settings filter content shown on the "Discover" home page based on regional availability and original language, respectively. The Streaming Region filters the available streaming providers on the media page. Users can override these global settings by configuring these same options in their user settings.

## Blocklist Region and Blocklist Language

These settings control the region and language used specifically for blocklist content scanning. The "Process Blocklisted Tags" job uses these settings to determine which content to scan for blocklisting, independent of the general Discover settings.

- **Blocklist Region**: The region used for blocklist content scanning. Leave empty to scan all regions.
- **Blocklist Language**: The language used for blocklist content scanning. Leave empty to scan all languages.

These settings are separate from the general "Discover Region" and "Discover Language" settings, allowing you to blocklist content from specific regions/languages regardless of what users see in their Discover pages.

## Blocklist Content with Tags and Limit Content Blocklisted per Tag

These settings blocklist any TV shows or movies that have one of the entered tags. The "Process Blocklisted Tags" job adds entries to the blocklist based on the configured blocklisted tags. If a blocklisted tag is removed, any media blocklisted under that tag will be removed from the blocklist when the "Process Blocklisted Tags" job runs.

The limit setting determines how many pages per tag the job will process, with each page containing 20 entries. The job cycles through all 16 available discovery sort options, querying the defined number of pages to blocklist media that is most likely to appear at the top of each sort. Higher limits will create a more accurate blocklist, but will require more storage.

Blocklisted tags are disabled until at least one tag is entered. These settings cannot be overridden in user settings.

## Hide Available Media

When enabled, media which is already available will not appear on the "Discover" home page, or in the "Recommended" or "Similar" categories or other links on media detail pages.

Available media will still appear in search results, however, so it is possible to locate and view hidden items by searching for them by title.

This setting is **disabled** by default.

## Hide Blocklisted Items

When enabled, media that has been blocklisted will not appear on the "Discover" home page, for all administrators. This can be useful to hide content that you don't want to see, such as content with specific tags or content that has been manually blocklisted when you have the "Manage Blocklist" permission.

This setting is **disabled** by default.

## Hide Requested Media

When enabled, media that has been requested (but not yet available) will not appear on the "Discover" home page, or in the "Recommended" or "Similar" categories or other links on media detail pages.

Requested media will still appear in search results, however, so it is possible to locate and view hidden items by searching for them by title.

This setting is **disabled** by default.

## Allow Partial Series Requests

When enabled, users will be able to submit requests for specific seasons of TV series. If disabled, users will only be able to submit requests for all unavailable seasons.

This setting is **enabled** by default.

## Allow Users to Request Only the Current Season

Lets users request only the season of a series that is airing, with older seasons deleted as new ones start. **Current Season Cleanup: Days Before Older Seasons Are Deleted** sets how long admins have to keep them. It only affects series requested this way: seasons that were already in your library are never deleted unless an admin approves it, and nothing else in Sonarr is touched. See [Current Season Requests](/using-seerr/features/current-season-requests).

This setting is **disabled** by default.

## Block Requests for Streaming Services

Titles that are included with a subscription to one of the chosen services, in your **Streaming Region**, cannot be requested. Only subscription offers count, so titles that are free, for rent or for sale on a service are never blocked. Users with **Manage Requests** can still request blocked titles by hand, while Plex watchlist auto-requests for them are always skipped.

## Default Book Format

The format preselected when requesting a book: **Ebook**, **Audiobook** or **Both**. The default is **Both**.

## Book Language

The language books are requested in, unless a user picks their own in their profile. Managers can pick another one when requesting. See [Chaptarr](/using-seerr/services/chaptarr#language) for how the language is enforced.

## Google Books API Key

Optional. Used to check whether books have ebook editions. Without a key, ebook editions are not checked and Google is never contacted. See [Google Books API Key](/using-seerr/services/google-books).

## Version Check

When enabled, Allseerr checks GitHub for new versions and tells admins when an update is available. See [Update Channels](/getting-started/update-channels).

This setting is **enabled** by default.
