/** @jest-environment-options {"url": "https://keats.kcl.ac.uk/course/view.php?id=100"} */
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { Blob } = require('node:buffer');
const { randomUUID, webcrypto } = require('node:crypto');
const { TextEncoder } = require('node:util');
const browserBlob = global.Blob;
const browserAbortSignal = global.AbortSignal;
const { createChromeMock } = require('./chrome-mock');
const { fixturePdf } = require('./fixtures/elementary-logic/pdf');

const origin = location.origin;
const courseUrl = location.href;
const fixture = name => readFileSync(join(__dirname, 'fixtures', 'elementary-logic', name + '.html'), 'utf8');
const week = 'Week 1 - Introduction to Propositional Logic';
const slides = count => 'Lecture Slides - Week 1 (' + count + ' slide' + (count === 1 ? '' : 's') + ' per page).pdf';
const page = id => '/mod/page/view.php?id=' + id;
const pluginfile = name => '/pluginfile.php/110/mod_page/content/0/' + encodeURIComponent(name);
const mock = createChromeMock();
global.chrome = mock;
let bg;

Object.defineProperty(HTMLElement.prototype, 'innerText', { get() { return this.textContent; } });

function response(path, body, type = 'text/html', disposition = '', status = 200) {
  return {
    ok: status === 200,
    status,
    url: origin + path,
    headers: { get: name => name === 'Content-Disposition' ? disposition : type },
    text: async () => body,
    blob: async () => new Blob([body], { type }),
  };
}

function appendActivity(id, name) {
  const section = document.querySelector('[data-id="41"]');
  section.insertAdjacentHTML('beforeend', '<div class="activity modtype_page"><a href="' +
    page(id) + '">' + name + '</a></div>');
}

async function waitForJob(predicate) {
  for (let attempt = 0; attempt < 80; attempt++) {
    await jest.advanceTimersByTimeAsync(250);
    const job = await bg.serviceJob();
    if (predicate(job)) return job;
  }
  throw new Error('Job did not reach the expected state: ' + JSON.stringify(bg.publicState()));
}

async function scan(sections) {
  const selected = sections.map(section => ({ href: courseUrl + '#week-' + section.sectionId, ...section }));
  const started = await bg.beginScan(1, { courseName: 'Elementary Logic', courseUrl, sections: selected });
  expect(started.ok).toBe(true);
  const preview = await waitForJob(job => ['preview', 'error'].includes(job.status));
  expect(preview.status).toBe('preview');
  expect(mock.downloads.download).not.toHaveBeenCalled();
  return preview;
}

async function run(sections) {
  const preview = await scan(sections);
  expect(await bg.confirmDownload(preview.jobId)).toEqual({ ok: true });
  await waitForJob(job => job.status === 'complete');
}

function reloadWorker() {
  mock.downloads._clearListeners();
  jest.isolateModules(() => { bg = require('../extension/background'); });
}

beforeEach(() => {
  jest.useFakeTimers();
  Object.defineProperty(global.crypto, 'randomUUID', { configurable: true, value: randomUUID });
  Object.defineProperty(global.crypto, 'subtle', { configurable: true, value: webcrypto.subtle });
  global.TextEncoder = TextEncoder;
  mock.storage.local._clear();
  mock.storage.session._clear();
  mock.downloads.download.mockClear();
  mock.downloads._clearItems();
  mock.downloads._setAutoComplete(true);
  reloadWorker();
  document.body.innerHTML = fixture('course');
  mock.tabs.update.mockImplementation((id, { url }, callback) => {
    callback();
    mock.tabs.onUpdated.addListener.mock.lastCall[0](id, { status: 'complete', url });
  });
  mock.scripting.executeScript.mockImplementation(async ({ func, args = [] }) => {
    if (func.name === 'scrapeFolderPage') {
      const old = document.body.innerHTML;
      document.body.innerHTML = '<main id="region-main"><a href="/pluginfile.php/310/mod_folder/content/0/exercise.txt">Exercise</a></main>';
      const result = func(...args);
      document.body.innerHTML = old;
      return [{ result }];
    }
    return [{ result: await func(...args) }];
  });

  global.Blob = Blob;
  global.AbortSignal = { timeout: () => new AbortController().signal };
  jest.spyOn(global, 'FileReader').mockImplementation(function () {
    this.readAsDataURL = async blob => {
      this.result = 'data:' + blob.type + ';base64,' + Buffer.from(await blob.arrayBuffer()).toString('base64');
      this.onload();
    };
  });
  global.fetch = jest.fn(async href => {
    const url = new URL(href);
    const id = url.searchParams.get('id');
    if (url.pathname === '/mod/page/view.php' && id === '110') return response(page(id), fixture('slide-pack'));
    if (url.pathname === '/mod/resource/view.php' && id === '210') return response(pluginfile('ordinary.pdf'), fixturePdf(0), 'application/pdf');
    if (url.pathname === '/mod/resource/view.php' && id === '211') return response(pluginfile('ordinary.pptx'), 'slides', 'application/octet-stream');
    if (url.pathname === '/mod/resource/view.php' && id === '212' && url.searchParams.get('redirect') === '1') {
      return response(pluginfile(slides(2)), fixturePdf(2), 'application/pdf');
    }
    if (decodeURIComponent(url.pathname) === decodeURIComponent(pluginfile(slides(1)))) return response(url.pathname, fixturePdf(1), 'application/pdf');
    if (url.pathname === '/pluginfile.php') {
      return response(url.pathname + url.search, fixturePdf(4), 'application/octet-stream',
        "attachment; filename=wrong.pdf; filename*=UTF-8''" + encodeURIComponent(slides(4)));
    }
    if (url.pathname.endsWith('/exercise.txt')) return response(url.pathname, 'practice', 'text/plain');
    throw new Error('Unexpected request in fixture');
  });
});

afterEach(() => {
  jest.restoreAllMocks();
  global.Blob = browserBlob;
  global.AbortSignal = browserAbortSignal;
  jest.useRealTimers();
});

test.each([
  ['standalone', [{ name: week, href: origin + '/course/section.php?id=41' }]],
  ['all inline', [{ name: week, inline: true, sectionId: '41' }]],
  ['mixed', [{ name: week, inline: true, sectionId: '41' }, { name: 'Other week', href: courseUrl }]],
])('discovers and downloads the three layouts through the %s course scan', async (_format, sections) => {
  await run(sections);
  expect(bg.state.status).toBe('complete');
  expect(bg.state.errors).toEqual([]);
  const downloads = mock.downloads.download.mock.calls.map(([file]) => file);
  const layouts = downloads.filter(file => /\/Lecture Slides - Week 1/.test(file.filename));
  expect(layouts).toHaveLength(3);
  for (const count of [1, 2, 4]) {
    const file = layouts.find(file => file.filename.endsWith('/Lectures/' + slides(count)));
    expect(file.conflictAction).toBe('uniquify');
    expect(file.url).toBe('data:application/pdf;base64,' + fixturePdf(count).toString('base64'));
  }
  expect(downloads.some(file => file.filename.endsWith('/ordinary.pdf'))).toBe(true);
  expect(downloads.some(file => file.filename.endsWith('/ordinary.pptx'))).toBe(true);
  expect(downloads.some(file => file.filename.endsWith('/Exercises/exercise.txt'))).toBe(true);
  expect(fetch.mock.calls.filter(([href]) => href === origin + page(110))).toHaveLength(1);
  expect(fetch.mock.calls.filter(([href]) => decodeURIComponent(href).includes(decodeURIComponent(pluginfile(slides(1)))))).toHaveLength(1);
  expect(fetch.mock.calls.some(([href]) => href.includes('id=911') || href.includes('id=912'))).toBe(false);
  expect(fetch).toHaveBeenCalledWith(origin + page(110), expect.objectContaining({
    mode: 'same-origin', credentials: 'same-origin',
  }));
});

test('isolates inaccessible pages, sign-in redirects and invalid files, and skips duplicate final file URLs', async () => {
  appendActivity(110, 'Duplicate slide pack');
  appendActivity(112, 'Unavailable');
  appendActivity(113, 'Session expired');
  appendActivity(114, 'Empty page');
  appendActivity(115, 'Extra links');
  const regularRoutes = fetch.getMockImplementation();
  fetch.mockImplementation(async href => {
    const url = new URL(href);
    switch (url.pathname + url.search) {
      case page(112): return response(page(112), '', 'text/html', '', 404);
      case page(113): return response('/login/index.php', '<form id="login"></form>');
      case page(114): return response(page(114), '<main><a href="/course/view.php?id=100">Course</a></main>');
      case page(115): return response(page(115), '<main><a href="' + page(115) + '#back">Cycle</a>' +
        '<a href="' + pluginfile(slides(2)) + '">Same file via pluginfile</a>' +
        '<a href="/broken.pdf">Broken PDF</a><a href="/impostor.pdf">Fake PDF</a>' +
        '<a href="/login-file.pdf">Expired file link</a><a href="https://example.invalid/file.pdf">External PDF</a></main>');
      case pluginfile(slides(2)): return response(url.pathname, fixturePdf(2), 'application/pdf');
      case '/broken.pdf': return response(url.pathname, '<html>Error</html>', 'application/pdf');
      case '/impostor.pdf': return response(url.pathname, 'not a PDF', 'application/pdf');
      case '/login-file.pdf': return response('/login/index.php', '<form id="login"></form>');
      default: return regularRoutes(href);
    }
  });

  await run([{ name: week, inline: true, sectionId: '41' }]);
  expect(bg.state.status).toBe('complete');
  expect(bg.state.downloadedFiles).toBe(6);
  expect(bg.state.failedFiles).toBe(3);
  expect(bg.state.errors).toEqual(expect.arrayContaining([
    { name: 'Unavailable', error: 'HTTP 404' },
    { name: 'Session expired', error: 'KEATS session expired or sign-in is required.' },
    { name: 'Broken PDF', error: 'Moodle returned HTML instead of a file.' },
    { name: 'Fake PDF', error: 'The response has no valid PDF header.' },
    { name: 'Expired file link', error: 'KEATS session expired or sign-in is required.' },
  ]));
  expect(bg.state.log).toContain('  No downloadable files found on page: Empty page');
  expect(bg.state.log.some(line => line.startsWith('Skipped duplicate:'))).toBe(true);
  expect(fetch.mock.calls.filter(([href]) => href === origin + page(110))).toHaveLength(1);
  expect(fetch.mock.calls.filter(([href]) => href.startsWith(origin + page(115)))).toHaveLength(1);
  expect(fetch.mock.calls.some(([href]) => href.includes('example.invalid'))).toBe(false);
});

test('bounds Page traversal depth and never records opaque access queries in history', async () => {
  appendActivity(120, 'First child');
  const regularRoutes = fetch.getMockImplementation();
  fetch.mockImplementation(async href => {
    const url = new URL(href);
    const id = Number(url.searchParams.get('id'));
    if (id >= 120 && id <= 123) {
      return response(page(id), '<main><a href="' + page(id + 1) + '">Child</a></main>');
    }
    return regularRoutes(href);
  });
  await run([{ name: week, inline: true, sectionId: '41' }]);
  expect(fetch.mock.calls.some(([href]) => href === origin + page(122))).toBe(true);
  expect(fetch.mock.calls.some(([href]) => href === origin + page(123))).toBe(false);
  expect(bg.state.log.some(line => line.includes('depth limit reached'))).toBe(true);
  expect(bg.fileKey('Elementary Logic', { type: 'pageFile', href: origin + '/notes.pdf?token=fixture' })).toBeNull();
});


const inlineWeek = [{ name: week, inline: true, sectionId: '41' }];

function leaveOnlyOrdinaryPdf() {
  for (const activity of document.querySelectorAll('.activity')) {
    if (!activity.querySelector('a[href$="id=210"]')) activity.remove();
  }
}

test('previews only the selected week and rejects stale and repeated confirmations', async () => {
  document.querySelector('#region-main').insertAdjacentHTML('beforeend',
    '<section class="section course-section" data-id="42"><div class="activity modtype_resource">' +
    '<a href="/mod/resource/view.php?id=999">Unselected week</a></div></section>');
  const preview = await scan(inlineWeek);
  expect(preview.totalFiles).toBe(6);
  expect(preview.skippedFiles).toBe(1);
  expect(preview.items.every(item => item.sectionName === week)).toBe(true);
  expect(preview.items.filter(item => item.typeLabel === 'Moodle Page file' && item.status === 'queued')).toHaveLength(3);
  expect(fetch.mock.calls.every(([href]) => !href.includes('/pluginfile.php') && !href.includes('/mod/resource/'))).toBe(true);
  expect(await bg.confirmDownload('previous-job')).toMatchObject({ ok: false });
  expect(mock.runtime.onMessage.addListener.mock.lastCall[0]({ type: 'START_DOWNLOAD' }, {}, jest.fn())).toBe(false);
  expect(mock.downloads.download).not.toHaveBeenCalled();
  expect(await bg.confirmDownload(preview.jobId)).toEqual({ ok: true });
  expect(await bg.confirmDownload(preview.jobId)).toMatchObject({ ok: false });
  await waitForJob(job => job.status === 'complete');
  expect(fetch.mock.calls.some(([href]) => href.includes('id=999'))).toBe(false);
});

test('recognizes Phase 1 history across section changes and distinguishes identical labels', async () => {
  const original = origin + '/mod/resource/view.php?id=210';
  const legacyKey = 'Elementary Logic|Previous week|Lectures|' + original;
  await mock.storage.local.set({ downloadHistory: {
    [legacyKey]: { course: 'Elementary Logic', name: 'Earlier title', date: 1 },
  } });
  for (const link of document.querySelectorAll('.modtype_resource a')) link.textContent = 'Same title';
  const preview = await scan(inlineWeek);
  expect(preview.items.filter(item => item.name === 'Same title').map(item => item.reason))
    .toEqual(['Already downloaded', '']);
  expect(await bg.confirmDownload(preview.jobId)).toEqual({ ok: true });
  await waitForJob(job => job.status === 'complete');
  await bg.cancelJob(preview.jobId);
  mock.downloads.download.mockClear();
  const rescan = await scan(inlineWeek);
  expect(rescan.totalFiles).toBe(0);
  expect(rescan.items.every(item => item.reason === 'Already downloaded')).toBe(true);
  expect(await bg.confirmDownload(rescan.jobId)).toMatchObject({ ok: false });
});

test('restores a preview and Chrome progress after worker recreation and records only completed downloads', async () => {
  leaveOnlyOrdinaryPdf();
  mock.downloads._setAutoComplete(false);
  const preview = await scan(inlineWeek);
  reloadWorker();
  expect(await bg.serviceJob()).toMatchObject({ status: 'preview', jobId: preview.jobId, totalFiles: 1 });
  expect(mock.downloads.download).not.toHaveBeenCalled();
  expect(await bg.confirmDownload(preview.jobId)).toEqual({ ok: true });
  const running = await waitForJob(job => job.items[0]?.status === 'in_progress');
  const id = running.items[0].downloadId;
  expect(running.downloadedFiles).toBe(0);
  expect((await mock.storage.local.get('downloadHistory')).downloadHistory).toBeUndefined();
  mock.downloads._update(id, { bytesReceived: 48 });
  reloadWorker();
  expect(await bg.serviceJob()).toMatchObject({ status: 'downloading', downloadedFiles: 0,
    items: [expect.objectContaining({ downloadId: id, status: 'in_progress', bytesReceived: 48 })] });
  mock.downloads._update(id, { state: 'complete', bytesReceived: 100 });
  const done = await waitForJob(job => job.status === 'complete');
  expect(done.downloadedFiles).toBe(1);
  expect(mock.downloads.download).toHaveBeenCalledTimes(1);
  expect(Object.values((await mock.storage.local.get('downloadHistory')).downloadHistory))
    .toEqual([expect.objectContaining({ downloadId: id, identities: expect.any(Array) })]);
});

test('recovers Chrome submission whose ID was not committed before the worker stopped', async () => {
  leaveOnlyOrdinaryPdf();
  mock.downloads._setAutoComplete(false);
  const preview = await scan(inlineWeek);
  await bg.confirmDownload(preview.jobId);
  const running = await waitForJob(job => job.items[0]?.status === 'in_progress');
  const id = running.items[0].downloadId;
  const { phase2Job } = await mock.storage.session.get('phase2Job');
  delete phase2Job.items[0].downloadId;
  phase2Job.items[0].status = 'submitting';
  await mock.storage.session.set({ phase2Job });
  reloadWorker();
  expect(await bg.serviceJob()).toMatchObject({ items: [expect.objectContaining({ status: 'in_progress', downloadId: id })] });
  mock.downloads._update(id, { state: 'complete' });
  await waitForJob(job => job.status === 'complete');
  expect(mock.downloads.download).toHaveBeenCalledTimes(1);
});

test('retries a transient Chrome interruption and reports a permanent error without adding history', async () => {
  leaveOnlyOrdinaryPdf();
  mock.downloads._setAutoComplete(false);
  const preview = await scan(inlineWeek);
  await bg.confirmDownload(preview.jobId);
  const first = await waitForJob(job => job.items[0]?.status === 'in_progress');
  const firstId = first.items[0].downloadId;
  mock.downloads._update(firstId, { state: 'interrupted', error: 'NETWORK_FAILED' });
  const second = await waitForJob(job => job.items[0]?.status === 'in_progress' && job.items[0].downloadId !== firstId);
  mock.downloads._update(second.items[0].downloadId, { state: 'interrupted', error: 'FILE_FAILED' });
  const done = await waitForJob(job => job.status === 'complete');
  expect(done).toMatchObject({ downloadedFiles: 0, failedFiles: 1 });
  expect(done.errors).toContainEqual({ name: 'Ordinary handout', error: 'FILE_FAILED' });
  expect((await mock.storage.local.get('downloadHistory')).downloadHistory).toBeUndefined();
});

test('cancels a Chrome download and keeps it out of completed history', async () => {
  leaveOnlyOrdinaryPdf();
  mock.downloads._setAutoComplete(false);
  const preview = await scan(inlineWeek);
  await bg.confirmDownload(preview.jobId);
  const running = await waitForJob(job => job.items[0]?.status === 'in_progress');
  expect(await bg.cancelJob(preview.jobId)).toEqual({ ok: true });
  const done = await waitForJob(job => job.status === 'cancelled');
  expect(mock.downloads.cancel).toHaveBeenCalledWith(running.items[0].downloadId);
  expect(done).toMatchObject({ downloadedFiles: 0, items: [expect.objectContaining({ status: 'cancelled' })] });
  expect((await mock.storage.local.get('downloadHistory')).downloadHistory).toBeUndefined();
});


test('keeps signed links out of storage and requires fresh confirmation when a link expires', async () => {
  leaveOnlyOrdinaryPdf();
  document.querySelector('[data-id="41"]').insertAdjacentHTML('beforeend',
    '<div class="activity modtype_resource"><a href="/mod/resource/view.php?id=213&amp;token=fixture-secret">Signed handout</a></div>');
  const preview = await scan(inlineWeek);
  expect(preview.totalFiles).toBe(2);
  expect(JSON.stringify(preview)).not.toContain('fixture-secret');
  expect(JSON.stringify(await mock.storage.session.get('phase2Job'))).not.toContain('fixture-secret');
  reloadWorker();
  expect(await bg.confirmDownload(preview.jobId)).toMatchObject({ ok: false });
  const updated = await bg.serviceJob();
  expect(updated).toMatchObject({ status: 'preview', totalFiles: 1 });
  expect(updated.jobId).not.toBe(preview.jobId);
  expect(updated.items).toContainEqual(expect.objectContaining({ name: 'Signed handout', status: 'unavailable' }));
  expect(mock.downloads.download).not.toHaveBeenCalled();
});

test('does not start if Chrome cannot persist the user confirmation', async () => {
  leaveOnlyOrdinaryPdf();
  const preview = await scan(inlineWeek);
  mock.storage.session.set.mockRejectedValueOnce(new Error('Storage temporarily unavailable'));
  await expect(bg.confirmDownload(preview.jobId)).rejects.toThrow('Storage temporarily unavailable');
  expect(await bg.serviceJob()).toMatchObject({ status: 'preview', jobId: preview.jobId });
  expect(mock.downloads.download).not.toHaveBeenCalled();
});

test('remembers a redirect alias on the completed entry without counting a second download', async () => {
  leaveOnlyOrdinaryPdf();
  document.querySelector('[data-id="41"]').insertAdjacentHTML('beforeend',
    '<div class="activity modtype_resource"><a href="/mod/resource/view.php?id=213">Same PDF, different activity</a></div>');
  const regularRoutes = fetch.getMockImplementation();
  fetch.mockImplementation(async href => {
    if (href.includes('id=213')) return regularRoutes(href.replace('id=213', 'id=210'));
    return regularRoutes(href);
  });
  const preview = await scan(inlineWeek);
  expect(preview.totalFiles).toBe(2);
  await bg.confirmDownload(preview.jobId);
  const done = await waitForJob(job => job.status === 'complete');
  expect(done).toMatchObject({ downloadedFiles: 1, skippedFiles: 1 });
  expect(Object.keys((await mock.storage.local.get('downloadHistory')).downloadHistory)).toHaveLength(1);
  await bg.cancelJob(preview.jobId);
  mock.downloads.download.mockClear();
  const rescan = await scan(inlineWeek);
  expect(rescan).toMatchObject({ totalFiles: 0, skippedFiles: 2 });
  expect(rescan.items.every(item => item.reason === 'Already downloaded')).toBe(true);
});
