const { speechUserHeaders } = require('./speechUserHeaders');

describe('speechUserHeaders', () => {
  const original = process.env.SPEECH_USER_EMAIL_HEADER;
  afterEach(() => {
    if (original === undefined) {
      delete process.env.SPEECH_USER_EMAIL_HEADER;
    } else {
      process.env.SPEECH_USER_EMAIL_HEADER = original;
    }
  });

  it('sends nothing unless SPEECH_USER_EMAIL_HEADER is set', () => {
    delete process.env.SPEECH_USER_EMAIL_HEADER;
    expect(speechUserHeaders({ email: 'a@apro.is' })).toEqual({});
    process.env.SPEECH_USER_EMAIL_HEADER = '  ';
    expect(speechUserHeaders({ email: 'a@apro.is' })).toEqual({});
  });

  it('names the user in the configured header', () => {
    process.env.SPEECH_USER_EMAIL_HEADER = 'x-user-email';
    expect(speechUserHeaders({ email: 'a@apro.is' })).toEqual({ 'x-user-email': 'a@apro.is' });
  });

  it('skips a missing or unsafe email', () => {
    process.env.SPEECH_USER_EMAIL_HEADER = 'x-user-email';
    expect(speechUserHeaders(undefined)).toEqual({});
    expect(speechUserHeaders({})).toEqual({});
    expect(speechUserHeaders({ email: 'a@apro.is\r\nx-evil: 1' })).toEqual({});
  });
});
