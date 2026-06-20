/**
 * Unit tests for attachment → generation-content preparation. Covers the PDF
 * (document block + magic-byte check) and plain-text paths and text capping.
 * The spreadsheet/DOCX paths lazy-load external parsers and are exercised by the
 * on-host smoke test instead.
 */
import {
  capText,
  prepareAttachments,
  type RawAttachment,
} from '../src/services/attachmentContent.service';
import { AppError } from '../src/middleware/errorHandler';

function pdf(name: string, body = 'fake pdf body'): RawAttachment {
  return { filename: name, mimeType: 'application/pdf', data: Buffer.from(`%PDF-1.7\n${body}`) };
}

describe('capText', () => {
  it('leaves short text unchanged', () => {
    expect(capText('hello', 100)).toBe('hello');
  });
  it('truncates and marks long text', () => {
    const out = capText('x'.repeat(50), 10);
    expect(out.startsWith('x'.repeat(10))).toBe(true);
    expect(out).toContain('truncated');
    expect(out.length).toBeLessThan(50 + 60);
  });
});

describe('prepareAttachments', () => {
  it('turns a PDF into a base64 document block', async () => {
    const { documents, textSections } = await prepareAttachments([pdf('srs.pdf')]);
    expect(textSections).toHaveLength(0);
    expect(documents).toHaveLength(1);
    expect(documents[0]).toMatchObject({
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf' },
    });
    // base64 round-trips back to the original bytes.
    const decoded = Buffer.from(documents[0].source.data, 'base64').toString('latin1');
    expect(decoded.startsWith('%PDF-')).toBe(true);
  });

  it('rejects a PDF without the %PDF- signature (422)', async () => {
    const bad: RawAttachment = {
      filename: 'fake.pdf',
      mimeType: 'application/pdf',
      data: Buffer.from('not really a pdf'),
    };
    await expect(prepareAttachments([bad])).rejects.toBeInstanceOf(AppError);
    await expect(prepareAttachments([bad])).rejects.toMatchObject({ statusCode: 422 });
  });

  it('extracts plain text / CSV / Markdown into labelled sections', async () => {
    const items: RawAttachment[] = [
      { filename: 'notes.txt', mimeType: 'text/plain', data: Buffer.from('hello world') },
      { filename: 'rows.csv', mimeType: 'text/csv', data: Buffer.from('a,b\n1,2') },
    ];
    const { documents, textSections } = await prepareAttachments(items);
    expect(documents).toHaveLength(0);
    expect(textSections).toHaveLength(2);
    expect(textSections[0]).toContain('### Attached file: notes.txt');
    expect(textSections[0]).toContain('hello world');
    expect(textSections[1]).toContain('rows.csv');
  });

  it('skips unsupported types defensively', async () => {
    const items: RawAttachment[] = [
      { filename: 'pic.png', mimeType: 'image/png', data: Buffer.from('x') },
      { filename: 'ok.txt', mimeType: 'text/plain', data: Buffer.from('kept') },
    ];
    const { documents, textSections } = await prepareAttachments(items);
    expect(documents).toHaveLength(0);
    expect(textSections).toHaveLength(1);
    expect(textSections[0]).toContain('kept');
  });

  it('preserves order across mixed types', async () => {
    const items: RawAttachment[] = [
      { filename: 'a.txt', mimeType: 'text/plain', data: Buffer.from('A') },
      pdf('b.pdf'),
      { filename: 'c.md', mimeType: 'text/markdown', data: Buffer.from('C') },
    ];
    const { documents, textSections } = await prepareAttachments(items);
    expect(documents).toHaveLength(1);
    expect(textSections.map((s) => s.match(/Attached file: (\S+)/)?.[1])).toEqual([
      'a.txt',
      'c.md',
    ]);
  });
});
