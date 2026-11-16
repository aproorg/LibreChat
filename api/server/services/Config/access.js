const { createAccessService } = require('@librechat/api');
const { getAppConfig } = require('./app');
const db = require('~/models');

const { getAccess, getAccessForUser } = createAccessService({
  getAppConfig,
  getUserGroups: (userId) => db.getUserGroups(userId),
  getUserEmail: async (userId) => (await db.getUserById(userId, 'email'))?.email,
});

module.exports = { getAccess, getAccessForUser };
