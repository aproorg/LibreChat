import { model, models } from 'mongoose';
import fileSchema from './file';

it('keeps the PDF page count and text size recorded at upload', () => {
  const File = models.PdfMeasureFile ?? model('PdfMeasureFile', fileSchema);
  const doc = new File({ metadata: { pageCount: 40, textChars: 271_780 } });
  expect(doc.toObject().metadata).toMatchObject({ pageCount: 40, textChars: 271_780 });
});
