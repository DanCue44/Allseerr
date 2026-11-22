import type { User } from '@server/entity/User';
import { defineMessages, getIntl } from '@server/i18n';
import recentlyAddedNewsletter from '@server/job/newsletter';
import { scheduledJobs } from '@server/job/schedule';
import { getNewsletterSchedule } from '@server/lib/newsletter';
import { Notification } from '@server/lib/notifications';
import type { NotificationAgent } from '@server/lib/notifications/agents/agent';
import DiscordAgent from '@server/lib/notifications/agents/discord';
import EmailAgent from '@server/lib/notifications/agents/email';
import GotifyAgent from '@server/lib/notifications/agents/gotify';
import NtfyAgent from '@server/lib/notifications/agents/ntfy';
import PushbulletAgent from '@server/lib/notifications/agents/pushbullet';
import PushoverAgent from '@server/lib/notifications/agents/pushover';
import SlackAgent from '@server/lib/notifications/agents/slack';
import TelegramAgent from '@server/lib/notifications/agents/telegram';
import WebhookAgent from '@server/lib/notifications/agents/webhook';
import WebPushAgent from '@server/lib/notifications/agents/webpush';
import type {
  NotificationAgentWebhook,
  WebhookInstance,
} from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import type { AvailableLocale } from '@server/types/languages';
import { Router } from 'express';
import { omit } from 'lodash';
import { rescheduleJob } from 'node-schedule';

const notificationRoutes = Router();

const messages = defineMessages('notifications.test', {
  subject: 'Test Notification',
  message: 'Check check, 1, 2, 3. Are we coming in clear?',
});

const sendTestNotification = async (agent: NotificationAgent, user: User) => {
  const intl = getIntl(user.settings?.locale as AvailableLocale);

  return await agent.send(Notification.TEST_NOTIFICATION, {
    notifySystem: true,
    notifyAdmin: false,
    notifyUser: user,
    subject: intl.formatMessage(messages.subject),
    message: intl.formatMessage(messages.message),
  });
};

notificationRoutes.get('/discord', (_req, res) => {
  const settings = getSettings();

  res.status(200).json(settings.notifications.agents.discord);
});

notificationRoutes.post('/discord', async (req, res) => {
  const settings = getSettings();

  settings.notifications.agents.discord = req.body;
  await settings.save();

  res.status(200).json(settings.notifications.agents.discord);
});

notificationRoutes.post('/discord/test', async (req, res, next) => {
  if (!req.user) {
    return next({
      status: 500,
      message: 'User information is missing from the request.',
    });
  }

  const discordAgent = new DiscordAgent(req.body);
  if (await sendTestNotification(discordAgent, req.user)) {
    return res.status(204).send();
  } else {
    return next({
      status: 500,
      message: 'Failed to send Discord notification.',
    });
  }
});

notificationRoutes.get('/slack', (_req, res) => {
  const settings = getSettings();

  res.status(200).json(settings.notifications.agents.slack);
});

notificationRoutes.post('/slack', async (req, res) => {
  const settings = getSettings();

  settings.notifications.agents.slack = req.body;
  await settings.save();

  res.status(200).json(settings.notifications.agents.slack);
});

notificationRoutes.post('/slack/test', async (req, res, next) => {
  if (!req.user) {
    return next({
      status: 500,
      message: 'User information is missing from the request.',
    });
  }

  const slackAgent = new SlackAgent(req.body);
  if (await sendTestNotification(slackAgent, req.user)) {
    return res.status(204).send();
  } else {
    return next({
      status: 500,
      message: 'Failed to send Slack notification.',
    });
  }
});

notificationRoutes.get('/telegram', (_req, res) => {
  const settings = getSettings();

  res.status(200).json(settings.notifications.agents.telegram);
});

notificationRoutes.post('/telegram', async (req, res) => {
  const settings = getSettings();

  settings.notifications.agents.telegram = req.body;
  await settings.save();

  res.status(200).json(settings.notifications.agents.telegram);
});

notificationRoutes.post('/telegram/test', async (req, res, next) => {
  if (!req.user) {
    return next({
      status: 500,
      message: 'User information is missing from the request.',
    });
  }

  const telegramAgent = new TelegramAgent(req.body);
  if (await sendTestNotification(telegramAgent, req.user)) {
    return res.status(204).send();
  } else {
    return next({
      status: 500,
      message: 'Failed to send Telegram notification.',
    });
  }
});

notificationRoutes.get('/pushbullet', (_req, res) => {
  const settings = getSettings();

  res.status(200).json(settings.notifications.agents.pushbullet);
});

notificationRoutes.post('/pushbullet', async (req, res) => {
  const settings = getSettings();

  settings.notifications.agents.pushbullet = req.body;
  await settings.save();

  res.status(200).json(settings.notifications.agents.pushbullet);
});

notificationRoutes.post('/pushbullet/test', async (req, res, next) => {
  if (!req.user) {
    return next({
      status: 500,
      message: 'User information is missing from the request.',
    });
  }

  const pushbulletAgent = new PushbulletAgent(req.body);
  if (await sendTestNotification(pushbulletAgent, req.user)) {
    return res.status(204).send();
  } else {
    return next({
      status: 500,
      message: 'Failed to send Pushbullet notification.',
    });
  }
});

notificationRoutes.get('/pushover', (_req, res) => {
  const settings = getSettings();

  res.status(200).json(settings.notifications.agents.pushover);
});

notificationRoutes.post('/pushover', async (req, res) => {
  const settings = getSettings();

  settings.notifications.agents.pushover = req.body;
  await settings.save();

  res.status(200).json(settings.notifications.agents.pushover);
});

notificationRoutes.post('/pushover/test', async (req, res, next) => {
  if (!req.user) {
    return next({
      status: 500,
      message: 'User information is missing from the request.',
    });
  }

  const pushoverAgent = new PushoverAgent(req.body);
  if (await sendTestNotification(pushoverAgent, req.user)) {
    return res.status(204).send();
  } else {
    return next({
      status: 500,
      message: 'Failed to send Pushover notification.',
    });
  }
});

notificationRoutes.get('/email', (_req, res) => {
  const settings = getSettings();

  res.status(200).json(settings.notifications.agents.email);
});

notificationRoutes.post('/email', async (req, res) => {
  const settings = getSettings();

  settings.notifications.agents.email = req.body;

  // Keep the newsletter job in sync with the configured day and hour
  const newsletterSchedule = getNewsletterSchedule(
    req.body.options?.newsletterDay,
    req.body.options?.newsletterHour
  );
  const newsletterJob = scheduledJobs.find(
    (job) => job.id === 'recently-added-newsletter'
  );

  if (newsletterJob && rescheduleJob(newsletterJob.job, newsletterSchedule)) {
    newsletterJob.cronSchedule = newsletterSchedule;
  }

  settings.jobs['recently-added-newsletter'].schedule = newsletterSchedule;
  await settings.save();

  res.status(200).json(settings.notifications.agents.email);
});

notificationRoutes.post('/email/test', async (req, res, next) => {
  if (!req.user) {
    return next({
      status: 500,
      message: 'User information is missing from the request.',
    });
  }

  const emailAgent = new EmailAgent(req.body);
  if (await sendTestNotification(emailAgent, req.user)) {
    return res.status(204).send();
  } else {
    return next({
      status: 500,
      message: 'Failed to send email notification.',
    });
  }
});

notificationRoutes.post('/email/newsletter/test', async (req, res, next) => {
  if (!req.user) {
    return next({
      status: 500,
      message: 'User information is missing from the request.',
    });
  }

  if (!new EmailAgent().shouldSend()) {
    return next({
      status: 400,
      message: 'The email agent is not enabled.',
    });
  }

  if (await recentlyAddedNewsletter.sendTest(req.user)) {
    return res.status(204).send();
  } else {
    return next({
      status: 500,
      message: 'Failed to send newsletter.',
    });
  }
});

notificationRoutes.get('/webpush', (_req, res) => {
  const settings = getSettings();

  res.status(200).json(settings.notifications.agents.webpush);
});

notificationRoutes.post('/webpush', async (req, res) => {
  const settings = getSettings();

  settings.notifications.agents.webpush = req.body;
  await settings.save();

  res.status(200).json(settings.notifications.agents.webpush);
});

notificationRoutes.post('/webpush/test', async (req, res, next) => {
  if (!req.user) {
    return next({
      status: 500,
      message: 'User information is missing from the request.',
    });
  }

  const webpushAgent = new WebPushAgent(req.body);
  if (await sendTestNotification(webpushAgent, req.user)) {
    return res.status(204).send();
  } else {
    return next({
      status: 500,
      message: 'Failed to send web push notification.',
    });
  }
});

type WebhookBody = {
  name?: string;
  enabled?: boolean;
  embedPoster?: boolean;
  types?: number;
  options?: {
    webhookUrl?: string;
    jsonPayload?: string;
    authHeader?: string;
    customHeaders?: { key: string; value: string }[];
    supportVariables?: boolean;
  };
};

/**
 * Webhook settings as stored, from a request body. The payload comes in as
 * JSON text and is stored base64 encoded; it throws when it is not JSON.
 */
const webhookFromBody = (body: WebhookBody): NotificationAgentWebhook => {
  JSON.parse(body.options?.jsonPayload ?? '');

  return {
    enabled: !!body.enabled,
    embedPoster: !!body.embedPoster,
    types: body.types,
    options: {
      jsonPayload: Buffer.from(
        JSON.stringify(body.options?.jsonPayload)
      ).toString('base64'),
      webhookUrl: body.options?.webhookUrl ?? '',
      authHeader: body.options?.authHeader,
      customHeaders: body.options?.customHeaders ?? [],
      supportVariables: body.options?.supportVariables ?? false,
    },
  };
};

/**
 * Webhook settings as the settings page reads them, with the payload as
 * JSON text
 */
const webhookResponse = <T extends NotificationAgentWebhook>(
  webhook: T
): T => ({
  ...webhook,
  options: {
    ...webhook.options,
    jsonPayload: JSON.parse(
      Buffer.from(webhook.options.jsonPayload, 'base64').toString('utf8')
    ),
    customHeaders: webhook.options.customHeaders ?? [],
    supportVariables: webhook.options.supportVariables ?? false,
  },
});

// The first webhook keeps living in agents.webhook, so it has id 0
const FIRST_WEBHOOK_ID = 0;

const listWebhooks = (): WebhookInstance[] => {
  const { agents, webhooks } = getSettings().notifications;

  return [
    {
      ...agents.webhook,
      id: FIRST_WEBHOOK_ID,
      name: agents.webhook.name || 'Webhook',
    },
    ...(webhooks ?? []),
  ];
};

notificationRoutes.get('/webhook', (_req, res) => {
  const settings = getSettings();
  // The first webhook's name is only part of the list of webhooks
  res
    .status(200)
    .json(webhookResponse(omit(settings.notifications.agents.webhook, 'name')));
});

notificationRoutes.post('/webhook', async (req, res, next) => {
  const settings = getSettings();
  try {
    const name = settings.notifications.agents.webhook.name;

    settings.notifications.agents.webhook = {
      ...webhookFromBody(req.body),
      ...(name ? { name } : {}),
    };
    await settings.save();

    res.status(200).json(omit(settings.notifications.agents.webhook, 'name'));
  } catch (e) {
    next({ status: 500, message: e.message });
  }
});

notificationRoutes.post('/webhook/test', async (req, res, next) => {
  if (!req.user) {
    return next({
      status: 500,
      message: 'User information is missing from the request.',
    });
  }

  try {
    const webhookAgent = new WebhookAgent({
      ...webhookFromBody(req.body),
      enabled: req.body.enabled,
    });
    if (await sendTestNotification(webhookAgent, req.user)) {
      return res.status(204).send();
    } else {
      return next({
        status: 500,
        message: 'Failed to send webhook notification.',
      });
    }
  } catch (e) {
    next({ status: 500, message: e.message });
  }
});

notificationRoutes.get('/webhooks', (_req, res) => {
  res.status(200).json(listWebhooks().map(webhookResponse));
});

notificationRoutes.post('/webhooks', async (req, res, next) => {
  const settings = getSettings();

  try {
    const webhooks = settings.notifications.webhooks ?? [];
    const id =
      Math.max(FIRST_WEBHOOK_ID, ...webhooks.map((webhook) => webhook.id)) + 1;
    const webhook: WebhookInstance = {
      ...webhookFromBody(req.body),
      id,
      name: req.body.name?.trim() || `Webhook ${webhooks.length + 2}`,
    };

    settings.notifications.webhooks = [...webhooks, webhook];
    await settings.save();

    res.status(201).json(webhookResponse(webhook));
  } catch (e) {
    next({ status: 400, message: e.message });
  }
});

notificationRoutes.get<{ id: string }>('/webhooks/:id', (req, res, next) => {
  const webhook = listWebhooks().find(
    (webhook) => webhook.id === Number(req.params.id)
  );

  if (!webhook) {
    return next({ status: 404, message: 'Webhook not found.' });
  }

  res.status(200).json(webhookResponse(webhook));
});

notificationRoutes.post<{ id: string }>(
  '/webhooks/:id',
  async (req, res, next) => {
    const settings = getSettings();
    const id = Number(req.params.id);

    try {
      const updated = webhookFromBody(req.body);
      const name: string | undefined = req.body.name?.trim() || undefined;

      if (id === FIRST_WEBHOOK_ID) {
        settings.notifications.agents.webhook = {
          ...updated,
          ...(name ? { name } : {}),
        };
      } else {
        const webhooks = settings.notifications.webhooks ?? [];
        const current = webhooks.find((webhook) => webhook.id === id);

        if (!current) {
          return next({ status: 404, message: 'Webhook not found.' });
        }

        settings.notifications.webhooks = webhooks.map((webhook) =>
          webhook.id === id
            ? { ...updated, id, name: name ?? current.name }
            : webhook
        );
      }

      await settings.save();

      const webhook = listWebhooks().find((webhook) => webhook.id === id);
      res.status(200).json(webhook && webhookResponse(webhook));
    } catch (e) {
      next({ status: 400, message: e.message });
    }
  }
);

notificationRoutes.delete<{ id: string }>(
  '/webhooks/:id',
  async (req, res, next) => {
    const settings = getSettings();
    const id = Number(req.params.id);

    if (id === FIRST_WEBHOOK_ID) {
      return next({
        status: 400,
        message: 'The first webhook can be turned off but not removed.',
      });
    }

    const webhooks = settings.notifications.webhooks ?? [];

    if (!webhooks.some((webhook) => webhook.id === id)) {
      return next({ status: 404, message: 'Webhook not found.' });
    }

    settings.notifications.webhooks = webhooks.filter(
      (webhook) => webhook.id !== id
    );
    await settings.save();

    res.status(204).send();
  }
);

notificationRoutes.get('/gotify', (_req, res) => {
  const settings = getSettings();

  res.status(200).json(settings.notifications.agents.gotify);
});

notificationRoutes.post('/gotify', async (req, res) => {
  const settings = getSettings();

  settings.notifications.agents.gotify = req.body;
  await settings.save();

  res.status(200).json(settings.notifications.agents.gotify);
});

notificationRoutes.post('/gotify/test', async (req, res, next) => {
  if (!req.user) {
    return next({
      status: 500,
      message: 'User information is missing from the request.',
    });
  }

  const gotifyAgent = new GotifyAgent(req.body);
  if (await sendTestNotification(gotifyAgent, req.user)) {
    return res.status(204).send();
  } else {
    return next({
      status: 500,
      message: 'Failed to send Gotify notification.',
    });
  }
});

notificationRoutes.get('/ntfy', (_req, res) => {
  const settings = getSettings();

  res.status(200).json(settings.notifications.agents.ntfy);
});

notificationRoutes.post('/ntfy', async (req, res) => {
  const settings = getSettings();

  settings.notifications.agents.ntfy = req.body;
  await settings.save();

  res.status(200).json(settings.notifications.agents.ntfy);
});

notificationRoutes.post('/ntfy/test', async (req, res, next) => {
  if (!req.user) {
    return next({
      status: 500,
      message: 'User information is missing from the request.',
    });
  }

  const ntfyAgent = new NtfyAgent(req.body);
  if (await sendTestNotification(ntfyAgent, req.user)) {
    return res.status(204).send();
  } else {
    return next({
      status: 500,
      message: 'Failed to send ntfy notification.',
    });
  }
});

export default notificationRoutes;
