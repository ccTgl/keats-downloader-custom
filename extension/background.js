// Background service worker - orchestrates scraping and downloads
// Supports any Moodle-based LMS (KEATS, Moodle, etc.) + Echo360 lecture recordings


let state = emptyState();

// ==================== New file detection ====================

const _recentChecks = {};

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete' || !tab.url) return;

  // Clear badge when navigating away from a course page
  if (!/\/course\/view\.php/.test(tab.url)) {
    chrome.action.setBadgeText({ text: '', tabId });
    return;
  }

  // Debounce: skip if same tab+URL checked in last 60s
  const cacheKey = `${tabId}:${tab.url.split('#')[0]}`;
  const now = Date.now();
  if (_recentChecks[cacheKey] && now - _recentChecks[cacheKey] < 60000) return;
  _recentChecks[cacheKey] = now;

  // Don't check during active download
  if (state.status === 'scanning' || state.status === 'downloading') return;

  try { await checkForNewFiles(tabId); } catch (e) {}
});

chrome.tabs.onRemoved.addListener((tabId) => {
  for (const key of Object.keys(_recentChecks)) {
    if (key.startsWith(`${tabId}:`)) delete _recentChecks[key];
  }
});

function scrapeFileHrefsLightweight() {
  const h1 = document.querySelector('h1');
  const courseName = h1 ? h1.textContent.trim() : document.title.trim();
  const hrefs = new Set();

  const selectors = [
    '.activity.modtype_resource a[href*="/mod/resource/"]',
    '.activity.modtype_folder a[href*="/mod/folder/"]',
    '.activity.modtype_kalvidres a[href*="/mod/kalvid"]',
    '.activity.modtype_kalvidpres a[href*="/mod/kalvid"]',
  ];

  for (const sel of selectors) {
    for (const link of document.querySelectorAll(sel)) {
      hrefs.add(link.href);
    }
  }

  return { courseName, courseUrl: location.href, hrefs: [...hrefs] };
}

async function checkForNewFiles(tabId) {
  const result = await chrome.scripting.executeScript({
    target: { tabId },
    func: scrapeFileHrefsLightweight,
  });

  const data = result[0]?.result;
  if (!data || !data.courseName || data.hrefs.length === 0) {
    chrome.action.setBadgeText({ text: '', tabId });
    return;
  }

  const history = await getDownloadHistory();
  const courseName = sanitize(data.courseName).substring(0, 80);

  const known = await historyIdentities(history, courseName, courseIdentity(data.courseUrl));
  // Folder and media containers can only be compared after a full scan.
  const links = data.hrefs.filter(href => MOODLE_RESOURCE.test(parsePageUrl(href)?.pathname || ''));
  const identities = new Set((await Promise.all(links.map(href => resourceIdentity(href)))).filter(Boolean));
  const newCount = [...identities].some(identity => known.has(identity))
    ? [...identities].filter(identity => !known.has(identity)).length : 0;

  if (newCount > 0) {
    chrome.action.setBadgeBackgroundColor({ color: '#c1002a', tabId });
    chrome.action.setBadgeText({ text: String(newCount), tabId });
  } else {
    chrome.action.setBadgeText({ text: '', tabId });
  }

  // Store for popup to read
  await chrome.storage.session.set({
    [`newFiles:${tabId}`]: { count: newCount, courseName, timestamp: Date.now() }
  });
}

// ==================== Download history ====================

async function getDownloadHistory() {
  const data = await chrome.storage.local.get('downloadHistory');
  return data.downloadHistory || {};
}

async function saveDownloadHistory(history) {
  await chrome.storage.local.set({ downloadHistory: history });
}

function fileKey(courseName, file) {
  // Unique key: course + section + category + filename href
  if (file.type === 'pageFile') {
    const link = pageLinkKey(file.href, true);
    return link ? `${courseName}|||page:${link}` : null;
  }
  return `${courseName}|${file.sectionName || ''}|${file.category || ''}|${file.href}`;
}

// ---------- Preview and durable download job ----------

const JOB_STORAGE = 'phase2Job';
const DOWNLOAD_ALARM = 'phase2Downloads';
const DOWNLOAD_SLOTS = 3;
let jobLoaded = false;
let jobLock = Promise.resolve();
let knownIdentities;

function emptyState() {
  return {
    status: 'idle', courseName: '', totalFiles: 0, downloadedFiles: 0, failedFiles: 0, skippedFiles: 0,
    scannedSections: 0, totalSections: 0, currentFile: '', log: [], errors: [], sections: [],
    cancelled: false, items: [],
  };
}

function withJobLock(action) {
  const result = jobLock.then(action);
  jobLock = result.catch(() => {});
  return result;
}

async function loadJob() {
  if (jobLoaded) return;
  const stored = (await chrome.storage.session.get(JOB_STORAGE))[JOB_STORAGE];
  jobLoaded = true;
  if (!stored) return;
  state = stored;
  if (state.status === 'scanning') {
    if (Number.isInteger(state.scanTabId)) await chrome.tabs.remove(state.scanTabId).catch(() => {});
    delete state.scanTabId;
    state.status = state.cancelled ? 'cancelled' : 'error';
    state.errors.push({ name: 'Scan', error: 'The scan stopped before preview. Start a new scan.' });
    await persistJob();
  } else if (state.status === 'downloading') {
    // Preparation can be repeated. A possible Chrome submission must be reconciled first.
    for (const item of state.items) {
      if (item.status === 'preparing') item.status = 'queued';
    }
  } else if (state.status === 'preview') {
    let changed = false;
    for (const item of state.items) {
      if (!item.eligible || item.href) continue;
      item.status = 'unavailable';
      item.eligible = false;
      item.reason = 'Temporary link expired. Scan again to refresh it.';
      state.errors.push({ name: item.name, error: item.reason });
      changed = true;
    }
    if (changed) {
      state.jobId = crypto.randomUUID();
      state.totalFiles = state.items.filter(item => item.eligible).length;
      await persistJob();
    }
  }
}

function safeStoredUrl(href) {
  const url = parsePageUrl(href);
  if (!url || url.protocol !== 'https:' || url.username || url.password ||
      /\/(?:ks|token|access_token)\//i.test(url.pathname)) return null;
  for (const [key, value] of url.searchParams) {
    if (/^(?:id|p|section|redirect|forceview|inpopup|forcedownload)$/.test(key) && /^\d+$/.test(value)) continue;
    if (key === 'file' && MOODLE_FILE.test(url.pathname) && value.startsWith('/')) continue;
    return null;
  }
  url.hash = '';
  return url.href;
}

function persistJob() {
  const items = state.items.map(item => {
    const { href, ...file } = item;
    // Video and signed URLs may contain access tokens. Keep those in worker memory.
    const storedHref = safeStoredUrl(href);
    return storedHref && ['queued', 'preparing', 'waiting', 'submitting', 'in_progress'].includes(item.status)
      ? { ...file, href: storedHref } : file;
  });
  return chrome.storage.session.set({ [JOB_STORAGE]: { ...state, items } });
}

function publicState() {
  const { items = [], courseKey, scanTabId, ...summary } = state;
  const rows = items.map(item => ({
    name: item.name, sectionName: item.sectionName, category: item.category, folderName: item.folderName,
    typeLabel: { resource: 'File', pageFile: 'Moodle Page file', folderFile: 'Folder file',
      kalturaDownload: 'Kaltura', echo360: 'Echo360' }[item.type],
    status: item.status, reason: item.reason, error: item.error, bytesReceived: item.bytesReceived,
    totalBytes: item.totalBytes, downloadId: item.downloadId,
  }));
  return { ...summary, items: rows };
}

async function fingerprint(value) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
}

async function resourceIdentity(href, resourceId) {
  if (resourceId) return resourceId;
  const url = parsePageUrl(pageLinkKey(href));
  if (!url) return null;
  const entry = url.pathname.match(/\/entryId\/([^/]+)/i);
  if (entry && /(?:^|\.)kaltura\.com$/i.test(url.hostname)) {
    const partner = url.pathname.match(/\/p\/(\d+)/);
    if (partner) return 'kaltura:' + partner[1] + ':' + entry[1];
  }
  for (const key of [...url.searchParams.keys()]) {
    if (/^(?:access_?token|token|sesskey|signature|policy|key-pair-id|expires|x-amz-.+)$/i.test(key)) {
      url.searchParams.delete(key);
    }
  }
  return safeStoredUrl(url.href) ? 'url:' + url.href : 'sha256:' + await fingerprint(url.href);
}

function courseIdentity(href) {
  const url = parsePageUrl(href);
  if (!url || url.protocol !== 'https:' || url.username || url.password) return null;
  const id = url.searchParams.get('id');
  return url.origin + url.pathname + (/^\d+$/.test(id || '') ? '?id=' + id : '');
}

async function historyIdentities(history, courseName, courseKey) {
  const identities = new Set();
  for (const [key, record] of Object.entries(history)) {
    if (record.courseKey) {
      if (record.courseKey === courseKey) for (const identity of record.identities || []) identities.add(identity);
      continue;
    }
    if (record.course !== courseName) continue;
    const href = key.split('|').slice(3).join('|').replace(/^page:/, '');
    const identity = await resourceIdentity(href);
    if (identity) identities.add(identity);
  }
  return identities;
}

async function rememberDownload(item, download) {
  const history = await getDownloadHistory();
  const identities = [...new Set([item.identity, item.resolvedIdentity].filter(Boolean))];
  history['v2|' + state.courseKey + '|' + item.identity] = {
    name: item.name, path: download.filename || item.fullPath, date: Date.now(),
    course: state.courseName, courseKey: state.courseKey, identities, downloadId: download.id,
  };
  await saveDownloadHistory(history);
  if (knownIdentities) for (const identity of identities) knownIdentities.add(identity);
}

function recountJob() {
  state.downloadedFiles = state.items.filter(item => item.status === 'complete').length;
  state.failedFiles = state.items.filter(item => item.status === 'failed').length;
  state.skippedFiles = state.items.filter(item => item.status === 'duplicate').length;
  state.processedFiles = state.items.filter(item => item.eligible &&
    ['complete', 'failed', 'duplicate', 'cancelled'].includes(item.status)).length;
  const active = state.items.filter(item => ['preparing', 'submitting', 'in_progress'].includes(item.status));
  state.activeFiles = active.length;
  state.currentFile = active[0]?.name || '';
}

async function checkpoint() {
  recountJob();
  await persistJob();
  broadcastProgress();
}

async function beginScan(tabId, courseInfo, options = {}) {
  return withJobLock(async () => {
    await loadJob();
    if (['scanning', 'preview', 'downloading'].includes(state.status)) {
      return { ok: false, error: 'Finish or discard the current job first.' };
    }
    const courseKey = courseIdentity(courseInfo?.courseUrl);
    if (!courseKey || !Number.isInteger(tabId) || !Array.isArray(courseInfo.sections) || !courseInfo.sections.length) {
      return { ok: false, error: 'Choose at least one section from an HTTPS course page.' };
    }
    const origin = new URL(courseKey).origin;
    if (courseInfo.sections.some(section => parsePageUrl(section.href)?.origin !== origin)) {
      return { ok: false, error: 'Selected sections must belong to the course site.' };
    }
    const courseName = sanitize(courseInfo.courseName || 'Unknown').substring(0, 80) || 'Course';
    const folder = sanitize(options.downloadPath || 'KEATS Downloads') || 'KEATS Downloads';
    state = { ...emptyState(), status: 'scanning', jobId: crypto.randomUUID(), courseName, courseKey,
      basePath: folder + '/' + courseName + '/', totalSections: courseInfo.sections.length };
    knownIdentities = undefined;
    await checkpoint();
    void buildPreview(tabId, courseInfo, options);
    return { ok: true, jobId: state.jobId };
  });
}

async function buildPreview(tabId, courseInfo, options) {
  try {
    const files = await scanCourse(tabId, courseInfo, options);
    await withJobLock(async () => {
      if (state.cancelled) {
        state.status = 'cancelled';
      } else {
        const history = await getDownloadHistory();
        knownIdentities = await historyIdentities(history, state.courseName, state.courseKey);
        const candidates = await Promise.all(files.map(async file =>
          ({ ...file, identity: await resourceIdentity(file.href, file.resourceId) })));
        const first = new Map();
        for (const file of candidates) {
          const previous = first.get(file.identity);
          if (!previous || (previous.type === 'pageFile' && file.type !== 'pageFile')) first.set(file.identity, file);
        }
        for (const file of candidates) {
          if (!file.identity || !parsePageUrl(file.href)) {
            const reason = 'File link unavailable';
            state.items.push({ ...file, status: 'unavailable', reason });
            state.errors.push({ name: file.name, error: reason });
            continue;
          }
          const reason = (knownIdentities.has(file.identity) || history[fileKey(state.courseName, file)]) ? 'Already downloaded' :
            first.get(file.identity) !== file ? 'Duplicate in this scan' : '';
          state.items.push({ ...file, status: reason ? 'duplicate' : 'queued', reason, eligible: !reason });
        }
        state.totalFiles = state.items.filter(item => item.eligible).length;
        state.status = 'preview';
      }
      await checkpoint();
    });
  } catch {
    await withJobLock(async () => {
      state.status = state.cancelled ? 'cancelled' : 'error';
      if (!state.cancelled) state.errors.push({ name: 'Scan', error: 'The course scan failed. Check the course page and try again.' });
      await checkpoint();
    }).catch(reportJobFailure);
  }
}

async function confirmDownload(jobId) {
  const reply = await withJobLock(async () => {
    await loadJob();
    if (state.status !== 'preview' || state.jobId !== jobId || !state.totalFiles) {
      return { ok: false, error: 'There is no matching preview with files to download.' };
    }
    await chrome.alarms.create(DOWNLOAD_ALARM, { periodInMinutes: 1 });
    state.status = 'downloading';
    try {
      await checkpoint();
    } catch (error) {
      state.status = 'preview';
      await chrome.alarms.clear(DOWNLOAD_ALARM).catch(() => {});
      throw error;
    }
    return { ok: true };
  });
  if (reply.ok) wakeJob();
  return reply;
}

async function cancelJob(jobId) {
  const reply = await withJobLock(async () => {
    await loadJob();
    if (state.jobId !== jobId) return { ok: false };
    if (['scanning', 'downloading'].includes(state.status)) state.cancelled = true;
    else {
      state = emptyState();
      knownIdentities = undefined;
    }
    await checkpoint();
    return { ok: true };
  });
  if (reply.ok) wakeJob();
  return reply;
}

function failItem(item, message) {
  item.status = 'failed';
  item.error = message;
  state.errors.push({ name: item.name, error: message });
  addLog('Failed: ' + item.name + ' - ' + message);
}

async function reconcileSubmission(item) {
  const recent = await chrome.downloads.search({
    startedAfter: new Date(item.startedAt - 1).toISOString(), limit: 30,
  });
  const assigned = new Set(state.items.map(file => file.downloadId));
  const candidates = [];
  for (const download of recent) {
    if (download.byExtensionId === chrome.runtime.id && !assigned.has(download.id) && download.url &&
        await fingerprint(download.url) === item.submissionHash) candidates.push(download);
  }
  if (candidates.length === 1) {
    item.downloadId = candidates[0].id;
    item.status = 'in_progress';
  } else {
    failItem(item, 'Chrome did not return a recoverable download ID. Check Chrome Downloads before retrying.');
  }
}

async function reconcileDownload(item) {
  const [download] = await chrome.downloads.search({ id: item.downloadId });
  if (!download) {
    failItem(item, 'Chrome download record is missing.');
  } else if (download.state === 'complete') {
    await rememberDownload(item, download);
    item.status = 'complete';
    addLog('Downloaded: ' + item.name);
  } else if (download.state === 'interrupted') {
    if (state.cancelled && download.error === 'USER_CANCELED') item.status = 'cancelled';
    else if (!state.cancelled && item.href && (item.downloadRetries || 0) < 2 &&
        /^(NETWORK_FAILED|NETWORK_TIMEOUT|NETWORK_DISCONNECTED|NETWORK_SERVER_DOWN)$/.test(download.error)) {
      item.downloadRetries = (item.downloadRetries || 0) + 1;
      item.status = 'queued';
      delete item.downloadId;
      addLog('Retrying ' + item.name + ' after Chrome reported ' + download.error + '.');
    } else {
      failItem(item, download.error || 'Chrome interrupted the download.');
    }
  } else {
    item.bytesReceived = download.bytesReceived;
    item.totalBytes = download.totalBytes;
    if (state.cancelled) await chrome.downloads.cancel(item.downloadId).catch(() => {});
  }
}

function hasResolvedPeer(item, statuses) {
  return state.items.some(other => other !== item && statuses.includes(other.status) &&
    item.resolvedIdentity && (other.resolvedIdentity || other.identity) === item.resolvedIdentity);
}

async function skipResolvedDuplicate(item) {
  // Keep the alias on the completed entry so the next preview can skip it without fetching.
  const history = await getDownloadHistory();
  const record = Object.values(history).find(entry =>
    entry.courseKey === state.courseKey && entry.identities?.includes(item.resolvedIdentity));
  if (record && !record.identities.includes(item.identity)) {
    record.identities.push(item.identity);
    await saveDownloadHistory(history);
    knownIdentities?.add(item.identity);
  }
  item.status = 'duplicate';
  item.reason = 'Duplicate after redirect';
  addLog('Skipped duplicate: ' + item.name);
}

function serviceJob(publish = false) {
  return withJobLock(async () => {
    await loadJob();
    if (state.status !== 'downloading') return publicState();

    for (const item of state.items) {
      if (item.status === 'submitting') await reconcileSubmission(item);
      if (item.status === 'in_progress') await reconcileDownload(item);
      if (state.cancelled && ['queued', 'preparing', 'waiting'].includes(item.status)) item.status = 'cancelled';
    }
    for (const item of state.items.filter(file => file.status === 'waiting')) {
      if (hasResolvedPeer(item, ['complete'])) await skipResolvedDuplicate(item);
      else if (!hasResolvedPeer(item, ['submitting', 'in_progress'])) item.status = 'queued';
    }

    const active = state.items.filter(item => ['preparing', 'in_progress', 'submitting'].includes(item.status)).length;
    const next = state.items.filter(item => item.status === 'queued').slice(0, Math.max(0, DOWNLOAD_SLOTS - active));
    if (!active && !next.length) {
      state.status = state.cancelled ? 'cancelled' : 'complete';
      await chrome.alarms.clear(DOWNLOAD_ALARM);
    }
    for (const item of next) item.status = 'preparing';
    recountJob();
    await persistJob();
    if (publish) broadcastProgress();
    for (const item of next) void prepareItem(item, state.jobId, state.basePath);
    return publicState();
  });
}

async function prepareItem(item, jobId, basePath) {
  let prepared;
  let failure;
  try {
    if (!item.href) {
      failure = 'This temporary link expired when the worker stopped. Scan again to refresh it.';
    } else {
      prepared = await prepareWithRetry(item, basePath, 3, () => state.cancelled || state.jobId !== jobId);
    }
  } catch (error) {
    failure = item.type === 'pageFile' || /^HTTP \d+$/.test(error.message) ||
      error.message === 'Moodle returned HTML instead of a file.'
      ? error.message : 'Could not fetch or prepare this file.';
  }
  try {
    await withJobLock(async () => {
      if (state.jobId !== jobId || item.status !== 'preparing') return;
      if (state.cancelled) {
        item.status = 'cancelled';
      } else if (!prepared) {
        failItem(item, failure || 'File preparation stopped.');
      } else {
        item.resolvedIdentity = await resourceIdentity(prepared.responseUrl || item.href, item.resourceId);
        if (!knownIdentities) {
          knownIdentities = await historyIdentities(await getDownloadHistory(), state.courseName, state.courseKey);
        }
        if (knownIdentities.has(item.resolvedIdentity) || hasResolvedPeer(item, ['complete'])) {
          await skipResolvedDuplicate(item);
        } else if (hasResolvedPeer(item, ['in_progress', 'submitting'])) {
          item.status = 'waiting';
        } else {
          item.status = 'submitting';
          item.fullPath = prepared.fullPath;
          item.submissionHash = await fingerprint(prepared.downloadUrl);
          item.startedAt = Date.now();
          await persistJob();
          try {
            item.downloadId = await submitDownload(prepared.downloadUrl, prepared.fullPath);
            item.status = 'in_progress';
          } catch (error) {
            failItem(item, error.message);
          }
        }
      }
      await checkpoint();
    });
  } catch (error) {
    reportJobFailure(error);
  } finally {
    wakeJob();
  }
}

function reportJobFailure() {
  console.warn('KEATS Downloader could not update its job. It will retry reconciliation on the next status check.');
}

function wakeJob() {
  void serviceJob(true).catch(reportJobFailure);
}

// Top-level listeners wake a dormant Manifest V3 worker.
chrome.downloads.onChanged.addListener(delta => {
  if (delta.state) wakeJob();
});
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === DOWNLOAD_ALARM) wakeJob();
});

async function historySummary() {
  const history = await getDownloadHistory();
  const courses = Object.create(null);
  for (const entry of Object.values(history)) {
    const course = entry.course || 'Unknown';
    if (!courses[course]) courses[course] = { count: 0, lastDownload: 0 };
    courses[course].count++;
    courses[course].lastDownload = Math.max(courses[course].lastDownload, entry.date || 0);
  }
  return { total: Object.keys(history).length, courses };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  let reply;
  switch (msg.type) {
    case 'SCAN_COURSE': reply = beginScan(msg.tabId, msg.courseInfo, msg.options); break;
    case 'CONFIRM_DOWNLOAD': reply = confirmDownload(msg.jobId); break;
    case 'GET_STATUS': reply = serviceJob(); break;
    case 'CANCEL': reply = cancelJob(msg.jobId); break;
    case 'GET_HISTORY': reply = historySummary(); break;
    case 'CLEAR_HISTORY':
      reply = withJobLock(async () => {
        const history = msg.course ? await getDownloadHistory() : {};
        if (msg.course) for (const [key, entry] of Object.entries(history)) {
          if (entry.course === msg.course) delete history[key];
        }
        await saveDownloadHistory(history);
        knownIdentities = undefined;
        return { ok: true };
      });
      break;
    case 'CHECK_NEW_FILES': reply = checkForNewFiles(msg.tabId).then(() => ({ ok: true })); break;
    default: return false;
  }
  reply.then(sendResponse, () => sendResponse({ ok: false, error: 'The extension could not update the job.' }));
  return true;
});


// ---------- Fetch file as blob and resolve filename ----------

async function fetchFileBlob(url) {
  const resp = await fetch(url, { redirect: 'follow' });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

  // Resolve filename from headers
  const cd = resp.headers.get('Content-Disposition') || '';
  const match = cd.match(/filename\*?=["']?(?:UTF-8'')?([^"';\r\n]+)/i);
  let filename = null;
  if (match) {
    filename = sanitize(decodeURIComponent(match[1]));
  } else {
    const urlPath = new URL(resp.url).pathname;
    const urlFilename = decodeURIComponent(urlPath.split('/').pop());
    if (urlFilename && urlFilename.includes('.') && !urlFilename.endsWith('.php')) {
      filename = sanitize(urlFilename);
    }
  }

  const blob = await resp.blob();
  return { blob, filename, responseUrl: resp.url };
}

async function blobToDataUrl(blob) {
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const chunks = [];
  for (let i = 0; i < bytes.length; i += 8192) {
    chunks.push(String.fromCharCode.apply(null, bytes.subarray(i, i + 8192)));
  }
  const base64 = btoa(chunks.join(''));
  const mimeType = blob.type || 'application/octet-stream';
  return `data:${mimeType};base64,${base64}`;
}

// ---------- Core workflow ----------

async function scanCourse(tabId, courseInfo, options) {
  const courseName = state.courseName;
  const sectionCount = courseInfo.sections.length;
  const doMaterials = options.materials !== false;
  const doVideos = options.videos === true;
  const doCaptures = options.captures === true;
  const doFolders = options.folders !== false;
  const doOptional = options.optional === true;

  addLog(`Course: ${courseName}`);
  addLog(`Sections: ${sectionCount}`);
  if (doVideos) addLog(`Kaltura video download enabled`);
  if (doCaptures) addLog(`Echo360 capture download enabled`);
  broadcastProgress();

  const tempTab = await chrome.tabs.create({ url: 'about:blank', active: false });
  const tempTabId = tempTab.id;
  state.scanTabId = tempTabId;

  try {
    await persistJob();
    // ==================== Phase 1: Scan sections for files ====================
    const allFiles = [];
    const pageScan = { tabId, origin: parsePageUrl(courseInfo.courseUrl)?.origin, visited: new Set() };

    if (doMaterials || doVideos) {
      // Check if all sections are inline (topics/topcoll format)
      const allInline = courseInfo.sections.every(s => s.inline && s.sectionId);

      if (allInline && courseInfo.sections.length > 0) {
        // Batch scrape: all sections live on one page, scrape them all at once
        const coursePageUrl = courseInfo.courseUrl.split('#')[0];
        addLog(`Scanning all ${courseInfo.sections.length} sections...`);
        broadcastProgress();

        addLog(`Loading course page...`);
        broadcastProgress();
        await navigateTab(tempTabId, coursePageUrl);
        await sleep(1500);

        const sectionIds = courseInfo.sections.map(s => s.sectionId);
        addLog(`Expanding sections...`);
        broadcastProgress();

        // Expand any collapsed sections first, then wait for DOM to update
        const expandedCount = await executeScrape(tempTabId, expandCollapsedSections, sectionIds);
        if (expandedCount > 0) {
          addLog(`Expanded ${expandedCount} collapsed sections`);
          await sleep(1000);
        }

        addLog(`Scraping content...`);
        broadcastProgress();
        const batchResults = await executeScrape(tempTabId, scrapeAllInlineSections, sectionIds, doOptional, doVideos);

        for (let i = 0; i < courseInfo.sections.length; i++) {
          if (state.cancelled) break;
          const section = courseInfo.sections[i];
          const sectionName = sanitize(section.name);
          if (!sectionName || /^-+$/.test(sectionName)) continue;

          const files = batchResults[section.sectionId] || [];
          const expandedFiles = [];
          for (const file of files) {
            if (state.cancelled) break;
            if (!doMaterials && file.type !== 'kaltura') continue;
            if (file.type === 'page') {
              await expandMoodlePage(file, pageScan, expandedFiles);
            } else if (file.type === 'folder' && doFolders) {
              addLog(`  Expanding folder: ${file.name}`);
              await navigateTab(tempTabId, file.href);
              await sleep(800);
              const folderFiles = await executeScrape(tempTabId, scrapeFolderPage);
              for (const ff of folderFiles) {
                ff.category = file.category;
                ff.folderName = file.name;
                expandedFiles.push(ff);
              }
            } else if (file.type === 'kaltura' && doVideos) {
              addLog(`  Resolving video: ${file.name}`);
              await navigateTab(tempTabId, file.href);
              await sleep(2000);
              const videoInfo = await executeScrape(tempTabId, scrapeKalturaVideo);
              if (videoInfo && videoInfo.entryId) {
                const iframeSrc = await executeScrape(tempTabId, scrapeKalturaIframeSrc);
                if (iframeSrc) {
                  await navigateTab(tempTabId, iframeSrc);
                  await sleep(3000);
                  const innerInfo = await executeScrape(tempTabId, scrapeKalturaKS);
                  if (innerInfo && innerInfo.ksValues && innerInfo.ksValues.length > 0) {
                    if (innerInfo.partnerId) videoInfo.partnerId = innerInfo.partnerId;
                    let workingKs = null;
                    for (const ks of innerInfo.ksValues) {
                      try {
                        const testUrl = `https://cdnapisec.kaltura.com/api_v3/service/baseEntry/action/get?ks=${ks}&entryId=${videoInfo.entryId}&format=1`;
                        const resp = await fetch(testUrl);
                        const data = await resp.json();
                        if (data && data.id && !data.code) { workingKs = ks; break; }
                      } catch (e) { /* try next */ }
                    }
                    if (workingKs) {
                      videoInfo.downloadUrl = `https://cdnapisec.kaltura.com/p/${videoInfo.partnerId}/sp/${videoInfo.partnerId}00/playManifest/entryId/${videoInfo.entryId}/format/download/protocol/https/ks/${workingKs}`;
                    }
                  }
                }
                file.href = videoInfo.downloadUrl;
                file.type = 'kalturaDownload';
                file.resourceId = ['kaltura', videoInfo.partnerId, videoInfo.entryId].join(':');
                expandedFiles.push(file);
              } else {
                addLog(`  Could not resolve video: ${file.name}`);
              }
            } else if (file.type !== 'folder' && file.type !== 'kaltura') {
              expandedFiles.push(file);
            }
          }

          for (const file of expandedFiles) {
            file.sectionName = sectionName;
            file.courseName = courseName;
          }
          allFiles.push(...expandedFiles);
          state.sections.push({ name: sectionName, fileCount: expandedFiles.length });
          state.scannedSections++;
          addLog(`Scanned: ${sectionName} (${expandedFiles.length} files)`);
          broadcastProgress();
        }
      } else {
        // Grid format or mixed: navigate to each section page
        for (let i = 0; i < courseInfo.sections.length; i++) {
          if (state.cancelled) break;

          const section = courseInfo.sections[i];
          const sectionName = sanitize(section.name);
          if (!sectionName || /^-+$/.test(sectionName)) continue;

          state.scannedSections = i;
          addLog(`Scanning ${i + 1}/${courseInfo.sections.length}: ${sectionName}`);
          broadcastProgress();

          let files;
          if (section.inline && section.sectionId) {
            const coursePageUrl = courseInfo.courseUrl.split('#')[0];
            const currentUrl = await getTabUrl(tempTabId);
            if (!currentUrl || !currentUrl.includes(coursePageUrl.split('?')[0])) {
              await navigateTab(tempTabId, coursePageUrl);
              await sleep(1500);
            }
            files = await executeScrape(tempTabId, scrapeInlineSection, section.sectionId, doOptional, doVideos);
          } else {
            await navigateTab(tempTabId, section.href);
            await sleep(1000);
            files = await executeScrape(tempTabId, scrapeSectionPage, doOptional);
          }

          const expandedFiles = [];
          for (const file of files) {
            if (state.cancelled) break;
            if (!doMaterials && file.type !== 'kaltura') continue;
            if (file.type === 'page') {
              await expandMoodlePage(file, pageScan, expandedFiles);
            } else if (file.type === 'folder' && doFolders) {
              addLog(`  Expanding folder: ${file.name}`);
              await navigateTab(tempTabId, file.href);
              await sleep(800);
              const folderFiles = await executeScrape(tempTabId, scrapeFolderPage);
              for (const ff of folderFiles) {
                ff.category = file.category;
                ff.folderName = file.name;
                expandedFiles.push(ff);
              }
            } else if (file.type === 'kaltura' && doVideos) {
              addLog(`  Resolving video: ${file.name}`);
              await navigateTab(tempTabId, file.href);
              await sleep(2000);
              const videoInfo = await executeScrape(tempTabId, scrapeKalturaVideo);
              if (videoInfo && videoInfo.entryId) {
                const iframeSrc = await executeScrape(tempTabId, scrapeKalturaIframeSrc);
                if (iframeSrc) {
                  await navigateTab(tempTabId, iframeSrc);
                  await sleep(3000);
                  const innerInfo = await executeScrape(tempTabId, scrapeKalturaKS);
                  if (innerInfo && innerInfo.ksValues && innerInfo.ksValues.length > 0) {
                    if (innerInfo.partnerId) videoInfo.partnerId = innerInfo.partnerId;
                    let workingKs = null;
                    for (const ks of innerInfo.ksValues) {
                      try {
                        const testUrl = `https://cdnapisec.kaltura.com/api_v3/service/baseEntry/action/get?ks=${ks}&entryId=${videoInfo.entryId}&format=1`;
                        const resp = await fetch(testUrl);
                        const data = await resp.json();
                        if (data && data.id && !data.code) { workingKs = ks; break; }
                      } catch (e) { /* try next */ }
                    }
                    if (workingKs) {
                      videoInfo.downloadUrl = `https://cdnapisec.kaltura.com/p/${videoInfo.partnerId}/sp/${videoInfo.partnerId}00/playManifest/entryId/${videoInfo.entryId}/format/download/protocol/https/ks/${workingKs}`;
                    }
                  }
                }
                file.href = videoInfo.downloadUrl;
                file.type = 'kalturaDownload';
                file.resourceId = ['kaltura', videoInfo.partnerId, videoInfo.entryId].join(':');
                expandedFiles.push(file);
              } else {
                addLog(`  Could not resolve video: ${file.name}`);
              }
            } else if (file.type !== 'folder' && file.type !== 'kaltura') {
              expandedFiles.push(file);
            }
          }

          for (const file of expandedFiles) {
            file.sectionName = sectionName;
            file.courseName = courseName;
          }
          allFiles.push(...expandedFiles);
          state.sections.push({ name: sectionName, fileCount: expandedFiles.length });
          state.scannedSections = i + 1;
          broadcastProgress();
        }
      }
    }

    // ==================== Phase 2: Scan Echo360 for videos ====================
    if (doCaptures && !state.cancelled) {
      addLog(`\nScanning for Echo360 lecture captures...`);
      broadcastProgress();

      // Find Echo360 LTI link on the main course page
      const coursePageUrl = courseInfo.courseUrl.split('#')[0];
      await navigateTab(tempTabId, coursePageUrl);
      await sleep(2000);

      const ltiLinks = await executeScrape(tempTabId, scrapeEcho360LTI);

      for (const lti of ltiLinks) {
        if (state.cancelled) break;

        addLog(`Checking LTI: ${lti.name}`);

        // Navigate to LTI page first to get the launch URL
        await navigateTab(tempTabId, lti.href);
        await sleep(2000);

        // The LTI view page opens a new window or has a launch link
        // Navigate to the launch URL which redirects to Echo360
        const launchUrl = lti.href.replace('/view.php', '/launch.php') +
          (lti.href.includes('?') ? '&' : '?') + 'triggerview=0';
        await navigateTab(tempTabId, launchUrl);
        await sleep(6000);

        const currentUrl = await getTabUrl(tempTabId);
        if (!currentUrl || !currentUrl.includes('echo360')) {
          if (!lti.isCandidate) addLog(`  Could not access Echo360`);
          continue;
        }

        addLog(`  Connected to Echo360`);

        // Get the Echo360 section ID from the URL
        const sectionMatch = currentUrl.match(/section\/([a-f0-9-]+)/);
        const echo360SectionId = sectionMatch ? sectionMatch[1] : null;

        if (!echo360SectionId) {
          addLog(`  Could not find Echo360 section ID`);
          continue;
        }

        // Fetch syllabus data via Echo360 API (runs in Echo360 page context)
        const syllabusData = await executeScrape(tempTabId, scrapeEcho360Syllabus, echo360SectionId);

        if (!syllabusData || syllabusData.length === 0) {
          addLog(`  No recordings found`);
          continue;
        }

        addLog(`Found ${syllabusData.length} Echo360 recordings`);

        // Get institution ID from the Echo360 page
        const institutionId = await executeScrape(tempTabId, () => {
          const match = document.body.innerHTML.match(/institutionId['":\s]+['"]([a-f0-9-]+)['"]/);
          return match ? match[1] : null;
        });

        for (const recording of syllabusData) {
          if (state.cancelled) break;
          if (!recording.mediaId || !recording.isAvailable) continue;

          // Navigate to the lesson classroom to trigger video loading and get CloudFront cookies
          if (recording.lessonId) {
            addLog(`  Loading: ${recording.name}`);
            await navigateTab(tempTabId, `https://${new URL(currentUrl).host}/lesson/${recording.lessonId}/classroom`);
            await sleep(4000);

            // Capture the MP4 URL from the page (the player loads it)
            const videoUrl = await executeScrape(tempTabId, scrapeEcho360VideoUrl, recording.mediaId, institutionId);

            if (videoUrl) {
              // Format a nice date-based name
              const dateStr = recording.date || 'Unknown Date';

              allFiles.push({
                name: `${recording.name} - ${dateStr}`,
                href: videoUrl,
                category: 'Lectures',
                sectionName: 'Lecture Recordings',
                courseName: courseName,
                type: 'echo360',
                resourceId: ['echo360', institutionId, recording.mediaId].join(':'),
              });
            } else {
              addLog(`    Could not get video URL`);
            }
          }
        }
      }
    }

    return allFiles.filter(file => ['resource', 'folderFile', 'pageFile', 'echo360', 'kalturaDownload'].includes(file.type));
  } finally {
    await chrome.tabs.remove(tempTabId).catch(() => {});
    delete state.scanTabId;
  }
}

// ==================== Moodle Page resources ====================

const MOODLE_PAGE = /\/mod\/page\/view\.php$/;
const MOODLE_RESOURCE = /\/mod\/resource\/view\.php$/;
const MOODLE_FILE = /\/pluginfile\.php(?:\/|$)/;
const PAGE_FILE_EXTENSION = /\.(?:pdf|pptx?|docx?|xlsx?|od[pts]|zip|csv|txt|rtf|epub|ipynb|mp[34]|png|jpe?g|webp)$/i;
const MAX_PAGE_DEPTH = 3;
const MAX_PAGE_VISITS = 100;

function pageLinkKey(href, forHistory = false) {
  const url = parsePageUrl(href);
  if (!url || url.username || url.password) return null;
  url.hash = '';
  // Moodle serves the same file with or without these display parameters.
  if (MOODLE_FILE.test(url.pathname)) {
    if (url.pathname.endsWith('/pluginfile.php') && url.searchParams.get('file')?.startsWith('/')) {
      url.pathname += url.searchParams.get('file').split('/').map(encodeURIComponent).join('/');
      url.searchParams.delete('file');
    }
    url.searchParams.delete('forcedownload');
  }
  url.pathname = url.pathname.split('/').map(segment => {
    try { return encodeURIComponent(decodeURIComponent(segment)); } catch { return segment; }
  }).join('/');
  if (MOODLE_PAGE.test(url.pathname) || MOODLE_RESOURCE.test(url.pathname)) {
    url.searchParams.delete('redirect');
    url.searchParams.delete('forceview');
    url.searchParams.delete('inpopup');
  }
  // Skip history for links with opaque query parameters, which may contain signed access data.
  if (forHistory && [...url.searchParams].some(([key, value]) =>
    !MOODLE_RESOURCE.test(url.pathname) || key !== 'id' || !/^\d+$/.test(value))) return null;
  url.searchParams.sort();
  return url.href;
}

function parsePageUrl(href, base) {
  try { return new URL(href, base); } catch { return null; }
}

async function expandMoodlePage(root, scan, files) {
  const queue = [{ ...root, depth: 1 }];
  for (const page of queue) {
    if (state.cancelled) return;
    const url = parsePageUrl(page.href);
    if (!url || url.protocol !== 'https:' || url.origin !== scan.origin || url.username || url.password ||
        !MOODLE_PAGE.test(url.pathname)) continue;

    const id = ['p', 'id'].find(param => /^\d+$/.test(url.searchParams.get(param) || ''));
    if (!id) continue;
    const key = url.pathname + '?' + id + '=' + url.searchParams.get(id);
    if (scan.visited.has(key)) continue;
    if (scan.visited.size >= MAX_PAGE_VISITS) {
      if (!scan.limitLogged) addLog('Skipped further Moodle Pages: course visit limit reached.');
      scan.limitLogged = true;
      return;
    }
    scan.visited.add(key);

    const name = page.name || 'Moodle Page';
    addLog('  Scanning page: ' + name);
    broadcastProgress();
    try {
      const result = await requestPageContent(scan.tabId, scan.origin, url.href, 'page');
      if (state.cancelled) return;
      let found = 0;
      for (const link of result.links) {
        const target = parsePageUrl(link.href, result.url);
        if (!target || target.origin !== scan.origin || target.username || target.password) continue;
        if (MOODLE_PAGE.test(target.pathname)) {
          if (page.depth < MAX_PAGE_DEPTH) {
            queue.push({ href: target.href, name: link.name, depth: page.depth + 1 });
            found++;
          } else {
            addLog('  Skipped child page from ' + name + ': depth limit reached.');
          }
          continue;
        }
        if (!MOODLE_RESOURCE.test(target.pathname) && !MOODLE_FILE.test(target.pathname) &&
            !PAGE_FILE_EXTENSION.test(target.pathname) && link.download === null) continue;
        found++;
        target.hash = '';
        files.push({
          name: link.download || link.name || 'Download',
          href: target.href,
          type: 'pageFile',
          category: root.category,
          tabId: scan.tabId,
          origin: scan.origin,
        });
      }
      if (!found) addLog('  No downloadable files found on page: ' + name);
    } catch (err) {
      state.errors.push({ name, error: err.message });
      addLog('Failed: ' + name + ' - ' + err.message);
    }
  }
}

async function requestPageContent(tabId, origin, url, kind, expectedName = '') {
  let result;
  try {
    result = await executeScrape(tabId, readPageContent, origin, url, kind, expectedName);
  } catch {
    throw new Error('Could not read KEATS in the course tab. Keep the signed-in course tab open.');
  }
  if (result.error) throw new Error(result.error);
  if (!result.url) throw new Error('Could not read a response from the course tab.');
  return result;
}

// Injected into the original course tab so cookies are sent by the browser's
// same-origin fetch. A cross-origin redirect fails before requesting its target.
async function readPageContent(origin, url, kind, expectedName) {
  if (location.origin !== origin || !origin.startsWith('https://')) {
    return { error: 'The signed-in course tab is no longer on KEATS.' };
  }

  try {
    const response = await fetch(url, {
      mode: 'same-origin',
      credentials: 'same-origin',
      signal: AbortSignal.timeout(20000),
    });
    const finalUrl = new URL(response.url);
    if (/\/(?:login|auth)(?:\/|$)/i.test(finalUrl.pathname) || response.status === 401) {
      return { error: 'KEATS session expired or sign-in is required.' };
    }
    if (!response.ok) return { error: 'HTTP ' + response.status };
    const type = (response.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase();

    if (kind === 'page') {
      // Template contents are inert, including scripts and external embeds.
      const template = document.createElement('template');
      template.innerHTML = await response.text();
      const dom = template.content;
      if (dom.querySelector('form#login, form[action*="/login/"], input[type="password"]') &&
          !dom.querySelector('#region-main .generalbox.center.clearfix')) {
        return { error: 'KEATS session expired or sign-in is required.' };
      }
      if (dom.querySelector('#region-main .errorcode, #region-main .alert-danger')) {
        return { error: 'Moodle returned an error page.' };
      }
      if (!/\/mod\/page\/view\.php$/.test(finalUrl.pathname)) {
        return { error: 'Moodle redirected to a page outside the expected Page activity.' };
      }
      const main = dom.querySelector('#region-main, main, [role="main"]');
      if (!main) return { error: 'Moodle Page content region was missing.' };
      const content = main.querySelector('.generalbox.center.clearfix') || main;
      const links = Array.from(content.querySelectorAll('a[href]'))
        .filter(a => !a.closest('nav, [role="navigation"], .activity-navigation, .breadcrumb, #courseindex, #page-footer'))
        .map(a => ({
          href: a.getAttribute('href'),
          name: a.textContent.trim(),
          download: a.getAttribute('download'),
        }));
      return { url: finalUrl.href, links };
    }

    const blob = await response.blob();
    const header = await blob.slice(0, 1024).text();
    const disposition = response.headers.get('Content-Disposition') || '';
    const isPdf = /^%PDF-\d\.\d/.test(header);
    const pdfExpected = type === 'application/pdf' || /\.pdf(?:$|[?"&#;])/i.test(
      [url, finalUrl.href, disposition, expectedName].join(';')
    );
    if (type === 'text/html' || type === 'application/xhtml+xml' ||
        /^\s*(?:<!--|<(?:!doctype\s+html|html|head|body|title|form|div|script|meta|p|h[1-6])\b)/i.test(header)) {
      const login = /(?:id=["']login|\/login\/index\.php|type=["']password)/i.test(header);
      return { error: login ? 'KEATS session expired or sign-in is required.' : 'Moodle returned HTML instead of a file.' };
    }
    if (!blob.size || (pdfExpected && !isPdf)) {
      return { error: blob.size ? 'The response has no valid PDF header.' : 'The response was empty.' };
    }

    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(isPdf && type !== 'application/pdf' ? new Blob([blob], { type: 'application/pdf' }) : blob);
    });
    return { url: finalUrl.href, disposition, isPdf, dataUrl };
  } catch (err) {
    return { error: err.name === 'TimeoutError'
      ? 'The KEATS request timed out.'
      : 'The KEATS request failed or was redirected to an external sign-in page.' };
  }
}

function pageFileName(file, result) {
  const decode = value => {
    try { return decodeURIComponent(value); } catch { return value; }
  };
  const fromUrl = href => {
    const url = new URL(href);
    const path = MOODLE_FILE.test(url.pathname) && url.searchParams.get('file') || url.pathname;
    const basename = decode(path.split('/').pop());
    return /\.[a-z0-9]{1,12}$/i.test(basename) && !/\.php$/i.test(basename) ? basename : '';
  };
  const encoded = result.disposition.match(/(?:^|;)\s*filename\*=UTF-8'[^']*'([^;]+)/i);
  const plain = result.disposition.match(/(?:^|;)\s*filename\s*=\s*(?:"([^"]+)"|([^;]+))/i);
  const candidate = (encoded && decode(encoded[1])) || plain?.[1] || plain?.[2] ||
    fromUrl(result.url) || fromUrl(file.href) || file.name;
  let name = sanitize(candidate.replace(/[\x00-\x1f\x7f]/g, ' ')) || 'Download';
  if (result.isPdf && !/\.pdf$/i.test(name)) name += '.pdf';
  return name;
}


// ==================== Scraping functions (injected into tabs) ====================

function scrapeSectionPage(includeOptional) {
  const results = [];
  let currentCategory = 'other';
  let isOptional = false;

  const activities = document.querySelectorAll('.activity');
  for (const el of activities) {
    if (el.classList.contains('modtype_label')) {
      const raw = el.innerText.trim();
      if (!raw || /^-+$/.test(raw) || raw.length < 3) continue;

      const firstLine = raw.split('\n')[0].trim();
      if (firstLine.length < 3 || firstLine.length > 120) continue;

      const fl = firstLine.toUpperCase();

      // Detect optional/mandatory markers
      if (fl.includes('OPTIONAL')) { isOptional = true; }
      if (fl.includes('MANDATORY') || fl.includes('REQUIRED') || fl.includes('CORE')) { isOptional = false; }

      if (fl.includes('LECTURE MATERIAL') || fl.includes('LECTURE SLIDES') ||
          fl.includes('LECTURE PODCAST') ||
          (fl.includes('WEEK') && fl.includes('LECTURE'))) {
        currentCategory = 'Lectures';
      } else if (fl.includes('TUTORIAL MATERIAL') || fl.includes('TUTORIAL SLIDES') ||
                 fl.includes('TUTORIAL PRE-READING') || fl.includes('TUTORIAL PREPARATION') ||
                 fl.includes('SEMINAR MATERIAL')) {
        currentCategory = 'Tutorials';
      } else {
        const isHeading = firstLine.length <= 80 &&
          /^[A-Z]/.test(firstLine) &&
          !firstLine.includes('. ') &&
          firstLine.split(' ').length <= 12;

        if (isHeading) {
          currentCategory = firstLine.replace(/[/\\?%*:|"<>]/g, '-').substring(0, 60).trim();
        }
      }
      continue;
    }

    // Skip optional resources unless user opted in
    if (isOptional && !includeOptional) continue;

    const pageLink = el.querySelector('a[href*="/mod/page/view.php"]');
    if (pageLink) {
      results.push({ name: pageLink.textContent.trim(), href: pageLink.href, category: currentCategory, type: 'page' });
    }

    if (el.classList.contains('modtype_resource')) {
      const link = el.querySelector('a[href*="/mod/resource/"]');
      if (!link) continue;
      const name = el.innerText.trim().replace(/\n/g, ' ').replace(/\s*(File|Folder)\s*/g, '').trim();
      if (!name || name.length < 2) continue;
      results.push({ name, href: link.href, category: currentCategory, type: 'resource', optional: isOptional });
    }

    if (el.classList.contains('modtype_folder')) {
      const link = el.querySelector('a[href*="/mod/folder/"]');
      if (!link) continue;
      const name = el.innerText.trim().replace(/\n/g, ' ').replace(/\s*(File|Folder)\s*/g, '').trim();
      if (!name || name.length < 2) continue;
      results.push({ name, href: link.href, category: currentCategory, type: 'folder', optional: isOptional });
    }

    // Kaltura video resources
    if (el.classList.contains('modtype_kalvidres') || el.classList.contains('modtype_kalvidpres')) {
      const link = el.querySelector('a[href*="/mod/kalvid"]');
      if (!link) continue;
      const name = el.innerText.trim().replace(/\n/g, ' ')
        .replace(/\s*Kaltura Video (Resource|Presentation)\s*/gi, '').trim();
      if (!name || name.length < 2) continue;
      results.push({ name, href: link.href, category: currentCategory, type: 'kaltura', optional: isOptional });
    }
  }

  return results;
}

function scrapeInlineSection(sectionId, includeOptional, includeVideos = false) {
  // Find the section — try multiple selectors for different Moodle formats
  let section = document.querySelector(
    `.section.course-section[data-id="${sectionId}"], ` +
    `.section.main[data-id="${sectionId}"], ` +
    `li[id^="section-"][data-id="${sectionId}"]`
  );
  if (!section) return [];

  // For topcoll format, expand the section if collapsed
  const toggle = section.querySelector('.toggle_closed');
  if (toggle) { toggle.click(); }

  const results = [];
  let currentCategory = 'other';
  let isOptional = false;

  // Get activities — look in the section and any toggled content divs inside it
  const activities = section.querySelectorAll('.activity');
  for (const el of activities) {
    if (el.classList.contains('modtype_label')) {
      const raw = el.innerText.trim();
      if (!raw || /^-+$/.test(raw) || raw.length < 3) continue;
      const firstLine = raw.split('\n')[0].trim();
      if (firstLine.length < 3 || firstLine.length > 120) continue;
      const fl = firstLine.toUpperCase();

      if (fl.includes('OPTIONAL')) { isOptional = true; }
      if (fl.includes('MANDATORY') || fl.includes('REQUIRED') || fl.includes('CORE')) { isOptional = false; }

      if (fl.includes('LECTURE MATERIAL') || fl.includes('LECTURE SLIDES') ||
          fl.includes('LECTURE PODCAST') ||
          (fl.includes('WEEK') && fl.includes('LECTURE'))) {
        currentCategory = 'Lectures';
      } else if (fl.includes('TUTORIAL MATERIAL') || fl.includes('TUTORIAL SLIDES') ||
                 fl.includes('TUTORIAL PRE-READING') || fl.includes('TUTORIAL PREPARATION') ||
                 fl.includes('SEMINAR MATERIAL')) {
        currentCategory = 'Tutorials';
      } else {
        const isHeading = firstLine.length <= 80 &&
          /^[A-Z]/.test(firstLine) &&
          !firstLine.includes('. ') &&
          firstLine.split(' ').length <= 12;
        if (isHeading) {
          currentCategory = firstLine.replace(/[/\\?%*:|"<>]/g, '-').substring(0, 60).trim();
        }
      }
      continue;
    }

    if (isOptional && !includeOptional) continue;

    if (includeVideos && (el.classList.contains('modtype_kalvidres') || el.classList.contains('modtype_kalvidpres'))) {
      const link = el.querySelector('a[href*="/mod/kalvid"]');
      const name = link?.textContent.trim().replace(/\s*Kaltura Video (Resource|Presentation)\s*/gi, '').trim();
      if (name) results.push({ name, href: link.href, category: currentCategory, type: 'kaltura' });
    }

    const pageLink = el.querySelector('a[href*="/mod/page/view.php"]');
    if (pageLink) {
      results.push({ name: pageLink.textContent.trim(), href: pageLink.href, category: currentCategory, type: 'page' });
    }

    if (el.classList.contains('modtype_resource')) {
      const link = el.querySelector('a[href*="/mod/resource/"]');
      if (!link) continue;
      const name = el.innerText.trim().replace(/\n/g, ' ').replace(/\s*(File|Folder)\s*/g, '').trim();
      if (!name || name.length < 2) continue;
      results.push({ name, href: link.href, category: currentCategory, type: 'resource' });
    }

    if (el.classList.contains('modtype_folder')) {
      const link = el.querySelector('a[href*="/mod/folder/"]');
      if (!link) continue;
      const name = el.innerText.trim().replace(/\n/g, ' ').replace(/\s*(File|Folder)\s*/g, '').trim();
      if (!name || name.length < 2) continue;
      results.push({ name, href: link.href, category: currentCategory, type: 'folder' });
    }
  }

  return results;
}

function expandCollapsedSections(sectionIds) {
  // Click all collapsed toggles so their content becomes visible
  let expanded = 0;
  for (const sectionId of sectionIds) {
    const section = document.querySelector(
      `.section.course-section[data-id="${sectionId}"], ` +
      `.section.main[data-id="${sectionId}"], ` +
      `li[id^="section-"][data-id="${sectionId}"]`
    );
    if (!section) continue;
    const toggle = section.querySelector('.toggle_closed, .toggled-off .sectionname a, .collapsed .sectionname a');
    if (toggle) { toggle.click(); expanded++; }
  }
  return expanded;
}

function scrapeAllInlineSections(sectionIds, includeOptional, includeVideos = false) {
  const resultMap = {};

  for (const sectionId of sectionIds) {
    const section = document.querySelector(
      `.section.course-section[data-id="${sectionId}"], ` +
      `.section.main[data-id="${sectionId}"], ` +
      `li[id^="section-"][data-id="${sectionId}"]`
    );
    if (!section) { resultMap[sectionId] = []; continue; }

    const results = [];
    let currentCategory = 'other';
    let isOptional = false;

    const activities = section.querySelectorAll('.activity');
    for (const el of activities) {
      if (el.classList.contains('modtype_label')) {
        const raw = el.innerText.trim();
        if (!raw || /^-+$/.test(raw) || raw.length < 3) continue;
        const firstLine = raw.split('\n')[0].trim();
        if (firstLine.length < 3 || firstLine.length > 120) continue;
        const fl = firstLine.toUpperCase();

        if (fl.includes('OPTIONAL')) { isOptional = true; }
        if (fl.includes('MANDATORY') || fl.includes('REQUIRED') || fl.includes('CORE')) { isOptional = false; }

        if (fl.includes('LECTURE MATERIAL') || fl.includes('LECTURE SLIDES') ||
            fl.includes('LECTURE PODCAST') ||
            (fl.includes('WEEK') && fl.includes('LECTURE'))) {
          currentCategory = 'Lectures';
        } else if (fl.includes('TUTORIAL MATERIAL') || fl.includes('TUTORIAL SLIDES') ||
                   fl.includes('TUTORIAL PRE-READING') || fl.includes('TUTORIAL PREPARATION') ||
                   fl.includes('SEMINAR MATERIAL')) {
          currentCategory = 'Tutorials';
        } else {
          const isHeading = firstLine.length <= 80 &&
            /^[A-Z]/.test(firstLine) &&
            !firstLine.includes('. ') &&
            firstLine.split(' ').length <= 12;
          if (isHeading) {
            currentCategory = firstLine.replace(/[/\\?%*:|"<>]/g, '-').substring(0, 60).trim();
          }
        }
        continue;
      }

      if (isOptional && !includeOptional) continue;

      if (includeVideos && (el.classList.contains('modtype_kalvidres') || el.classList.contains('modtype_kalvidpres'))) {
        const link = el.querySelector('a[href*="/mod/kalvid"]');
        const name = link?.textContent.trim().replace(/\s*Kaltura Video (Resource|Presentation)\s*/gi, '').trim();
        if (name) results.push({ name, href: link.href, category: currentCategory, type: 'kaltura' });
      }

      const pageLink = el.querySelector('a[href*="/mod/page/view.php"]');
      if (pageLink) {
        results.push({ name: pageLink.textContent.trim(), href: pageLink.href, category: currentCategory, type: 'page' });
      }

      if (el.classList.contains('modtype_resource')) {
        const link = el.querySelector('a[href*="/mod/resource/"]');
        if (!link) continue;
        const name = el.innerText.trim().replace(/\n/g, ' ').replace(/\s*(File|Folder)\s*/g, '').trim();
        if (!name || name.length < 2) continue;
        results.push({ name, href: link.href, category: currentCategory, type: 'resource' });
      }

      if (el.classList.contains('modtype_folder')) {
        const link = el.querySelector('a[href*="/mod/folder/"]');
        if (!link) continue;
        const name = el.innerText.trim().replace(/\n/g, ' ').replace(/\s*(File|Folder)\s*/g, '').trim();
        if (!name || name.length < 2) continue;
        results.push({ name, href: link.href, category: currentCategory, type: 'folder' });
      }
    }

    resultMap[sectionId] = results;
  }

  return resultMap;
}

function scrapeFolderPage() {
  const results = [];

  let links = document.querySelectorAll('.fp-filename-icon a[href*="pluginfile.php"]');
  if (links.length === 0) {
    links = document.querySelectorAll('#region-main a[href*="pluginfile.php"]');
  }
  if (links.length === 0) {
    links = document.querySelectorAll('.filemanager a[href*="pluginfile.php"], .foldertree a[href*="pluginfile.php"]');
  }

  for (const link of links) {
    const href = link.href;
    const urlPath = new URL(href).pathname;
    const name = decodeURIComponent(urlPath.split('/').pop());
    if (name && name.length > 1) {
      results.push({ name, href, type: 'folderFile' });
    }
  }

  return results;
}

function scrapeKalturaVideo() {
  // Step 1: Find the Kaltura iframe and extract entry ID
  const iframe = document.querySelector('iframe.kaltura-player-iframe, iframe#contentframe, iframe[src*="kalvidres"]');
  if (!iframe || !iframe.src) return null;

  const decodedSrc = decodeURIComponent(iframe.src);
  const entryMatch = decodedSrc.match(/entryid\/([^\/&]+)/i) ||
                     decodedSrc.match(/entry_id[=\/]([^\/&]+)/i);
  if (!entryMatch) return null;

  const entryId = entryMatch[1];

  // Step 2: Try to find partner ID and KS from the page or iframe
  // These are often in script tags or data attributes
  let partnerId = '2368101'; // KEATS default
  let ks = null;

  // Check page scripts for Kaltura config
  const scripts = document.querySelectorAll('script');
  for (const s of scripts) {
    const text = s.textContent;
    if (text.includes('partnerId')) {
      const pMatch = text.match(/partnerId['":\s]+(\d+)/);
      if (pMatch) partnerId = pMatch[1];
    }
    if (text.includes('"ks"')) {
      const kMatch = text.match(/"ks"\s*:\s*"([^"]+)"/);
      if (kMatch) ks = kMatch[1];
    }
  }

  // Step 3: Construct direct download URL
  // Kaltura's /format/download/ endpoint returns a direct MP4
  let downloadUrl = `https://cdnapisec.kaltura.com/p/${partnerId}/sp/${partnerId}00/playManifest/entryId/${entryId}/format/download/protocol/https`;
  if (ks) {
    downloadUrl += `/ks/${ks}`;
  }

  return {
    entryId,
    partnerId,
    downloadUrl,
    hasKs: !!ks,
  };
}

function scrapeKalturaIframeSrc() {
  const iframe = document.querySelector('iframe.kaltura-player-iframe, iframe#contentframe, iframe[src*="kalvidres"]');
  return iframe ? iframe.src : null;
}

function scrapeKalturaKS() {
  // When navigated directly to the KAF page, multiple KS values exist in script tags.
  // Some are domain-restricted and won't work for API calls.
  // Collect all unique KS values so the caller can try each.
  const ksValues = [];
  let partnerId = null;

  const scripts = document.querySelectorAll('script');
  for (const s of scripts) {
    const text = s.textContent;
    // Find all KS strings
    const matches = text.matchAll(/"ks"\s*:\s*"([^"]+)"/g);
    for (const m of matches) {
      if (!ksValues.includes(m[1])) ksValues.push(m[1]);
    }
    if (text.includes('partnerId') && !partnerId) {
      const pMatch = text.match(/partnerId['":\s]+(\d+)/);
      if (pMatch) partnerId = pMatch[1];
    }
  }

  // Also check for KS in the page source via other patterns
  const bodyText = document.body.innerHTML;
  const altMatches = bodyText.matchAll(/["']ks["']\s*:\s*["']([^"']+)["']/g);
  for (const m of altMatches) {
    if (!ksValues.includes(m[1])) ksValues.push(m[1]);
  }

  return { ksValues, partnerId };
}

function scrapeEcho360LTI() {
  // Find LTI links that look like lecture capture
  const results = [];

  // Check all LTI activities
  const activities = document.querySelectorAll('.activity.modtype_lti');
  for (const act of activities) {
    const actLink = act.querySelector('a[href*="/mod/lti/"]');
    if (!actLink) continue;

    const text = (act.getAttribute('data-activityname') || act.innerText || '').toLowerCase();
    const href = actLink.href;

    // Match common lecture capture naming patterns
    if (text.includes('lecture capture') || text.includes('echo360') ||
        text.includes('recording') || text.includes('lecture recording')) {
      results.push({
        name: act.getAttribute('data-activityname') || actLink.textContent.trim() || 'Lecture Capture',
        href: href,
      });
    }
  }

  // If no obvious matches, include all LTI links as candidates
  // (the background will check if they redirect to Echo360)
  if (results.length === 0) {
    for (const act of activities) {
      const actLink = act.querySelector('a[href*="/mod/lti/"]');
      if (actLink) {
        results.push({
          name: act.getAttribute('data-activityname') || actLink.textContent.trim() || 'LTI Activity',
          href: actLink.href,
          isCandidate: true, // might not be Echo360
        });
      }
    }
  }

  return results;
}

function scrapeEcho360Section() {
  // Check if current page is Echo360
  const url = window.location.href;
  if (!url.includes('echo360')) return [];

  const rows = document.querySelectorAll('.class-row');
  const results = [];
  for (const row of rows) {
    results.push({
      text: row.textContent.trim().substring(0, 200),
    });
  }
  return results;
}

function scrapeEcho360VideoUrl(mediaId, institutionId) {
  // Try to find the MP4 URL from the player page
  // Method 1: Check video elements
  const videos = document.querySelectorAll('video');
  for (const v of videos) {
    if (v.src && v.src.includes('.mp4')) return v.src;
    const sources = v.querySelectorAll('source');
    for (const s of sources) {
      if (s.src && s.src.includes('.mp4')) return s.src;
    }
  }

  // Method 2: Construct from known pattern
  // Echo360 MP4 URL pattern: https://content.echo360.org.uk/0000.{institutionId}/{mediaId}/1/s2q1.mp4
  if (mediaId && institutionId) {
    const host = window.location.hostname.replace('echo360', 'content.echo360');
    return `https://${host}/0000.${institutionId}/${mediaId}/1/s2q1.mp4`;
  }

  // Method 3: Check performance entries for MP4 URLs
  if (window.performance && window.performance.getEntries) {
    const entries = window.performance.getEntries();
    for (const entry of entries) {
      if (entry.name && entry.name.includes('.mp4') && entry.name.includes(mediaId)) {
        return entry.name;
      }
    }
  }

  return null;
}

function scrapeEcho360Syllabus(sectionId) {
  // Fetch Echo360 syllabus API from within the Echo360 page context
  return fetch(`/section/${sectionId}/syllabus`, { credentials: 'include' })
    .then(r => r.json())
    .then(data => {
      return (data.data || []).map(item => {
        const lesson = item.lesson;
        if (!lesson || !lesson.hasVideo) return null;

        const media = lesson.medias && lesson.medias[0];
        if (!media || !media.isAvailable) return null;

        const startDate = lesson.lesson?.timing?.start;
        const dateStr = startDate
          ? new Date(startDate).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
          : null;

        return {
          name: lesson.lesson?.displayName || 'Lecture',
          lessonId: lesson.lesson?.id,
          mediaId: media.id,
          isAvailable: media.isAvailable,
          date: dateStr,
        };
      }).filter(Boolean);
    })
    .catch(() => []);
}

// ==================== Download with retry ====================

async function prepareWithRetry(file, basePath, maxRetries = 3, isCancelled = () => false) {
  let lastError;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      if (isCancelled()) return null;
      return await prepareDownload(file, basePath);
    } catch (err) {
      lastError = err;
      if (attempt < maxRetries && !isCancelled()) {
        const delay = 1000 * Math.pow(2, attempt - 1); // 1s, 2s, 4s
        addLog(`  Retry ${attempt}/${maxRetries - 1} for: ${file.name}`);
        await sleep(delay);
      }
    }
  }
  throw lastError;
}

// ==================== Download handler ====================

async function prepareDownload(file, basePath) {
  // Build directory path
  let dirPath = basePath;

  if (file.sectionName) {
    dirPath += `${sanitize(file.sectionName)}/`;
  }

  if (file.category && file.category !== 'other') {
    dirPath += `${file.category}/`;
  }

  if (file.folderName) {
    dirPath += `${sanitize(file.folderName)}/`;
  }

  // Build download URL
  let url = file.href;
  if (file.type === 'resource') {
    const target = new URL(url);
    target.hash = '';
    target.searchParams.set('redirect', '1');
    url = target.href;
  }

  // Determine filename and fetch content
  let filename;
  let downloadUrl;
  let responseUrl;

  if (file.type === 'folderFile') {
    const urlPath = new URL(file.href).pathname;
    filename = sanitize(decodeURIComponent(urlPath.split('/').pop()));
  } else if (file.type === 'kalturaDownload' || file.type === 'echo360') {
    filename = sanitize(file.name) + '.mp4';
  }

  if (file.type === 'echo360' || file.type === 'kalturaDownload') {
    // Video files: download directly from CDN (too large for data URL)
    downloadUrl = url;
    if (!filename) filename = sanitize(file.name) + '.mp4';
  } else if (file.type === 'pageFile') {
    const target = new URL(url);
    if (MOODLE_RESOURCE.test(target.pathname)) target.searchParams.set('redirect', '1');
    const result = await requestPageContent(file.tabId, file.origin, target.href, 'file', file.name);
    filename = pageFileName(file, result);
    downloadUrl = result.dataUrl;
    responseUrl = result.url;
  } else {
    // Fetch file content and convert to data URL to bypass save dialog
    const fetched = await fetchFileBlob(url);
    if (/^(text\/html|application\/xhtml\+xml)(?:;|$)/i.test(fetched.blob.type) &&
        !/\.x?html?$/i.test(fetched.filename || '')) {
      throw new Error('Moodle returned HTML instead of a file.');
    }
    if (fetched.filename) filename = fetched.filename;
    if (!filename) filename = sanitize(file.name) || 'download';
    downloadUrl = await blobToDataUrl(fetched.blob);
    responseUrl = fetched.responseUrl;
  }

  return { downloadUrl, fullPath: dirPath + filename, responseUrl };
}

function submitDownload(downloadUrl, fullPath) {
  return new Promise((resolve, reject) => {
    chrome.downloads.download(
      { url: downloadUrl, filename: fullPath, saveAs: false, conflictAction: 'uniquify' },
      downloadId => {
        if (chrome.runtime.lastError || downloadId === undefined) reject(new Error('Chrome could not start this download.'));
        else resolve(downloadId);
      }
    );
  });
}
// ==================== Execute scraping in a tab ====================

async function executeScrape(tabId, func, ...args) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func,
    args,
  });
  return results[0]?.result ?? [];
}

// ==================== Helpers ====================

function navigateTab(tabId, url) {
  return new Promise((resolve, reject) => {
    let listener = null;
    const timeout = setTimeout(() => {
      if (listener) chrome.tabs.onUpdated.removeListener(listener);
      resolve(); // Resolve anyway after timeout
    }, 30000);

    chrome.tabs.update(tabId, { url }, () => {
      if (chrome.runtime.lastError) {
        clearTimeout(timeout);
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }

      listener = (id, info) => {
        if (id === tabId && info.status === 'complete') {
          chrome.tabs.onUpdated.removeListener(listener);
          clearTimeout(timeout);
          resolve();
        }
      };
      chrome.tabs.onUpdated.addListener(listener);
    });
  });
}

async function getTabUrl(tabId) {
  const tab = await chrome.tabs.get(tabId);
  return tab.url;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function sanitize(name) {
  return name.replace(/[/\\?%*:|"<>]/g, '-').trim().replace(/\.+$/, '');
}

function addLog(msg) {
  state.log.push(msg);
  if (state.log.length > 300) {
    state.log = state.log.slice(-200);
  }
}

function broadcastProgress() {
  chrome.runtime.sendMessage({ type: 'PROGRESS_UPDATE', state: publicState() }).catch(() => {});
}

// Expose internals for testing (no-op in Chrome extension context)
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    sanitize, addLog, sleep, prepareWithRetry, fileKey, blobToDataUrl, fetchFileBlob,
    beginScan, confirmDownload, cancelJob, serviceJob, publicState,
    scrapeSectionPage, scrapeInlineSection, scrapeAllInlineSections, scrapeFolderPage,
    scrapeEcho360LTI, isMoodleCoursePage: undefined,
    get state() { return state; },
    set state(s) { state = s; },
  };
}
