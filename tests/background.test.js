const { createChromeMock } = require('./chrome-mock');

// Set up Chrome mock before loading background.js
global.chrome = createChromeMock();

// Mock fetch for downloadSingleFile (returns a fake blob)
global.fetch = jest.fn().mockResolvedValue({
  ok: true,
  status: 200,
  url: 'https://example.com/resolved-file.pdf',
  headers: new Map([['Content-Disposition', 'attachment; filename="test.pdf"'], ['Content-Type', 'application/pdf']]),
  blob: () => Promise.resolve({
    arrayBuffer: () => Promise.resolve(new ArrayBuffer(4)),
    type: 'application/pdf',
  }),
});
// Patch headers.get
global.fetch.mockResolvedValue({
  ok: true,
  status: 200,
  url: 'https://example.com/resolved-file.pdf',
  headers: { get: (h) => h === 'Content-Disposition' ? 'attachment; filename="test.pdf"' : 'application/pdf' },
  blob: () => Promise.resolve({
    arrayBuffer: () => Promise.resolve(new ArrayBuffer(4)),
    type: 'application/pdf',
  }),
});

// Mock btoa for Node
global.btoa = (str) => Buffer.from(str, 'binary').toString('base64');

const bg = require('../extension/background');

describe('sanitize', () => {
  test('removes illegal filename characters', () => {
    expect(bg.sanitize('file/name\\test')).toBe('file-name-test');
  });

  test('removes question marks and asterisks', () => {
    expect(bg.sanitize('what? file*.txt')).toBe('what- file-.txt');
  });

  test('removes colons, pipes, quotes, angle brackets', () => {
    expect(bg.sanitize('a:b|c"d<e>f')).toBe('a-b-c-d-e-f');
  });

  test('trims whitespace', () => {
    expect(bg.sanitize('  hello  ')).toBe('hello');
  });

  test('removes trailing dots', () => {
    expect(bg.sanitize('file...')).toBe('file');
  });

  test('handles empty string', () => {
    expect(bg.sanitize('')).toBe('');
  });

  test('preserves normal filenames', () => {
    expect(bg.sanitize('Lecture 1 - Introduction.pdf')).toBe('Lecture 1 - Introduction.pdf');
  });

  test('removes percent signs', () => {
    expect(bg.sanitize('100% complete')).toBe('100- complete');
  });
});

describe('addLog', () => {
  beforeEach(() => {
    bg.state = {
      status: 'idle', courseName: '', totalFiles: 0, downloadedFiles: 0,
      failedFiles: 0, scannedSections: 0, totalSections: 0, currentFile: '', log: [], errors: [], sections: [], cancelled: false,
    };
  });

  test('appends messages to the log', () => {
    bg.addLog('first');
    bg.addLog('second');
    expect(bg.state.log).toEqual(['first', 'second']);
  });

  test('caps log at 300 entries by trimming to 200', () => {
    for (let i = 0; i < 301; i++) {
      bg.addLog(`msg ${i}`);
    }
    expect(bg.state.log.length).toBe(200);
    expect(bg.state.log[0]).toBe('msg 101');
    expect(bg.state.log[199]).toBe('msg 300');
  });
});

describe('sleep', () => {
  test('resolves after the specified time', async () => {
    const start = Date.now();
    await bg.sleep(50);
    expect(Date.now() - start).toBeGreaterThanOrEqual(40);
  });
});


describe('prepareWithRetry', () => {
  beforeEach(() => {
    bg.state = { ...bg.state, log: [] };
  });

  test('prepares the file on the first attempt without submitting a download', async () => {
    const file = {
      name: 'test.pdf', href: 'https://example.com/test.pdf',
      type: 'resource', sectionName: 'Week 1', category: 'Lectures',
    };
    const result = await bg.prepareWithRetry(file, 'KEATS Downloads/Course/', 1);
    expect(result.fullPath).toBe('KEATS Downloads/Course/Week 1/Lectures/test.pdf');
    expect(chrome.downloads.download).not.toHaveBeenCalled();
  });

  test('retries failed file fetches', async () => {
    global.fetch.mockClear();
    global.fetch.mockResolvedValueOnce({ ok: false, status: 503 })
      .mockResolvedValueOnce({ ok: false, status: 502 });
    const file = {
      name: 'retry.pdf', href: 'https://example.com/retry.pdf',
      type: 'folderFile', sectionName: 'Week 1',
    };
    await expect(bg.prepareWithRetry(file, 'KEATS/', 3)).resolves.toHaveProperty('downloadUrl');
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  test('throws after all retries are exhausted', async () => {
    global.fetch.mockResolvedValue({ ok: false, status: 503 });
    const file = { name: 'fail.pdf', href: 'https://example.com/fail.pdf', type: 'resource' };
    await expect(bg.prepareWithRetry(file, 'KEATS/', 2)).rejects.toThrow('HTTP 503');
  });
});

describe('fileKey', () => {
  test('generates unique key from course + section + category + href', () => {
    const file = { sectionName: 'Week 1', category: 'Lectures', href: 'https://example.com/file.pdf' };
    const key = bg.fileKey('MDE', file);
    expect(key).toBe('MDE|Week 1|Lectures|https://example.com/file.pdf');
  });

  test('handles missing optional fields', () => {
    const file = { href: 'https://example.com/file.pdf' };
    const key = bg.fileKey('MDE', file);
    expect(key).toBe('MDE|||https://example.com/file.pdf');
  });

  test('different files produce different keys', () => {
    const file1 = { sectionName: 'Week 1', href: 'https://example.com/a.pdf' };
    const file2 = { sectionName: 'Week 1', href: 'https://example.com/b.pdf' };
    expect(bg.fileKey('MDE', file1)).not.toBe(bg.fileKey('MDE', file2));
  });
});
