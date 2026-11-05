const path = require('path');
const mongoose = require('mongoose');
const { User } = require('@librechat/data-schemas').createModels(mongoose);
require('module-alias')({ base: path.resolve(__dirname, '..', 'api') });
const { askQuestion, silentExit } = require('./helpers');
const connect = require('./connect');

(async () => {
  await connect();

  console.purple('---------------------');
  console.purple('Unlink Agents API (remoteAgentOid) from user accounts!');
  console.purple('---------------------');

  const domainArg = process.argv.find((a) => a.startsWith('--all-for-domain='));
  const email = process.argv.slice(2).find((a) => !a.startsWith('--'));

  if (!domainArg && !email) {
    console.orange('Usage: npm run unlink-remote-agent <email>');
    console.orange('       npm run unlink-remote-agent -- --all-for-domain=<domain>');
    silentExit(1);
  }

  let filter;
  if (domainArg) {
    const domain = domainArg.split('=')[1].trim().toLowerCase();
    if (!domain || domain.includes('@')) {
      console.red('Error: Invalid domain!');
      silentExit(1);
    }
    const escaped = domain.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    filter = { remoteAgentOid: { $exists: true }, email: new RegExp(`@${escaped}$`, 'i') };
    const count = await User.countDocuments(filter);
    console.orange(`${count} linked user(s) at @${domain} will be unlinked.`);
    const confirm = await askQuestion(`Type the domain (${domain}) to confirm:`);
    if (confirm.trim().toLowerCase() !== domain) {
      console.red('Aborted: confirmation did not match.');
      silentExit(1);
    }
  } else {
    filter = { email: email.toLowerCase(), remoteAgentOid: { $exists: true } };
  }

  const users = await User.find(filter, 'email remoteAgentOid').lean();
  if (users.length === 0) {
    console.orange('No linked users matched; nothing changed.');
    silentExit(0);
  }
  await User.updateMany(
    { _id: { $in: users.map((u) => u._id) } },
    { $unset: { remoteAgentOid: '' } },
  );
  for (const u of users) {
    console.green(`Unlinked ${u.email} (was oid ${u.remoteAgentOid})`);
  }
  console.purple(
    `Unlinked ${users.length} user(s). Users re-link on their next Agents API call if still eligible.`,
  );
  silentExit(0);
})();

process.on('uncaughtException', (err) => {
  if (!err.message.includes('fetch failed')) {
    console.error('There was an uncaught error:');
    console.error(err);
  }

  if (err.message.includes('fetch failed')) {
    return;
  } else {
    process.exit(1);
  }
});
