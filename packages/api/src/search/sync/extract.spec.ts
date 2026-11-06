import { ContentTypes } from 'librechat-data-provider';
import { extractConversation, extractMessage } from './extract';

const SENTINEL = 'SENTINELHIDDEN';

const message = (fields: Record<string, unknown> = {}) => ({
  _id: 'id1',
  messageId: 'message-1',
  user: 'user-1',
  conversationId: 'conversation-1',
  createdAt: new Date('2026-01-02T03:04:05.000Z'),
  text: 'plain words',
  ...fields,
});

describe('extractMessage', () => {
  it('takes text when content is not an array', () => {
    expect(extractMessage(message()).text).toBe('plain words');
    expect(extractMessage(message({ content: 'not parts' })).text).toBe('plain words');
    expect(extractMessage(message({ text: undefined })).text).toBe('');
    expect(extractMessage(message({ text: { nested: SENTINEL } })).text).toBe('');
  });

  it('takes thinking and steer text from content, over text', () => {
    const { text } = extractMessage(
      message({
        text: SENTINEL,
        content: [
          { type: ContentTypes.THINK, think: 'thought' },
          { type: ContentTypes.TEXT, text: 'answer' },
          { type: ContentTypes.STEER, steer: 'steered' },
        ],
      }),
    );

    expect(text).toBe('thought answer steered');
  });

  it('never reads context, summaries, signatures or tool output', () => {
    const { text, h } = extractMessage(
      message({
        contextMeta: { note: SENTINEL },
        summary: SENTINEL,
        metadata: { thoughtSignatures: [SENTINEL] },
        sender: SENTINEL,
        content: [
          { type: ContentTypes.TEXT, text: 'answer' },
          {
            type: ContentTypes.TOOL_CALL,
            tool_call: { name: 'tool', args: SENTINEL, output: SENTINEL },
          },
        ],
      }),
    );

    expect(text).toBe('answer');
    expect(h).toBe(extractMessage(message({ text: 'answer' })).h);
  });

  it('accepts dates as stored or as loaded from a corpus', () => {
    const iso = '2026-01-02T03:04:05.000Z';
    const expected = new Date(iso);

    expect(extractMessage(message({ createdAt: iso })).createdAt).toEqual(expected);
    expect(extractMessage(message({ createdAt: expected.getTime() })).createdAt).toEqual(expected);
  });

  it('refuses a source with no usable date or identity, naming no content', () => {
    expect(() => extractMessage(message({ createdAt: 'never' }))).toThrow('createdAt');
    expect(() => extractMessage(message({ user: undefined }))).toThrow('user');
    expect(() => extractMessage(message({ messageId: 7 }))).toThrow('messageId');
  });

  describe('its hash', () => {
    const base = extractMessage(message()).h;

    it('is stable across metadata-only changes', () => {
      expect(extractMessage(message({ updatedAt: new Date(), sender: 'other' })).h).toBe(base);
    });

    it.each([
      ['text', { text: 'other' }],
      ['user', { user: 'user-2' }],
      ['conversationId', { conversationId: 'conversation-2' }],
      ['createdAt', { createdAt: new Date(0) }],
    ])('changes with %s', (_field, change) => {
      expect(extractMessage(message(change)).h).not.toBe(base);
    });

    it('cannot be collided by moving text between fields', () => {
      expect(extractMessage(message({ text: 'a', user: 'bc' })).h).not.toBe(
        extractMessage(message({ text: 'ab', user: 'c' })).h,
      );
    });
  });
});

describe('extractConversation', () => {
  const convo = (fields: Record<string, unknown> = {}) => ({
    _id: 'id2',
    conversationId: 'conversation-1',
    user: 'user-1',
    title: 'Trip plans',
    tags: ['work', 'later'],
    ...fields,
  });

  it('joins title and tags, and tolerates missing ones', () => {
    expect(extractConversation(convo()).text).toBe('Trip plans work later');
    expect(extractConversation(convo({ title: null, tags: undefined })).text).toBe('');
    expect(extractConversation(convo({ tags: ['ok', 7, null] })).text).toBe('Trip plans ok');
  });

  it('reads no other field', () => {
    const { text } = extractConversation(convo({ model: SENTINEL, endpoint: SENTINEL }));

    expect(text).not.toContain(SENTINEL);
  });

  it.each([
    ['title', { title: 'other' }],
    ['tags', { tags: ['other'] }],
    ['user', { user: 'user-2' }],
    ['conversationId', { conversationId: 'conversation-2' }],
  ])('changes its hash with %s', (_field, change) => {
    expect(extractConversation(convo(change)).h).not.toBe(extractConversation(convo()).h);
  });

  it('does not take a moved tag boundary for the same tags', () => {
    expect(extractConversation(convo({ tags: ['a b'] })).h).not.toBe(
      extractConversation(convo({ tags: ['a', 'b'] })).h,
    );
  });

  it('keeps a metadata-only change out of its hash', () => {
    expect(extractConversation(convo({ model: 'other' })).h).toBe(extractConversation(convo()).h);
  });
});
