const express = require('express');
const request = require('supertest');

const mockHealth = jest.fn();

jest.mock('meilisearch', () => ({
  MeiliSearch: jest.fn(() => ({ health: mockHealth })),
}));
jest.mock('~/server/middleware/requireJwtAuth', () => (req, res, next) => next());

const searchRoute = require('../search');

describe('GET /api/search/enable', () => {
  const appWith = (search) => {
    const app = express();
    if (search) {
      app.locals.search = search;
    }
    app.use('/api/search', searchRoute);
    return app;
  };

  const previousSearch = process.env.SEARCH;

  beforeEach(() => {
    process.env.SEARCH = 'true';
    mockHealth.mockResolvedValue({ status: 'available' });
  });

  afterAll(() => {
    process.env.SEARCH = previousSearch;
  });

  it('keeps today’s check with no binding', async () => {
    const response = await request(appWith()).get('/api/search/enable');
    expect(response.body).toBe(true);
    expect(mockHealth).toHaveBeenCalledTimes(1);
  });

  it('keeps today’s check when the service leaves it to Meilisearch', async () => {
    const enabled = jest.fn().mockResolvedValue(null);
    const response = await request(appWith({ enabled })).get('/api/search/enable');
    expect(response.body).toBe(true);
    expect(mockHealth).toHaveBeenCalledTimes(1);
  });

  it('answers the search row on the new backend, without asking Meilisearch', async () => {
    const enabled = jest.fn().mockResolvedValue(false);
    const response = await request(appWith({ enabled })).get('/api/search/enable');
    expect(response.body).toBe(false);
    expect(mockHealth).not.toHaveBeenCalled();
  });

  it('stays off with SEARCH off, reading nothing', async () => {
    process.env.SEARCH = 'false';
    const enabled = jest.fn();
    const response = await request(appWith({ enabled })).get('/api/search/enable');
    expect(response.body).toBe(false);
    expect(enabled).not.toHaveBeenCalled();
  });
});
