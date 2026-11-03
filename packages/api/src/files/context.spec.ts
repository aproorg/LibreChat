import type { TFile } from 'librechat-data-provider';
import { applyTurnDelivery, resolveTurnDeliveryRouting } from '~/agents/files/delivery';
import { getAttachmentTitleText, extractFileContext } from './context';

const file = (filename?: string): TFile => ({ filename }) as TFile;

describe('getAttachmentTitleText', () => {
  it('returns an empty string when there are no files', () => {
    expect(getAttachmentTitleText()).toBe('');
    expect(getAttachmentTitleText(null)).toBe('');
    expect(getAttachmentTitleText([])).toBe('');
  });

  it('lists a single filename', () => {
    expect(getAttachmentTitleText([file('report.pdf')])).toBe('Attached file(s): report.pdf');
  });

  it('lists every filename', () => {
    expect(getAttachmentTitleText([file('a.pdf'), file('b.csv')])).toBe(
      'Attached file(s): a.pdf, b.csv',
    );
  });

  it('skips files that carry no filename', () => {
    expect(getAttachmentTitleText([file(), file('kept.txt')])).toBe('Attached file(s): kept.txt');
  });

  it('returns an empty string when no file has a filename', () => {
    expect(getAttachmentTitleText([file(), file()])).toBe('');
  });
});

describe('extractFileContext for a spreadsheet read at upload for Run Code', () => {
  it('puts the stored text in the prompt on a turn without Run Code', async () => {
    const sheet = {
      file_id: 'sheet',
      filename: 'report.xlsx',
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      text: 'a,b',
      llmDeliveryPath: 'none' as const,
      metadata: { destinationChosen: false },
    };
    const routing = resolveTurnDeliveryRouting({
      agent: { provider: 'openAI' },
      config: {
        fileConfig: {
          endpoints: {
            openAI: { llmDeliveryPolicy: 'automatic' },
          },
        },
      },
    });
    const delivered = applyTurnDelivery([sheet], {
      routing,
      consumers: { executeCode: false, fileSearch: false },
    });

    const context = await extractFileContext({
      attachments: delivered,
      tokenCountFn: (text: string) => text.length,
    });

    expect(context).toContain('a,b');
    expect(context).toContain('report.xlsx');
  });
});

describe('extractFileContext for a spreadsheet stored for Run Code without text', () => {
  it('puts a note naming the file in the prompt on a turn without Run Code', async () => {
    const sheet = {
      file_id: 'sheet',
      filename: 'pivot.xlsx',
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      llmDeliveryPath: 'none' as const,
      metadata: { destinationChosen: false, textDerivation: 'deferred' as const },
    };
    const routing = resolveTurnDeliveryRouting({
      agent: { provider: 'openAI' },
      config: { fileConfig: { endpoints: { openAI: { llmDeliveryPolicy: 'automatic' } } } },
    });
    const delivered = applyTurnDelivery([sheet], {
      routing,
      consumers: { executeCode: false, fileSearch: false },
    });

    const context = await extractFileContext({
      attachments: delivered,
      tokenCountFn: (text: string) => text.length,
    });

    expect(context).toContain('"pivot.xlsx"');
    expect(context).toContain('Run Code');
  });
});
