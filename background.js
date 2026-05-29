/**
 * background.js
 * Service worker for AI Writing Detector extension.
 */

const API_URL = 'https://ai-detector-api-production-64d7.up.railway.app';

const SCOPES = [
  'https://www.googleapis.com/auth/documents.readonly',
  'https://www.googleapis.com/auth/drive.activity.readonly'
];

// ─── Auth helpers ─────────────────────────────────────────────────────────────

async function getAuthToken(interactive = true) {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive, scopes: SCOPES }, (token) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(token);
      }
    });
  });
}

async function removeCachedToken(token) {
  return new Promise((resolve) => {
    chrome.identity.removeCachedAuthToken({ token }, resolve);
  });
}

async function isAuthenticated() {
  try {
    const token = await getAuthToken(false);
    return !!token;
  } catch {
    return false;
  }
}

// ─── Google Docs API ──────────────────────────────────────────────────────────

async function fetchDocContent(docId) {
  const token = await getAuthToken(true);

  const response = await fetch(
    `https://docs.googleapis.com/v1/documents/${docId}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );

  if (response.status === 401) {
    await removeCachedToken(token);
    throw new Error('Token expired. Please try again.');
  }

  if (!response.ok) throw new Error(`Docs API error: ${response.status}`);

  const doc = await response.json();
  return extractTextFromDoc(doc);
}

function extractTextFromDoc(doc) {
  let text = '';
  const content = doc.body?.content || [];

  for (const element of content) {
    if (element.paragraph) {
      for (const pe of element.paragraph.elements || []) {
        if (pe.textRun?.content) text += pe.textRun.content;
      }
    } else if (element.table) {
      for (const row of element.table.tableRows || []) {
        for (const cell of row.tableCells || []) {
          for (const cellEl of cell.content || []) {
            if (cellEl.paragraph) {
              for (const pe of cellEl.paragraph.elements || []) {
                if (pe.textRun?.content) text += pe.textRun.content;
              }
            }
          }
        }
      }
    }
  }

  return text.trim();
}

// ─── Drive Activity API ───────────────────────────────────────────────────────

async function fetchDocActivity(docId) {
  const token = await getAuthToken(false);

  const response = await fetch(
    'https://driveactivity.googleapis.com/v2/activity:query',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        itemName: `items/${docId}`,
        pageSize: 100
      })
    }
  );

  if (response.status === 401) {
    await removeCachedToken(token);
    throw new Error('Token expired');
  }

  if (!response.ok) throw new Error(`Drive Activity API error: ${response.status}`);

  const data = await response.json();
  return analyzeActivityData(data.activities || []);
}

function analyzeActivityData(activities) {
  if (activities.length === 0) {
    return {
      total_edit_sessions: 0,
      signals: [{
        label: 'No Activity Found',
        detail: 'No edit history could be retrieved for this document.',
        flagged: false
      }]
    };
  }

  const editActivities = activities.filter(a =>
    a.primaryActionDetail?.edit !== undefined ||
    a.primaryActionDetail?.create !== undefined
  );

  const timestamps = activities
    .map(a => a.timestamp || a.timeRange?.endTime)
    .filter(Boolean)
    .map(t => new Date(t))
    .sort((a, b) => a - b);

  const firstEdit = timestamps[0];
  const lastEdit = timestamps[timestamps.length - 1];
  const totalSessions = editActivities.length;
  const spanHours = timestamps.length > 1
    ? (lastEdit - firstEdit) / (1000 * 60 * 60)
    : 0;

  const signals = [];

  if (totalSessions <= 2 && spanHours < 1) {
    signals.push({
      label: 'Minimal Edit History',
      detail: `Document shows only ${totalSessions} edit session(s) over ${Math.round(spanHours * 60)} minutes. Content created in a single session may have been pasted in rather than typed.`,
      flagged: true
    });
  } else if (totalSessions <= 3) {
    signals.push({
      label: 'Limited Edit History',
      detail: `Document has ${totalSessions} edit sessions. Human-written work typically shows more iterative editing.`,
      flagged: false
    });
  } else {
    signals.push({
      label: 'Normal Edit History',
      detail: `Document shows ${totalSessions} edit sessions over ${spanHours > 24 ? Math.round(spanHours / 24) + ' days' : Math.round(spanHours) + ' hours'}, suggesting iterative writing.`,
      flagged: false
    });
  }

  if (spanHours < 0.5 && totalSessions > 0) {
    signals.push({
      label: 'Very Short Writing Window',
      detail: `All edits occurred within ${Math.round(spanHours * 60)} minutes. This may indicate copy-paste rather than organic writing.`,
      flagged: true
    });
  }

  return {
    total_edit_sessions: totalSessions,
    first_edit: firstEdit?.toISOString(),
    last_edit: lastEdit?.toISOString(),
    span_hours: parseFloat(spanHours.toFixed(2)),
    signals
  };
}

// ─── Message handler ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'analyze') {
    handleAnalyze(request.payload).then(sendResponse).catch(err => {
      sendResponse({ error: err.message });
    });
    return true;
  }

  if (request.action === 'saveBaseline') {
    handleSaveBaseline(request.payload).then(sendResponse).catch(err => {
      sendResponse({ error: err.message });
    });
    return true;
  }

  if (request.action === 'fetchBaselines') {
    handleFetchBaselines(request.payload).then(sendResponse).catch(err => {
      sendResponse({ error: err.message });
    });
    return true;
  }

  if (request.action === 'deleteBaseline') {
    handleDeleteBaseline(request.payload).then(sendResponse).catch(err => {
      sendResponse({ error: err.message });
    });
    return true;
  }

  if (request.action === 'getAuthToken') {
    getAuthToken(false).then(token => sendResponse({ token })).catch(() => {
      sendResponse({ token: null });
    });
    return true;
  }

  if (request.action === 'checkAuth') {
    isAuthenticated().then(auth => sendResponse({ authenticated: auth })).catch(() => {
      sendResponse({ authenticated: false });
    });
    return true;
  }

  if (request.action === 'signIn') {
    getAuthToken(true).then(token => sendResponse({ success: !!token })).catch(err => {
      sendResponse({ success: false, error: err.message });
    });
    return true;
  }

  if (request.action === 'signOut') {
    getAuthToken(false).then(token => {
      if (token) return removeCachedToken(token);
    }).then(() => sendResponse({ success: true })).catch(() => {
      sendResponse({ success: true });
    });
    return true;
  }

  if (request.action === 'readGoogleDoc') {
    const { docId } = request.payload;
    fetchDocContent(docId).then(text => sendResponse({ success: true, text })).catch(err => {
      sendResponse({ success: false, error: err.message });
    });
    return true;
  }

  if (request.action === 'fetchDocActivity') {
    const { docId } = request.payload;
    fetchDocActivity(docId).then(data => sendResponse({ success: true, data })).catch(err => {
      sendResponse({ success: false, error: err.message });
    });
    return true;
  }
});

// ─── API calls ────────────────────────────────────────────────────────────────

async function handleAnalyze(payload) {
  const response = await fetch(`${API_URL}/analyze`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (!response.ok) {
    const err = await response.json();
    throw new Error(err.error || 'API error');
  }
  return response.json();
}

async function handleSaveBaseline(payload) {
  const response = await fetch(`${API_URL}/baseline`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (!response.ok) {
    const err = await response.json();
    throw new Error(err.error || 'API error');
  }
  return response.json();
}

async function handleFetchBaselines(payload) {
  const { student_name, school_token } = payload;
  const url = `${API_URL}/baseline/${encodeURIComponent(student_name)}?school_token=${encodeURIComponent(school_token)}`;
  const response = await fetch(url);
  if (!response.ok) {
    const err = await response.json();
    throw new Error(err.error || 'API error');
  }
  return response.json();
}

async function handleDeleteBaseline(payload) {
  const { baseline_id, school_token } = payload;
  const url = `${API_URL}/baseline/${baseline_id}?school_token=${encodeURIComponent(school_token)}`;
  const response = await fetch(url, { method: 'DELETE' });
  if (!response.ok) {
    const err = await response.json();
    throw new Error(err.error || 'API error');
  }
  return response.json();
}
