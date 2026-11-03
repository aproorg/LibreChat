import { model, models } from 'mongoose';
import fileSchema from './file';

it('keeps the PDF page count and text size recorded at upload', () => {
  const File = models.PdfMeasureFile ?? model('PdfMeasureFile', fileSchema);
  const doc = new File({ metadata: { pageCount: 40, textChars: 271_780 } });
  expect(doc.toObject().metadata).toMatchObject({ pageCount: 40, textChars: 271_780 });
});

it('keeps the deferred text marker and rejects any other value', () => {
  const File = models.PdfMeasureFile ?? model('PdfMeasureFile', fileSchema);
  expect(new File({ metadata: { textDerivation: 'deferred' } }).metadata?.textDerivation).toBe(
    'deferred',
  );
  expect(
    new File({ metadata: { textDerivation: 'complete' } }).validateSync()?.errors,
  ).toHaveProperty(['metadata.textDerivation']);
});
