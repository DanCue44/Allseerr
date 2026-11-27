import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import express from 'express';
import * as OpenApiValidator from 'express-openapi-validator';
import path from 'path';
import request from 'supertest';

const API_SPEC_PATH = path.join(__dirname, '../seerr-api.yml');

// The validator compiles the whole spec on the first request, so a single
// invalid schema turns every API call into a 500
describe('seerr-api.yml', () => {
  it('compiles in the request validator', async () => {
    const app = express();
    app.use(express.json());
    app.use(
      OpenApiValidator.middleware({
        apiSpec: API_SPEC_PATH,
        validateRequests: true,
        // Sessions are not part of this test
        validateSecurity: false,
      })
    );
    app.get('/api/v1/status', (_req, res) => {
      res.status(200).json({ ok: true });
    });
    app.post('/api/v1/removal', (_req, res) => {
      res.status(201).json({ ok: true });
    });
    app.post('/api/v1/book/audiobook-availability', (_req, res) => {
      res.status(200).json({});
    });
    app.post('/api/v1/book/ebook-availability', (_req, res) => {
      res.status(200).json({});
    });
    app.get('/api/v1/book/:bookId/ebook', (_req, res) => {
      res.status(200).json({ exists: null });
    });
    app.post('/api/v1/settings/googlebooks/test', (_req, res) => {
      res.status(200).json({});
    });
    app.post('/api/v1/request/discography', (_req, res) => {
      res.status(201).json({ created: [], skipped: [], failed: [] });
    });
    app.post('/api/v1/request/author-catalog', (_req, res) => {
      res.status(201).json({ created: [], skipped: [], failed: [] });
    });
    app.get('/api/v1/artist/:artistId/discography', (_req, res) => {
      res.status(200).json({ releaseGroups: [] });
    });
    app.get('/api/v1/author/:authorId/catalog', (_req, res) => {
      res.status(200).json({ works: [] });
    });
    app.get('/api/v1/discover/music/hero', (_req, res) => {
      res.status(200).json({ results: [] });
    });
    app.get('/api/v1/discover/books/hero', (_req, res) => {
      res.status(200).json({ results: [], collage: [] });
    });
    app.post('/api/v1/settings/chaptarr', (_req, res) => {
      res.status(201).json({});
    });
    app.post('/api/v1/settings/chaptarr/test', (_req, res) => {
      res.status(200).json({});
    });
    app.post('/api/v1/settings/main', (_req, res) => {
      res.status(200).json({});
    });
    app.post('/api/v1/user/:userId/settings/tour', (_req, res) => {
      res.status(200).json({ tourVersion: 1 });
    });
    app.get('/api/v1/media/:mediaId/arr', (_req, res) => {
      res.status(200).json({});
    });
    app.get('/api/v1/media/:mediaId/arr/releases', (_req, res) => {
      res.status(200).json({ results: [] });
    });
    app.post('/api/v1/media/:mediaId/arr/search', (_req, res) => {
      res.status(200).json({});
    });
    app.post('/api/v1/media/:mediaId/arr/grab', (_req, res) => {
      res.status(200).json({});
    });
    app.post('/api/v1/media/:mediaId/arr/replace', (_req, res) => {
      res.status(200).json({});
    });
    app.post('/api/v1/settings/plex', (_req, res) => {
      res.status(200).json({});
    });
    app.get('/api/v1/settings/jobs/alerts', (_req, res) => {
      res.status(200).json([]);
    });
    app.get('/api/v1/settings/jobs', (_req, res) => {
      res.status(200).json([]);
    });
    app.get('/api/v1/discover/books/upcoming', (_req, res) => {
      res.status(200).json({ comingSoon: [], newReleases: [] });
    });
    app.get('/api/v1/discover/comics', (_req, res) => {
      res.status(200).json({ results: [] });
    });
    app.get('/api/v1/discover/comics/western', (_req, res) => {
      res.status(200).json({ results: [] });
    });
    app.get('/api/v1/media', (_req, res) => {
      res.status(200).json({ results: [] });
    });
    app.get('/api/v1/settings/audiobookshelf', (_req, res) => {
      res.status(200).json({});
    });
    app.post('/api/v1/settings/audiobookshelf', (_req, res) => {
      res.status(200).json({});
    });
    app.post('/api/v1/settings/audiobookshelf/test', (_req, res) => {
      res.status(200).json({});
    });
    app.post('/api/v1/settings/audiobookshelf/match-authors', (_req, res) => {
      res
        .status(200)
        .json({ total: 0, matched: 0, noPhoto: 0, failed: 0, done: true });
    });
    app.get('/api/v1/settings/nobookends-sync', (_req, res) => {
      res.status(200).json({});
    });
    app.post('/api/v1/settings/nobookends-sync', (_req, res) => {
      res.status(200).json({});
    });
    app.post('/api/v1/settings/nobookends-sync/test', (_req, res) => {
      res.status(200).json({});
    });
    app.post('/api/v1/settings/nobookends-sync/backfill', (_req, res) => {
      res.status(200).json({ total: 0, accepted: 0, rejected: 0, failed: 0 });
    });
    app.get('/api/v1/book/:bookId/recordings', (_req, res) => {
      res.status(200).json({ supported: false, reason: 'service' });
    });
    app.post('/api/v1/request', (_req, res) => {
      res.status(201).json({});
    });
    app.get('/api/v1/downloads/seeding', (_req, res) => {
      res.status(200).json({ supported: false });
    });
    app.get('/api/v1/nobookends/status', (_req, res) => {
      res.status(200).json({});
    });
    app.get('/api/v1/nobookends/item/:absItemId', (_req, res) => {
      res.status(200).json({});
    });
    app.get('/api/v1/user/:userId/settings/nobookends', (_req, res) => {
      res.status(200).json({ available: true, connected: false });
    });
    app.post('/api/v1/user/:userId/settings/nobookends', (_req, res) => {
      res.status(201).json({});
    });
    app.delete('/api/v1/user/:userId/settings/nobookends', (_req, res) => {
      res.status(204).send();
    });
    app.post('/api/v1/user/:userId/settings/main', (_req, res) => {
      res.status(200).json({});
    });
    app.use(
      (
        err: { status?: number; message?: string },
        _req: express.Request,
        res: express.Response,
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        _next: express.NextFunction
      ) => {
        res.status(err.status ?? 500).json({ message: err.message });
      }
    );

    const status = await request(app).get('/api/v1/status');
    assert.strictEqual(status.status, 200, status.body.message);

    // The hostname may hold a full URL
    const plex = await request(app).post('/api/v1/settings/plex').send({
      ip: 'https://plex.example.com',
      port: 443,
      useSsl: true,
      webAppUrl: '',
    });
    assert.strictEqual(plex.status, 200, plex.body.message);

    const scanAlerts = await request(app).get('/api/v1/settings/jobs/alerts');
    assert.strictEqual(scanAlerts.status, 200, scanAlerts.body.message);

    const jobs = await request(app).get('/api/v1/settings/jobs');
    assert.strictEqual(jobs.status, 200, jobs.body.message);

    const removal = await request(app)
      .post('/api/v1/removal')
      .send({ mediaId: 1, reason: 'Finished it' });
    assert.strictEqual(removal.status, 201, removal.body.message);

    const invalid = await request(app).post('/api/v1/removal').send({});
    assert.strictEqual(invalid.status, 400);

    const recordings = await request(app).get(
      '/api/v1/book/OL45804W/recordings'
    );
    assert.strictEqual(recordings.status, 200, recordings.body.message);

    const seeding = await request(app).get('/api/v1/downloads/seeding');
    assert.strictEqual(seeding.status, 200, seeding.body.message);

    // Another recording of an audiobook is asked for on the request route
    const recordingRequest = await request(app).post('/api/v1/request').send({
      mediaType: 'book',
      mediaId: 'OL45804W',
      isAudiobook: true,
      recording: 'narrator',
      recordingNarrator: 'Scott Brick',
    });
    assert.strictEqual(
      recordingRequest.status,
      201,
      recordingRequest.body.message
    );

    const editionRequest = await request(app).post('/api/v1/request').send({
      mediaType: 'book',
      mediaId: 'OL45804W',
      isAudiobook: true,
      recording: 'edition',
      recordingEditionId: 28705,
    });
    assert.strictEqual(editionRequest.status, 201, editionRequest.body.message);

    const unknownRecording = await request(app)
      .post('/api/v1/request')
      .send({ mediaType: 'book', mediaId: 'OL45804W', recording: 'radio' });
    assert.strictEqual(unknownRecording.status, 400);

    const availability = await request(app)
      .post('/api/v1/book/audiobook-availability')
      .send({ books: [{ olId: 'OL45804W', title: 'Fantastic Mr Fox' }] });
    assert.strictEqual(availability.status, 200, availability.body.message);

    const tooMany = await request(app)
      .post('/api/v1/book/audiobook-availability')
      .send({
        books: Array.from({ length: 51 }, () => ({
          olId: 'OL45804W',
          title: 'Fantastic Mr Fox',
        })),
      });
    assert.strictEqual(tooMany.status, 400);

    const ebooks = await request(app)
      .post('/api/v1/book/ebook-availability')
      .send({
        books: [
          {
            olId: 'OL17930368W',
            title: 'Atomic Habits',
            author: 'James Clear',
          },
        ],
      });
    assert.strictEqual(ebooks.status, 200, ebooks.body.message);

    const tooManyEbooks = await request(app)
      .post('/api/v1/book/ebook-availability')
      .send({
        books: Array.from({ length: 51 }, () => ({
          olId: 'OL17930368W',
          title: 'Atomic Habits',
        })),
      });
    assert.strictEqual(tooManyEbooks.status, 400);

    const ebook = await request(app).get('/api/v1/book/OL17930368W/ebook');
    assert.strictEqual(ebook.status, 200, ebook.body.message);

    const googleBooksTest = await request(app)
      .post('/api/v1/settings/googlebooks/test')
      .send({ apiKey: 'key' });
    assert.strictEqual(
      googleBooksTest.status,
      200,
      googleBooksTest.body.message
    );

    const googleBooksKey = await request(app)
      .post('/api/v1/settings/main')
      .send({ googleBooksApiKey: 'key' });
    assert.strictEqual(googleBooksKey.status, 200, googleBooksKey.body.message);

    const tour = await request(app)
      .post('/api/v1/user/1/settings/tour')
      .send({ version: 1 });
    assert.strictEqual(tour.status, 200, tour.body.message);

    const badTour = await request(app)
      .post('/api/v1/user/1/settings/tour')
      .send({});
    assert.strictEqual(badTour.status, 400);

    const discography = await request(app)
      .post('/api/v1/request/discography')
      .send({
        artistId: 'a74b1b7f-71a5-4011-9441-d0b5e4122711',
        mbIds: ['1dc4c347-a1db-32aa-b14f-bc9cc507b843'],
        userId: null,
        monitorNewReleases: true,
      });
    assert.strictEqual(discography.status, 201, discography.body.message);

    const catalog = await request(app)
      .post('/api/v1/request/author-catalog')
      .send({ authorId: 'OL34184A', olIds: ['OL45804W'], format: 'both' });
    assert.strictEqual(catalog.status, 201, catalog.body.message);

    const badFormat = await request(app)
      .post('/api/v1/request/author-catalog')
      .send({ authorId: 'OL34184A', olIds: ['OL45804W'], format: 'paper' });
    assert.strictEqual(badFormat.status, 400);

    const artistDiscography = await request(app).get(
      '/api/v1/artist/a74b1b7f-71a5-4011-9441-d0b5e4122711/discography'
    );
    assert.strictEqual(
      artistDiscography.status,
      200,
      artistDiscography.body.message
    );

    const authorCatalog = await request(app).get(
      '/api/v1/author/OL34184A/catalog'
    );
    assert.strictEqual(authorCatalog.status, 200, authorCatalog.body.message);

    const musicHero = await request(app).get('/api/v1/discover/music/hero');
    assert.strictEqual(musicHero.status, 200, musicHero.body.message);

    const booksHero = await request(app).get('/api/v1/discover/books/hero');
    assert.strictEqual(booksHero.status, 200, booksHero.body.message);

    const chaptarr = await request(app).post('/api/v1/settings/chaptarr').send({
      name: 'Chaptarr',
      hostname: 'chaptarr',
      port: 8789,
      apiKey: 'key',
      useSsl: false,
      activeProfileId: 1,
      activeProfileName: 'E-Book',
      activeDirectory: '/ebooks',
      activeMetadataProfileId: 2,
      activeMetadataProfileName: 'Ebook Default',
      activeAudiobookProfileId: 2,
      activeAudiobookProfileName: 'Audiobook',
      activeAudiobookDirectory: '/audiobooks',
      activeAudiobookMetadataProfileId: 1,
      activeAudiobookMetadataProfileName: 'Audiobook Default',
      tags: [],
      isDefault: true,
      syncEnabled: true,
      preventSearch: false,
      tagRequests: false,
    });
    assert.strictEqual(chaptarr.status, 201, chaptarr.body.message);

    const chaptarrTest = await request(app)
      .post('/api/v1/settings/chaptarr/test')
      .send({ hostname: 'chaptarr', port: 8789, apiKey: 'key', useSsl: false });
    assert.strictEqual(chaptarrTest.status, 200, chaptarrTest.body.message);

    const bookService = await request(app)
      .post('/api/v1/settings/main')
      .send({ bookService: 'chaptarr' });
    assert.strictEqual(bookService.status, 200, bookService.body.message);

    const badBookService = await request(app)
      .post('/api/v1/settings/main')
      .send({ bookService: 'readarr' });
    assert.strictEqual(badBookService.status, 400);

    const arrItem = await request(app).get(
      '/api/v1/media/1/arr?is4k=true&seasonNumber=1&episodeNumber=2'
    );
    assert.strictEqual(arrItem.status, 200, arrItem.body.message);

    const releases = await request(app).get(
      '/api/v1/media/1/arr/releases?bookFormat=audiobook'
    );
    assert.strictEqual(releases.status, 200, releases.body.message);

    const badFormatReleases = await request(app).get(
      '/api/v1/media/1/arr/releases?bookFormat=paperback'
    );
    assert.strictEqual(badFormatReleases.status, 400);

    const arrSearch = await request(app)
      .post('/api/v1/media/1/arr/search')
      .send({ seasonNumber: 1, issueId: 3, resolveIssue: true });
    assert.strictEqual(arrSearch.status, 200, arrSearch.body.message);

    const grab = await request(app).post('/api/v1/media/1/arr/grab').send({
      guid: 'https://indexer/details/1',
      indexerId: 3,
      title: 'Movie.2020.1080p',
      replaced: true,
    });
    assert.strictEqual(grab.status, 200, grab.body.message);

    const grabWithoutGuid = await request(app)
      .post('/api/v1/media/1/arr/grab')
      .send({ indexerId: 3 });
    assert.strictEqual(grabWithoutGuid.status, 400);

    const replace = await request(app)
      .post('/api/v1/media/1/arr/replace')
      .send({ blocklist: true, search: 'interactive', bookFormat: 'ebook' });
    assert.strictEqual(replace.status, 200, replace.body.message);

    const badReplace = await request(app)
      .post('/api/v1/media/1/arr/replace')
      .send({ search: 'later' });
    assert.strictEqual(badReplace.status, 400);

    const upcomingBooks = await request(app).get(
      '/api/v1/discover/books/upcoming'
    );
    assert.strictEqual(upcomingBooks.status, 200, upcomingBooks.body.message);

    for (const route of [
      '/api/v1/discover/comics',
      '/api/v1/discover/comics/western',
    ]) {
      const comics = await request(app).get(route).query({ page: 2 });
      assert.strictEqual(comics.status, 200, comics.body.message);
    }

    const musicLibrary = await request(app).get('/api/v1/media').query({
      filter: 'allavailable',
      mediaType: 'music',
      sort: 'creator',
      sortDirection: 'desc',
      albumType: 'ep',
    });
    assert.strictEqual(musicLibrary.status, 200, musicLibrary.body.message);

    const bookLibrary = await request(app).get('/api/v1/media').query({
      filter: 'allavailable',
      mediaType: 'book',
      sort: 'releaseDate',
      format: 'audiobook',
    });
    assert.strictEqual(bookLibrary.status, 200, bookLibrary.body.message);

    const badBookFormat = await request(app)
      .get('/api/v1/media')
      .query({ mediaType: 'book', format: 'paper' });
    assert.strictEqual(badBookFormat.status, 400);

    const audiobookshelf = await request(app).get(
      '/api/v1/settings/audiobookshelf'
    );
    assert.strictEqual(audiobookshelf.status, 200, audiobookshelf.body.message);

    const saveAudiobookshelf = await request(app)
      .post('/api/v1/settings/audiobookshelf')
      .send({
        url: 'https://books.example.com',
        libraryId: '3f2b8c1e-6a4d-4e9b-8c7a-1d2e3f4a5b6c',
        apiKey: 'key',
      });
    assert.strictEqual(
      saveAudiobookshelf.status,
      200,
      saveAudiobookshelf.body.message
    );

    const testAudiobookshelf = await request(app)
      .post('/api/v1/settings/audiobookshelf/test')
      .send({ url: 'https://books.example.com' });
    assert.strictEqual(
      testAudiobookshelf.status,
      200,
      testAudiobookshelf.body.message
    );

    const hideNoBookEnds = await request(app)
      .post('/api/v1/settings/audiobookshelf')
      .send({ url: 'https://books.example.com', showNoBookEnds: false });
    assert.strictEqual(hideNoBookEnds.status, 200, hideNoBookEnds.body.message);

    const badShowNoBookEnds = await request(app)
      .post('/api/v1/settings/audiobookshelf')
      .send({ showNoBookEnds: 'sometimes' });
    assert.strictEqual(badShowNoBookEnds.status, 400);

    const authorMatchSettings = await request(app)
      .post('/api/v1/settings/audiobookshelf')
      .send({ adminApiKey: 'admin-key', authorMatchRegion: 'uk' });
    assert.strictEqual(
      authorMatchSettings.status,
      200,
      authorMatchSettings.body.message
    );

    const badMatchRegion = await request(app)
      .post('/api/v1/settings/audiobookshelf')
      .send({ authorMatchRegion: 'mars' });
    assert.strictEqual(badMatchRegion.status, 400);

    const matchAuthors = await request(app).post(
      '/api/v1/settings/audiobookshelf/match-authors'
    );
    assert.strictEqual(matchAuthors.status, 200, matchAuthors.body.message);

    const nobookendsStatus = await request(app).get(
      '/api/v1/nobookends/status'
    );
    assert.strictEqual(
      nobookendsStatus.status,
      200,
      nobookendsStatus.body.message
    );

    const nobookendsItem = await request(app)
      .get('/api/v1/nobookends/item/li_8a3k2m9x4q7w1p5z')
      .query({ title: 'Fantastic Mr Fox', author: 'Roald Dahl' });
    assert.strictEqual(nobookendsItem.status, 200, nobookendsItem.body.message);

    const nobookendsConnection = await request(app).get(
      '/api/v1/user/1/settings/nobookends'
    );
    assert.strictEqual(
      nobookendsConnection.status,
      200,
      nobookendsConnection.body.message
    );

    const nobookendsConnect = await request(app).post(
      '/api/v1/user/1/settings/nobookends'
    );
    assert.strictEqual(
      nobookendsConnect.status,
      201,
      nobookendsConnect.body.message
    );

    const nobookendsDisconnect = await request(app).delete(
      '/api/v1/user/1/settings/nobookends'
    );
    assert.strictEqual(nobookendsDisconnect.status, 204);

    const getSync = await request(app).get('/api/v1/settings/nobookends-sync');
    assert.strictEqual(getSync.status, 200, getSync.body.message);

    const saveSync = await request(app)
      .post('/api/v1/settings/nobookends-sync')
      .send({
        enabled: true,
        url: 'https://sync.example.com',
        internalUrl: 'http://192.168.1.20:8000',
        adminToken: 'token',
      });
    assert.strictEqual(saveSync.status, 200, saveSync.body.message);

    const badSync = await request(app)
      .post('/api/v1/settings/nobookends-sync')
      .send({ enabled: 'yes' });
    assert.strictEqual(badSync.status, 400);

    const testSync = await request(app)
      .post('/api/v1/settings/nobookends-sync/test')
      .send({ url: 'https://sync.example.com' });
    assert.strictEqual(testSync.status, 200, testSync.body.message);

    const backfillSync = await request(app).post(
      '/api/v1/settings/nobookends-sync/backfill'
    );
    assert.strictEqual(backfillSync.status, 200, backfillSync.body.message);

    // GET returns null genre blocks for users who follow the server's list, and
    // the same body has to save back
    const followsServerGenres = await request(app)
      .post('/api/v1/user/1/settings/main')
      .send({ username: 'demo', accentColor: '#018E11', blockedGenres: null });
    assert.strictEqual(
      followsServerGenres.status,
      200,
      followsServerGenres.body.message
    );

    const ownGenres = await request(app)
      .post('/api/v1/user/1/settings/main')
      .send({ username: 'demo', blockedGenres: { movie: '27', book: '' } });
    assert.strictEqual(ownGenres.status, 200, ownGenres.body.message);

    const badGenres = await request(app)
      .post('/api/v1/user/1/settings/main')
      .send({ username: 'demo', blockedGenres: 'horror' });
    assert.strictEqual(badGenres.status, 400);

    const testWithoutUrl = await request(app)
      .post('/api/v1/settings/audiobookshelf/test')
      .send({ apiKey: 'key' });
    assert.strictEqual(testWithoutUrl.status, 400);
  });
});
