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
  try {
    // Focus the doc editor
    const editor = document.querySelector('.kix-appview-editor, [role="textbox"]');
    if (editor) editor.click();

    await new Promise(r => setTimeout(r, 100));

    // Select all
    document.execCommand('selectAll');

    await new Promise(r => setTimeout(r, 100));

    // Create a hidden textarea and intercept the copy
    return new Promise((resolve) => {
      const handler = (e) => {
        const text = e.clipboardData.getData('text/plain');
        document.removeEventListener('copy', handler);
        e.preventDefault();
        resolve({ text, success: text.length > 0 });
      };
      document.addEventListener('copy', handler);
      document.execCommand('copy');

      // Timeout fallback
      setTimeout(() => {
        document.removeEventListener('copy', handler);
        resolve({ text: null, success: false, error: 'Timeout' });
      }, 1000);
    });
  } catch (err) {
    return { text: null, success: false, error: err.message };
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

  // Assignment title
  const titleSelectors = ['h1[jsname]', '.Df26Gf', 'h1'];
  for (const sel of titleSelectors) {
    const el = document.querySelector(sel);
    if (el && el.textContent.trim().length > 2) {
      result.assignment_title = el.textContent.trim();
      break;
    }
  }

  // Student name
  const studentSelectors = ['.RjsPE', '.YVvGBb', '[data-student-name]'];
  for (const sel of studentSelectors) {
    const el = document.querySelector(sel);
    if (el && el.textContent.trim().length > 1) {
      result.student_name = el.textContent.trim();
      break;
    }
  }

  // Submission text
  const textSelectors = ['.ql-editor', '[contenteditable="true"]'];
  for (const sel of textSelectors) {
    const el = document.querySelector(sel);
    if (el && el.innerText.trim().length > 30) {
      result.submission_text = el.innerText.trim();
      break;
    }
  }

  // Check for embedded Doc iframe
  if (!result.submission_text) {
    const hasDocFrame = document.querySelector('iframe[src*="docs.google.com"]');
    if (hasDocFrame) result.has_embedded_doc = true;
  }

  return result;
}
