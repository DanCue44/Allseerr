import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';

import { createIntl } from '@formatjs/intl';
import {
  breakAutoLinks,
  formatEmailTimestamp,
  getEmailLayoutLocals,
  getGreetingName,
} from '@server/lib/email/format';
import Email from 'email-templates';

const intl = createIntl({
  locale: 'en',
  messages: {},
  defaultLocale: 'en',
  onError: () => undefined,
});

// ICU puts a narrow no-break space before AM/PM
const plain = (value: string) => value.replace(/[\u202f\u00a0]/g, ' ');

describe('formatEmailTimestamp', () => {
  it('formats a short date and time without a time zone name', () => {
    const date = new Date('2026-10-12T19:04:20Z');

    assert.equal(
      plain(formatEmailTimestamp(date, intl, 'America/New_York')),
      'Oct 12, 2026 at 3:04 PM'
    );
    assert.equal(
      plain(formatEmailTimestamp(date, intl, 'UTC')),
      'Oct 12, 2026 at 7:04 PM'
    );
  });

  it('follows the recipient language', () => {
    const de = createIntl({
      locale: 'de',
      messages: {},
      defaultLocale: 'en',
      onError: () => undefined,
    });
    const text = plain(
      formatEmailTimestamp(new Date('2026-10-12T19:04:20Z'), de, 'UTC')
    );

    assert.match(text, /12\. Okt\. 2026/);
    assert.match(text, /19:04/);
    assert.doesNotMatch(text, /GMT|UTC|PM/);
  });

  it('uses the server time zone when none is given', () => {
    const text = formatEmailTimestamp(new Date(), intl);

    assert.doesNotMatch(text, /GMT|Time\)/);
  });
});

describe('getGreetingName', () => {
  it('uses the display name', () => {
    assert.equal(getGreetingName('Robin', 'robin@example.com'), 'Robin');
    assert.equal(
      getGreetingName('  Alex Rivera  ', 'a@example.com'),
      'Alex Rivera'
    );
  });

  it('skips names that are only an email address', () => {
    assert.equal(
      getGreetingName('robin@example.com', 'robin@example.com'),
      undefined
    );
    assert.equal(
      getGreetingName('ROBIN@example.com', 'robin@example.com'),
      undefined
    );
    assert.equal(
      getGreetingName('other@example.com', 'robin@example.com'),
      undefined
    );
  });

  it('skips empty names', () => {
    assert.equal(getGreetingName(undefined, 'robin@example.com'), undefined);
    assert.equal(getGreetingName(null), undefined);
    assert.equal(getGreetingName('   '), undefined);
  });
});

describe('getEmailLayoutLocals', () => {
  it('greets by name and links to the notification settings', () => {
    const locals = getEmailLayoutLocals({
      intl,
      applicationTitle: 'Allseerr',
      applicationUrl: 'https://requests.example.com',
      recipientName: 'dan.c',
      recipientEmail: 'robin@example.com',
    });

    assert.equal(locals.greeting, `Hi ${breakAutoLinks('dan.c')},`);
    assert.equal(
      locals.manageNotificationsUrl,
      'https://requests.example.com/profile/settings/notifications/email'
    );
    assert.equal(locals.labels.viewInApp, 'View in Allseerr');
    assert.equal(locals.labels.sentBy, 'Sent by Allseerr');
  });

  it('falls back to a generic greeting and leaves out links without a URL', () => {
    const locals = getEmailLayoutLocals({
      intl,
      applicationTitle: 'Cue Media',
      applicationUrl: '',
      recipientName: 'robin@example.com',
      recipientEmail: 'robin@example.com',
    });

    assert.equal(locals.greeting, 'Hi there,');
    assert.equal(locals.manageNotificationsUrl, undefined);
    assert.equal(locals.labels.openApp, 'Open Cue Media');
  });

  it('can leave out the notification settings link', () => {
    const locals = getEmailLayoutLocals({
      intl,
      applicationTitle: 'Allseerr',
      applicationUrl: 'https://requests.example.com',
      manageNotifications: false,
    });

    assert.equal(locals.manageNotificationsUrl, undefined);
  });
});

describe('email templates', () => {
  const templates = path.join(__dirname, '../../templates/email');
  const email = new Email({
    send: false,
    preview: false,
    views: { options: { extension: 'pug' } },
  });
  const layout = getEmailLayoutLocals({
    intl,
    applicationTitle: 'Allseerr',
    applicationUrl: 'https://requests.example.com',
    recipientName: 'Robin',
    recipientEmail: 'robin@example.com',
  });
  const timestamp = formatEmailTimestamp(
    new Date('2026-10-12T19:04:20Z'),
    intl,
    'America/New_York'
  );

  it('renders a request with the details, timestamp and button', async () => {
    const html = await email.render(
      path.join(templates, 'media-request/html'),
      {
        ...layout,
        applicationTitle: 'Allseerr',
        applicationUrl: 'https://requests.example.com',
        body: 'Your request for the following movie was declined:',
        mediaName: 'Dune: Part Two',
        mediaExtra: [{ name: 'Reason', value: 'Already in 1080p' }],
        imageUrl: 'https://image.example.com/poster.jpg',
        timestamp,
        requestedBy: 'Robin',
        actionUrl: 'https://requests.example.com/movie/693134',
      }
    );

    assert.match(html, /Hi Robin,/);
    assert.match(html, /Oct 12, 2026 at 3:04/);
    assert.match(html, /Already in 1080p/);
    assert.match(html, /View in Allseerr/);
    assert.match(html, /bgcolor="#202124"/);
    assert.match(html, /bgcolor="#ec703e"/);
    assert.match(html, /profile\/settings\/notifications\/email/);
    assert.doesNotMatch(html, /\u2014/);
  });

  it('renders a request like the Pushover message, poster and all', async () => {
    const locals = {
      ...layout,
      applicationTitle: 'Allseerr',
      applicationUrl: 'https://requests.example.com',
      event: 'Movie Request Approved',
      body: 'Your request for the following movie has been approved:',
      mediaName: 'Dangerous Minds (1995)',
      mediaTitle: 'Dangerous Minds (1995)',
      overview: 'Former Marine Louanne Johnson lands a gig teaching.',
      mediaExtra: [],
      imageUrl: 'https://image.tmdb.org/t/p/w780/poster.jpg',
      timestamp,
      requestedBy: 'jsmith',
      status: { label: 'Processing', tone: 'blue' },
      actionUrl: 'https://requests.example.com/movie/9909',
    };
    const html = await email.render(
      path.join(templates, 'media-request/html'),
      locals
    );
    const text = await email.render(
      path.join(templates, 'media-request/text'),
      locals
    );

    assert.match(html, /Movie Request Approved/);
    assert.match(html, /Former Marine Louanne Johnson/);
    assert.match(html, /class="as-poster[^"]*" src="[^"]*w780\/poster\.jpg"/);
    assert.match(html, /alt="Dangerous Minds \(1995\)"/);
    assert.match(html, /class="as-pill-blue"[^>]*>Processing</);
    assert.match(html, /\.as-pill-blue \{ background-color: #dce8fb/);
    assert.match(text, /^Movie Request Approved\n/);
    assert.match(text, /Requested By: jsmith\nRequest Status: Processing/);
    assert.match(
      text,
      /View in Allseerr: https:\/\/requests\.example\.com\/movie\/9909/
    );
    assert.doesNotMatch(html + text, /\u2014/);
  });

  it('shows the requester once when the details already name them', async () => {
    const html = await email.render(
      path.join(templates, 'media-request/html'),
      {
        ...layout,
        applicationTitle: 'Allseerr',
        applicationUrl: '',
        body: 'Your request to remove the following book was approved:',
        mediaName: 'Dune by Frank Herbert (1965)',
        mediaTitle: 'Dune (1965)',
        mediaByline: 'by Frank Herbert',
        mediaExtra: [{ name: 'Requested By', value: 'Robin' }],
        requestedBy: 'Robin',
      }
    );

    assert.equal(html.match(/Requested By/g)?.length, 1);
    assert.match(html, /by Frank Herbert/);
    assert.doesNotMatch(html, /View in Allseerr/);
  });

  it('keeps the light mode media query and swaps the wordmark', async () => {
    const html = await email.render(path.join(templates, 'test-email/html'), {
      ...layout,
      applicationTitle: 'Allseerr',
      applicationUrl: 'https://requests.example.com',
      body: 'Test body',
      logoUrl: 'https://requests.example.com/logo_full.png',
      logoLightUrl: 'https://requests.example.com/logo_full_dark.png',
    });

    assert.match(html, /<meta name="color-scheme" content="light dark">/);
    assert.match(html, /@media \(prefers-color-scheme: light\)/);
    assert.match(
      html,
      /\.as-bg-ground \{ background-color: #f5f4f2 !important; \}/
    );
    // The dark look stays inline for mail apps without media queries
    assert.match(html, /<body class="as-bg-ground" bgcolor="#202124"/);
    assert.doesNotMatch(html, /100vh/);
    assert.match(html, /class="as-logo-dark[^"]*" src="[^"]*\/logo_full\.png"/);
    assert.match(
      html,
      /<!--\[if !mso\]><!-->\s*<div class="as-logo-light" style="display:none;[^"]*mso-hide:all;">\s*<img[^>]*src="[^"]*\/logo_full_dark\.png"/
    );
  });

  it('sends one wordmark when there is no light variant', async () => {
    const html = await email.render(path.join(templates, 'test-email/html'), {
      ...layout,
      applicationTitle: 'Allseerr',
      applicationUrl: 'https://requests.example.com',
      body: 'Test body',
      logoUrl: 'https://requests.example.com/logo.png',
    });

    assert.match(html, /src="https:\/\/requests\.example\.com\/logo\.png"/);
    assert.doesNotMatch(html, /class="as-logo-/);
  });

  it('renders every template', async () => {
    const base = {
      ...getEmailLayoutLocals({
        intl,
        applicationTitle: 'Allseerr',
        applicationUrl: '',
        recipientName: 'Robin',
      }),
      applicationTitle: 'Allseerr',
      applicationUrl: '',
    };
    const cases: [string, Record<string, unknown>][] = [
      [
        'media-issue',
        { body: 'b', mediaName: 'm', extra: [], issueComment: 'c' },
      ],
      [
        'newsletter',
        { body: 'b', movies: [], series: [], optOut: 'o', openIn: 'x' },
      ],
      ['generatedpassword', { password: 'secret-password' }],
      ['resetpassword', { resetPasswordLink: '/resetpassword/abc' }],
      ['plexsignin', { signInUrl: '/login' }],
      ['test-email', { body: 'Test body' }],
    ];

    for (const [template, locals] of cases) {
      const html = await email.render(path.join(templates, template, 'html'), {
        ...base,
        ...locals,
      });

      assert.match(html, /Hi Robin,/, template);
      assert.doesNotMatch(html, /settings\/notifications/, template);
    }
  });
});
