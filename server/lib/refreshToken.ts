import PlexTvAPI from '@server/api/plextv';
import { getRepository } from '@server/datasource';
import { User } from '@server/entity/User';
import { markPlexTokenInvalid } from '@server/lib/plexTokenHealth';
import logger from '@server/logger';

class RefreshToken {
  public async run() {
    const userRepository = getRepository(User);

    const users = await userRepository
      .createQueryBuilder('user')
      .addSelect('user.plexToken')
      .where("user.plexToken != ''")
      // An expired sign in is left alone until the person signs in again
      .andWhere('user.plexTokenInvalidAt IS NULL')
      .getMany();

    for (const user of users) {
      await this.refreshUserToken(user);
    }
  }

  private async refreshUserToken(user: User) {
    if (!user.plexToken) {
      logger.warn('Skipping user refresh token for user without plex token', {
        label: 'Plex Refresh Token',
        user: user.displayName,
      });
      return;
    }

    const plexTvApi = new PlexTvAPI(user.plexToken);
    if ((await plexTvApi.pingToken()) === 'invalid') {
      await markPlexTokenInvalid(user.id);
    }
  }
}

const refreshToken = new RefreshToken();

export default refreshToken;
