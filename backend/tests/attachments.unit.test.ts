/**
 * Unit tests for the pure attachment domain (type classification + limits).
 * No database or HTTP layer involved.
 */
import {
  checkAttachmentLimits,
  classifyAttachment,
  fileExtension,
  isAcceptedAttachment,
  type AttachmentLimits,
} from '../src/domain/attachments';

const LIMITS: AttachmentLimits = {
  maxFileBytes: 10 * 1024 * 1024, // 10 MB
  maxPerRun: 5,
  maxTotalBytes: 25 * 1024 * 1024, // 25 MB
};

describe('fileExtension', () => {
  it('returns the lower-cased extension with the dot', () => {
    expect(fileExtension('Spec.PDF')).toBe('.pdf');
    expect(fileExtension('a.b.docx')).toBe('.docx');
  });

  it('returns empty string when there is no usable extension', () => {
    expect(fileExtension('README')).toBe('');
    expect(fileExtension('.env')).toBe(''); // dot at position 0
    expect(fileExtension('trailing.')).toBe('');
  });
});

describe('classifyAttachment', () => {
  it('classifies accepted types by extension', () => {
    expect(classifyAttachment('srs.pdf', 'application/pdf')).toBe('pdf');
    expect(classifyAttachment('data.xlsx', 'application/octet-stream')).toBe('spreadsheet');
    expect(classifyAttachment('legacy.xls', '')).toBe('spreadsheet');
    expect(classifyAttachment('spec.docx', '')).toBe('document');
    expect(classifyAttachment('notes.md', 'application/octet-stream')).toBe('text');
    expect(classifyAttachment('rows.csv', 'application/vnd.ms-excel')).toBe('text');
    expect(classifyAttachment('plain.txt', 'text/plain')).toBe('text');
  });

  it('falls back to MIME when the extension is unknown', () => {
    expect(classifyAttachment('blob', 'application/pdf')).toBe('pdf');
  });

  it('rejects unsupported types', () => {
    expect(classifyAttachment('image.png', 'image/png')).toBeNull();
    expect(classifyAttachment('archive.zip', 'application/zip')).toBeNull();
    expect(isAcceptedAttachment('movie.mp4', 'video/mp4')).toBe(false);
  });
});

describe('checkAttachmentLimits', () => {
  const empty = { count: 0, totalBytes: 0 };

  it('allows a normal upload', () => {
    expect(
      checkAttachmentLimits(empty, [{ sizeBytes: 1_000 }], LIMITS).allowed,
    ).toBe(true);
  });

  it('rejects an empty upload (400)', () => {
    const d = checkAttachmentLimits(empty, [], LIMITS);
    expect(d.allowed).toBe(false);
    expect(d.status).toBe(400);
  });

  it('rejects a file larger than the per-file cap (413)', () => {
    const d = checkAttachmentLimits(empty, [{ sizeBytes: LIMITS.maxFileBytes + 1 }], LIMITS);
    expect(d.allowed).toBe(false);
    expect(d.status).toBe(413);
  });

  it('rejects exceeding the per-run file count (409)', () => {
    const d = checkAttachmentLimits(
      { count: 4, totalBytes: 0 },
      [{ sizeBytes: 1 }, { sizeBytes: 1 }],
      LIMITS,
    );
    expect(d.allowed).toBe(false);
    expect(d.status).toBe(409);
  });

  it('rejects exceeding the total run size (413)', () => {
    const d = checkAttachmentLimits(
      { count: 1, totalBytes: 24 * 1024 * 1024 },
      [{ sizeBytes: 2 * 1024 * 1024 }],
      LIMITS,
    );
    expect(d.allowed).toBe(false);
    expect(d.status).toBe(413);
  });

  it('allows reaching the caps exactly', () => {
    const d = checkAttachmentLimits(
      { count: 4, totalBytes: 20 * 1024 * 1024 },
      [{ sizeBytes: 5 * 1024 * 1024 }],
      LIMITS,
    );
    expect(d.allowed).toBe(true);
  });
});
