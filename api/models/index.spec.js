const mockCreateMethods = jest.fn(() => ({ initializeRoles: jest.fn() }));

jest.mock('@librechat/data-schemas', () => ({
  createMethods: (...args) => mockCreateMethods(...args),
}));
jest.mock('@librechat/api', () => ({
  matchModelName: jest.fn(),
  findMatchingPattern: jest.fn(),
  isDeploymentSkillId: jest.fn(),
}));
jest.mock('~/cache/getLogStores', () => jest.fn());

describe('search port binding', () => {
  it('hands createMethods a getter that answers null until the port is set', () => {
    const { setSearchPort } = require('./index');

    expect(mockCreateMethods).toHaveBeenCalledTimes(1);
    const { getSearchPort } = mockCreateMethods.mock.calls[0][1];
    expect(getSearchPort()).toBeNull();

    const port = { conversationMatches: jest.fn(), titleMatches: jest.fn() };
    setSearchPort(port);
    expect(getSearchPort()).toBe(port);

    setSearchPort(null);
    expect(getSearchPort()).toBeNull();
  });
});
