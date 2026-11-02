---
title: Current Season Requests
description: Request only the season that is airing, for talk shows and long running series.
sidebar_position: 5
---

# Current Season Requests

Some series, such as talk shows, news programs and soaps, have many seasons and nobody wants all of them. A **current season** request keeps only the season that is airing now and follows the series from season to season, deleting older seasons as new ones start.

Allseerr also supports two other partial requests in the series request dialog: **single episodes** (expand a season to pick episodes) and **only future seasons** (Sonarr monitors episodes that have not aired yet, without searching for old ones). Both need **Allow Partial Series Requests** to be enabled in **Settings &rarr; General**.

## Turning it on

In **Settings &rarr; General**:

- **Allow Users to Request Only the Current Season**: off by default. Admins can always make current season requests, even when it is off.
- **Current Season Cleanup: Days Before Older Seasons Are Deleted**: how long admins have to keep older seasons once a new season starts. The default is 3 days. Set it to 0 to delete them right away. It only affects series requested with Request Current Season; nothing else in Sonarr is touched.

Users then see **Request Current Season** in the request dialog of a series.

## What happens

1. Sonarr searches for the season that is airing and monitors new seasons.
2. When a newer season has an aired episode with a file, the Sonarr scan sees that the series has moved on.
3. Admins get a **Seasons Scheduled for Deletion** notice on the series page (and a notification, if that type is enabled). They can **Keep Seasons**, **Delete Now** or let the notice period run out.
4. After the notice period, the Sonarr scan unmonitors the older seasons the request brought in, deletes their files and marks them as deleted. The request moves on to the new season.

Some rules keep this safe:

- Specials (season 0) are never touched.
- Seasons that were already on the server before the request are kept, unless an admin approves deleting them too (**Delete All Older Seasons**).
- A series only rolls over when **every** active request for it is a current season request. If someone requested the full series, nothing is deleted.
