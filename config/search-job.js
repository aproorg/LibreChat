const path = require('path');
require('module-alias')({ base: path.resolve(__dirname, '..', 'api') });
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });
/* An operator script against a live tenant: connecting must not build anything. */
process.env.MONGO_AUTO_INDEX = 'false';
process.env.MONGO_AUTO_CREATE = 'false';
require('~/db/models');
const { runSearchJobCommand } = require('@librechat/api');
const { silentExit } = require('./helpers');
const connect = require('./connect');
const methods = require('~/models');

(async () => {
  await connect();
  const code = await runSearchJobCommand({
    argv: process.argv.slice(2),
    methods,
    print: (line) => console.log(line),
    /* Only `drop` reads the config, and loading its service is slow, so `status` does not pay for it. */
    loadAppConfig: () => require('~/server/services/Config').getAppConfig({ baseOnly: true }),
  });
  silentExit(code);
})().catch((error) => {
  console.error('Search job command failed:', error?.message);
  silentExit(1);
});
