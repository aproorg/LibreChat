const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const User = require('~/models/User');

describe('User schema', () => {
  let mongoServer;

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    const mongoUri = mongoServer.getUri();
    await mongoose.connect(mongoUri);
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    await User.deleteMany({});
  });

  test('should have lastSelectedModel property', async () => {
    const email = 'bla+test@apro.is';
    await User.create({
      name: 'Test User',
      email: 'bla+test@apro.is',
    });

    const user = await User.findOne({ email: email });
    expect(user.lastSelectedModel).toBe('');
  });
});
