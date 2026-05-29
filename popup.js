/**
 * popup.js
 * Drives all three screens: setup, main, results.
 */

const API_URL = 'https://ai-detector-api-production-64d7.up.railway.app';

let state = {
  schoolToken: null,
  studentName: null,
  assignmentTitle: null,
  submissionText: null,
  selectedBaselineIds: new Set(),
  baselines: [],
  currentTab: null,
  isDocsPage: false,
  isAuthenticated: false,
  currentDocId: null
};

// ─── Init ─────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  const stored = await chrome.storage.local.get(['school_token']);
  state.schoolToken = stored.school_token || null;

  if (!state.schoolToken) {
    showScreen('setup');
  } else {
    showScreen('main');
    await loadPageContext();
  }

  bindEvents();
});

function bindEvents() {
  document.getElementById('btn-save-token').addEventListener('click', saveSchoolToken);
  document.getElementById('btn-settings').addEventListener('click', () => showScreen('setup'));
  document.getElementById('btn-analyze').addEventListener('click', runAnalysis);
  document.getElementById('btn-save-baseline').addEventListener('click', saveBaseline);
  document.getElementById('btn-refresh-baselines').addEventListener('click', loadBaselines);
  document.getElementById('btn-back').addEventListener('click', () => showScreen('main'));
  document.getElementById('btn-sign-in').addEventListener('click', signIn);
  document.getElementById('btn-check-revisions').addEventListener('click', checkRevisions);
  document.getElementById('btn-playback').addEventListener('click', openPlayback);
}

// ─── Screen management ────────────────────────────────────────────────────────

function showScreen(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.add('hidden'));
  document.getElementById(`screen-${name}`).classList.remove('hidden');
}

// ─── Setup ────────────────────────────────────────────────────────────────────

async function saveSchoolToken() {
  const token = document.getElementById('input-school-token').value.trim();
  if (!token) return setStatus('Please enter a school code.', 'error');
  await chrome.storage.local.set({ school_token: token });
  state.schoolToken = token;
  showScreen('main');
  await loadPageContext();
}

// ─── Page context ─────────────────────────────────────────────────────────────

async function loadPageContext() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const isClassroom = tab.url.includes('classroom.google.com');
    const isDocs = tab.url.includes('docs.google.com');

    if (!isClassroom && !isDocs) {
      setStatus('Navigate to a Google Classroom submission or Google Doc to use this tool.', 'info');
      return;
    }

    state.isDocsPage = isDocs;
    state.currentTab = tab;

    // Extract doc ID from URL if on Docs
    if (isDocs) {
      const match = tab.url.match(/\/document\/d\/([a-zA-Z0-9_-]+)/);
      state.currentDocId = match ? match[1] : null;
    }

    // Force inject content script
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['content.js']
    });

    const data = await chrome.tabs.sendMessage(tab.id, { action: 'scrapeSubmission' });

    state.studentName = data.student_name || null;
    state.assignmentTitle = data.assignment_title || null;
    state.submissionText = data.submission_text || null;

    document.getElementById('ctx-student').textContent = state.studentName || 'Not detected';
    document.getElementById('ctx-assignment').textContent = state.assignmentTitle || 'Not detected';

    if (isDocs) {
      await handleDocsPage();
    } else if (data.has_embedded_doc || !state.submissionText) {
      document.getElementById('paste-area').classList.remove('hidden');
      document.getElementById('ctx-words').textContent = '—';
    } else {
      const words = state.submissionText.trim().split(/\s+/).length;
      document.getElementById('ctx-words').textContent = words;
    }

    if (state.studentName) await loadBaselines();

  } catch (err) {
    console.error('loadPageContext error:', err);
    document.getElementById('paste-area').classList.remove('hidden');
    document.getElementById('ctx-student').textContent = 'Not detected';
    document.getElementById('ctx-assignment').textContent = 'Not detected';
  }
}

async function handleDocsPage() {
  // Check auth status
  const authResult = await chrome.runtime.sendMessage({ action: 'checkAuth' });
  state.isAuthenticated = authResult.authenticated;

  if (!state.isAuthenticated) {
    // Show sign in prompt
    document.getElementById('auth-prompt').classList.remove('hidden');
    document.getElementById('paste-area').classList.remove('hidden');
    document.getElementById('ctx-words').textContent = '—';
    updateAuthStatus(false);
  } else {
    // Signed in — read doc automatically
    updateAuthStatus(true);
    document.getElementById('revision-section').classList.remove('hidden');
    await readDocContent();
  }
}

async function readDocContent() {
  if (!state.currentDocId) {
    document.getElementById('paste-area').classList.remove('hidden');
    return;
  }

  setStatus('Reading document...', 'info');

  const result = await chrome.runtime.sendMessage({
    action: 'readGoogleDoc',
    payload: { docId: state.currentDocId }
  });

  if (result.success && result.text && result.text.length > 20) {
    state.submissionText = result.text;
    const words = result.text.trim().split(/\s+/).length;
    document.getElementById('ctx-words').textContent = words;
    setStatus(`✓ Document read (${words} words)`, 'success');
  } else {
    document.getElementById('paste-area').classList.remove('hidden');
    setStatus('Could not read document automatically. Paste text manually.', 'error');
  }
}

async function openPlayback() {
  if (!state.currentDocId) {
    setStatus('No document ID found. Open a Google Doc first.', 'error');
    return;
  }

  setStatus('Opening playback...', 'info');

  try {
    const result = await chrome.runtime.sendMessage({ action: 'getAuthToken' });
    if (!result.token) {
      setStatus('Please connect your Google account first.', 'error');
      return;
    }

    const title = encodeURIComponent(state.assignmentTitle || 'Untitled Document');
    const url = `https://ai-detector-api-production-64d7.up.railway.app/view/playback?docId=${state.currentDocId}&token=${encodeURIComponent(result.token)}&title=${title}`;
    chrome.tabs.create({ url });
  } catch (err) {
    setStatus('Could not open playback.', 'error');
  }
}

async function checkRevisions() {
  if (!state.currentDocId) return;

  const revDiv = document.getElementById('revision-results');
  revDiv.innerHTML = '<div class="empty-state">Checking revision history...</div>';

  const result = await chrome.runtime.sendMessage({
    action: 'fetchDocActivity',
    payload: { docId: state.currentDocId }
  });

  if (!result.success) {
    revDiv.innerHTML = `<div class="empty-state">Could not fetch revision history: ${result.error}</div>`;
    return;
  }

  const data = result.data;
  let html = '';

  if (data.first_edit) {
    html += `<div class="rev-meta">${data.total_edit_sessions} edit sessions · ${data.span_hours > 24 ? Math.round(data.span_hours / 24) + ' days' : Math.round(data.span_hours) + ' hours'} total</div>`;
  }

  for (const sig of data.signals) {
    html += `
      <div class="signal-item ${sig.flagged ? 'signal-flagged' : ''}">
        <div class="signal-label">${sig.flagged ? '⚠ ' : ''}${escHtml(sig.label)}</div>
        <div class="signal-detail">${escHtml(sig.detail)}</div>
      </div>
    `;
  }

  revDiv.innerHTML = html;
}

async function signIn() {
  setStatus('Signing in...', 'info');
  const result = await chrome.runtime.sendMessage({ action: 'signIn' });

  if (result.success) {
    state.isAuthenticated = true;
    document.getElementById('auth-prompt').classList.add('hidden');
    document.getElementById('revision-section').classList.remove('hidden');
    updateAuthStatus(true);
    await readDocContent();
  } else {
    setStatus(`Sign in failed: ${result.error}`, 'error');
  }
}

function updateAuthStatus(authenticated) {
  const el = document.getElementById('auth-status');
  if (authenticated) {
    el.innerHTML = '<span class="auth-dot auth-on" title="Google connected">●</span>';
  } else {
    el.innerHTML = '<span class="auth-dot auth-off" title="Not connected">●</span>';
  }
}

function getSubmissionText() {
  const manual = document.getElementById('manual-text').value.trim();
  return manual.length > 0 ? manual : state.submissionText;
}

function getStudentName() {
  return state.studentName || prompt('Student name not detected. Enter student name:');
}

// ─── Baselines ────────────────────────────────────────────────────────────────

async function loadBaselines() {
  if (!state.studentName) { renderBaselines([]); return; }

  try {
    const result = await chrome.runtime.sendMessage({
      action: 'fetchBaselines',
      payload: { student_name: state.studentName, school_token: state.schoolToken }
    });
    if (result.error) throw new Error(result.error);
    state.baselines = result.baselines || [];
    state.selectedBaselineIds = new Set();
    renderBaselines(state.baselines);
  } catch (err) {
    console.error('Failed to load baselines:', err);
    renderBaselines([]);
  }
}

function renderBaselines(baselines) {
  const list = document.getElementById('baseline-list');
  if (baselines.length === 0) {
    list.innerHTML = '<div class="empty-state">No baselines saved for this student yet.</div>';
    return;
  }

  list.innerHTML = baselines.map(b => `
    <div class="baseline-item" data-id="${b.id}">
      <label class="baseline-check-label">
        <input type="checkbox" class="baseline-checkbox" data-id="${b.id}" />
        <div class="baseline-info">
          <div class="baseline-title">${escHtml(b.assignment_title || 'Untitled submission')}</div>
          <div class="baseline-meta">${b.word_count || '?'} words · ${formatDate(b.created_at)}</div>
          <div class="baseline-preview">${escHtml(b.preview || '')}…</div>
        </div>
      </label>
      <button class="delete-baseline-btn" data-id="${b.id}" title="Remove baseline">✕</button>
    </div>
  `).join('');

  list.querySelectorAll('.baseline-checkbox').forEach(cb => {
    cb.addEventListener('change', () => {
      const id = parseInt(cb.dataset.id);
      if (cb.checked) state.selectedBaselineIds.add(id);
      else state.selectedBaselineIds.delete(id);
    });
  });

  list.querySelectorAll('.delete-baseline-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = btn.dataset.id;
      if (!confirm('Remove this baseline?')) return;
      await chrome.runtime.sendMessage({
        action: 'deleteBaseline',
        payload: { baseline_id: id, school_token: state.schoolToken }
      });
      await loadBaselines();
    });
  });
}

// ─── Save baseline ────────────────────────────────────────────────────────────

async function saveBaseline() {
  const text = getSubmissionText();
  const studentName = getStudentName();
  if (!text || text.length < 50) return setStatus('Not enough text to save as a baseline.', 'error');
  if (!studentName) return;

  setStatus('Saving baseline...', 'info');
  const result = await chrome.runtime.sendMessage({
    action: 'saveBaseline',
    payload: {
      student_name: studentName,
      school_token: state.schoolToken,
      text_content: text,
      assignment_title: state.assignmentTitle
    }
  });

  if (result.error) return setStatus(`Error: ${result.error}`, 'error');
  setStatus(`✓ Baseline saved (${result.word_count} words)`, 'success');
  await loadBaselines();
}

// ─── Run analysis ──────────────────────────────────────────────────────────────

async function runAnalysis() {
  const text = getSubmissionText();
  const studentName = getStudentName();
  if (!text || text.length < 50) return setStatus('Not enough text to analyze. Paste the submission text.', 'error');
  if (!studentName) return;

  setStatus('Analyzing... this may take a moment.', 'info');
  document.getElementById('btn-analyze').disabled = true;

  const payload = {
    student_name: studentName,
    school_token: state.schoolToken,
    text_content: text,
    assignment_title: state.assignmentTitle,
    compare_baseline_ids: Array.from(state.selectedBaselineIds)
  };

  const result = await chrome.runtime.sendMessage({ action: 'analyze', payload });
  document.getElementById('btn-analyze').disabled = false;

  if (result.error) { setStatus(`Error: ${result.error}`, 'error'); return; }

  renderResults(result, studentName);
  showScreen('results');
}

// ─── Render results ───────────────────────────────────────────────────────────

function renderResults(data, studentName) {
  const qa = data.qualitative_analysis;
  const signals = data.statistical_signals || [];

  const assessmentLabel = {
    low_concern: { text: 'Low Concern', cls: 'badge-green' },
    moderate_concern: { text: 'Moderate Concern', cls: 'badge-yellow' },
    high_concern: { text: 'High Concern', cls: 'badge-red' },
    consistent: { text: 'Consistent with Baseline', cls: 'badge-green' },
    somewhat_inconsistent: { text: 'Somewhat Inconsistent', cls: 'badge-yellow' },
    significantly_inconsistent: { text: 'Significantly Inconsistent', cls: 'badge-red' }
  }[qa?.overall_assessment] || { text: 'Analysis Complete', cls: 'badge-gray' };

  const flaggedSignals = signals.filter(s => s.flagged);
  const unflaggedSignals = signals.filter(s => !s.flagged);

  let html = `
    <div class="result-student">${escHtml(studentName)}</div>
    ${data.assignment_title ? `<div class="result-assignment">${escHtml(data.assignment_title)}</div>` : ''}
    <div class="verdict-row">
      <span class="badge ${assessmentLabel.cls}">${assessmentLabel.text}</span>
    </div>
    ${qa?.summary ? `<div class="result-summary">${escHtml(qa.summary)}</div>` : ''}
    ${data.baseline_comparison ? `
      <div class="compared-against">
        Compared against ${data.baseline_comparison.baselines_used.length} baseline(s):
        ${data.baseline_comparison.baselines_used.map(b => `<em>${escHtml(b.assignment_title || 'Untitled')}</em>`).join(', ')}
      </div>
    ` : ''}
  `;

  if (signals.length > 0) {
    html += `<div class="section-title-sm">Statistical Signals</div><div class="signals-list">`;
    for (const sig of [...flaggedSignals, ...unflaggedSignals]) {
      html += `
        <div class="signal-item ${sig.flagged ? 'signal-flagged' : ''}">
          <div class="signal-label">${sig.flagged ? '⚠ ' : ''}${escHtml(sig.label)}</div>
          <div class="signal-detail">${escHtml(sig.detail)}</div>
        </div>`;
    }
    html += `</div>`;
  }

  if (qa?.style_observations?.length > 0) {
    html += `<div class="section-title-sm">Style Observations</div><ul class="obs-list">`;
    for (const obs of qa.style_observations) html += `<li>${escHtml(obs)}</li>`;
    html += `</ul>`;
  }

  if (qa?.notable_differences?.length > 0) {
    html += `<div class="section-title-sm">Notable Differences from Baseline</div><ul class="obs-list flagged-list">`;
    for (const d of qa.notable_differences) html += `<li>${escHtml(d)}</li>`;
    html += `</ul>`;
  }

  if (qa?.notable_similarities?.length > 0) {
    html += `<div class="section-title-sm">Similarities to Baseline</div><ul class="obs-list">`;
    for (const s of qa.notable_similarities) html += `<li>${escHtml(s)}</li>`;
    html += `</ul>`;
  }

  if (qa?.flagged_phrases?.length > 0) {
    html += `<div class="section-title-sm">Flagged Phrases</div>`;
    for (const phrase of qa.flagged_phrases.slice(0, 4)) {
      html += `<div class="flagged-phrase">"${escHtml(phrase)}"</div>`;
    }
  }

  if (qa?.authentic_signals?.length > 0) {
    html += `<div class="section-title-sm">Authentic Signals</div><ul class="obs-list auth-list">`;
    for (const a of qa.authentic_signals) html += `<li>${escHtml(a)}</li>`;
    html += `</ul>`;
  }

  if (qa?.teacher_recommendation) {
    html += `
      <div class="recommendation">
        <div class="rec-label">Suggested Next Step</div>
        <div class="rec-text">${escHtml(qa.teacher_recommendation)}</div>
      </div>`;
  }

  html += `<div class="disclaimer">⚠ This report is a decision-support tool only. It does not prove AI authorship and should not be used as the sole basis for any academic action.</div>`;

  document.getElementById('results-body').innerHTML = html;
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function setStatus(msg, type = 'info') {
  const el = document.getElementById('status-msg');
  el.textContent = msg;
  el.className = `status-msg status-${type}`;
  el.classList.remove('hidden');
  if (type === 'success') setTimeout(() => el.classList.add('hidden'), 3000);
}

function escHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatDate(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}
