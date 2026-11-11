const mockAskQuestion = jest.fn();
const mockSilentExit = jest.fn();
const mockBatchResetMeiliFlags = jest.fn();
const mockCountDocuments = jest.fn();

jest.mock('../connect', () => jest.fn().mockResolvedValue(undefined));
jest.mock('../helpers', () => ({
  ...jest.requireActual('../helpers'),
  askQuestion: mockAskQuestion,
  silentExit: mockSilentExit,
}));
jest.mock('~/db/utils', () => ({ batchResetMeiliFlags: mockBatchResetMeiliFlags }));
jest.mock('mongoose', () => ({
  connection: {
    db: { collection: jest.fn((name) => ({ name, countDocuments: mockCountDocuments })) },
  },
}));

describe('reset-meili-sync CLI', () => {
  const originalArgv = process.argv;
  let existingHandlers;
  let output;

  const runScript = (...flags) => {
    process.argv = ['node', 'reset-meili-sync.js', ...flags];
    jest.isolateModules(() => require('../reset-meili-sync'));
  };

  const exited = () =>
    new Promise((resolve) => {
      mockSilentExit.mockImplementation((code) => resolve(code));
    });

  beforeEach(() => {
    jest.clearAllMocks();
    existingHandlers = new Set(process.listeners('uncaughtException'));
    output = [
      jest.spyOn(console, 'log').mockImplementation(() => undefined),
      jest.spyOn(process.stdout, 'write').mockImplementation(() => true),
    ];
    mockBatchResetMeiliFlags.mockResolvedValue(3);
    mockCountDocuments.mockResolvedValue(3);
  });

  afterEach(() => {
    process.argv = originalArgv;
    output.forEach((spy) => spy.mockRestore());
    process
      .listeners('uncaughtException')
      .filter((handler) => !existingHandlers.has(handler))
      .forEach((handler) => process.removeListener('uncaughtException', handler));
  });

  it('--yes skips both prompts, resets both collections and exits 0', async () => {
    const done = exited();

    runScript('--yes');

    expect(await done).toBe(0);
    expect(mockAskQuestion).not.toHaveBeenCalled();
    expect(mockBatchResetMeiliFlags.mock.calls.map(([collection]) => collection.name)).toEqual([
      'messages',
      'conversations',
    ]);
    expect(mockSilentExit).toHaveBeenCalledTimes(1);
  });

  it('--yes exits 1 when the reset fails', async () => {
    mockBatchResetMeiliFlags.mockRejectedValue(new Error('reset failed'));
    const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const done = exited();

    runScript('--yes');

    expect(await done).toBe(1);
    expect(mockAskQuestion).not.toHaveBeenCalled();
    error.mockRestore();
  });

  it('still asks before resetting without the flag', async () => {
    const asked = new Promise((resolve) => {
      mockAskQuestion.mockImplementation((question) => {
        resolve(question);
        return new Promise(() => undefined);
      });
    });

    runScript();

    expect(await asked).toContain('Are you sure');
    expect(mockBatchResetMeiliFlags).not.toHaveBeenCalled();
    expect(mockSilentExit).not.toHaveBeenCalled();
  });
});
