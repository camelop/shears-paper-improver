// Shears Paper Review — Frontend Application
import * as pdfjsLib from './pdf.min.mjs';

// PDF.js worker
pdfjsLib.GlobalWorkerOptions.workerSrc = '/static/pdf.worker.min.mjs';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const state = {
  problems: new Map(),      // id -> problem object
  selections: new Map(),    // id -> boolean
  expanded: new Set(),      // problem IDs whose card body is expanded
  progress: {},             // criteria -> {current_page, total_pages, status}
  groupMode: 'criteria',    // 'criteria' | 'page'
  allDone: false,
  pdfDoc: null,
  currentPage: 1,
  totalPages: 0,
  scale: 1.0,
  fitWidth: true,
  rendering: false,
  pdfPageHeight: 0,
  pdfPageWidth: 0,
  pdfMtime: 0,              // mtime of PDF as last loaded — detect recompiles
  lastLocated: null,        // last located problem ID — replayed after PDF reload
};

const POLL_ACTIVE = 2000;
const POLL_DONE = 10000;
let pollInterval = POLL_ACTIVE;
let pollTimer = null;

// ---------------------------------------------------------------------------
// Polling
// ---------------------------------------------------------------------------
async function fetchJSON(url) {
  try {
    const resp = await fetch(url);
    if (!resp.ok) return null;
    return resp.json();
  } catch (e) {
    return null;
  }
}

async function pollProblems() {
  const data = await fetchJSON('/api/problems');
  if (!data) return;

  let changed = false;
  let newProblem = false;
  for (const p of data.problems) {
    const existing = state.problems.get(p.id);
    if (!existing) {
      state.problems.set(p.id, p);
      if (!state.selections.has(p.id)) state.selections.set(p.id, true);
      changed = true;
      newProblem = true;
    } else if (existing.status !== p.status) {
      // Status transitioned (e.g., to resolved or skipped after /shears-fix)
      state.problems.set(p.id, p);
      // Auto-deselect resolved items so they don't get fixed again
      if (p.status === 'resolved') state.selections.set(p.id, false);
      changed = true;
    }
  }
  if (changed) {
    renderProblems();
    if (newProblem) syncSelectionsToServer();
  }
}

async function pollProgress() {
  const data = await fetchJSON('/api/progress');
  if (!data) return;

  state.progress = data.criteria || {};
  const wasDone = state.allDone;
  state.allDone = data.all_done;

  renderProgress();

  if (data.all_done && !wasDone) {
    pollInterval = POLL_DONE;
    document.getElementById('status-badge').textContent = 'Complete';
    document.getElementById('status-badge').className = 'badge badge-done';
    setTimeout(() => { pollInterval = 0; }, 30000);
  }
}

async function pollPdfStatus() {
  const data = await fetchJSON('/api/status');
  if (!data || !data.pdf_mtime) return;
  if (state.pdfMtime === 0) {
    state.pdfMtime = data.pdf_mtime;
    return;
  }
  if (data.pdf_mtime > state.pdfMtime) {
    // PDF was recompiled (e.g., by /shears-fix). Reload it and replay the last highlight.
    state.pdfMtime = data.pdf_mtime;
    try {
      state.pdfDoc = await pdfjsLib.getDocument(`/pdf?t=${data.pdf_mtime}`).promise;
      state.totalPages = state.pdfDoc.numPages;
      await buildPages();
      if (state.lastLocated) {
        window.locateProblem(state.lastLocated);
      }
    } catch (e) {
      console.warn('PDF reload failed:', e);
    }
  }
}

async function loadSelections() {
  const data = await fetchJSON('/api/selections');
  if (!data) return;
  for (const [pid, selected] of Object.entries(data)) {
    state.selections.set(pid, selected);
  }
}

function startPolling() {
  async function tick() {
    if (pollInterval === 0) return;
    await Promise.all([pollProblems(), pollProgress(), pollPdfStatus()]);
    pollTimer = setTimeout(tick, pollInterval);
  }
  tick();
}

// ---------------------------------------------------------------------------
// Selections sync
// ---------------------------------------------------------------------------
let syncTimer = null;

function syncSelectionsToServer() {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(async () => {
    const selections = {};
    for (const [pid, sel] of state.selections) {
      selections[pid] = sel;
    }
    await fetch('/api/selections/bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ selections }),
    });
  }, 500);
}

// ---------------------------------------------------------------------------
// Rendering: Progress
// ---------------------------------------------------------------------------
function renderProgress() {
  const container = document.getElementById('progress-bars');
  const criteria = Object.entries(state.progress);

  if (criteria.length === 0) {
    container.innerHTML = '<span style="font-size:12px;color:var(--text-muted)">Waiting for agents...</span>';
    return;
  }

  container.innerHTML = criteria.map(([name, info]) => {
    const total = info.total_pages || 0;
    const current = info.current_page || 0;
    const pct = total > 0 ? Math.round((current / total) * 100) : 0;
    const isDone = info.status === 'completed';
    const statusText = isDone ? 'Done' : `${current}/${total}`;
    return `
      <div class="progress-item">
        <span class="progress-label">${escapeHtml(name)}</span>
        <div class="progress-bar-bg">
          <div class="progress-bar-fill ${isDone ? 'done' : ''}" style="width:${pct}%"></div>
        </div>
        <span class="progress-text">${statusText}</span>
      </div>
    `;
  }).join('');
}

// ---------------------------------------------------------------------------
// Rendering: Problems
// ---------------------------------------------------------------------------
function renderProblems() {
  const panel = document.getElementById('problems-panel');
  const container = document.getElementById('problems-container');
  const problems = Array.from(state.problems.values());

  // Preserve scroll position across re-renders
  const prevScroll = panel ? panel.scrollTop : 0;

  if (problems.length === 0) {
    container.innerHTML = '<div class="empty-state">Waiting for problems to be reported...</div>';
    updateSelectionCount();
    return;
  }

  const groups = groupProblems(problems, state.groupMode);
  let html = '';

  for (const [groupName, items] of groups) {
    html += `<div class="group-header">${escapeHtml(groupName)} <span class="group-count">(${items.length})</span></div>`;
    for (const p of items) {
      html += renderCard(p);
    }
  }

  container.innerHTML = html;
  updateSelectionCount();

  // Restore scroll position
  if (panel) panel.scrollTop = prevScroll;
}

function renderCard(p) {
  const selected = state.selections.get(p.id) !== false;
  const isExpanded = state.expanded.has(p.id);
  const severity = p.severity || 'low';
  const confidence = typeof p.confidence === 'number' ? p.confidence : null;
  const confidenceClass = confidence === null ? '' : (confidence >= 80 ? '' : (confidence >= 60 ? 'medium' : 'low'));
  const pidEsc = escapeAttr(p.id);
  const status = p.status || '';  // 'resolved' | 'skipped' | ''
  const isResolved = status === 'resolved';
  const isSkipped = status === 'skipped';
  const statusClass = isResolved ? ' resolved' : (isSkipped ? ' skipped' : '');

  let statusTag = '';
  if (isResolved) {
    statusTag = '<span class="status-tag status-resolved">✓ Resolved</span><span class="meta-sep">·</span>';
  } else if (isSkipped) {
    statusTag = `<span class="status-tag status-skipped" title="${escapeAttr(p.skipped_reason || '')}">⚠ Skipped</span><span class="meta-sep">·</span>`;
  }

  return `
    <div class="problem-card severity-${severity}${selected ? ' selected' : ''}${statusClass}" data-id="${pidEsc}">
      <div class="card-header">
        <input type="checkbox" ${selected ? 'checked' : ''} ${isResolved ? 'disabled' : ''}
               onchange="window.toggleSelection('${pidEsc}', this.checked)">
        <div class="card-summary" onclick="window.toggleExpand('${pidEsc}')">
          <span class="card-title">${escapeHtml(p.title || p.id)}</span>
          <div class="card-meta">
            ${statusTag}
            <span class="severity-tag ${severity}">${severity}</span>
            ${confidence !== null ? `
              <span class="confidence-tag" title="Confidence: ${confidence}%">
                <span class="confidence-bar"><span class="confidence-bar-fill ${confidenceClass}" style="width:${confidence}%"></span></span>
                ${confidence}%
              </span>
            ` : ''}
            <span class="meta-sep">·</span>
            <span>${escapeHtml(p.criteria || '')}</span>
            <span class="meta-sep">·</span>
            <span>p.${p.page || '?'}</span>
            <span class="meta-sep">·</span>
            <span>${escapeHtml(p.file || '')}:${p.line_start || ''}</span>
          </div>
        </div>
        <div class="card-actions">
          ${p.page ? `<button class="btn-locate" onclick="window.locateProblem('${pidEsc}')">Locate</button>` : ''}
        </div>
      </div>
      <div class="card-body${isExpanded ? ' expanded' : ''}">
        <h4>Description</h4>
        <p>${escapeHtml(p.description || 'No description')}</p>
        ${isSkipped && p.skipped_reason ? `
          <h4>Skip Reason</h4>
          <p>${escapeHtml(p.skipped_reason)}</p>
        ` : ''}
        ${p.original_text ? `
          <h4>Original</h4>
          <pre class="diff-old">${escapeHtml(p.original_text)}</pre>
        ` : ''}
        ${p.suggested_fix ? `
          <h4>Suggested Fix</h4>
          <pre class="diff-new">${escapeHtml(p.suggested_fix)}</pre>
        ` : ''}
      </div>
    </div>
  `;
}

function groupProblems(problems, mode) {
  const groups = new Map();
  for (const p of problems) {
    const key = mode === 'criteria'
      ? (p.criteria || 'unknown')
      : `Page ${p.page || '?'}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p);
  }

  const sorted = new Map([...groups.entries()].sort((a, b) => {
    if (mode === 'page') {
      const pa = parseInt(a[0].replace('Page ', '')) || 0;
      const pb = parseInt(b[0].replace('Page ', '')) || 0;
      return pa - pb;
    }
    return a[0].localeCompare(b[0]);
  }));

  // Within each group, unresolved first, then skipped, then resolved.
  // Inside each status bucket sort by page, then line.
  const statusRank = (p) => p.status === 'resolved' ? 2 : (p.status === 'skipped' ? 1 : 0);
  for (const [, items] of sorted) {
    items.sort((a, b) =>
      statusRank(a) - statusRank(b) ||
      (a.page || 0) - (b.page || 0) ||
      (a.line_start || 0) - (b.line_start || 0)
    );
  }

  return sorted;
}

function updateSelectionCount() {
  let total = 0;
  let selected = 0;
  let resolved = 0;
  for (const [pid, p] of state.problems) {
    if (p.status === 'resolved') { resolved++; continue; }
    total++;
    if (state.selections.get(pid) !== false) selected++;
  }
  const parts = [`${selected} / ${total} selected`];
  if (resolved > 0) parts.push(`${resolved} resolved`);
  document.getElementById('selection-count').textContent = parts.join(' · ');
}

// ---------------------------------------------------------------------------
// User actions
// ---------------------------------------------------------------------------
window.toggleSelection = function(pid, checked) {
  state.selections.set(pid, checked);
  const card = document.querySelector(`.problem-card[data-id="${pid}"]`);
  if (card) card.classList.toggle('selected', checked);
  updateSelectionCount();
  syncSelectionsToServer();
};

window.toggleExpand = function(pid) {
  if (state.expanded.has(pid)) {
    state.expanded.delete(pid);
  } else {
    state.expanded.add(pid);
  }
  const card = document.querySelector(`.problem-card[data-id="${pid}"]`);
  if (card) {
    const body = card.querySelector('.card-body');
    if (body) body.classList.toggle('expanded', state.expanded.has(pid));
  }
};

window.setGroupMode = function(mode) {
  state.groupMode = mode;
  document.querySelectorAll('[data-group]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.group === mode);
  });
  renderProblems();
};

window.selectAll = function() {
  for (const [pid, p] of state.problems) {
    if (p.status !== 'resolved') state.selections.set(pid, true);
  }
  renderProblems();
  syncSelectionsToServer();
};

window.deselectAll = function() {
  for (const [pid, p] of state.problems) {
    if (p.status !== 'resolved') state.selections.set(pid, false);
  }
  renderProblems();
  syncSelectionsToServer();
};

window.locateProblem = async function(pid) {
  const p = state.problems.get(pid);
  if (!p || !p.file || !p.line_start) return;

  const url = `/api/locate?file=${encodeURIComponent(p.file)}&line_start=${p.line_start}&line_end=${p.line_end || p.line_start}`;
  const data = await fetchJSON(url);

  const targetPage = (data && data.page) || p.page;
  const boxes = (data && data.boxes) || null;

  if (targetPage) {
    clearHighlightBoxes();  // clears DOM only — keeps lastLocated
    if (boxes) drawHighlightsOnPage(targetPage, boxes);
    scrollToPage(targetPage, boxes);
    // Remember AFTER clearing, so poll-triggered PDF reload can replay this
    state.lastLocated = pid;
  }
};

// Internal: just wipe the highlight-box DOM (used by locateProblem)
function clearHighlightBoxes() {
  for (const layer of document.querySelectorAll('.pdf-page .highlight-layer')) {
    layer.innerHTML = '';
  }
}

// User-facing: "Clear" toolbar button — also forgets which problem was located
window.clearHighlights = function() {
  clearHighlightBoxes();
  state.lastLocated = null;
};

// ---------------------------------------------------------------------------
// PDF Viewer — continuous scroll mode
// ---------------------------------------------------------------------------
async function initPdf() {
  try {
    // Fetch PDF mtime first so we can detect future recompiles
    const status = await fetchJSON('/api/status');
    const mtime = (status && status.pdf_mtime) || Date.now() / 1000;
    state.pdfMtime = mtime;
    state.pdfDoc = await pdfjsLib.getDocument(`/pdf?t=${mtime}`).promise;
    state.totalPages = state.pdfDoc.numPages;
    state.currentPage = 1;
    await buildPages();
    attachScrollTracking();
  } catch (e) {
    console.warn('Could not load PDF:', e);
    document.getElementById('pdf-viewport').innerHTML =
      '<div class="empty-state">PDF not available</div>';
  }
}

async function buildPages() {
  const container = document.getElementById('pdf-pages');
  container.innerHTML = '';

  // Compute the target scale once based on fit-width or zoom state
  const firstPage = await state.pdfDoc.getPage(1);
  const unscaled = firstPage.getViewport({ scale: 1 });
  state.pdfPageWidth = unscaled.width;
  state.pdfPageHeight = unscaled.height;

  if (state.fitWidth) {
    const viewport_el = document.getElementById('pdf-viewport');
    const availWidth = viewport_el.clientWidth - 24;
    state.scale = Math.min(availWidth / unscaled.width, 4);
  }
  document.getElementById('pdf-zoom-info').textContent = `${Math.round(state.scale * 100)}%`;

  // Create placeholder divs immediately so the scrollbar height is correct
  const scale = state.scale;
  const pageDivs = [];
  for (let n = 1; n <= state.totalPages; n++) {
    const pageDiv = document.createElement('div');
    pageDiv.className = 'pdf-page';
    pageDiv.dataset.page = n;
    pageDiv.style.width = `${unscaled.width * scale}px`;
    pageDiv.style.height = `${unscaled.height * scale}px`;
    const canvas = document.createElement('canvas');
    const textLayer = document.createElement('div');
    textLayer.className = 'textLayer';
    const highlightLayer = document.createElement('div');
    highlightLayer.className = 'highlight-layer';
    pageDiv.appendChild(canvas);
    pageDiv.appendChild(textLayer);
    pageDiv.appendChild(highlightLayer);
    container.appendChild(pageDiv);
    pageDivs.push({ pageDiv, canvas, textLayer, n });
  }

  // Render each page sequentially (but don't block the UI — use yield points)
  for (const { canvas, textLayer, n } of pageDivs) {
    await renderOnePage(n, canvas, textLayer, scale);
  }
}

async function renderOnePage(n, canvas, textLayer, scale) {
  try {
    const page = await state.pdfDoc.getPage(n);
    const viewport = page.getViewport({ scale });
    const ctx = canvas.getContext('2d');

    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.floor(viewport.width * dpr);
    canvas.height = Math.floor(viewport.height * dpr);
    canvas.style.width = `${viewport.width}px`;
    canvas.style.height = `${viewport.height}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    await page.render({ canvasContext: ctx, viewport }).promise;

    // Text layer for selection/search
    textLayer.innerHTML = '';
    textLayer.style.width = `${viewport.width}px`;
    textLayer.style.height = `${viewport.height}px`;
    textLayer.style.setProperty('--scale-factor', viewport.scale);
    try {
      const textContent = await page.getTextContent();
      const renderTask = new pdfjsLib.TextLayer({
        textContentSource: textContent,
        container: textLayer,
        viewport: viewport,
      });
      await renderTask.render();
    } catch (e) {
      // non-fatal
    }
  } catch (e) {
    console.error(`Render error on page ${n}:`, e);
  }
}

function drawHighlightsOnPage(pageNum, boxes) {
  const pageDiv = document.querySelector(`.pdf-page[data-page="${pageNum}"]`);
  if (!pageDiv) return;
  const layer = pageDiv.querySelector('.highlight-layer');
  layer.innerHTML = '';
  if (!boxes || boxes.length === 0) return;

  const scale = state.scale;
  for (const box of boxes) {
    const div = document.createElement('div');
    div.className = 'highlight-box';
    div.style.left = `${box.x * scale}px`;
    div.style.top = `${box.y * scale}px`;
    div.style.width = `${box.w * scale}px`;
    div.style.height = `${box.h * scale}px`;
    layer.appendChild(div);
  }
}

function scrollToPage(pageNum, boxes) {
  const pageDiv = document.querySelector(`.pdf-page[data-page="${pageNum}"]`);
  if (!pageDiv) return;
  const viewport = document.getElementById('pdf-viewport');
  const scale = state.scale;

  let targetTop = pageDiv.offsetTop - 20;
  if (boxes && boxes.length > 0) {
    const firstBoxY = Math.min(...boxes.map(b => b.y)) * scale;
    targetTop = pageDiv.offsetTop + firstBoxY - 100;
  }
  viewport.scrollTo({ top: targetTop, behavior: 'smooth' });
}

function attachScrollTracking() {
  const viewport = document.getElementById('pdf-viewport');
  let rafId = null;
  viewport.addEventListener('scroll', () => {
    if (rafId) return;
    rafId = requestAnimationFrame(() => {
      rafId = null;
      updateCurrentPageFromScroll();
    });
  });
  updateCurrentPageFromScroll();
}

function updateCurrentPageFromScroll() {
  const viewport = document.getElementById('pdf-viewport');
  const pages = document.querySelectorAll('.pdf-page');
  const viewportMid = viewport.scrollTop + viewport.clientHeight / 3;
  let current = 1;
  for (const p of pages) {
    const top = p.offsetTop;
    const bottom = top + p.offsetHeight;
    if (top <= viewportMid && viewportMid < bottom) {
      current = parseInt(p.dataset.page, 10);
      break;
    }
  }
  state.currentPage = current;
  document.getElementById('pdf-page-info').textContent =
    `Page ${current} / ${state.totalPages}`;
}

window.pdfPrevPage = function() {
  const n = Math.max(1, state.currentPage - 1);
  scrollToPage(n, null);
};

window.pdfNextPage = function() {
  const n = Math.min(state.totalPages, state.currentPage + 1);
  scrollToPage(n, null);
};

window.pdfZoomIn = async function() {
  state.fitWidth = false;
  state.scale = Math.min(state.scale * 1.25, 5);
  await buildPages();
};

window.pdfZoomOut = async function() {
  state.fitWidth = false;
  state.scale = Math.max(state.scale / 1.25, 0.25);
  await buildPages();
};

window.pdfZoomFit = async function() {
  state.fitWidth = true;
  await buildPages();
};

window.pdfZoomReset = async function() {
  state.fitWidth = false;
  state.scale = 1.0;
  await buildPages();
};

// Keyboard shortcuts
document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

  if ((e.ctrlKey || e.metaKey) && (e.key === '=' || e.key === '+')) { e.preventDefault(); window.pdfZoomIn(); }
  else if ((e.ctrlKey || e.metaKey) && e.key === '-') { e.preventDefault(); window.pdfZoomOut(); }
  else if ((e.ctrlKey || e.metaKey) && e.key === '0') { e.preventDefault(); window.pdfZoomReset(); }
  else if (e.key === 'PageDown' || (e.key === 'ArrowRight' && e.altKey)) { e.preventDefault(); window.pdfNextPage(); }
  else if (e.key === 'PageUp' || (e.key === 'ArrowLeft' && e.altKey)) { e.preventDefault(); window.pdfPrevPage(); }
});

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------
function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function escapeAttr(str) {
  if (str === null || str === undefined) return '';
  return String(str).replace(/'/g, "\\'").replace(/"/g, '&quot;');
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
async function init() {
  await loadSelections();
  startPolling();
  initPdf();

  // Re-render PDF on resize (only if fit-width is active)
  let resizeTimer;
  window.addEventListener('resize', () => {
    if (!state.fitWidth) return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => buildPages(), 250);
  });
}

init();
