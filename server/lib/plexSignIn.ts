import PlexTvAPI from '@server/api/plextv';
import { MediaServerType } from '@server/constants/server';
import { UserType } from '@server/constants/user';
import { getRepository } from '@server/datasource';
import { User } from '@server/entity/User';
import { startJobs } from '@server/job/schedule';
import { Permission } from '@server/lib/permissions';
import { getSettings } from '@server/lib/settings';
import {
  findValidInvite,
  hasRedeemedInvite,
} from '@server/lib/userAccess/invites';
import { grantPlexDefaults } from '@server/lib/userAccess/plexDefaults';
import logger from '@server/logger';

/**
 * Why a Plex account was not let in, with the status the API answers
 */
export class PlexSignInError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
  }
}

/**
 * Whether people sign in with Plex here: Plex is the media server and
 * media server sign in is on, or no media server is set up yet
 */
export const isPlexLoginEnabled = (): boolean => {
  const { main } = getSettings();

  return (
    main.mediaServerType === MediaServerType.NOT_CONFIGURED ||
    (main.mediaServerLogin !== false &&
      main.mediaServerType === MediaServerType.PLEX)
  );
};

/**
 * Finds or makes the user a Plex token signs in as. An existing user is
 * matched by Plex id or email. A new user gets in when they can use the
 * Plex server and new Plex users may sign in, or with an invite. The first
 * account ever becomes the admin, unless setup is not allowed.
 */
export const signInWithPlex = async ({
  authToken,
  inviteToken,
  ip,
  allowSetup = true,
  keepStoredToken = false,
}: {
  authToken: string;
  inviteToken?: string;
  ip?: string;
  // Lets the first account set Allseerr up as its admin
  allowSetup?: boolean;
  // Keeps the Plex token Allseerr already has for the user. A token made for
  // another app stops working when that device is removed in Plex, and the
  // admin's token is the one Allseerr reaches Plex with.
  keepStoredToken?: boolean;
}): Promise<User> => {
  const settings = getSettings();
  const userRepository = getRepository(User);

  // First we need to use this auth token to get the user's email from plex.tv
  const plextv = new PlexTvAPI(authToken);
  const account = await plextv.getUser().catch((e: Error) => {
    const status = (e.cause as { response?: { status?: number } })?.response
      ?.status;

    // Plex turned the token down, so the person signs in to Plex again
    if (status === 401 || status === 403 || status === 422) {
      throw new PlexSignInError(
        401,
        'Plex did not accept this sign in. Sign in with Plex again.'
      );
    }
    throw e;
  });

  // An invite lets a Plex account in that has no access to the server
  const invite = inviteToken ? await findValidInvite(inviteToken) : null;

  // Next let's see if the user already exists
  let user = await userRepository
    .createQueryBuilder('user')
    // Hidden by default, read to know whether one is stored
    .addSelect('user.plexToken')
    .where('user.plexId = :id', { id: account.id })
    .orWhere('user.email = :email', {
      email: account.email.toLowerCase(),
    })
    .getOne();

  if (!user && !(await userRepository.count())) {
    if (!allowSetup) {
      throw new PlexSignInError(403, 'Access denied.');
    }

    user = new User({
      email: account.email,
      plexUsername: account.username,
      plexId: account.id,
      plexToken: account.authToken,
      permissions: Permission.ADMIN,
      avatar: account.thumb,
      userType: UserType.PLEX,
    });

    settings.main.mediaServerType = MediaServerType.PLEX;
    await settings.save();
    startJobs();

    await userRepository.save(user);
    return user;
  }

  const mainUser = await userRepository.findOneOrFail({
    select: { id: true, plexToken: true, plexId: true, email: true },
    where: { id: 1 },
  });
  const mainPlexTv = new PlexTvAPI(mainUser.plexToken ?? '');

  if (!account.id) {
    logger.error('Plex ID was missing from Plex.tv response', {
      label: 'API',
      ip,
      email: account.email,
      plexUsername: account.username,
    });

    throw new PlexSignInError(500, 'Something went wrong. Try again.');
  }

  if (
    account.id === mainUser.plexId ||
    (account.email === mainUser.email && !mainUser.plexId) ||
    !!invite ||
    (!!user && (await hasRedeemedInvite(user.id))) ||
    (await mainPlexTv.checkUserAccess(account.id))
  ) {
    if (user) {
      if (!user.plexId) {
        logger.info('Found matching Plex user; updating user with Plex data', {
          label: 'API',
          ip,
          email: user.email,
          userId: user.id,
          plexId: account.id,
          plexUsername: account.username,
        });
      }

      if (!keepStoredToken || !user.plexToken) {
        user.plexToken = authToken;
        user.plexTokenInvalidAt = null;
      }
      user.plexId = account.id;
      user.avatar = account.thumb;
      user.email = account.email;
      user.plexUsername = account.username;
      user.userType = UserType.PLEX;

      await userRepository.save(user);
    } else if (!settings.main.newPlexLogin && !invite) {
      logger.warn(
        'Failed sign-in attempt by unimported Plex user with access to the media server',
        {
          label: 'API',
          ip,
          email: account.email,
          plexId: account.id,
          plexUsername: account.username,
        }
      );
      throw new PlexSignInError(403, 'Access denied.');
    } else {
      logger.info(
        'Sign-in attempt from Plex user with access to the media server; creating new Seerr user',
        {
          label: 'API',
          ip,
          email: account.email,
          plexId: account.id,
          plexUsername: account.username,
        }
      );
      user = new User({
        email: account.email,
        plexUsername: account.username,
        plexId: account.id,
        plexToken: account.authToken,
        permissions: settings.main.defaultPermissions,
        avatar: account.thumb,
        userType: UserType.PLEX,
      });

      await userRepository.save(user);
      await grantPlexDefaults(user.id);
    }
  } else {
    logger.warn(
      'Failed sign-in attempt by Plex user without access to the media server',
      {
        label: 'API',
        ip,
        email: account.email,
        plexId: account.id,
        plexUsername: account.username,
      }
    );
    throw new PlexSignInError(403, 'Access denied.');
  }

  return user;
};
