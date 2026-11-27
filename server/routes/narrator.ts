import { getNarratorDetails } from '@server/lib/narrators';
import logger from '@server/logger';
import { Router } from 'express';

const narratorRoutes = Router();

// Longer names are not narrator names
const MAX_NAME_LENGTH = 200;

/**
 * The audiobooks a narrator read, by name, grouped by author and series
 */
narratorRoutes.get('/', async (req, res, next) => {
  const name =
    typeof req.query.name === 'string' ? req.query.name.trim() : undefined;

  if (!name || name.length > MAX_NAME_LENGTH) {
    return next({ status: 400, message: 'A narrator name is required.' });
  }

  try {
    const narrator = await getNarratorDetails(name);

    if (!narrator) {
      return next({ status: 404, message: 'Narrator not found.' });
    }

    return res.status(200).json(narrator);
  } catch (e) {
    logger.debug('Something went wrong retrieving a narrator', {
      label: 'API',
      errorMessage: e.message,
      narrator: name,
    });
    return next({
      status: 500,
      message: 'Unable to retrieve narrator.',
    });
  }
});

export default narratorRoutes;
