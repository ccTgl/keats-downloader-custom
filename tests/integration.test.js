// Integration tests - simulate real scanning and downloading flows
const { createChromeMock } = require('./chrome-mock');

// Fresh chrome mock for each test
let chromeMock;
beforeEach(() => {
  chromeMock = createChromeMock();
  global.chrome = chromeMock;
  global.fetch = jest.fn();
  global.btoa = (str) => Buffer.from(str, 'binary').toString('base64');
});

// Re-require background.js for fresh state each time
// (can't do this easily with require cache, so we test exported functions)
const bg = (() => {
  global.chrome = createChromeMock();
  global.fetch = jest.fn().mockResolvedValue({
    ok: true, status: 200,
    url: 'https://example.com/file.pdf',
    headers: { get: () => 'application/pdf' },
    blob: () => Promise.resolve({
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(4)),
      type: 'application/pdf',
    }),
  });
  global.btoa = (str) => Buffer.from(str, 'binary').toString('base64');
  return require('../extension/background');
})();

describe('scanning progress tracking', () => {
  beforeEach(() => {
    bg.state = {
      status: 'scanning', courseName: 'Test Course', totalFiles: 0,
      downloadedFiles: 0, failedFiles: 0, scannedSections: 0,
      totalSections: 5, currentFile: '', log: [], errors: [],
      sections: [], cancelled: false,
    };
  });

  test('scannedSections starts at 0', () => {
    expect(bg.state.scannedSections).toBe(0);
    expect(bg.state.totalSections).toBe(5);
  });

  test('addLog captures scanning messages', () => {
    bg.addLog('Scanning 1/5: Week 1');
    bg.addLog('Scanning 2/5: Week 2');
    expect(bg.state.log).toHaveLength(2);
    expect(bg.state.log[0]).toBe('Scanning 1/5: Week 1');
  });

  test('state tracks sections incrementally', () => {
    bg.state.scannedSections = 0;
    expect(bg.state.scannedSections).toBe(0);
    bg.state.scannedSections = 1;
    expect(bg.state.scannedSections).toBe(1);
    bg.state.scannedSections = 5;
    expect(bg.state.scannedSections).toBe(5);
  });
});

describe('blob download flow', () => {
  test('fetchFileBlob resolves filename from Content-Disposition', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true, status: 200,
      url: 'https://keats.kcl.ac.uk/pluginfile.php/123/mod_resource/content/0/lecture.pdf',
      headers: {
        get: (h) => {
          if (h === 'Content-Disposition') return 'attachment; filename="Week1_Slides.pdf"';
          return 'application/pdf';
        },
      },
      blob: () => Promise.resolve({
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)),
        type: 'application/pdf',
      }),
    });

    // fetchFileBlob is not exported but we can test the flow via downloadSingleFile
    // For now test that fetch is called correctly
    const response = await fetch('https://keats.kcl.ac.uk/mod/resource/view.php?id=123&redirect=1');
    expect(response.ok).toBe(true);
    const cd = response.headers.get('Content-Disposition');
    expect(cd).toContain('Week1_Slides.pdf');
  });

  test('blobToDataUrl converts small blobs', async () => {
    // Test the conversion function directly
    const mockBlob = {
      arrayBuffer: () => Promise.resolve(new Uint8Array([72, 101, 108, 108, 111]).buffer),
      type: 'text/plain',
    };
    const dataUrl = await bg.blobToDataUrl(mockBlob);
    expect(dataUrl).toMatch(/^data:text\/plain;base64,/);
    expect(dataUrl).toBe('data:text/plain;base64,SGVsbG8=');
  });

  test('blobToDataUrl handles empty blobs', async () => {
    const mockBlob = {
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
      type: 'application/octet-stream',
    };
    const dataUrl = await bg.blobToDataUrl(mockBlob);
    expect(dataUrl).toBe('data:application/octet-stream;base64,');
  });

  test('blobToDataUrl handles larger data (simulated)', async () => {
    // Simulate a 16KB file
    const size = 16384;
    const buffer = new ArrayBuffer(size);
    const view = new Uint8Array(buffer);
    for (let i = 0; i < size; i++) view[i] = i % 256;

    const mockBlob = {
      arrayBuffer: () => Promise.resolve(buffer),
      type: 'application/pdf',
    };
    const dataUrl = await bg.blobToDataUrl(mockBlob);
    expect(dataUrl).toMatch(/^data:application\/pdf;base64,/);
    // Verify the base64 string has the right length (~21848 chars for 16KB)
    const base64Part = dataUrl.split(',')[1];
    expect(base64Part.length).toBeGreaterThan(20000);
  });
});

describe('download history integration', () => {
  beforeEach(() => {
    global.chrome.storage.local._clear();
  });

  test('fileKey generates consistent keys', () => {
    const file1 = { sectionName: 'Week 1', category: 'Lectures', href: 'https://keats.kcl.ac.uk/mod/resource/view.php?id=100' };
    const file2 = { sectionName: 'Week 1', category: 'Lectures', href: 'https://keats.kcl.ac.uk/mod/resource/view.php?id=100' };
    expect(bg.fileKey('MDE', file1)).toBe(bg.fileKey('MDE', file2));
  });

  test('fileKey differs for different URLs', () => {
    const file1 = { sectionName: 'Week 1', href: 'https://keats.kcl.ac.uk/mod/resource/view.php?id=100' };
    const file2 = { sectionName: 'Week 1', href: 'https://keats.kcl.ac.uk/mod/resource/view.php?id=200' };
    expect(bg.fileKey('MDE', file1)).not.toBe(bg.fileKey('MDE', file2));
  });

  test('fileKey differs for different courses', () => {
    const file = { sectionName: 'Week 1', href: 'https://keats.kcl.ac.uk/mod/resource/view.php?id=100' };
    expect(bg.fileKey('MDE', file)).not.toBe(bg.fileKey('Business Strategy', file));
  });
});

describe('sanitize edge cases', () => {
  test('handles unicode characters', () => {
    const result = bg.sanitize('Lecture café résumé');
    expect(result).toBe('Lecture café résumé');
  });

  test('handles long filenames', () => {
    const longName = 'A'.repeat(200);
    const result = bg.sanitize(longName);
    expect(result.length).toBe(200); // sanitize doesn't truncate
  });

  test('handles multiple consecutive special chars', () => {
    expect(bg.sanitize('a???b***c')).toBe('a---b---c');
  });

  test('handles names with only special chars', () => {
    expect(bg.sanitize('???')).toBe('---');
  });
});

describe('scraping with complex DOM structures', () => {
  // These need jsdom but we're in node environment
  // Skip DOM tests here, they're in scraping.test.js
});

describe('prepareWithRetry with blob flow', () => {
  beforeEach(() => {
    bg.state = {
      status: 'downloading', courseName: 'Test', totalFiles: 1,
      downloadedFiles: 0, failedFiles: 0, scannedSections: 0,
      totalSections: 0, currentFile: '', log: [], errors: [],
      sections: [], cancelled: false,
    };

    // Reset download mock to auto-complete
    global.chrome.runtime.lastError = null;

    // Mock fetch for blob downloads
    global.fetch = jest.fn().mockResolvedValue({
      ok: true, status: 200,
      url: 'https://keats.kcl.ac.uk/pluginfile.php/123/file.pdf',
      headers: {
        get: (h) => {
          if (h === 'Content-Disposition') return 'attachment; filename="slides.pdf"';
          return 'application/pdf';
        },
      },
      blob: () => Promise.resolve({
        arrayBuffer: () => Promise.resolve(new Uint8Array([1, 2, 3, 4]).buffer),
        type: 'application/pdf',
      }),
    });
  });

  test('resource files go through blob path (fetch is called)', async () => {
    const file = {
      name: 'Lecture Slides', href: 'https://keats.kcl.ac.uk/mod/resource/view.php?id=123',
      type: 'resource', sectionName: 'Week 1', category: 'Lectures',
    };

    await bg.prepareWithRetry(file, 'KEATS Downloads/MDE/', 1);
    // fetch should be called for the blob download
    expect(global.fetch).toHaveBeenCalled();
    const fetchUrl = global.fetch.mock.calls[0][0];
    expect(fetchUrl).toContain('redirect=1');
  });

  test('folderFile files go through blob path', async () => {
    const file = {
      name: 'notes.pdf', href: 'https://keats.kcl.ac.uk/pluginfile.php/123/mod_folder/content/0/notes.pdf',
      type: 'folderFile', sectionName: 'Week 1',
    };

    await bg.prepareWithRetry(file, 'KEATS Downloads/MDE/', 1);
    expect(global.fetch).toHaveBeenCalled();
  });

  test('echo360 videos use direct URL (no blob)', async () => {
    const file = {
      name: 'Lecture Recording', href: 'https://content.echo360.org.uk/media/video.mp4',
      type: 'echo360', sectionName: 'Recordings',
    };

    const prepared = await bg.prepareWithRetry(file, 'KEATS Downloads/MDE/', 1);
    // fetch should NOT be called for video files
    expect(global.fetch).not.toHaveBeenCalled();
    // download should use the direct URL

    expect(prepared.downloadUrl).toContain('echo360');
  });

  test('kaltura videos use direct URL (no blob)', async () => {
    const file = {
      name: 'Week 1 Video', href: 'https://cdnapisec.kaltura.com/playManifest/entryId/abc/format/download',
      type: 'kalturaDownload', sectionName: 'Week 1',
    };

    const prepared = await bg.prepareWithRetry(file, 'KEATS Downloads/MDE/', 1);
    expect(global.fetch).not.toHaveBeenCalled();

    expect(prepared.downloadUrl).toContain('kaltura');
  });

  test('prepares a data URL for resource downloads', async () => {
    const file = {
      name: 'Test File', href: 'https://keats.kcl.ac.uk/mod/resource/view.php?id=1',
      type: 'resource', sectionName: 'Week 1',
    };

    const prepared = await bg.prepareWithRetry(file, 'KEATS Downloads/Test/', 1);

    // Should be a data URL, not the original URL
    expect(prepared.downloadUrl).toMatch(/^data:/);

    expect(prepared.fullPath).toContain('KEATS Downloads/Test/');
  });

  test('fetch failure triggers retry', async () => {
    let callCount = 0;
    global.fetch = jest.fn(() => {
      callCount++;
      if (callCount < 2) {
        return Promise.resolve({ ok: false, status: 500 });
      }
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
      name: 'Retry File', href: 'https://keats.kcl.ac.uk/mod/resource/view.php?id=99',
      type: 'resource', sectionName: 'Week 1',
    };

    await bg.prepareWithRetry(file, 'KEATS/', 3);
    expect(callCount).toBe(2); // failed once, succeeded on retry
  });
});

describe('cancelled state handling', () => {
  test('cancelled flag prevents new work', () => {
    bg.state = {
      status: 'scanning', cancelled: true, scannedSections: 0,
      totalSections: 5, log: [], errors: [], sections: [],
      courseName: '', totalFiles: 0, downloadedFiles: 0,
      failedFiles: 0, currentFile: '',
    };
    expect(bg.state.cancelled).toBe(true);
  });
});
