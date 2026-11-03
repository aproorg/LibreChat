const mockAppend = jest.fn();
jest.mock('fs', () => ({ createReadStream: jest.fn(() => 'stream'), promises: {} }));
jest.mock('axios', () => ({ post: jest.fn().mockResolvedValue({ data: { status: true } }) }));
jest.mock('form-data', () =>
  jest.fn(() => ({ append: mockAppend, getHeaders: jest.fn().mockReturnValue({}) })),
);
jest.mock('@librechat/api', () => ({
  logAxiosError: jest.fn(),
  generateShortLivedToken: jest.fn(() => 'jwt'),
  sanitizeFilename: jest.fn((name) => name),
}));
jest.mock('@librechat/data-schemas', () => ({ logger: { error: jest.fn(), debug: jest.fn() } }));

const { uploadVectors } = require('./crud');

describe('uploadVectors', () => {
  it('sends the original filename, not the unique staged basename', async () => {
    process.env.RAG_API_URL = 'http://rag.test';
    await uploadVectors({
      req: { user: { id: 'u1' } },
      file: { path: '/tmp/temp/u1/uuid-1-report.pdf', originalname: 'report.pdf' },
      file_id: 'f1',
    });

    expect(mockAppend).toHaveBeenCalledWith('file', 'stream', { filename: 'report.pdf' });
  });
});
