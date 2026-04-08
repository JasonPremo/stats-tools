/**
 * survey.js — Survey frontend
 *
 * Responsibilities:
 *  1. Fetch survey definition from /survey.json
 *  2. Start a session via POST /api/start
 *  3. Evaluate display_if conditions in real time
 *  4. Render all question types
 *  5. Handle page navigation, validation, and checkpointing
 *  6. POST each page to /api/page, final page to /api/submit
 */

"use strict";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let SURVEY      = null;   // full survey definition from /survey.json
let SESSION_ID  = null;   // UUID from /api/start
let answers     = {};     // { questionId: value }  — flat answer store
let currentPageIndex = 0; // index into the VISIBLE pages array
let maxPageReached   = 0; // highest page index the user has visited
let variables   = {};     // { varName: displayString } — resolved from defines_variable

// Debug mode
let DEBUG_MODE    = false;
let DEBUG_CSV_MAP = {};   // { questionId: [csv_col_names] }


// ---------------------------------------------------------------------------
// Variable resolution
// ---------------------------------------------------------------------------

/**
 * Rebuild the variables dict from current answers and all defines_variable
 * declarations in the survey.
 */
function rebuildVariables() {
  const vars = {};
  if (!SURVEY) return;
  SURVEY.pages.forEach(page => {
    page.questions.forEach(q => {
      if (!q.defines_variable) return;
      const v = q.defines_variable;
      const answer = answers[q.id];
      if (answer === undefined || answer === null || answer === "") {
        // No answer yet — variable is undefined
        return;
      }
      if (v.mapping) {
        const key = String(answer);
        if (key in v.mapping) {
          vars[v.name] = v.mapping[key];
        }
        // If the answer doesn't match any mapping key, leave undefined
      } else {
        // No mapping — use the raw answer value as the display string
        vars[v.name] = String(answer);
      }
    });
  });
  variables = vars;
}

/**
 * Replace {var_name} placeholders in a string with their current values.
 * Unresolved variables are left as {var_name} (shown literally).
 */
function resolveVars(str) {
  if (!str) return str;
  return str.replace(/\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g, (match, name) => {
    return name in variables ? variables[name] : match;
  });
}


// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

document.addEventListener("DOMContentLoaded", async () => {
  try {
    SURVEY = await fetchSurvey();

    // Check for debug mode
    const params = new URLSearchParams(window.location.search);
    const debugKey = params.get("debug");
    if (debugKey) {
      await activateDebugMode(debugKey);
    }

    // Check for resume parameter
    const resumeId = params.get("resume");

    if (resumeId) {
      const resumed = await resumeSession(resumeId);
      if (resumed) return;
    }

    SESSION_ID = await startSession();
    renderWelcome();
    showScreen("welcome");
  } catch (e) {
    showError(e.message || "Failed to load the survey.");
  }
});

async function activateDebugMode(key) {
  try {
    const r = await fetch(`/api/debug-verify?key=${encodeURIComponent(key)}`);
    if (!r.ok) {
      console.warn("Debug key rejected");
      return;
    }
    const data = await r.json();
    DEBUG_MODE = true;
    DEBUG_CSV_MAP = data.csv_columns || {};
    document.body.classList.add("debug-mode");
    console.log("%c[DEBUG MODE ACTIVE]", "color: #e74c3c; font-weight: bold; font-size: 14px");
  } catch (e) {
    console.warn("Debug activation failed:", e);
  }
}


async function fetchSurvey() {
  const r = await fetch("/survey.json");
  if (!r.ok) throw new Error("Could not load survey definition.");
  return r.json();
}

async function startSession() {
  const r = await fetch("/api/start", { method: "POST" });
  if (!r.ok) throw new Error("Could not start session.");
  const data = await r.json();
  return data.session_id;
}

async function resumeSession(sessionId) {
  try {
    const r = await fetch(`/api/resume/${encodeURIComponent(sessionId)}`);
    if (!r.ok) return false;
    const data = await r.json();

    if (data.completed) {
      // Already submitted — show completion screen
      SESSION_ID = data.session_id;
      showScreen("complete");
      return true;
    }

    SESSION_ID = data.session_id;

    // Restore saved answers
    Object.assign(answers, data.answers);
    rebuildVariables();

    // Determine resume page: find the first visible page that is "not_reached"
    // in the saved visibility, or resume at the last visible page.
    const vis = data.visibility || {};
    const vPages = visiblePages();
    let resumeIndex = 0;
    for (let i = 0; i < vPages.length; i++) {
      const pageVis = vis[vPages[i].id];
      if (pageVis === "not_reached" || pageVis === undefined) {
        resumeIndex = i;
        break;
      }
      resumeIndex = i;  // keep advancing past visited pages
    }

    // Set up the UI
    document.title = SURVEY.title;
    document.getElementById("sidebar-survey-title").textContent = SURVEY.title;
    buildProgressNav();
    maxPageReached = resumeIndex;
    showScreen("survey");
    navigateToPage(resumeIndex);
    return true;
  } catch (e) {
    console.warn("Resume failed:", e);
    return false;
  }
}


// ---------------------------------------------------------------------------
// Screen management
// ---------------------------------------------------------------------------

function showScreen(name) {
  document.querySelectorAll(".screen").forEach(el => el.classList.remove("active"));
  document.getElementById(`screen-${name}`).classList.add("active");
}

function showError(msg) {
  document.getElementById("error-message").textContent = msg;
  showScreen("error");
}


// ---------------------------------------------------------------------------
// Welcome screen
// ---------------------------------------------------------------------------

function renderWelcome() {
  document.title = SURVEY.title;
  document.getElementById("welcome-title").textContent = SURVEY.title;
  const descEl = document.getElementById("welcome-description");
  if (SURVEY.description) {
    descEl.innerHTML = renderInlineBlock(SURVEY.description);
    descEl.style.display = "";
  } else {
    descEl.style.display = "none";
  }
  document.getElementById("sidebar-survey-title").textContent = SURVEY.title;
  document.getElementById("btn-begin").addEventListener("click", beginSurvey);
}

function beginSurvey() {
  buildProgressNav();
  showScreen("survey");
  navigateToPage(0);
}


// ---------------------------------------------------------------------------
// Condition evaluator
// ---------------------------------------------------------------------------

/**
 * Evaluate a display_if condition tree against the current answers.
 * Returns true if the element should be shown, false if hidden.
 * A null condition means always show.
 */
function evalCondition(cond) {
  if (!cond) return true;

  // Compound condition
  if (cond.operator === "and") {
    return cond.conditions.every(c => evalCondition(c));
  }
  if (cond.operator === "or") {
    return cond.conditions.some(c => evalCondition(c));
  }
  if (cond.operator === "not") {
    return !evalCondition(cond.conditions[0]);
  }

  // Leaf condition
  const { question, operator, value } = cond;
  // $-prefixed references resolve from variables dict, not answers
  const answer = question.startsWith("$")
    ? variables[question.slice(1)]
    : answers[question];

  switch (operator) {
    case "equals":
      return String(answer) === String(value);
    case "not_equals":
      return String(answer) !== String(value);
    case "includes":
      return Array.isArray(answer) && answer.includes(value);
    case "not_includes":
      return !Array.isArray(answer) || !answer.includes(value);
    case "is_answered":
      return answer !== undefined && answer !== null && answer !== "" &&
             !(Array.isArray(answer) && answer.length === 0);
    case "is_not_answered":
      return answer === undefined || answer === null || answer === "" ||
             (Array.isArray(answer) && answer.length === 0);
    case "count_equals": {
      const count = Array.isArray(answer) ? answer.length : 0;
      return count === Number(value);
    }
    case "count_not_equals": {
      const count = Array.isArray(answer) ? answer.length : 0;
      return count !== Number(value);
    }
    case "count_gt": {
      const count = Array.isArray(answer) ? answer.length : 0;
      return count > Number(value);
    }
    case "count_gte": {
      const count = Array.isArray(answer) ? answer.length : 0;
      return count >= Number(value);
    }
    case "count_lt": {
      const count = Array.isArray(answer) ? answer.length : 0;
      return count < Number(value);
    }
    case "count_lte": {
      const count = Array.isArray(answer) ? answer.length : 0;
      return count <= Number(value);
    }
    default:
      console.warn("Unknown operator:", operator);
      return true;
  }
}

/**
 * Is a page currently active (visible)?
 * A page is visible if its display_if evaluates to true.
 */
function isPageVisible(page) {
  return evalCondition(page.display_if);
}

/**
 * Is a question currently active?
 * A question is visible if its own display_if passes AND it has at least
 * one visible child (option or row) when it has conditional children.
 * This prevents empty question shells from appearing.
 */
function isQuestionVisible(question) {
  if (!evalCondition(question.display_if)) return false;

  // If the question has options with display_if conditions, check that at least
  // one option is visible. (Only check if at least one option *has* a condition —
  // if no options are conditional, they're all implicitly visible.)
  if (question.options && question.options.length > 0) {
    const hasAnyConditionalOpt = question.options.some(o => o.display_if);
    if (hasAnyConditionalOpt) {
      const hasVisibleOpt = question.options.some(o => isOptionVisible(o));
      if (!hasVisibleOpt) return false;
    }
  }

  // Same logic for grid rows
  if (question.rows && question.rows.length > 0) {
    const hasAnyConditionalRow = question.rows.some(r => r.display_if);
    if (hasAnyConditionalRow) {
      const hasVisibleRow = question.rows.some(r => isRowVisible(r));
      if (!hasVisibleRow) return false;
    }
  }

  return true;
}

/**
 * Is a grid row currently visible?
 */
function isRowVisible(row) {
  return evalCondition(row.display_if);
}

/**
 * Is an option currently visible?
 */
function isOptionVisible(option) {
  return evalCondition(option.display_if);
}


// ---------------------------------------------------------------------------
// Visibility helpers — returns array of currently-visible pages/indices
// ---------------------------------------------------------------------------

function visiblePages() {
  return SURVEY.pages.filter(p => isPageVisible(p));
}

function visiblePageAt(index) {
  return visiblePages()[index] || null;
}


// ---------------------------------------------------------------------------
// Page navigation
// ---------------------------------------------------------------------------

function navigateToPage(index) {
  currentPageIndex = index;
  if (index > maxPageReached) maxPageReached = index;
  rebuildVariables();
  const vPages = visiblePages();
  const page   = vPages[index];
  if (!page) return;

  renderPage(page, vPages, index);
  updateProgressNav(page.id, vPages);
  updateProgressBar(index, vPages.length);

  // Debug panel
  if (DEBUG_MODE) {
    renderDebugPanel(page, vPages, index);
    addDebugIdOverlays(page);
  }

  // Scroll back to top after page transition.
  // Temporarily override CSS smooth-scroll so the reset is instant —
  // we don't want the user to see the old content scrolling up.
  const html = document.documentElement;
  html.style.scrollBehavior = "auto";
  window.scrollTo(0, 0);
  html.scrollTop = 0;
  document.body.scrollTop = 0;
  // Restore smooth scrolling on next frame
  requestAnimationFrame(() => { html.style.scrollBehavior = ""; });
}


// ---------------------------------------------------------------------------
// Progress sidebar
// ---------------------------------------------------------------------------

function buildProgressNav() {
  // Nav is built dynamically by updateProgressNav — nothing to do here.
}

function updateProgressNav(activePageId, vPages) {
  const nav = document.getElementById("progress-nav");
  nav.innerHTML = "";

  const curIdx = vPages.findIndex(p => p.id === activePageId);

  vPages.forEach((page, idx) => {
    const item = document.createElement("div");
    item.className = "progress-nav-item";
    item.id        = `nav-item-${page.id}`;

    if (page.id === activePageId) {
      item.classList.add("active");
    } else if (idx < curIdx) {
      item.classList.add("completed");
    }

    item.innerHTML = `<span class="nav-dot"></span><span>${escHtml(resolveVars(page.title))}</span>`;

    // Allow clicking to navigate to any page the user has already reached
    // In debug mode, all pages are clickable
    if (DEBUG_MODE || idx <= maxPageReached) {
      item.classList.add("clickable");
      item.addEventListener("click", () => {
        if (idx !== currentPageIndex) {
          navigateToPage(idx);
        }
      });
    }

    nav.appendChild(item);
  });
}

function updateProgressBar(index, total) {
  const pct = total <= 1 ? 100 : Math.round((index / (total - 1)) * 100);
  document.getElementById("progress-bar").style.width = pct + "%";
  document.getElementById("progress-label").textContent =
    `Page ${index + 1} of ${total}`;
}


// ---------------------------------------------------------------------------
// Page renderer
// ---------------------------------------------------------------------------

function renderPage(page, vPages, index) {
  const container = document.getElementById("page-container");
  container.innerHTML = "";

  const pageEl = document.createElement("div");
  pageEl.className = "survey-page";
  pageEl.id = `page-${page.id}`;

  const pageType = page.page_type || "standard";

  // --- Section title page ---
  if (pageType === "section_title") {
    pageEl.classList.add("section-title-page");
    pageEl.innerHTML = `
      <div class="section-title-card">
        <div class="header-rule"></div>
        <h2 class="section-title-heading">${escHtml(resolveVars(page.title))}</h2>
        ${page.description ? `<div class="section-title-desc">${renderInlineBlock(resolveVars(page.description))}</div>` : ""}
        <div class="header-rule"></div>
      </div>
    `;
    container.appendChild(pageEl);
    renderNavButtons(index, vPages, page);
    return;
  }

  // --- Breakout page ---
  if (pageType === "breakout") {
    pageEl.classList.add("breakout-page");

    const card = document.createElement("div");
    card.className = "breakout-card";

    card.innerHTML = `
      <div class="breakout-icon">⚠</div>
      <h2 class="breakout-title">${escHtml(resolveVars(page.title))}</h2>
      ${page.description ? `<div class="breakout-desc">${renderInlineBlock(resolveVars(page.description))}</div>` : ""}
    `;

    // Acknowledgment checkbox
    const ackWrap = document.createElement("div");
    ackWrap.className = "breakout-acknowledge";
    const ackLabel = document.createElement("label");
    ackLabel.className = "breakout-ack-label";
    const ackCb = document.createElement("input");
    ackCb.type = "checkbox";
    ackCb.className = "breakout-ack-checkbox";
    const ackText = document.createElement("span");
    ackText.textContent = resolveVars(page.acknowledge_text || "I understand and wish to continue.");
    ackLabel.appendChild(ackCb);
    ackLabel.appendChild(ackText);
    ackWrap.appendChild(ackLabel);
    card.appendChild(ackWrap);

    // Buttons
    const btnRow = document.createElement("div");
    btnRow.className = "breakout-buttons";

    const btnEnd = document.createElement("button");
    btnEnd.className = "btn-primary breakout-btn-end";
    btnEnd.textContent = resolveVars(page.breakout_button_label || "End survey");
    btnEnd.addEventListener("click", () => handleBreakoutEnd(page));

    const btnContinue = document.createElement("button");
    btnContinue.className = "btn-primary breakout-btn-continue";
    btnContinue.textContent = resolveVars(page.continue_button_label || "Continue");
    btnContinue.disabled = true;

    ackCb.addEventListener("change", () => {
      btnContinue.disabled = !ackCb.checked;
    });
    btnContinue.addEventListener("click", () => handleNext(page));

    btnRow.appendChild(btnEnd);
    btnRow.appendChild(btnContinue);
    card.appendChild(btnRow);

    // Back link (only if not the first page)
    if (index > 0) {
      const backLink = document.createElement("button");
      backLink.className = "breakout-back-link";
      backLink.textContent = "← Go back";
      backLink.addEventListener("click", () => handleBack());
      card.appendChild(backLink);
    }

    pageEl.appendChild(card);
    container.appendChild(pageEl);

    // Hide standard nav buttons on breakout pages
    const stdBtnBack = document.getElementById("btn-back");
    const stdBtnNext = document.getElementById("btn-next");
    stdBtnBack.style.visibility = "hidden";
    stdBtnNext.style.display = "none";

    return;
  }

  // --- Standard page ---
  // Page header
  const header = document.createElement("header");
  header.innerHTML = `
    <h2 class="page-title">${escHtml(resolveVars(page.title))}</h2>
    <div class="page-title-rule"></div>
    ${page.description ? `<div class="page-description">${renderInlineBlock(resolveVars(page.description))}</div>` : ""}
  `;
  pageEl.appendChild(header);

  // Questions
  page.questions.forEach(q => {
    const block = renderQuestion(q);
    pageEl.appendChild(block);
  });

  container.appendChild(pageEl);
  renderNavButtons(index, vPages, page);

  // Initial visibility pass
  applyVisibility(page);
}

/**
 * Render the standard Back / Continue nav buttons.
 */
function renderNavButtons(index, vPages, page) {
  const btnBack = document.getElementById("btn-back");
  const btnNext = document.getElementById("btn-next");
  btnNext.style.display = "";  // ensure visible (breakout hides it)

  if (index === 0) {
    btnBack.style.visibility = "hidden";
  } else {
    btnBack.style.visibility = "visible";
    btnBack.onclick = () => handleBack();
  }

  btnNext.textContent = index === vPages.length - 1 ? "Submit survey →" : "Continue →";
  btnNext.onclick = () => handleNext(page);

  // Show save-resume link (only after the first page has been reached)
  const saveWrap = document.getElementById("save-resume");
  if (saveWrap) {
    saveWrap.style.display = index > 0 ? "" : "none";
    const btn = document.getElementById("btn-save-resume");
    btn.onclick = () => showResumeLink(page);
  }
}

/**
 * Build the resume URL for the current session.
 */
function getResumeUrl() {
  const base = window.location.origin + window.location.pathname;
  return `${base}?resume=${encodeURIComponent(SESSION_ID)}`;
}

/**
 * Save current answers and show a copyable resume link.
 */
async function showResumeLink(page) {
  // Save current page's answers first
  const payload = {
    session_id: SESSION_ID,
    page_id:    page.id,
    answers:    buildAnswerSnapshot(),
    visibility: buildVisibilitySnapshot(),
  };

  try {
    await fetch("/api/page", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    // Continue anyway — show the link even if save failed
    console.warn("Save before resume failed:", e);
  }

  const url = getResumeUrl();

  // Remove existing overlay if any
  const existing = document.getElementById("resume-overlay");
  if (existing) existing.remove();

  const overlay = document.createElement("div");
  overlay.id = "resume-overlay";
  overlay.className = "skip-warning-overlay";

  overlay.innerHTML = `
    <div class="skip-warning-card">
      <h3 class="skip-warning-title">Your progress has been saved</h3>
      <p class="skip-warning-body">Use this link to return to your survey where you left off:</p>
      <div class="resume-url-box">
        <input type="text" class="resume-url-input" value="${escHtml(url)}" readonly />
        <button class="btn-primary resume-copy-btn">Copy</button>
      </div>
      <p class="resume-hint">Bookmark this link or copy it to a safe place.</p>
      <div class="skip-warning-buttons">
        <button class="btn-secondary resume-close-btn">Continue survey</button>
      </div>
    </div>
  `;

  const copyBtn = overlay.querySelector(".resume-copy-btn");
  const urlInput = overlay.querySelector(".resume-url-input");
  copyBtn.addEventListener("click", () => {
    urlInput.select();
    navigator.clipboard.writeText(url).then(() => {
      copyBtn.textContent = "Copied!";
      setTimeout(() => { copyBtn.textContent = "Copy"; }, 2000);
    }).catch(() => {
      // Fallback — the input is already selected
      document.execCommand("copy");
      copyBtn.textContent = "Copied!";
      setTimeout(() => { copyBtn.textContent = "Copy"; }, 2000);
    });
  });

  overlay.querySelector(".resume-close-btn").addEventListener("click", () => overlay.remove());
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) overlay.remove();
  });

  document.body.appendChild(overlay);
}

/**
 * Handle ending the survey early from a breakout page.
 */
async function handleBreakoutEnd(page) {
  const payload = {
    session_id: SESSION_ID,
    page_id:    page.id,
    answers:    buildAnswerSnapshot(),
    visibility: buildVisibilitySnapshot(),
  };

  try {
    await fetch("/api/submit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    // Best-effort — still show completion even if submission fails
    console.error("Breakout submit error:", e);
  }

  showScreen("complete");
}


// ---------------------------------------------------------------------------
// Question renderers
// ---------------------------------------------------------------------------

function renderQuestion(q) {
  const block = document.createElement("div");
  const isGrid = ["radio_grid","checkbox_grid","rating_grid","number_grid"].includes(q.type);
  const notePos = q.note_position || "side";
  // Use stacked (single-column) layout when notes aren't in the side column
  const stacked = isGrid || notePos !== "side";
  block.className = "question-block" + (stacked ? " question-block--stacked" : "");
  block.id        = `block-${q.id}`;
  block.dataset.questionId = q.id;

  // Helper to build the notes panel element
  const buildNotes = () => {
    const notes = document.createElement("div");
    notes.className = "question-notes";
    if (q.note_title) {
      const notesLabel = document.createElement("div");
      notesLabel.className = "question-notes-label";
      notesLabel.textContent = q.note_title;
      notes.appendChild(notesLabel);
    }
    const notesText = document.createElement("p");
    notesText.innerHTML = renderInlineBlock(resolveVars(q.notes));
    notes.appendChild(notesText);
    return notes;
  };

  // Inner wrapper holds label + input (and inline notes when stacked)
  const inner = document.createElement("div");
  inner.className = "question-inner";

  const label = document.createElement("label");
  label.className = "question-label";
  label.setAttribute("for", `q-${q.id}`);
  label.innerHTML = renderInline(resolveVars(q.text)) +
    (q.required ? `<span class="required-star" aria-hidden="true">*</span>` : "");
  inner.appendChild(label);

  // Notes: below_text — between label and answers
  // For grids, this is the default position regardless of setting
  if (q.notes && (notePos === "below_text" || isGrid)) {
    inner.appendChild(buildNotes());
  }

  // Render the appropriate input widget
  switch (q.type) {
    case "radio":     inner.appendChild(renderRadio(q));     break;
    case "checkbox":  inner.appendChild(renderCheckbox(q));  break;
    case "dropdown":  inner.appendChild(renderDropdown(q));  break;
    case "text":      inner.appendChild(renderText(q));      break;
    case "textarea":  inner.appendChild(renderTextarea(q));  break;
    case "number":    inner.appendChild(renderNumber(q));    break;
    case "rating":    inner.appendChild(renderRating(q));    break;
    case "radio_grid":    inner.appendChild(renderRadioGrid(q));    break;
    case "checkbox_grid": inner.appendChild(renderCheckboxGrid(q)); break;
    case "rating_grid":   inner.appendChild(renderRatingGrid(q));   break;
    case "number_grid":   inner.appendChild(renderNumberGrid(q));   break;
  }

  // Notes: below_answers — after the input widget
  if (q.notes && notePos === "below_answers" && !isGrid) {
    inner.appendChild(buildNotes());
  }

  block.appendChild(inner);

  // Notes: side — in the second grid column (only for non-grid, non-stacked)
  if (q.notes && notePos === "side" && !isGrid) {
    block.appendChild(buildNotes());
  }

  return block;
}


// ---- Radio ----
function renderRadio(q) {
  const list = document.createElement("div");
  list.className = "options-list";
  if (q.layout === "horizontal") list.classList.add("options-horizontal");
  else if (q.layout === "two_col") list.classList.add("options-two-col");
  list.id = `q-${q.id}`;

  q.options.forEach(opt => {
    const item = document.createElement("label");
    item.className = "option-item";
    item.id        = `opt-${q.id}--${opt.value}`;
    if (!isOptionVisible(opt)) item.classList.add("hidden");

    const input = document.createElement("input");
    input.type  = "radio";
    input.name  = `q-${q.id}`;
    input.value = opt.value;
    if (answers[q.id] === opt.value) {
      input.checked = true;
      item.classList.add("selected");
    }

    // Click-to-deselect: intercept the click before the browser processes it.
    // If this option is already selected, clear it instead of re-selecting.
    input.addEventListener("click", () => {
      if (answers[q.id] === opt.value) {
        // Already selected — deselect
        input.checked = false;
        item.classList.remove("selected");
        delete answers[q.id];
        onAnswerChange();
      }
    });

    input.addEventListener("change", () => {
      list.querySelectorAll(".option-item").forEach(el => el.classList.remove("selected"));
      item.classList.add("selected");
      answers[q.id] = opt.value;
      onAnswerChange();
    });

    const span = document.createElement("span");
    span.className = "option-text";
    span.textContent = resolveVars(opt.text);

    item.appendChild(input);
    item.appendChild(span);
    list.appendChild(item);
  });

  return list;
}


// ---- Checkbox ----
function renderCheckbox(q) {
  if (!Array.isArray(answers[q.id])) answers[q.id] = answers[q.id] ? [answers[q.id]] : [];

  const list = document.createElement("div");
  list.className = "options-list";
  if (q.layout === "horizontal") list.classList.add("options-horizontal");
  else if (q.layout === "two_col") list.classList.add("options-two-col");
  list.id = `q-${q.id}`;

  q.options.forEach(opt => {
    const item = document.createElement("label");
    item.className = "option-item";
    item.id        = `opt-${q.id}--${opt.value}`;
    if (!isOptionVisible(opt)) item.classList.add("hidden");

    const input = document.createElement("input");
    input.type  = "checkbox";
    input.name  = `q-${q.id}`;
    input.value = opt.value;
    if (answers[q.id].includes(opt.value)) {
      input.checked = true;
      item.classList.add("selected");
    }

    input.addEventListener("change", () => {
      if (input.checked) {
        item.classList.add("selected");
        if (!answers[q.id].includes(opt.value)) answers[q.id].push(opt.value);
      } else {
        item.classList.remove("selected");
        answers[q.id] = answers[q.id].filter(v => v !== opt.value);
      }
      onAnswerChange();
    });

    const span = document.createElement("span");
    span.className = "option-text";
    span.textContent = resolveVars(opt.text);

    item.appendChild(input);
    item.appendChild(span);
    list.appendChild(item);
  });

  return list;
}


// ---- Dropdown ----
function renderDropdown(q) {
  const sel = document.createElement("select");
  sel.className = "styled-select";
  sel.id        = `q-${q.id}`;
  sel.name      = `q-${q.id}`;

  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "— Select an option —";
  placeholder.selected = !answers[q.id];
  sel.appendChild(placeholder);

  q.options.forEach(opt => {
    const o = document.createElement("option");
    o.value       = opt.value;
    o.textContent = resolveVars(opt.text);
    if (!isOptionVisible(opt)) o.hidden = true;
    if (answers[q.id] === opt.value) o.selected = true;
    sel.appendChild(o);
  });

  sel.addEventListener("change", () => {
    answers[q.id] = sel.value || null;
    onAnswerChange();
  });

  return sel;
}


// ---- Text ----
function renderText(q) {
  const input = document.createElement("input");
  input.type      = "text";
  input.className = "styled-input";
  input.id        = `q-${q.id}`;
  input.name      = `q-${q.id}`;
  input.value     = answers[q.id] || "";

  input.addEventListener("input", () => {
    answers[q.id] = input.value.trim() || null;
  });

  return input;
}


// ---- Textarea ----
function renderTextarea(q) {
  const ta = document.createElement("textarea");
  ta.className = "styled-textarea";
  ta.id        = `q-${q.id}`;
  ta.name      = `q-${q.id}`;
  ta.value     = answers[q.id] || "";
  ta.rows      = 4;

  ta.addEventListener("input", () => {
    answers[q.id] = ta.value.trim() || null;
  });

  return ta;
}


// ---- Number ----
function renderNumber(q) {
  // Use type="text" with inputmode so we control exactly what's allowed,
  // while mobile keyboards still show a numeric pad.
  const input = document.createElement("input");
  input.type       = "text";
  input.inputMode  = q.integer_only ? "numeric" : "decimal";
  input.className  = "styled-input styled-input--number";
  input.id         = `q-${q.id}`;
  input.name       = `q-${q.id}`;
  // Apply default value if no answer yet
  if (answers[q.id] === undefined && q.default_value !== null && q.default_value !== undefined) {
    answers[q.id] = q.default_value;
  }
  input.value      = answers[q.id] !== undefined && answers[q.id] !== null ? answers[q.id] : "";
  if (q.min !== null && q.min !== undefined) input.dataset.min = q.min;
  if (q.max !== null && q.max !== undefined) input.dataset.max = q.max;

  // Block invalid keystrokes before they reach the input value.
  // Allow: digits, one leading minus (if min < 0 or min is unset),
  // one decimal point (if not integer_only), and control keys.
  const allowMinus   = (q.min === null || q.min === undefined || q.min < 0);
  const allowDecimal = !q.integer_only;

  input.addEventListener("keydown", (e) => {
    // Always allow control keys
    if (e.metaKey || e.ctrlKey) return;
    if (["Backspace", "Delete", "Tab", "Enter", "ArrowLeft", "ArrowRight",
         "ArrowUp", "ArrowDown", "Home", "End"].includes(e.key)) return;

    // Allow minus only at position 0 and only if negative values are possible
    if (e.key === "-") {
      if (allowMinus && input.selectionStart === 0 && !input.value.includes("-")) return;
      e.preventDefault(); return;
    }

    // Allow one decimal point if not integer_only
    if (e.key === ".") {
      if (allowDecimal && !input.value.includes(".")) return;
      e.preventDefault(); return;
    }

    // Allow digits 0–9
    if (/^[0-9]$/.test(e.key)) return;

    // Block everything else (e, E, +, etc.)
    e.preventDefault();
  });

  // Also sanitise on paste
  input.addEventListener("paste", (e) => {
    e.preventDefault();
    const pasted = (e.clipboardData || window.clipboardData).getData("text");
    const pattern = q.integer_only ? /^-?[0-9]+$/ : /^-?[0-9]*\.?[0-9]*$/;
    if (pattern.test(pasted.trim())) {
      const start = input.selectionStart;
      const end   = input.selectionEnd;
      const current = input.value;
      input.value = current.slice(0, start) + pasted.trim() + current.slice(end);
      input.dispatchEvent(new Event("input"));
    }
  });

  input.addEventListener("input", () => {
    const v = input.value.trim();
    answers[q.id] = v === "" ? null : (q.integer_only ? parseInt(v, 10) : parseFloat(v));
  });

  return input;
}


// ---- Rating ----
function renderRating(q) {
  const wrap = document.createElement("div");
  wrap.className = "rating-scale";

  const btns = document.createElement("div");
  btns.className = "rating-buttons";
  btns.id        = `q-${q.id}`;

  for (let i = q.min; i <= q.max; i++) {
    const btn = document.createElement("button");
    btn.type      = "button";
    btn.className = "rating-btn";
    btn.textContent = i;
    btn.dataset.value = i;
    if (answers[q.id] === i) btn.classList.add("selected");

    btn.addEventListener("click", () => {
      if (answers[q.id] === i) {
        // Already selected — deselect
        btn.classList.remove("selected");
        delete answers[q.id];
      } else {
        btns.querySelectorAll(".rating-btn").forEach(b => b.classList.remove("selected"));
        btn.classList.add("selected");
        answers[q.id] = i;
      }
      onAnswerChange();
    });

    btns.appendChild(btn);
  }

  wrap.appendChild(btns);

  if (q.min_label || q.max_label) {
    const labels = document.createElement("div");
    labels.className = "rating-labels";
    labels.innerHTML = `<span>${escHtml(q.min_label || "")}</span><span>${escHtml(q.max_label || "")}</span>`;
    wrap.appendChild(labels);
  }

  return wrap;
}


// ---- Radio Grid ----
function renderRadioGrid(q) {
  const table = document.createElement("table");
  table.className = "grid-table";

  // Header row
  const thead = document.createElement("thead");
  const headerRow = document.createElement("tr");
  const emptyTh = document.createElement("th");
  emptyTh.className = "row-header-th";
  headerRow.appendChild(emptyTh);
  q.columns.forEach(col => {
    const th = document.createElement("th");
    th.textContent = resolveVars(col.text);
    headerRow.appendChild(th);
  });
  thead.appendChild(headerRow);
  table.appendChild(thead);

  // Body rows
  const tbody = document.createElement("tbody");
  q.rows.forEach(row => {
    const tr = document.createElement("tr");
    tr.id = `grid-row-${row.id}`;
    if (!isRowVisible(row)) tr.classList.add("grid-row-hidden");

    const labelTd = document.createElement("td");
    labelTd.className = "row-label";
    labelTd.textContent = resolveVars(row.text);
    tr.appendChild(labelTd);

    q.columns.forEach(col => {
      const td = document.createElement("td");
      const input = document.createElement("input");
      input.type  = "radio";
      input.name  = `grid-${row.id}`;
      input.value = col.value;
      if (answers[row.id] === col.value) input.checked = true;

      input.addEventListener("click", () => {
        if (answers[row.id] === col.value) {
          // Already selected — deselect
          input.checked = false;
          delete answers[row.id];
          onAnswerChange();
        }
      });

      input.addEventListener("change", () => {
        answers[row.id] = col.value;
        onAnswerChange();
      });

      td.appendChild(input);
      tr.appendChild(td);
    });

    tbody.appendChild(tr);
  });

  table.appendChild(tbody);
  return table;
}


// ---- Checkbox Grid ----
function renderCheckboxGrid(q) {
  // Initialise answers for each row
  q.rows.forEach(row => {
    if (!Array.isArray(answers[row.id])) answers[row.id] = [];
  });

  const table = document.createElement("table");
  table.className = "grid-table";

  // Header
  const thead = document.createElement("thead");
  const headerRow = document.createElement("tr");
  const emptyTh = document.createElement("th");
  emptyTh.className = "row-header-th";
  headerRow.appendChild(emptyTh);
  q.columns.forEach(col => {
    const th = document.createElement("th");
    th.textContent = resolveVars(col.text);
    headerRow.appendChild(th);
  });
  thead.appendChild(headerRow);
  table.appendChild(thead);

  // Body
  const tbody = document.createElement("tbody");
  q.rows.forEach(row => {
    const tr = document.createElement("tr");
    tr.id = `grid-row-${row.id}`;
    if (!isRowVisible(row)) tr.classList.add("grid-row-hidden");

    const labelTd = document.createElement("td");
    labelTd.className = "row-label";
    labelTd.textContent = resolveVars(row.text);
    tr.appendChild(labelTd);

    q.columns.forEach(col => {
      const td = document.createElement("td");
      const input = document.createElement("input");
      input.type  = "checkbox";
      input.name  = `grid-${row.id}`;
      input.value = col.value;
      if (answers[row.id].includes(col.value)) input.checked = true;

      input.addEventListener("change", () => {
        if (input.checked) {
          if (!answers[row.id].includes(col.value)) answers[row.id].push(col.value);
        } else {
          answers[row.id] = answers[row.id].filter(v => v !== col.value);
        }
        onAnswerChange();
      });

      td.appendChild(input);
      tr.appendChild(td);
    });

    tbody.appendChild(tr);
  });

  table.appendChild(tbody);
  return table;
}


// ---- Rating Grid ----
function renderRatingGrid(q) {
  const table = document.createElement("table");
  table.className = "grid-table";

  // Header — one column per rating value
  const thead = document.createElement("thead");
  const headerRow = document.createElement("tr");
  const emptyTh = document.createElement("th");
  emptyTh.className = "row-header-th";
  headerRow.appendChild(emptyTh);

  const values = [];
  for (let i = q.min; i <= q.max; i++) values.push(i);

  values.forEach(v => {
    const th = document.createElement("th");
    th.textContent = v;
    headerRow.appendChild(th);
  });
  thead.appendChild(headerRow);
  table.appendChild(thead);

  // If there are labels, add a sub-header row
  if (q.min_label || q.max_label) {
    const labelRow = document.createElement("tr");
    const spaceTd = document.createElement("td");
    spaceTd.className = "row-label";
    labelRow.appendChild(spaceTd);

    values.forEach((v, idx) => {
      const td = document.createElement("td");
      td.style.fontSize = "0.72rem";
      td.style.color = "var(--ink-muted)";
      if (idx === 0 && q.min_label) td.textContent = q.min_label;
      if (idx === values.length - 1 && q.max_label) td.textContent = q.max_label;
      labelRow.appendChild(td);
    });
    thead.appendChild(labelRow);
  }

  // Body
  const tbody = document.createElement("tbody");
  q.rows.forEach(row => {
    const tr = document.createElement("tr");
    tr.id = `grid-row-${row.id}`;
    if (!isRowVisible(row)) tr.classList.add("grid-row-hidden");

    const labelTd = document.createElement("td");
    labelTd.className = "row-label";
    labelTd.textContent = resolveVars(row.text);
    tr.appendChild(labelTd);

    values.forEach(v => {
      const td = document.createElement("td");
      td.className = "grid-rating-cell";

      const btn = document.createElement("button");
      btn.type      = "button";
      btn.className = "grid-rating-btn";
      btn.textContent = v;
      btn.dataset.value = v;
      if (answers[row.id] === v) btn.classList.add("selected");

      btn.addEventListener("click", () => {
        if (answers[row.id] === v) {
          // Already selected — deselect
          btn.classList.remove("selected");
          delete answers[row.id];
        } else {
          tr.querySelectorAll(".grid-rating-btn").forEach(b => b.classList.remove("selected"));
          btn.classList.add("selected");
          answers[row.id] = v;
        }
        onAnswerChange();
      });

      td.appendChild(btn);
      tr.appendChild(td);
    });

    tbody.appendChild(tr);
  });

  table.appendChild(tbody);
  return table;
}


// ---- Number Grid ----
function renderNumberGrid(q) {
  const table = document.createElement("table");
  table.className = "grid-table";

  // Header — row label + one column per grid column
  const thead = document.createElement("thead");
  const headerRow = document.createElement("tr");
  const labelTh = document.createElement("th");
  labelTh.className = "row-header-th";
  headerRow.appendChild(labelTh);
  q.columns.forEach(col => {
    const th = document.createElement("th");
    th.textContent = resolveVars(col.text);
    headerRow.appendChild(th);
  });
  thead.appendChild(headerRow);
  table.appendChild(thead);

  // Body — one row per grid row, one input per column
  const tbody = document.createElement("tbody");
  q.rows.forEach(row => {
    const tr = document.createElement("tr");
    tr.id = `grid-row-${row.id}`;
    if (!isRowVisible(row)) tr.classList.add("grid-row-hidden");

    const labelTd = document.createElement("td");
    labelTd.className = "row-label";
    labelTd.textContent = resolveVars(row.text);
    tr.appendChild(labelTd);

    q.columns.forEach(col => {
      const td = document.createElement("td");
      const answerKey = `${row.id}__${col.value}`;
      const input = document.createElement("input");
      input.type = "number";
      input.className = "grid-number-input";
      input.name = `grid-${answerKey}`;
      if (q.min !== null && q.min !== undefined) input.min = q.min;
      if (q.max !== null && q.max !== undefined) input.max = q.max;
      if (q.integer_only) input.step = "1";
      if (answers[answerKey] === undefined && q.default_value !== null && q.default_value !== undefined) {
        answers[answerKey] = q.default_value;
      }
      if (answers[answerKey] !== undefined && answers[answerKey] !== null) {
        input.value = answers[answerKey];
      }

      input.addEventListener("input", () => {
        if (input.value === "") {
          delete answers[answerKey];
        } else {
          answers[answerKey] = Number(input.value);
        }
        onAnswerChange();
      });

      td.appendChild(input);
      tr.appendChild(td);
    });

    tbody.appendChild(tr);
  });

  table.appendChild(tbody);
  return table;
}


// ---------------------------------------------------------------------------
// Reactivity — re-evaluate visibility when any answer changes
// ---------------------------------------------------------------------------

function onAnswerChange() {
  const page = visiblePageAt(currentPageIndex);
  if (!page) return;

  // Rebuild variables before visibility/rendering so text is up-to-date
  const oldVars = JSON.stringify(variables);
  rebuildVariables();
  const varsChanged = JSON.stringify(variables) !== oldVars;

  applyVisibility(page);
  clearHiddenAnswers(page);

  // If variables changed, refresh all rendered text on the current page
  if (varsChanged) {
    refreshPageText(page);
  }

  // Update the Next button label in case page visibility changed
  const vPages = visiblePages();
  const btnNext = document.getElementById("btn-next");
  if (btnNext) {
    btnNext.textContent = currentPageIndex >= vPages.length - 1
      ? "Submit survey →"
      : "Continue →";
  }

  // Refresh debug panel
  if (DEBUG_MODE) {
    renderDebugPanel(page, vPages, currentPageIndex);
  }
}

/**
 * Refresh variable-substituted text in already-rendered DOM elements
 * on the current page without full re-render (preserves user input state).
 */
function refreshPageText(page) {
  // Page title
  const titleEl = document.querySelector(`#page-${page.id} .page-title`);
  if (titleEl) {
    titleEl.textContent = resolveVars(page.title);
  }

  // Page description
  const descEl = document.querySelector(`#page-${page.id} .page-description`);
  if (descEl && page.description) {
    descEl.innerHTML = renderInlineBlock(resolveVars(page.description));
  }

  page.questions.forEach(q => {
    const block = document.getElementById(`block-${q.id}`);
    if (!block) return;

    // Question label
    const label = block.querySelector(".question-label");
    if (label) {
      label.innerHTML = renderInline(resolveVars(q.text)) +
        (q.required ? '<span class="required-star" aria-hidden="true">*</span>' : "");
    }

    // Notes
    const notesText = block.querySelector(".question-notes p");
    if (notesText && q.notes) {
      notesText.innerHTML = renderInlineBlock(resolveVars(q.notes));
    }

    // Option text (radio, checkbox, dropdown)
    if (q.options) {
      q.options.forEach(opt => {
        if (q.type === "dropdown") {
          const sel = document.getElementById(`q-${q.id}`);
          if (sel) {
            const optionEl = sel.querySelector(`option[value="${opt.value}"]`);
            if (optionEl) optionEl.textContent = resolveVars(opt.text);
          }
        } else {
          const optEl = document.getElementById(`opt-${q.id}--${opt.value}`);
          if (optEl) {
            const span = optEl.querySelector(".option-text");
            if (span) span.textContent = resolveVars(opt.text);
          }
        }
      });
    }

    // Grid row text
    if (q.rows) {
      q.rows.forEach(row => {
        const rowEl = document.getElementById(`grid-row-${row.id}`);
        if (rowEl) {
          const labelTd = rowEl.querySelector(".row-label");
          if (labelTd) labelTd.textContent = resolveVars(row.text);
        }
      });
    }
  });
}

/**
 * Walk the current page and show/hide questions, options, and grid rows
 * based on current answers.
 */
function applyVisibility(page) {
  page.questions.forEach(q => {
    const block = document.getElementById(`block-${q.id}`);
    if (!block) return;

    const visible = isQuestionVisible(q);
    block.classList.toggle("hidden", !visible);

    if (!visible) return;

    // Options (radio / checkbox)
    if (q.options) {
      q.options.forEach(opt => {
        const optEl = document.getElementById(`opt-${q.id}--${opt.value}`);
        if (!optEl) return;
        const optVisible = isOptionVisible(opt);
        optEl.classList.toggle("hidden", !optVisible);

        // For dropdowns, hide via the <option> element instead
        if (q.type === "dropdown") {
          const sel = document.getElementById(`q-${q.id}`);
          if (sel) {
            const optionEl = sel.querySelector(`option[value="${opt.value}"]`);
            if (optionEl) optionEl.hidden = !optVisible;
          }
        }
      });
    }

    // Grid rows
    if (q.rows) {
      q.rows.forEach(row => {
        const rowEl = document.getElementById(`grid-row-${row.id}`);
        if (!rowEl) return;
        rowEl.classList.toggle("grid-row-hidden", !isRowVisible(row));
      });
    }
  });

  // Also update the sidebar to reflect potentially changed page visibility
  updateProgressNav(page.id, visiblePages());
}

/**
 * When a question becomes hidden, clear its stored answer so it doesn't
 * interfere with downstream conditions and so it's reported correctly.
 */
function clearHiddenAnswers(page) {
  page.questions.forEach(q => {
    if (!isQuestionVisible(q)) {
      clearAnswer(q);
      return;
    }
    // Also clear answers for hidden options within visible checkbox questions
    if (q.type === "checkbox" && Array.isArray(answers[q.id])) {
      const visibleValues = q.options
        .filter(o => isOptionVisible(o))
        .map(o => o.value);
      answers[q.id] = answers[q.id].filter(v => visibleValues.includes(v));
      // Uncheck the actual checkboxes
      q.options.forEach(opt => {
        if (!isOptionVisible(opt)) {
          const optEl = document.getElementById(`opt-${q.id}--${opt.value}`);
          if (optEl) {
            const input = optEl.querySelector("input");
            if (input) input.checked = false;
            optEl.classList.remove("selected");
          }
        }
      });
    }
    // Clear hidden grid rows
    if (q.rows) {
      q.rows.forEach(row => {
        if (!isRowVisible(row)) {
          if (q.type === "number_grid" && q.columns) {
            q.columns.forEach(col => delete answers[`${row.id}__${col.value}`]);
          } else {
            delete answers[row.id];
          }
        }
      });
    }
  });
}

function clearAnswer(q) {
  if (q.type === "checkbox") {
    answers[q.id] = [];
  } else if (q.type === "number_grid" && q.rows && q.columns) {
    q.rows.forEach(row => q.columns.forEach(col => delete answers[`${row.id}__${col.value}`]));
  } else if (q.rows) {
    q.rows.forEach(row => delete answers[row.id]);
  } else {
    delete answers[q.id];
  }
}


// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validate required questions on a page.
 * Returns true if all valid, false otherwise (also marks errors in the DOM).
 */
function validatePage(page) {
  let valid = true;

  page.questions.forEach(q => {
    const block = document.getElementById(`block-${q.id}`);
    if (!block || block.classList.contains("hidden")) return;

    clearError(block);
    const answer = getEffectiveAnswer(q);

    // Required check — applies to all types
    if (q.required && isEmptyAnswer(answer, q.type)) {
      markError(block, "This question requires an answer.");
      valid = false;
      return;  // no point checking bounds if empty
    }

    // Number bounds — applies even when not required, if a value was entered
    if (q.type === "number" && answer !== null && answer !== undefined && answer !== "") {
      const num = Number(answer);
      if (isNaN(num)) {
        markError(block, "Please enter a valid number.");
        valid = false;
      } else if (q.integer_only && !Number.isInteger(num)) {
        markError(block, "Please enter a whole number (no decimals).");
        valid = false;
      } else if (q.min !== null && q.min !== undefined && num < q.min) {
        markError(block, `Please enter a value of ${q.min} or more.`);
        valid = false;
      } else if (q.max !== null && q.max !== undefined && num > q.max) {
        markError(block, `Please enter a value of ${q.max} or less.`);
        valid = false;
      }
    }

    // Number grid bounds — validate each visible row×column cell
    if (q.type === "number_grid" && q.rows && q.columns) {
      let gridErr = false;
      for (const row of q.rows) {
        if (gridErr) break;
        if (!isRowVisible(row)) continue;
        for (const col of q.columns) {
          const answerKey = `${row.id}__${col.value}`;
          const val = answers[answerKey];
          if (val === undefined || val === null || val === "") continue;
          const num = Number(val);
          if (isNaN(num)) {
            markError(block, `"${row.text}" / "${col.text}": please enter a valid number.`);
            valid = false; gridErr = true; break;
          } else if (q.integer_only && !Number.isInteger(num)) {
            markError(block, `"${row.text}" / "${col.text}": please enter a whole number.`);
            valid = false; gridErr = true; break;
          } else if (q.min !== null && q.min !== undefined && num < q.min) {
            markError(block, `"${row.text}" / "${col.text}": value must be ${q.min} or more.`);
            valid = false; gridErr = true; break;
          } else if (q.max !== null && q.max !== undefined && num > q.max) {
            markError(block, `"${row.text}" / "${col.text}": value must be ${q.max} or less.`);
            valid = false; gridErr = true; break;
          }
        }
      }
    }
  });

  return valid;
}

function getEffectiveAnswer(q) {
  if (q.type === "number_grid" && q.rows && q.columns) {
    // Collect all visible cell values (row×column)
    const vals = [];
    q.rows.filter(row => isRowVisible(row)).forEach(row => {
      q.columns.forEach(col => {
        vals.push(answers[`${row.id}__${col.value}`]);
      });
    });
    return vals;
  }
  if (q.rows) {
    // For other grids, collect all visible row answers
    return q.rows
      .filter(row => isRowVisible(row))
      .map(row => answers[row.id]);
  }
  return answers[q.id];
}

function isEmptyAnswer(answer, type) {
  if (type === "checkbox" || type === "checkbox_grid") {
    if (!Array.isArray(answer)) return true;
    return answer.length === 0;
  }
  if (Array.isArray(answer)) {
    // radio_grid / rating_grid: required means every visible row must be answered
    return answer.some(v => v === undefined || v === null || v === "");
  }
  return answer === undefined || answer === null || answer === "";
}

function markError(block, msg) {
  block.classList.add("has-error");
  let err = block.querySelector(".error-msg");
  if (!err) {
    err = document.createElement("p");
    err.className = "error-msg";
    // Append inside .question-inner so it sits with the input, not beside notes
    const inner = block.querySelector(".question-inner") || block;
    inner.appendChild(err);
  }
  err.textContent = msg;
}

function clearError(block) {
  block.classList.remove("has-error");
  const err = block.querySelector(".error-msg");
  if (err) err.remove();
}


// ---------------------------------------------------------------------------
// Visibility snapshot — what to send to the server with each page POST
// ---------------------------------------------------------------------------

/**
 * Build a visibility dict for the entire survey as it stands right now.
 * This is cumulative — we include pages we've already submitted, not just
 * the current page, so the server always has a complete picture.
 */
function buildVisibilitySnapshot() {
  const vis = {};
  const vPages    = visiblePages();
  const vPageIds  = new Set(vPages.map(p => p.id));
  // The id of the page we're currently on
  const currentPageId = vPages[currentPageIndex] ? vPages[currentPageIndex].id : null;

  // Build a set of page ids that have been reached (current page and all before it
  // in the FULL page list, provided they were visible when we passed through them).
  // Simplest correct rule: a page has been "reached" if it appears at or before
  // the current visible-page index in the visible list, OR if it is a non-visible
  // page that sits before the current page in the full list (it was skipped).
  const reachedVisibleIds = new Set(vPages.slice(0, currentPageIndex + 1).map(p => p.id));

  // For the full page list, a page is "reached" if either:
  //   a) it is in reachedVisibleIds, or
  //   b) it is not visible but falls before the current page in document order
  //      (we skipped past it)
  let passedCurrentPage = false;

  SURVEY.pages.forEach((page) => {
    if (currentPageId && page.id === currentPageId) passedCurrentPage = true;

    const pageVisible = vPageIds.has(page.id);
    // A page is reached if we have passed it (or are on it) in document order
    const pageReached = reachedVisibleIds.has(page.id) ||
                        (!pageVisible && !passedCurrentPage) ||
                        (pageVisible && reachedVisibleIds.has(page.id));

    // Simpler: a page is not_reached only if it is visible but we haven't
    // gotten to it yet in the visible sequence.
    const notYetReached = pageVisible && !reachedVisibleIds.has(page.id);

    if (notYetReached) {
      vis[page.id] = "not_reached";
      page.questions.forEach(q => {
        vis[q.id] = "not_reached";
        if (q.rows) q.rows.forEach(row => { vis[row.id] = "not_reached"; });
      });
      return;
    }

    if (!pageVisible) {
      vis[page.id] = "hidden";
      page.questions.forEach(q => {
        vis[q.id] = "hidden";
        if (q.rows) q.rows.forEach(row => { vis[row.id] = "hidden"; });
      });
      return;
    }

    vis[page.id] = "visible";

    page.questions.forEach(q => {
      const qVisible = isQuestionVisible(q);
      vis[q.id] = qVisible ? "visible" : "hidden";

      if (q.rows) {
        q.rows.forEach(row => {
          vis[row.id] = (qVisible && isRowVisible(row)) ? "visible" : "hidden";
        });
      }
      if (q.options) {
        q.options.forEach(opt => {
          vis[`${q.id}__opt__${opt.value}`] = isOptionVisible(opt) ? "visible" : "hidden";
        });
      }
    });
  });

  return vis;
}


// ---------------------------------------------------------------------------
// Answers snapshot — what to send to the server
// ---------------------------------------------------------------------------

/**
 * Build the answer payload for the current state of answers.
 * Sends null for questions the respondent hasn't answered.
 */
function buildAnswerSnapshot() {
  const snap = {};
  SURVEY.pages.forEach(page => {
    page.questions.forEach(q => {
      if (q.rows) {
        q.rows.forEach(row => {
          snap[row.id] = answers[row.id] !== undefined ? answers[row.id] : null;
        });
      } else {
        snap[q.id] = answers[q.id] !== undefined ? answers[q.id] : null;
      }
    });
  });
  return snap;
}


// ---------------------------------------------------------------------------
// Navigation handlers
// ---------------------------------------------------------------------------

async function handleNext(page) {
  if (!DEBUG_MODE && !validatePage(page)) {
    // Scroll to first error
    const firstError = document.querySelector(".has-error");
    if (firstError) firstError.scrollIntoView({ behavior: "smooth", block: "center" });
    return;
  }

  // Soft warning for unanswered optional questions with warn_if_empty (skip in debug)
  if (!DEBUG_MODE) {
    const unanswered = getWarnableUnanswered(page);
    if (unanswered.length > 0) {
      const shouldContinue = await showSkipWarning(unanswered);
      if (!shouldContinue) return;
    }
  }

  await submitPage(page);
}

/**
 * Determine whether warn_if_empty is effective for a question.
 * If explicitly set, use that. Otherwise, default ON for all types
 * except checkbox, text, and textarea.
 */
function shouldWarnIfEmpty(q) {
  if (q.warn_if_empty !== null && q.warn_if_empty !== undefined) return q.warn_if_empty;
  const quietByDefault = new Set(["checkbox", "text", "textarea", "checkbox_grid"]);
  return !quietByDefault.has(q.type);
}

/**
 * Get list of visible, non-required questions with warn_if_empty
 * that the user has left blank on this page.
 */
function getWarnableUnanswered(page) {
  const result = [];
  page.questions.forEach(q => {
    const block = document.getElementById(`block-${q.id}`);
    if (!block || block.classList.contains("hidden")) return;
    if (q.required) return;  // required questions handled by validation
    if (!shouldWarnIfEmpty(q)) return;
    const answer = getEffectiveAnswer(q);
    if (isEmptyAnswer(answer, q.type)) {
      result.push(q);
    }
  });
  return result;
}

/**
 * Show a warning overlay listing unanswered questions.
 * Returns a promise that resolves true (continue) or false (go back).
 */
function showSkipWarning(questions) {
  return new Promise(resolve => {
    // Remove any existing overlay
    const existing = document.getElementById("skip-warning-overlay");
    if (existing) existing.remove();

    const overlay = document.createElement("div");
    overlay.id = "skip-warning-overlay";
    overlay.className = "skip-warning-overlay";

    const qList = questions.map(q => `<li>${escHtml(q.text)}</li>`).join("");

    overlay.innerHTML = `
      <div class="skip-warning-card">
        <h3 class="skip-warning-title">You left some questions blank</h3>
        <p class="skip-warning-body">The following optional questions on this page haven't been answered:</p>
        <ul class="skip-warning-list">${qList}</ul>
        <div class="skip-warning-buttons">
          <button class="btn-secondary skip-warning-back">Go back</button>
          <button class="btn-primary skip-warning-continue">Continue anyway</button>
        </div>
      </div>
    `;

    overlay.querySelector(".skip-warning-back").addEventListener("click", () => {
      overlay.remove();
      resolve(false);
    });
    overlay.querySelector(".skip-warning-continue").addEventListener("click", () => {
      overlay.remove();
      resolve(true);
    });
    // Click on backdrop also dismisses (go back)
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) { overlay.remove(); resolve(false); }
    });

    document.body.appendChild(overlay);
  });
}

async function submitPage(page) {
  const isLast = currentPageIndex >= visiblePages().length - 1;

  const payload = {
    session_id: SESSION_ID,
    page_id:    page.id,
    answers:    buildAnswerSnapshot(),
    visibility: buildVisibilitySnapshot(),
  };

  const btn = document.getElementById("btn-next");
  btn.disabled = true;
  btn.textContent = isLast ? "Submitting…" : "Saving…";

  try {
    const endpoint = isLast ? "/api/submit" : "/api/page";
    const r = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      throw new Error(err.error || `Server error (${r.status})`);
    }

    // Re-evaluate visible pages after saving — answers on this page
    // may have changed which subsequent pages are now visible.
    const vPagesNow = visiblePages();
    const isNowLast = currentPageIndex >= vPagesNow.length - 1;

    if (isNowLast) {
      showScreen("complete");
    } else {
      currentPageIndex++;
      navigateToPage(currentPageIndex);
    }
  } catch (e) {
    showError(`Could not save your responses: ${e.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = currentPageIndex >= visiblePages().length - 1 ? "Submit survey →" : "Continue →";
  }
}

function handleBack() {
  if (currentPageIndex > 0) {
    currentPageIndex--;
    navigateToPage(currentPageIndex);
  }
}


// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function escHtml(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Render **bold** and *italic* in a string safely.
// Escapes HTML first, then applies the inline patterns.
function renderInline(str) {
  if (!str) return "";
  return escHtml(str)
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g,     "<em>$1</em>");
}

// Like renderInline but also converts \n to <br> for multi-line strings.
function renderInlineBlock(str) {
  if (!str) return "";
  return str.split("\n")
    .map(line => renderInline(line))
    .join("<br>");
}


// ---------------------------------------------------------------------------
// Debug mode
// ---------------------------------------------------------------------------

/**
 * Evaluate a condition and return a human-readable trace string.
 */
function traceCondition(cond) {
  if (!cond) return { result: true, text: "(no condition — always visible)" };

  if (cond.operator === "and") {
    const children = cond.conditions.map(c => traceCondition(c));
    const result = children.every(c => c.result);
    const text = children.map(c => `  ${c.result ? "✓" : "✗"} ${c.text}`).join("\n");
    return { result, text: `AND:\n${text}` };
  }
  if (cond.operator === "or") {
    const children = cond.conditions.map(c => traceCondition(c));
    const result = children.some(c => c.result);
    const text = children.map(c => `  ${c.result ? "✓" : "✗"} ${c.text}`).join("\n");
    return { result, text: `OR:\n${text}` };
  }
  if (cond.operator === "not") {
    const child = traceCondition(cond.conditions[0]);
    const result = !child.result;
    return { result, text: `NOT (inner=${child.result ? "✓" : "✗"}):\n  ${child.text}` };
  }

  const { question, operator, value } = cond;
  const answer = question.startsWith("$")
    ? variables[question.slice(1)]
    : answers[question];
  const result = evalCondition(cond);
  const answerStr = answer === undefined ? "undefined" :
                    answer === null ? "null" :
                    Array.isArray(answer) ? `[${answer.join(", ")}]` :
                    JSON.stringify(answer);
  const valueStr = value !== undefined && value !== null ? JSON.stringify(value) : "";
  const opStr = operator.replace(/_/g, " ");

  let text;
  if (operator === "is_answered" || operator === "is_not_answered") {
    text = `${question} ${opStr} → answer=${answerStr}`;
  } else {
    text = `${question} ${opStr} ${valueStr} → answer=${answerStr}`;
  }
  return { result, text };
}


/**
 * Render the debug panel for the current page.
 * Called from navigateToPage when DEBUG_MODE is active.
 */
function renderDebugPanel(page, vPages, index) {
  let panel = document.getElementById("debug-panel");
  if (!panel) {
    panel = document.createElement("aside");
    panel.id = "debug-panel";
    panel.className = "debug-panel";
    document.querySelector(".survey-layout").appendChild(panel);
  }

  let html = `<div class="debug-panel-inner">`;
  html += `<div class="debug-header">
    <span class="debug-header-title">🐛 Debug</span>
    <button class="debug-collapse-btn" onclick="document.getElementById('debug-panel').classList.toggle('collapsed')">◀</button>
  </div>`;

  // Debug toolbar
  html += `<div class="debug-section">
    <div class="debug-toolbar">
      <button class="debug-btn" id="debug-reset-page">↺ Reset page</button>
    </div>
  </div>`;

  // Page info
  html += `<div class="debug-section">
    <div class="debug-section-title">Page</div>
    <div class="debug-kv"><span class="debug-key">id</span><span class="debug-val">${page.id}</span></div>
    <div class="debug-kv"><span class="debug-key">index</span><span class="debug-val">${index} of ${vPages.length - 1}</span></div>
    <div class="debug-kv"><span class="debug-key">type</span><span class="debug-val">${page.page_type || "standard"}</span></div>`;

  if (page.display_if) {
    const trace = traceCondition(page.display_if);
    html += `<div class="debug-kv"><span class="debug-key">display_if</span><span class="debug-val debug-cond-${trace.result ? "pass" : "fail"}">${escHtml(trace.text)}</span></div>`;
  }
  html += `</div>`;

  // Questions on this page
  html += `<div class="debug-section"><div class="debug-section-title">Questions</div>`;
  page.questions.forEach(q => {
    const visible = isQuestionVisible(q);
    html += `<div class="debug-question ${visible ? "" : "debug-hidden-item"}">`;
    html += `<div class="debug-q-header">${escHtml(q.id)} <span class="debug-q-type">${q.type}</span>${!visible ? ' <span class="debug-badge-hidden">hidden</span>' : ""}</div>`;

    // CSV columns
    const csvCols = DEBUG_CSV_MAP[q.id] || [];
    if (csvCols.length > 0) {
      html += `<div class="debug-kv"><span class="debug-key">csv</span><span class="debug-val debug-csv">${csvCols.map(escHtml).join(", ")}</span></div>`;
    }

    // Current answer
    const ans = getEffectiveAnswer(q);
    const ansStr = ans === undefined ? "—" :
                   ans === null ? "null" :
                   Array.isArray(ans) ? `[${ans.map(v => v === undefined ? "—" : JSON.stringify(v)).join(", ")}]` :
                   JSON.stringify(ans);
    html += `<div class="debug-kv"><span class="debug-key">answer</span><span class="debug-val">${escHtml(ansStr)}</span></div>`;

    // display_if trace
    if (q.display_if) {
      const trace = traceCondition(q.display_if);
      html += `<div class="debug-kv"><span class="debug-key">display_if</span><span class="debug-val debug-cond-${trace.result ? "pass" : "fail"}">${escHtml(trace.text)}</span></div>`;
    }

    // Option-level conditions
    if (q.options) {
      q.options.forEach(opt => {
        if (opt.display_if) {
          const trace = traceCondition(opt.display_if);
          html += `<div class="debug-kv debug-indent"><span class="debug-key">opt "${escHtml(opt.value)}"</span><span class="debug-val debug-cond-${trace.result ? "pass" : "fail"}">${escHtml(trace.text)}</span></div>`;
        }
      });
    }

    // Row-level conditions
    if (q.rows) {
      q.rows.forEach(row => {
        if (row.display_if) {
          const trace = traceCondition(row.display_if);
          html += `<div class="debug-kv debug-indent"><span class="debug-key">row "${escHtml(row.id)}"</span><span class="debug-val debug-cond-${trace.result ? "pass" : "fail"}">${escHtml(trace.text)}</span></div>`;
        }
      });
    }

    html += `</div>`;
  });
  html += `</div>`;

  // Variables
  if (Object.keys(variables).length > 0) {
    html += `<div class="debug-section"><div class="debug-section-title">Variables</div>`;
    Object.entries(variables).forEach(([name, val]) => {
      html += `<div class="debug-kv"><span class="debug-key">{${escHtml(name)}}</span><span class="debug-val">${escHtml(val || "—")}</span></div>`;
    });
    html += `</div>`;
  }

  // Answer state (full)
  html += `<div class="debug-section"><div class="debug-section-title">All Answers</div>`;
  html += `<pre class="debug-json">${escHtml(JSON.stringify(answers, null, 2))}</pre>`;
  html += `</div>`;

  html += `</div>`;
  panel.innerHTML = html;

  // Wire up reset button
  const resetBtn = document.getElementById("debug-reset-page");
  if (resetBtn) {
    resetBtn.addEventListener("click", () => {
      page.questions.forEach(q => clearAnswer(q));
      navigateToPage(currentPageIndex);
    });
  }
}

/**
 * Add ID overlays to question blocks on the current page.
 */
function addDebugIdOverlays(page) {
  page.questions.forEach(q => {
    const block = document.getElementById(`block-${q.id}`);
    if (!block) return;
    const badge = document.createElement("div");
    badge.className = "debug-id-overlay";
    badge.textContent = q.id;
    block.style.position = "relative";
    block.prepend(badge);
  });
}
