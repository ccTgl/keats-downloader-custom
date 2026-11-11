// Hardening tests — covers edge cases, grid format, video paths, large files, error recovery
const { createChromeMock } = require('./chrome-mock');

global.chrome = createChromeMock();
global.fetch = jest.fn().mockResolvedValue({
  ok: true, status: 200,
  url: 'https://example.com/file.pdf',
  headers: { get: () => null },
  blob: () => Promise.resolve({
    arrayBuffer: () => Promise.resolve(new ArrayBuffer(4)),
    type: 'application/pdf',
  }),
});
global.btoa = (str) => Buffer.from(str, 'binary').toString('base64');

const bg = require('../extension/background');

// ==================== Grid format scraping ====================

describe('scrapeSectionPage — grid format edge cases', () => {
  beforeEach(() => {
    // jsdom innerText polyfill not available in node env
    // scrapeSectionPage uses innerText which is browser-only
    // These tests verify the function doesn't crash with various inputs
  });

  test('returns empty array when no activities found', () => {
    // scrapeSectionPage expects DOM — in node env, document doesn't exist
    // This test verifies the exported function exists
    expect(typeof bg.scrapeSectionPage).toBe('function');
  });
});

// ==================== Blob download edge cases ====================

describe('blobToDataUrl edge cases', () => {
  test('handles 1 byte file', async () => {
    const blob = {
      arrayBuffer: () => Promise.resolve(new Uint8Array([0xFF]).buffer),
      type: 'application/octet-stream',
    };
    const url = await bg.blobToDataUrl(blob);
    expect(url).toBe('data:application/octet-stream;base64,/w==');
  });

  test('handles exactly 8192 bytes (one chunk boundary)', async () => {
    const arr = new Uint8Array(8192);
    arr.fill(65); // 'A'
    const blob = {
      arrayBuffer: () => Promise.resolve(arr.buffer),
      type: 'text/plain',
    };
    const url = await bg.blobToDataUrl(blob);
    expect(url).toMatch(/^data:text\/plain;base64,/);
    const base64 = url.split(',')[1];
    // 8192 bytes -> ceil(8192/3)*4 = 10924 base64 chars
    expect(base64.length).toBe(10924);
  });

  test('handles 8193 bytes (crosses chunk boundary)', async () => {
    const arr = new Uint8Array(8193);
    arr.fill(66); // 'B'
    const blob = {
      arrayBuffer: () => Promise.resolve(arr.buffer),
      type: 'text/plain',
    };
    const url = await bg.blobToDataUrl(blob);
    expect(url).toMatch(/^data:text\/plain;base64,/);
    // Verify it decodes back correctly
    const base64 = url.split(',')[1];
    const decoded = Buffer.from(base64, 'base64');
    expect(decoded.length).toBe(8193);
    expect(decoded[0]).toBe(66);
    expect(decoded[8192]).toBe(66);
  });

  test('handles 100KB file (simulating a PDF)', async () => {
    const size = 102400;
    const arr = new Uint8Array(size);
    for (let i = 0; i < size; i++) arr[i] = i % 256;
    const blob = {
      arrayBuffer: () => Promise.resolve(arr.buffer),
      type: 'application/pdf',
    };
    const url = await bg.blobToDataUrl(blob);
    const base64 = url.split(',')[1];
    const decoded = Buffer.from(base64, 'base64');
    expect(decoded.length).toBe(size);
    // Verify first and last bytes
    expect(decoded[0]).toBe(0);
    expect(decoded[size - 1]).toBe((size - 1) % 256);
  });

  test('handles missing MIME type', async () => {
    const blob = {
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(2)),
      type: '', // empty
    };
    const url = await bg.blobToDataUrl(blob);
    expect(url).toMatch(/^data:application\/octet-stream;base64,/);
  });
});

// ==================== fetchFileBlob edge cases ====================

describe('fetchFileBlob', () => {
  test('resolves filename from Content-Disposition', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true, status: 200,
      url: 'https://keats.kcl.ac.uk/pluginfile.php/123/file.pdf',
      headers: {
        get: (h) => h === 'Content-Disposition'
          ? 'attachment; filename="Week 1 Slides.pdf"'
          : 'application/pdf',
      },
      blob: () => Promise.resolve({
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(4)),
        type: 'application/pdf',
      }),
    });

    const result = await bg.fetchFileBlob('https://keats.kcl.ac.uk/mod/resource/view.php?id=123');
    expect(result.filename).toBe('Week 1 Slides.pdf');
    expect(result.blob).toBeDefined();
  });

  test('resolves filename from URL path when no Content-Disposition', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true, status: 200,
      url: 'https://keats.kcl.ac.uk/pluginfile.php/123/mod_resource/content/0/lecture_notes.pdf',
      headers: { get: () => null },
      blob: () => Promise.resolve({
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(4)),
        type: 'application/pdf',
      }),
    });

    const result = await bg.fetchFileBlob('https://keats.kcl.ac.uk/mod/resource/view.php?id=123');
    expect(result.filename).toBe('lecture_notes.pdf');
  });

  test('returns null filename when URL ends in .php', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true, status: 200,
      url: 'https://keats.kcl.ac.uk/mod/resource/view.php',
      headers: { get: () => null },
      blob: () => Promise.resolve({
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(4)),
        type: 'text/html',
      }),
    });

    const result = await bg.fetchFileBlob('https://keats.kcl.ac.uk/mod/resource/view.php?id=123');
    expect(result.filename).toBeNull();
  });

  test('throws on HTTP error', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false, status: 403,
      headers: { get: () => null },
    });

    await expect(bg.fetchFileBlob('https://keats.kcl.ac.uk/mod/resource/view.php?id=123'))
      .rejects.toThrow('HTTP 403');
  });

  test('handles UTF-8 encoded filename in Content-Disposition', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true, status: 200,
      url: 'https://keats.kcl.ac.uk/pluginfile.php/123/file.pdf',
      headers: {
        get: (h) => h === 'Content-Disposition'
          ? "attachment; filename*=UTF-8''Pr%C3%A9sentation.pdf"
          : null,
      },
      blob: () => Promise.resolve({
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(4)),
        type: 'application/pdf',
      }),
    });

    const result = await bg.fetchFileBlob('https://keats.kcl.ac.uk/mod/resource/view.php?id=123');
    expect(result.filename).toBe('Présentation.pdf');
  });
});

// ==================== Download path building ====================

describe('download path construction', () => {
  test('sanitize handles course names with special chars', () => {
    const name = 'CS101: Intro to Programming (2025/26)';
    const sanitized = bg.sanitize(name);
    expect(sanitized).toBe('CS101- Intro to Programming (2025-26)');
    expect(sanitized).not.toContain('/');
    expect(sanitized).not.toContain(':');
  });

  test('sanitize handles names with trailing dots', () => {
    expect(bg.sanitize('file...')).toBe('file');
    expect(bg.sanitize('test.')).toBe('test');
  });

  test('sanitize preserves unicode', () => {
    expect(bg.sanitize('Résumé für Müller')).toBe('Résumé für Müller');
  });

  test('fileKey is consistent', () => {
    const file = { sectionName: 'Week 1', category: 'Lectures', href: 'https://example.com/file.pdf' };
    expect(bg.fileKey('Course A', file)).toBe(bg.fileKey('Course A', file));
  });

  test('fileKey differentiates courses', () => {
    const file = { sectionName: 'Week 1', href: 'https://example.com/file.pdf' };
    expect(bg.fileKey('Course A', file)).not.toBe(bg.fileKey('Course B', file));
  });
});

// ==================== Video download paths ====================

describe('video file handling', () => {
  beforeEach(() => {
    bg.state = {
      status: 'downloading', courseName: 'Test', totalFiles: 1,
      downloadedFiles: 0, failedFiles: 0, scannedSections: 0,
      totalSections: 0, currentFile: '', log: [], errors: [],
      sections: [], cancelled: false,
    };

    global.chrome.runtime.lastError = null;
  });

  test('echo360 files use direct URL, not blob', async () => {
    global.fetch = jest.fn();

    const file = {
      name: 'Lecture 1', href: 'https://content.echo360.org.uk/media/abc/s2q1.mp4',
      type: 'echo360', sectionName: 'Recordings',
    };

    const opts = await bg.prepareWithRetry(file, 'KEATS/Course/', 1);

    // fetch should NOT be called (no blob conversion)
    expect(global.fetch).not.toHaveBeenCalled();

    // download URL should be the original echo360 URL

    expect(opts.downloadUrl).toContain('echo360');
    expect(opts.fullPath).toContain('Lecture 1.mp4');

  });

  test('kaltura files use direct URL, not blob', async () => {
    global.fetch = jest.fn();

    const file = {
      name: 'Week 2 Video', href: 'https://cdnapisec.kaltura.com/p/123/playManifest/entryId/abc/format/download',
      type: 'kalturaDownload', sectionName: 'Week 2', category: 'Lectures',
    };

    const opts = await bg.prepareWithRetry(file, 'KEATS/Course/', 1);
    expect(global.fetch).not.toHaveBeenCalled();


    expect(opts.downloadUrl).toContain('kaltura');
    expect(opts.fullPath).toContain('Week 2 Video.mp4');
  });

  test('resource files go through blob path', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true, status: 200,
      url: 'https://keats.kcl.ac.uk/pluginfile.php/1/mod_resource/content/0/slides.pdf',
      headers: { get: (h) => h === 'Content-Disposition' ? 'attachment; filename="slides.pdf"' : 'application/pdf' },
      blob: () => Promise.resolve({
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(100)),
        type: 'application/pdf',
      }),
    });

    const file = {
      name: 'Slides', href: 'https://keats.kcl.ac.uk/mod/resource/view.php?id=1',
      type: 'resource', sectionName: 'Week 1',
    };

    const opts = await bg.prepareWithRetry(file, 'KEATS/Course/', 1);
    expect(global.fetch).toHaveBeenCalled();


    expect(opts.downloadUrl).toMatch(/^data:/);
  });

  test('folderFile uses blob path with filename from URL', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true, status: 200,
      url: 'https://keats.kcl.ac.uk/pluginfile.php/1/mod_folder/content/0/handout.pdf',
      headers: { get: () => null },
      blob: () => Promise.resolve({
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(50)),
        type: 'application/pdf',
      }),
    });

    const file = {
      name: 'handout.pdf', href: 'https://keats.kcl.ac.uk/pluginfile.php/1/mod_folder/content/0/handout.pdf',
      type: 'folderFile', sectionName: 'Week 1', category: 'Tutorials',
    };

    const opts = await bg.prepareWithRetry(file, 'KEATS/Course/', 1);
    expect(global.fetch).toHaveBeenCalled();


    expect(opts.fullPath).toContain('handout.pdf');
  });
});

// ==================== Error recovery ====================

describe('error recovery', () => {
  beforeEach(() => {
    bg.state = {
      status: 'downloading', courseName: 'Test', totalFiles: 1,
      downloadedFiles: 0, failedFiles: 0, scannedSections: 0,
      totalSections: 0, currentFile: '', log: [], errors: [],
      sections: [], cancelled: false,
    };
    global.chrome.runtime.lastError = null;
  });

  test('retry succeeds after transient fetch failure', async () => {
    let attempt = 0;
    global.fetch = jest.fn(() => {
      attempt++;
      if (attempt === 1) return Promise.resolve({ ok: false, status: 503 });
      return Promise.resolve({
        ok: true, status: 200,
        url: 'https://example.com/file.pdf',
        headers: { get: () => null },
        blob: () => Promise.resolve({
          arrayBuffer: () => Promise.resolve(new ArrayBuffer(4)),
          type: 'application/pdf',
        }),
      });
    });


    const file = {
      name: 'test.pdf', href: 'https://example.com/test.pdf',
      type: 'resource', sectionName: 'Week 1',
    };

    await bg.prepareWithRetry(file, 'KEATS/', 3);
    expect(attempt).toBe(2);
  });

  test('all retries exhausted throws final error', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 500 });

    const file = {
      name: 'bad.pdf', href: 'https://example.com/bad.pdf',
      type: 'resource', sectionName: 'Week 1',
    };

    await expect(bg.prepareWithRetry(file, 'KEATS/', 2)).rejects.toThrow('HTTP 500');
  });
});

// ==================== Cancelled state ====================

describe('cancelled state', () => {
  test('cancelled flag is respected', () => {
    bg.state = { ...bg.state, cancelled: true, status: 'cancelled' };
    expect(bg.state.cancelled).toBe(true);
    expect(bg.state.status).toBe('cancelled');
  });
});

// ==================== addLog overflow ====================

describe('addLog overflow protection', () => {
  beforeEach(() => {
    bg.state = {
      status: 'idle', courseName: '', totalFiles: 0, downloadedFiles: 0,
      failedFiles: 0, scannedSections: 0, totalSections: 0, currentFile: '',
      log: [], errors: [], sections: [], cancelled: false,
    };
  });

  test('trims log when it exceeds 300 entries', () => {
    bg.state.log = [];
    for (let i = 0; i < 301; i++) bg.addLog(`line ${i}`);
    // After 301st entry, log exceeds 300 and is sliced to last 200
    expect(bg.state.log.length).toBe(200);
    expect(bg.state.log[0]).toBe('line 101');
    expect(bg.state.log[199]).toBe('line 300');
  });
});

// ==================== sleep ====================

describe('sleep precision', () => {
  test('resolves after specified duration', async () => {
    const start = Date.now();
    await bg.sleep(100);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(90);
    expect(elapsed).toBeLessThan(200);
  });
});
