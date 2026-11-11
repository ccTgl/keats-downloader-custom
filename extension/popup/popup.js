// Popup UI controller

const $ = (sel) => document.querySelector(sel);

const views = {
  notKeats: $('#not-keats'),
  ready: $('#ready'),
  preview: $('#preview'),
  progress: $('#progress'),
  complete: $('#complete'),
};

function showView(name) {
  Object.values(views).forEach(v => v.classList.add('hidden'));
  views[name]?.classList.remove('hidden');
}

function isMoodleCoursePage(url) {
  if (!url) return false;
  return /\/course\/view\.php/.test(url);
}

// ---------- Theme toggle ----------

function initTheme() {
  const saved = localStorage.getItem('keats-theme');
  if (saved === 'dark') {
    document.body.classList.add('dark');
    $('#theme-toggle').checked = true;
  } else {
    document.body.classList.remove('dark');
    $('#theme-toggle').checked = false;
  }
}

$('#theme-toggle').addEventListener('change', (e) => {
  if (e.target.checked) {
    document.body.classList.add('dark');
    localStorage.setItem('keats-theme', 'dark');
  } else {
    document.body.classList.remove('dark');
    localStorage.setItem('keats-theme', 'light');
  }
});

// ---------- Download path ----------

async function loadDownloadPath() {
  try {
    const data = await chrome.storage.local.get('downloadPath');
    const path = data.downloadPath || 'KEATS Downloads';
    $('#download-path').value = path;
    autoSizePath();
  } catch (e) {}
}

function autoSizePath() {
  const input = $('#download-path');
  if (input) input.style.width = Math.max(40, input.value.length * 7) + 'px';
}

$('#download-path').addEventListener('input', autoSizePath);
$('#download-path').addEventListener('change', () => {
  const val = $('#download-path').value.trim() || 'KEATS Downloads';
  $('#download-path').value = val;
  chrome.storage.local.set({ downloadPath: val });
  autoSizePath();
});

// ---------- Library ----------

async function loadLibrary() {
  try {
    const history = await sendBg({ type: 'GET_HISTORY' });
    const list = $('#library-list');
    const empty = $('#library-empty');
    const library = $('#library');

    if (!history || history.total === 0) {
      library.classList.add('hidden');
      return;
    }

    library.classList.remove('hidden');
    list.innerHTML = '';
    empty.classList.add('hidden');

    const courses = Object.entries(history.courses)
      .sort((a, b) => b[1].lastDownload - a[1].lastDownload);

    for (const [name, info] of courses) {
      const date = new Date(info.lastDownload);
      const dateStr = date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
      const item = document.createElement('div');
      item.className = 'library-item';
      item.innerHTML = `
        <div class="library-item-info">
          <div class="library-item-name">${esc(name)}</div>
          <div class="library-item-meta">${info.count} files · ${dateStr}</div>
        </div>
        <button class="btn-text btn-clear-course" >Clear</button>
      `;
      item.querySelector('.btn-clear-course').dataset.course = name;
      list.appendChild(item);
    }

    list.querySelectorAll('.btn-clear-course').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const course = e.target.getAttribute('data-course');
        await sendBg({ type: 'CLEAR_HISTORY', course });
        loadLibrary();
      });
    });
  } catch (e) {}
}

$('#btn-clear-all').addEventListener('click', async () => {
  await sendBg({ type: 'CLEAR_HISTORY' });
  loadLibrary();
});

// ---------- Init ----------

async function init() {
  initTheme();
  await loadDownloadPath();

  // Check if we already have an active download
  try {
    if (renderStatus(await sendBg({ type: 'GET_STATUS' }))) return;
  } catch (e) {}

  // Check current tab
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!isMoodleCoursePage(tab?.url)) {
    showView('notKeats');
    loadLibrary();
    return;
  }

  // Scrape course info
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const h1 = document.querySelector('h1');
        const courseName = h1 ? h1.textContent.trim() : document.title.trim();
        const courseUrl = window.location.href.split('#')[0];
        const gridSections = [];
        const seen = {};
        const sectionLinks = document.querySelectorAll(
          'a[href*="course/section.php?id="], ' +
          'a[href*="course/view.php"][href*="section="], ' +
          '.grid-section a[href], .gridicon_link, #gridicons a[href]'
        );
        for (const link of sectionLinks) {
          const href = link.href.split('#')[0];
          const text = (link.textContent || '').trim().replace(/\s+/g, ' ');
          if (!seen[href] && text && text.length > 1 && !text.startsWith('Go to section')) {
            seen[href] = true;
            gridSections.push({ href, name: text });
          }
        }

        const inlineSectionsArr = [];
        const inlineSections = document.querySelectorAll(
          '#region-main .section.course-section[data-id], ' +
          '#region-main li[id^="section-"][data-id], ' +
          '#region-main .section.main[data-id]'
        );
        for (const sec of inlineSections) {
          const nameEl = sec.querySelector(
            'h3.sectionname, h3.section-title, .sectionname, ' +
            '.section-title a, .sectionhead h3, [data-for="section_title"]'
          );
          const name = nameEl ? nameEl.textContent.trim() : null;
          const sectionId = sec.getAttribute('data-id');
          const sectionNum = sec.getAttribute('data-number');
          if (!sectionId) continue;
          inlineSectionsArr.push({
            href: courseUrl + '#section-inline-' + sectionId,
            name: name || ('Section ' + (sectionNum || sectionId)),
            inline: true,
            sectionId,
          });
        }

        const tabSections = [];
        const tabs = document.querySelectorAll('.onetopic .nav-tabs .nav-link, .onetopic-tab-list a, ul.nav-tabs li a[href*="section="]');
        for (const tab of tabs) {
          const href = tab.href;
          const text = tab.textContent.trim();
          if (href && text && text.length > 0) tabSections.push({ href, name: text });
        }

        let sections, format;
        const counts = [
          { arr: inlineSectionsArr, fmt: 'topics' },
          { arr: gridSections, fmt: 'grid' },
          { arr: tabSections, fmt: 'onetopic' },
        ];
        counts.sort((a, b) => b.arr.length - a.arr.length);
        sections = counts[0].arr;
        format = counts[0].fmt;
        return { courseName, sections, courseUrl, format };
      },
    });

    const info = results[0]?.result;
    if (info?.courseName) renderCourse(info, tab.id);
    else showView('notKeats');
  } catch (e) {
    showView('notKeats');
  }
  loadLibrary();

  // Check for new files
  try {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (activeTab) {
      await sendBg({ type: 'CHECK_NEW_FILES', tabId: activeTab.id });
      const sessionData = await chrome.storage.session.get(`newFiles:${activeTab.id}`);
      const info = sessionData[`newFiles:${activeTab.id}`];
      if (info && info.count > 0) {
        const el = $('#new-files-badge');
        if (el) {
          el.textContent = `${info.count} new file${info.count > 1 ? 's' : ''} since last download`;
          el.classList.remove('hidden');
        }
      }
    }
  } catch (e) {}
}


function renderCourse(info, tabId) {
  const previous = window._courseInfo;
  const selections = new Map([...$('#week-list').querySelectorAll('input')]
    .map(input => [input.dataset.sectionKey, input.checked]));
  if (!info.sections.length) info.sections = [{ href: info.courseUrl, name: info.courseName }];
  window._courseInfo = info;
  window._tabId = tabId;
  $('#course-name').textContent = info.courseName;
  $('#path-course-name').textContent = info.courseName.substring(0, 30);
  const list = $('#week-list');
  list.replaceChildren();
  for (const [index, section] of info.sections.entries()) {
    const label = document.createElement('label');
    label.className = 'checkbox-row';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.value = String(index);
    input.dataset.sectionKey = section.href;
    input.checked = previous?.courseUrl === info.courseUrl ? (selections.get(section.href) ?? true) : true;
    const text = document.createElement('span');
    text.textContent = section.name;
    label.append(input, text);
    list.append(label);
  }
  updateSelection();
  showView('ready');
}

function updateSelection() {
  const count = $('#week-list').querySelectorAll('input:checked').length;
  $('#section-count').textContent = count + ' / ' + (window._courseInfo?.sections.length || 0);
  $('#btn-download').disabled = count === 0;
  $('#ready-error').textContent = '';
}

$('#week-list').addEventListener('change', updateSelection);
for (const [selector, checked] of [['#btn-select-all', true], ['#btn-select-none', false]]) {
  $(selector).addEventListener('click', () => {
    for (const input of $('#week-list').querySelectorAll('input')) input.checked = checked;
    updateSelection();
  });
}

$('#btn-download').addEventListener('click', async () => {
  const sections = [...$('#week-list').querySelectorAll('input:checked')]
    .map(input => window._courseInfo.sections[Number(input.value)]);
  if (!sections.length) return;
  $('#btn-download').disabled = true;
  $('#ready-error').textContent = '';
  const downloadPath = $('#download-path').value.trim() || 'KEATS Downloads';
  try {
    await chrome.storage.local.set({ downloadPath });
    const reply = await sendBg({
      type: 'SCAN_COURSE',
      tabId: window._tabId,
      courseInfo: { ...window._courseInfo, sections },
      options: {
        materials: $('#opt-materials').checked,
        videos: $('#opt-videos').checked,
        captures: $('#opt-captures').checked,
        folders: $('#opt-folders').checked,
        optional: $('#opt-optional').checked,
        downloadPath,
      },
    });
    if (!reply?.ok) throw new Error(reply?.error || 'Could not start the scan.');
    renderStatus(await sendBg({ type: 'GET_STATUS' }));
  } catch (error) {
    $('#ready-error').textContent = error.message;
    $('#btn-download').disabled = false;
  }
});

$('#btn-confirm').addEventListener('click', async () => {
  $('#btn-confirm').disabled = true;
  $('#preview-error').textContent = '';
  try {
    const reply = await sendBg({ type: 'CONFIRM_DOWNLOAD', jobId: displayedJobId });
    if (!reply?.ok) throw new Error(reply?.error || 'Could not confirm the preview.');
    renderStatus(await sendBg({ type: 'GET_STATUS' }));
  } catch (error) {
    try { renderStatus(await sendBg({ type: 'GET_STATUS' })); } catch {}
    $('#preview-error').textContent = error.message;
  }
});

async function leaveJob() {
  try {
    const result = await sendBg({ type: 'CANCEL', jobId: displayedJobId });
    if (result?.ok && !renderStatus(await sendBg({ type: 'GET_STATUS' }))) await init();
  } catch {
    // The next status update or popup reopen will restore the current job.
  }
}

for (const selector of ['#btn-cancel', '#btn-back', '#btn-done']) {
  $(selector).addEventListener('click', leaveJob);
}

let displayedJobId;
let progressPoll;
function renderStatus(s) {
  displayedJobId = s?.jobId;
  clearInterval(progressPoll);
  if (s?.status === 'scanning' || s?.status === 'downloading') {
    showView('progress');
    updateProgress(s);
    if (s.status === 'downloading') {
      progressPoll = setInterval(async () => {
        try { renderStatus(await sendBg({ type: 'GET_STATUS' })); } catch {}
      }, 1000);
    }
    return true;
  }
  if (s?.status === 'preview') {
    showView('preview');
    updatePreview(s);
    return true;
  }
  if (['complete', 'cancelled', 'error'].includes(s?.status)) {
    showView('complete');
    updateComplete(s);
    return true;
  }
  return false;
}

chrome.runtime.onMessage.addListener(msg => {
  if (msg.type === 'PROGRESS_UPDATE') renderStatus(msg.state);
});

function updatePreview(s) {
  const rows = s.items || [];
  $('#preview-course').textContent = s.courseName;
  $('#preview-summary').textContent = s.totalFiles + ' ready · ' + s.skippedFiles +
    ' duplicates skipped' + (s.errors.length ? ' · ' + s.errors.length + ' scan issues' : '');
  $('#preview-path').textContent = 'Downloads/' + s.basePath;
  $('#btn-confirm').disabled = !s.totalFiles;
  $('#preview-error').textContent = s.errors.map(error => error.name + ' – ' + error.error).join(' · ');
  const list = $('#preview-files');
  list.replaceChildren();
  let section;
  for (const file of rows) {
    if (file.sectionName !== section) {
      section = file.sectionName;
      const heading = document.createElement('h3');
      heading.className = 'preview-group';
      heading.textContent = section || 'Course files';
      list.append(heading);
    }
    const row = document.createElement('div');
    row.className = 'preview-row';
    const name = document.createElement('span');
    name.textContent = file.name;
    const detail = document.createElement('small');
    detail.className = 'preview-note';
    detail.textContent = [file.category !== 'other' ? file.category : '', file.folderName, file.typeLabel].filter(Boolean).join(' / ');
    name.append(detail);
    const status = document.createElement('span');
    status.textContent = file.reason || 'Ready';
    if (file.reason) status.className = 'preview-duplicate';
    row.append(name, status);
    list.append(row);
  }
  if (!rows.length) list.textContent = 'No downloadable resources were found in the selected sections.';
}

function updateProgress(s) {
  const statusBadge = $('#progress-status');
  const progressBar = $('#progress-bar');
  const progressCount = $('#progress-count');
  const details = $('#progress-details');

  if (s.status === 'scanning') {
    statusBadge.textContent = 'Scanning';
    statusBadge.className = 'status-badge';
    progressBar.classList.add('scanning');
    const scanPct = s.totalSections > 0
      ? Math.round(s.scannedSections / s.totalSections * 100) : 0;
    progressBar.style.width = scanPct + '%';
    progressCount.textContent = s.totalSections > 0
      ? `${s.scannedSections} / ${s.totalSections} sections` : '';
    details.textContent = s.cancelled ? 'Stopping scan…' : '';
  } else {
    progressBar.classList.remove('scanning');
    statusBadge.textContent = 'Downloading';
    statusBadge.className = 'status-badge downloading';
    const pct = s.totalFiles > 0 ? Math.round(s.processedFiles / s.totalFiles * 100) : 0;
    progressBar.style.width = pct + '%';
    progressCount.textContent = s.processedFiles + ' / ' + s.totalFiles + ' processed';
    const transfers = (s.items || []).filter(item => item.status === 'in_progress' && item.totalBytes > 0);
    const sizes = transfers.map(item => Math.min(100, Math.round((item.bytesReceived || 0) * 100 / item.totalBytes)) + '%');
    details.textContent = s.cancelled ? 'Cancelling…' : [
      s.downloadedFiles + ' completed', s.activeFiles + ' active', s.failedFiles + ' failed',
      ...(sizes.length ? ['Chrome transfers ' + sizes.join(', ')] : []),
    ].join(' · ');
  }

  $('#current-file').textContent = s.currentFile || '';

  $('#log').innerHTML = s.log.map(line => {
    if (line.startsWith('Downloaded:')) return `<span class="log-success">${esc(line)}</span>`;
    if (line.startsWith('Failed:') || line.startsWith('Error:')) return `<span class="log-error">${esc(line)}</span>`;
    if (line.startsWith('Skipped')) return `<span class="log-info">${esc(line)}</span>`;
    if (line.startsWith('Course:') || line.startsWith('Sections:') || line.startsWith('Found') || line.startsWith('Done') || line.startsWith('Downloading'))
      return `<span class="log-info">${esc(line)}</span>`;
    return esc(line);
  }).join('\n');

  const lc = $('#log-container');
  lc.scrollTop = lc.scrollHeight;
}

function updateComplete(s) {
  const title = $('#complete-title');
  if (s.status === 'cancelled') title.textContent = 'Download Cancelled';
  else if (s.status === 'error') title.textContent = 'Download Error';
  else title.textContent = 'Download Complete';

  $('#stat-downloaded').textContent = s.downloadedFiles;
  $('#stat-failed').textContent = s.failedFiles;
  $('#stat-failed').parentElement.style.display = s.failedFiles > 0 ? 'flex' : 'none';
  $('#stat-skipped').textContent = s.skippedFiles;
  $('#stat-skipped').parentElement.style.display = s.skippedFiles > 0 ? 'flex' : 'none';

  $('#save-path').textContent = s.basePath ? 'Destination: Downloads/' + s.basePath : '';
  $('#complete-errors').textContent = (s.errors || []).map(error => error.name + ' – ' + error.error).join(' · ');
}

// ---------- Helpers ----------

function sendBg(msg) { return chrome.runtime.sendMessage(msg); }

function esc(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

init();
