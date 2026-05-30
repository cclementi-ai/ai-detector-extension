chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'scrapeSubmission') {
    const data = scrapeSubmission();
    sendResponse(data);
  }

  if (request.action === 'readGoogleDoc') {
    readGoogleDocViaClipboard().then(sendResponse).catch(err => {
      sendResponse({ error: err.message });
    });
    return true;
  }

  return true;
});

function scrapeSubmission() {
  const url = window.location.href;

  if (url.includes('docs.google.com')) {
    return scrapeGoogleDoc();
  } else if (url.includes('classroom.google.com')) {
    return scrapeClassroom();
  }

  return {
    student_name: null,
    assignment_title: null,
    submission_text: null,
    source: 'unknown',
    url
  };
}

function scrapeGoogleDoc() {
  const result = {
    student_name: null,
    assignment_title: null,
    submission_text: null,
    source: 'google_docs',
    url: window.location.href
  };

  // Get document title
  const titleEl = document.querySelector('.docs-title-input');
  if (titleEl) result.assignment_title = titleEl.value || titleEl.textContent.trim();

  return result;
}

async function readGoogleDocViaClipboard() {
  // Focus the document editor
  const editor = document.querySelector('.kix-appview-editor, .docs-texteventtarget-iframe');
  if (editor) editor.focus();

  // Select all content in the doc
  document.execCommand('selectAll');

  // Small delay to let selection register
  await new Promise(r => setTimeout(r, 150));

  // Copy to clipboard
  document.execCommand('copy');

  // Another small delay
  await new Promise(r => setTimeout(r, 150));

  // Read from clipboard
  try {
    const text = await navigator.clipboard.readText();
    return { text, success: true };
  } catch (err) {
    // Fallback — if clipboard API blocked, tell popup to show paste area
    return { text: null, success: false, error: 'Clipboard access denied' };
  }
}

function scrapeClassroom() {
  const result = {
    student_name: null,
    assignment_title: null,
    submission_text: null,
    source: 'google_classroom',
    url: window.location.href
  };

  // Assignment title — try multiple selectors (Google changes these classes periodically)
  const titleSelectors = ['.gb_Vc', '.gb_yd', '.gb_Tc'];
  for (const sel of titleSelectors) {
    const el = document.querySelector(sel);
    if (el && el.textContent.trim().length > 2 && el.textContent.trim().length < 100) {
      result.assignment_title = el.textContent.trim();
      break;
    }
  }

  // Student name — look for UvCNFb class
  const studentEl = document.querySelector('.UvCNFb');
  if (studentEl && studentEl.textContent.trim().length > 1) {
    result.student_name = studentEl.textContent.trim();
  }

  // Submission text — try contenteditable and Quill editor
  const textSelectors = ['.ql-editor', '[contenteditable="true"]'];
  for (const sel of textSelectors) {
    const el = document.querySelector(sel);
    if (el && el.innerText.trim().length > 30) {
      result.submission_text = el.innerText.trim();
      break;
    }
  }

  // Try to find embedded Google Doc ID from iframes
  if (!result.submission_text) {
    const iframes = document.querySelectorAll('iframe');
    for (const iframe of iframes) {
      const match = iframe.src?.match(/\/document\/d\/([a-zA-Z0-9_-]+)/);
      if (match) {
        result.embedded_doc_id = match[1];
        result.has_embedded_doc = true;
        break;
      }
    }
  }

  // Check for embedded Doc iframe (fallback flag)
  if (!result.submission_text && !result.embedded_doc_id) {
    const hasDocFrame = document.querySelector('iframe[src*="docs.google.com"]');
    if (hasDocFrame) result.has_embedded_doc = true;
  }

  return result;
}
