const express = require('express');
const requireJwtAuth = require('~/server/middleware/requireJwtAuth');

const router = express.Router();

router.use(requireJwtAuth);

router.get('/enable', async function (req, res) {
  res.send((await req.app.locals.search?.enabled()) ?? false);
});

router.get('/meta', async function (req, res) {
  res.json((await req.app.locals.search?.meta()) ?? {});
});

module.exports = router;
