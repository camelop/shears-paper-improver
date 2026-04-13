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
  progress: {},             // criteria -> {current_page, total_pages, status}
  groupMode: 'criteria',    // 'criteria' | 'page'
  allDone: false,
  pdfDoc: null,
  currentPage: 1,
  totalPages: 0,
  scale: 1.0,               // current zoom scale
  fitWidth: true,           // auto-fit to viewport width
  rendering: false,
  pdfPageHeight: 0,         // current page height in PDF points
  pdfPageWidth: 0,          // current page width in PDF points
  pendingHighlight: null,   // {boxes, page} when locate fires before render completes
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
  for (const p of data.problems) {
    if (!state.problems.has(p.id)) {
      state.problems.set(p.id, p);
      if (!state.selections.has(p.id)) {
        state.selections.set(p.id, true);
      }
      changed = true;
    }
  }
  if (changed) {
    renderProblems();
    syncSelectionsToServer();
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
    await Promise.all([pollProblems(), pollProgress()]);
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
    const isPending = info.status === 'pending';
    const statusText = isDone ? 'Done' : (isPending ? 'Pending' : `${current}/${total}`);
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
  const container = document.getElementById('problems-container');
  const problems = Array.from(state.problems.values());

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
}

function renderCard(p) {
  const selected = state.selections.get(p.id) !== false;
  const severity = p.severity || 'low';
  const confidence = typeof p.confidence === 'number' ? p.confidence : null;
  const confidenceClass = confidence === null ? '' : (confidence >= 80 ? '' : (confidence >= 60 ? 'medium' : 'low'));
  const pidEsc = escapeAttr(p.id);

  return `
    <div class="problem-card severity-${severity} ${selected ? 'selected' : ''}" data-id="${pidEsc}">
      <div class="card-header">
        <input type="checkbox" ${selected ? 'checked' : ''}
               onchange="window.toggleSelection('${pidEsc}', this.checked)">
        <div class="card-summary" onclick="window.toggleExpand(this.closest('.problem-card'))">
          <span class="card-title">${escapeHtml(p.title || p.id)}</span>
          <div class="card-meta">
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
      <div class="card-body">
        <h4>Description</h4>
        <p>${escapeHtml(p.description || 'No description')}</p>
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

  for (const [, items] of sorted) {
    items.sort((a, b) => (a.page || 0) - (b.page || 0) || (a.line_start || 0) - (b.line_start || 0));
  }

  return sorted;
}

function updateSelectionCount() {
  const total = state.problems.size;
  const selected = Array.from(state.selections.values()).filter(Boolean).length;
  document.getElementById('selection-count').textContent = `${selected} / ${total} selected`;
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

window.toggleExpand = function(card) {
  const body = card.querySelector('.card-body');
  if (body) body.classList.toggle('expanded');
};

window.setGroupMode = function(mode) {
  state.groupMode = mode;
  document.querySelectorAll('[data-group]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.group === mode);
  });
  renderProblems();
};

window.selectAll = function() {
  for (const pid of state.problems.keys()) state.selections.set(pid, true);
  renderProblems();
  syncSelectionsToServer();
};

window.deselectAll = function() {
  for (const pid of state.problems.keys()) state.selections.set(pid, false);
  renderProblems();
  syncSelectionsToServer();
};

window.locateProblem = async function(pid) {
  const p = state.problems.get(pid);
  if (!p || !p.file || !p.line_start) return;

  const url = `/api/locate?file=${encodeURIComponent(p.file)}&line_start=${p.line_start}&line_end=${p.line_end || p.line_start}`;
  const data = await fetchJSON(url);

  let targetPage = p.page;
  let boxes = null;

  if (data && data.page) {
    targetPage = data.page;
    boxes = data.boxes;
  }

  if (targetPage && targetPage !== state.currentPage) {
    state.currentPage = targetPage;
    state.pendingHighlight = boxes ? { boxes, page: targetPage } : null;
    await renderPdfPage();
  } else if (boxes) {
    drawHighlights(boxes);
  }
};

window.clearHighlights = function() {
  document.getElementById('highlight-layer').innerHTML = '';
};

// ---------------------------------------------------------------------------
// PDF Viewer
// ---------------------------------------------------------------------------
async function initPdf() {
  try {
    state.pdfDoc = await pdfjsLib.getDocument('/pdf').promise;
    state.totalPages = state.pdfDoc.numPages;
    state.currentPage = 1;
    await renderPdfPage();
  } catch (e) {
    console.warn('Could not load PDF:', e);
    document.getElementById('pdf-viewport').innerHTML =
      '<div class="empty-state">PDF not available</div>';
  }
}

async function renderPdfPage() {
  if (!state.pdfDoc || state.rendering) return;
  state.rendering = true;
  clearHighlights();

  try {
    const page = await state.pdfDoc.getPage(state.currentPage);
    const canvas = document.getElementById('pdf-canvas');
    const ctx = canvas.getContext('2d');

    const unscaledViewport = page.getViewport({ scale: 1 });
    state.pdfPageWidth = unscaledViewport.width;
    state.pdfPageHeight = unscaledViewport.height;

    let scale = state.scale;
    if (state.fitWidth) {
      const viewport_el = document.getElementById('pdf-viewport');
      const availWidth = viewport_el.clientWidth - 24;
      scale = Math.min(availWidth / unscaledViewport.width, 4);
    }
    state.scale = scale;

    const viewport = page.getViewport({ scale });

    // Render canvas at device pixel ratio for crisp text
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.floor(viewport.width * dpr);
    canvas.height = Math.floor(viewport.height * dpr);
    canvas.style.width = `${viewport.width}px`;
    canvas.style.height = `${viewport.height}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Set page container size to match
    const container = document.getElementById('pdf-page-container');
    container.style.width = `${viewport.width}px`;
    container.style.height = `${viewport.height}px`;

    await page.render({ canvasContext: ctx, viewport }).promise;

    // Render the text layer for selection/search
    await renderTextLayer(page, viewport);

    document.getElementById('pdf-page-info').textContent =
      `Page ${state.currentPage} / ${state.totalPages}`;
    document.getElementById('pdf-zoom-info').textContent = `${Math.round(scale * 100)}%`;

    // Apply pending highlight if it targets this page
    if (state.pendingHighlight && state.pendingHighlight.page === state.currentPage) {
      drawHighlights(state.pendingHighlight.boxes);
      state.pendingHighlight = null;
    }
  } catch (e) {
    console.error('PDF render error:', e);
  } finally {
    state.rendering = false;
  }
}

async function renderTextLayer(page, viewport) {
  const textLayerDiv = document.getElementById('text-layer');
  textLayerDiv.innerHTML = '';
  textLayerDiv.style.width = `${viewport.width}px`;
  textLayerDiv.style.height = `${viewport.height}px`;
  textLayerDiv.style.setProperty('--scale-factor', viewport.scale);

  try {
    const textContent = await page.getTextContent();
    const renderTask = new pdfjsLib.TextLayer({
      textContentSource: textContent,
      container: textLayerDiv,
      viewport: viewport,
    });
    await renderTask.render();
  } catch (e) {
    console.warn('Text layer render error:', e);
  }
}

function drawHighlights(boxes) {
  const layer = document.getElementById('highlight-layer');
  layer.innerHTML = '';
  if (!boxes || boxes.length === 0) return;

  const scale = state.scale;
  layer.style.width = `${state.pdfPageWidth * scale}px`;
  layer.style.height = `${state.pdfPageHeight * scale}px`;

  // Synctex coordinates are in PDF points with origin at top-left.
  let firstBoxY = null;
  for (const box of boxes) {
    const div = document.createElement('div');
    div.className = 'highlight-box';
    div.style.left = `${box.x * scale}px`;
    div.style.top = `${box.y * scale}px`;
    div.style.width = `${box.w * scale}px`;
    div.style.height = `${box.h * scale}px`;
    layer.appendChild(div);
    if (firstBoxY === null) firstBoxY = box.y * scale;
  }

  // Scroll the first highlight into view
  if (firstBoxY !== null) {
    const viewport = document.getElementById('pdf-viewport');
    const container = document.getElementById('pdf-page-container');
    viewport.scrollTo({
      top: container.offsetTop + firstBoxY - 100,
      behavior: 'smooth',
    });
  }
}

window.pdfPrevPage = function() {
  if (state.currentPage > 1) {
    state.currentPage--;
    renderPdfPage();
  }
};

window.pdfNextPage = function() {
  if (state.currentPage < state.totalPages) {
    state.currentPage++;
    renderPdfPage();
  }
};

window.pdfZoomIn = function() {
  state.fitWidth = false;
  state.scale = Math.min(state.scale * 1.25, 5);
  renderPdfPage();
};

window.pdfZoomOut = function() {
  state.fitWidth = false;
  state.scale = Math.max(state.scale / 1.25, 0.25);
  renderPdfPage();
};

window.pdfZoomFit = function() {
  state.fitWidth = true;
  renderPdfPage();
};

window.pdfZoomReset = function() {
  state.fitWidth = false;
  state.scale = 1.0;
  renderPdfPage();
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
    resizeTimer = setTimeout(renderPdfPage, 200);
  });
}

init();
