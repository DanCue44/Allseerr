import { getRepository } from '@server/datasource';
import { User } from '@server/entity/User';
import { getIntl } from '@server/i18n';
import { getEmailLogo } from '@server/lib/branding';
import PreparedEmail from '@server/lib/email';
import { getEmailLayoutLocals } from '@server/lib/email/format';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import type { AvailableLocale } from '@server/types/languages';
import path from 'path';

const LABEL = 'Plex Sign In';

/** plex.tv answers one of these when it no longer knows a token */
export const isPlexTokenRejection = (e: {
  response?: { status?: number };
}): boolean => e.response?.status === 401 || e.response?.status === 422;

/**
 * Emails the person that Allseerr can no longer reach Plex as them, with a
 * link to sign in again. Quiet when email is off or they have no address.
 */
const sendPlexSignInEmail = async (user: User): Promise<void> => {
  const settings = getSettings();
  const emailSettings = settings.notifications.agents.email;

  if (!emailSettings.enabled || !user.email || !user.email.includes('@')) {
    return;
  }

  const { applicationTitle, applicationUrl } = settings.main;
  const intl = getIntl(user.settings?.locale as AvailableLocale);

  try {
    const email = new PreparedEmail(emailSettings, user.settings?.pgpKey);
    await email.send({
      template: path.join(__dirname, '../templates/email/plexsignin'),
      message: { to: user.email },
      locals: {
        signInUrl: applicationUrl ? `${applicationUrl}/login` : undefined,
        applicationTitle,
        applicationUrl,
        ...getEmailLogo(),
        recipientName: user.displayName,
        recipientEmail: user.email,
        ...getEmailLayoutLocals({
          intl,
          applicationTitle,
          applicationUrl,
          recipientName: user.displayName,
          recipientEmail: user.email,
          manageNotifications: false,
        }),
      },
    });
  } catch (e) {
    logger.error('Failed to email a user about an expired Plex sign in', {
      label: LABEL,
      userId: user.id,
      errorMessage: (e as Error).message,
    });
  }
};

/**
 * Remembers that plex.tv no longer accepts the person's token, the first
 * time any job notices, and asks them by email to sign in with Plex again.
 * The jobs leave the account alone until a fresh sign in clears the mark,
 * and the person sees a banner in the app until then.
 */
export const markPlexTokenInvalid = async (userId: number): Promise<void> => {
  const repository = getRepository(User);
  const user = await repository.findOne({ where: { id: userId } });

  if (!user || user.plexTokenInvalidAt) {
    return;
  }

  user.plexTokenInvalidAt = new Date();
  await repository.save(user);

  logger.info(
    'A Plex sign in has expired; the user was asked to sign in again',
    {
      label: LABEL,
      userId: user.id,
      user: user.displayName,
    }
  );

  await sendPlexSignInEmail(user);
};

/** The same for a token seen on its own, as the watchlist reader has it */
export const markPlexTokenInvalidByToken = async (
  plexToken: string
): Promise<void> => {
  if (!plexToken) {
    return;
  }

  const user = await getRepository(User)
    .createQueryBuilder('user')
    .select('user.id')
    .where('user.plexToken = :plexToken', { plexToken })
    .getOne();

  if (user) {
    await markPlexTokenInvalid(user.id);
  }
};
