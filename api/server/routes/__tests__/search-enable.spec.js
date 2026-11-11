const express = require('express');
const request = require('supertest');

jest.mock('~/server/middleware/requireJwtAuth', () => (req, res, next) => next());

const searchRoute = require('../search');

/** The route only hands over to the binding; the table itself is tested in `packages/api`. */
describe('search status routes', () => {
  const appWith = (search) => {
    const app = express();
    if (search) {
      app.locals.search = search;
    }
    app.use('/api/search', searchRoute);
    return app;
  };

  describe('GET /api/search/enable', () => {
    it.each([true, false])('sends the binding’s answer %s as a bare boolean', async (answer) => {
      const enabled = jest.fn().mockResolvedValue(answer);
      const response = await request(appWith({ enabled })).get('/api/search/enable');

      expect(response.status).toBe(200);
      expect(response.body).toBe(answer);
      expect(enabled).toHaveBeenCalledTimes(1);
    });

    it('is false with no binding', async () => {
      const response = await request(appWith()).get('/api/search/enable');
      expect(response.body).toBe(false);
    });
  });

  describe('GET /api/search/meta', () => {
    it('sends the binding’s answer', async () => {
      const attribution = { text: 'text', url: 'https://example.com' };
      const meta = jest.fn().mockResolvedValue({ attribution });
      const response = await request(appWith({ meta })).get('/api/search/meta');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ attribution });
    });

    it('is {} by default', async () => {
      const meta = jest.fn().mockResolvedValue({});
      expect((await request(appWith({ meta })).get('/api/search/meta')).body).toEqual({});
      expect((await request(appWith()).get('/api/search/meta')).body).toEqual({});
    });
  });
});
