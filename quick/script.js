/**
 * SpendWise Quick – script.js
 * Zero-dependency, mobile-first expense logger
 * localStorage persistence, Vibration API haptics, swipe-to-delete
 */

'use strict';

/* ═══════════════════════════════════════════════════════════════
   STORAGE KEYS & DEFAULTS
   ═══════════════════════════════════════════════════════════════ */
const STORE = {
  EXPENSES: 'swq_expenses',
  BUDGET:   'swq_budget',
};

/* ═══════════════════════════════════════════════════════════════
   STATE
   ═══════════════════════════════════════════════════════════════ */
const state = {
  expenses:        [],   // { id, amount, cat, emoji, note, ts }
  budget:          0,
  selectedCat:     'Food',
  selectedEmoji:   '🍔',
  pendingClearId:  null,
};

/* ═══════════════════════════════════════════════════════════════
   UTILS
   ═══════════════════════════════════════════════════════════════ */
const $ = (sel) => document.querySelector(sel);

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function fmt(n) {
  if (n >= 1e5) return `₹${(n / 1e5).toFixed(1)}L`;
  return `₹${n.toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;
}

function fmtTime(ts) {
  const d = new Date(ts);
  const now = new Date();
  const isToday =
    d.getDate() === now.getDate() &&
    d.getMonth() === now.getMonth() &&
    d.getFullYear() === now.getFullYear();

  if (isToday) {
    return d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });
  }
  // yesterday
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (d.getDate() === yesterday.getDate() && d.getMonth() === yesterday.getMonth()) {
    return 'Yesterday ' + d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });
  }
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });
}

function todayStart() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function monthStart() {
  const d = new Date();
  d.setDate(1);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function escHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/* ═══════════════════════════════════════════════════════════════
   HAPTICS  (graceful degradation)
   ═══════════════════════════════════════════════════════════════ */
function vibrate(pattern) {
  try {
    if ('vibrate' in navigator) navigator.vibrate(pattern);
  } catch (_) { /* ignore */ }
}

const haptic = {
  tap:     () => vibrate(8),
  success: () => vibrate([10, 40, 20]),
  error:   () => vibrate([30, 20, 30]),
  delete:  () => vibrate(15),
};

/* ═══════════════════════════════════════════════════════════════
   PERSISTENCE
   ═══════════════════════════════════════════════════════════════ */
function load() {
  try {
    const raw = localStorage.getItem(STORE.EXPENSES);
    state.expenses = raw ? JSON.parse(raw) : [];
  } catch { state.expenses = []; }
  state.budget = parseFloat(localStorage.getItem(STORE.BUDGET)) || 0;
}

function save() {
  try {
    localStorage.setItem(STORE.EXPENSES, JSON.stringify(state.expenses));
  } catch (e) {
    // Quota exceeded — trim oldest 20%
    const keep = Math.floor(state.expenses.length * 0.8);
    state.expenses = state.expenses.slice(-keep);
    localStorage.setItem(STORE.EXPENSES, JSON.stringify(state.expenses));
    showToast('Storage full — oldest entries trimmed.', 'err', 4000);
  }
}

function saveBudget() {
  localStorage.setItem(STORE.BUDGET, String(state.budget));
}

/* ═══════════════════════════════════════════════════════════════
   CALCULATIONS
   ═══════════════════════════════════════════════════════════════ */
function calcTodayTotal() {
  const start = todayStart();
  return state.expenses
    .filter(e => e.ts >= start)
    .reduce((s, e) => s + e.amount, 0);
}

function calcMonthTotal() {
  const start = monthStart();
  return state.expenses
    .filter(e => e.ts >= start)
    .reduce((s, e) => s + e.amount, 0);
}

/* ═══════════════════════════════════════════════════════════════
   TOP BAR & PROGRESS
   ═══════════════════════════════════════════════════════════════ */
function renderTopBar() {
  const today = calcTodayTotal();
  const month = calcMonthTotal();

  $('#todayVal').textContent = fmt(today);
  $('#monthVal').textContent = fmt(month);

  // Budget left
  const budgetLeftEl = $('#budgetLeftVal');
  const fill         = $('#microProgressFill');
  const track        = $('#microProgressTrack');

  if (state.budget <= 0) {
    budgetLeftEl.textContent = '—';
    budgetLeftEl.className = 'stat-val';
    fill.style.width = '0%';
    fill.className = 'micro-progress-fill';
    track.setAttribute('aria-valuenow', 0);
    return;
  }

  const left    = state.budget - month;
  const pct     = Math.min((month / state.budget) * 100, 100);
  const display = Math.min(pct, 100);

  budgetLeftEl.textContent = fmt(Math.max(left, 0));
  fill.style.width = `${display}%`;
  track.setAttribute('aria-valuenow', Math.round(pct));

  // Color classes
  fill.className = 'micro-progress-fill';
  budgetLeftEl.className = 'stat-val';

  if (pct >= 100) {
    budgetLeftEl.textContent = '-' + fmt(Math.abs(left));
    budgetLeftEl.classList.add('over');
    fill.classList.add('over');
  } else if (pct >= 80) {
    budgetLeftEl.classList.add('danger');
    fill.classList.add('danger');
  } else if (pct >= 60) {
    budgetLeftEl.classList.add('warn');
    fill.classList.add('warn');
  }
}

// Keep CSS var --bar-h in sync with actual rendered height
function syncBarHeight() {
  const h = $('#topBar').offsetHeight;
  document.documentElement.style.setProperty('--bar-h', h + 'px');
}

/* ═══════════════════════════════════════════════════════════════
   CATEGORY CHIPS
   ═══════════════════════════════════════════════════════════════ */
function initChips() {
  document.querySelectorAll('.chip').forEach(chip => {
    chip.addEventListener('click', () => {
      haptic.tap();
      // deselect all
      document.querySelectorAll('.chip').forEach(c => {
        c.classList.remove('active');
        c.setAttribute('aria-pressed', 'false');
      });
      chip.classList.add('active');
      chip.setAttribute('aria-pressed', 'true');
      state.selectedCat   = chip.dataset.cat;
      state.selectedEmoji = chip.dataset.emoji;
    });
  });
}

/* ═══════════════════════════════════════════════════════════════
   TRANSACTION LIST
   ═══════════════════════════════════════════════════════════════ */
function renderList() {
  const list    = $('#txList');
  const emptyEl = $('#txEmpty');

  // Remove existing items
  list.querySelectorAll('.tx-item').forEach(el => el.remove());

  if (state.expenses.length === 0) {
    emptyEl.classList.remove('hidden');
    return;
  }

  emptyEl.classList.add('hidden');

  // Sort newest-first
  const sorted = [...state.expenses].sort((a, b) => b.ts - a.ts);

  for (const exp of sorted) {
    const item = buildTxItem(exp);
    list.appendChild(item);
  }
}

function buildTxItem(exp) {
  const wrapper = document.createElement('li');
  wrapper.className = 'tx-item';
  wrapper.dataset.id = exp.id;

  wrapper.innerHTML = `
    <div class="tx-item-delete-bg" aria-hidden="true">🗑️</div>
    <div class="tx-front">
      <div class="tx-accent"></div>
      <span class="tx-emoji" aria-hidden="true">${exp.emoji}</span>
      <div class="tx-info">
        <p class="tx-title">${escHtml(exp.note || exp.cat)}</p>
        <div class="tx-meta">
          <span class="tx-time">${fmtTime(exp.ts)}</span>
          <span class="tx-cat-badge">${escHtml(exp.cat)}</span>
        </div>
      </div>
      <div class="tx-amount-col">
        <span class="tx-amount">${fmt(exp.amount)}</span>
        <button class="tx-del-btn" data-id="${exp.id}" aria-label="Delete: ${escHtml(exp.note || exp.cat)}" title="Delete">🗑️</button>
      </div>
    </div>
  `;

  // Tap-delete button
  wrapper.querySelector('.tx-del-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    haptic.delete();
    removeExpense(exp.id, wrapper);
  });

  // Swipe-to-delete (touch)
  attachSwipe(wrapper, exp.id);

  return wrapper;
}

/* ─── Swipe-to-delete ──────────────────────────────────────── */
function attachSwipe(wrapper, id) {
  const front = wrapper.querySelector('.tx-front');
  let startX = 0;
  let currentX = 0;
  let isSwiping = false;
  const THRESHOLD = 90; // px to trigger delete

  function onStart(e) {
    startX = e.touches ? e.touches[0].clientX : e.clientX;
    currentX = 0;
    isSwiping = false;
  }

  function onMove(e) {
    const dx = (e.touches ? e.touches[0].clientX : e.clientX) - startX;
    if (Math.abs(dx) < 5) return; // dead zone
    if (dx >= 0) return;          // only left swipe

    isSwiping = true;
    currentX  = dx;
    wrapper.classList.add('swiping');
    front.style.transform = `translateX(${Math.max(dx, -140)}px)`;
    e.preventDefault();
  }

  function onEnd() {
    if (!isSwiping) return;
    wrapper.classList.remove('swiping');
    if (currentX < -THRESHOLD) {
      haptic.delete();
      removeExpense(id, wrapper);
    } else {
      front.style.transition = 'transform 0.25s var(--ease)';
      front.style.transform  = 'translateX(0)';
      setTimeout(() => { front.style.transition = ''; }, 260);
    }
    isSwiping = false;
    currentX  = 0;
  }

  wrapper.addEventListener('touchstart', onStart, { passive: true });
  wrapper.addEventListener('touchmove',  onMove,  { passive: false });
  wrapper.addEventListener('touchend',   onEnd,   { passive: true });
}

/* ─── Remove expense ────────────────────────────────────────── */
function removeExpense(id, wrapper) {
  wrapper.classList.add('removing');
  setTimeout(() => {
    state.expenses = state.expenses.filter(e => e.id !== id);
    save();
    renderTopBar();
    // Remove DOM node after animation
    wrapper.remove();
    if (state.expenses.length === 0) {
      $('#txEmpty').classList.remove('hidden');
    }
  }, 400);
}

/* ═══════════════════════════════════════════════════════════════
   SAVE EXPENSE
   ═══════════════════════════════════════════════════════════════ */
function initSaveBtn() {
  const amountEl = $('#amountInput');
  const noteEl   = $('#noteInput');
  const errEl    = $('#entryError');
  const btn      = $('#saveBtn');
  const btnText  = $('#saveBtnText');
  const btnIcon  = $('#saveBtnIcon');

  function clearError() {
    errEl.classList.remove('show');
    errEl.textContent = '';
    $('#amountInput').closest('.amount-wrap').classList.remove('error');
  }

  function showError(msg) {
    errEl.textContent = msg;
    errEl.classList.add('show');
    $('#amountInput').closest('.amount-wrap').classList.add('error');
    btn.classList.add('error-shake');
    btn.addEventListener('animationend', () => btn.classList.remove('error-shake'), { once: true });
    haptic.error();
  }

  // Allow only numeric + one decimal point
  amountEl.addEventListener('input', () => {
    const val = amountEl.value.replace(/[^0-9.]/g, '');
    const parts = val.split('.');
    amountEl.value = parts.length > 2 ? parts[0] + '.' + parts.slice(1).join('') : val;
    if (amountEl.value) clearError();
  });

  btn.addEventListener('click', () => {
    clearError();
    const raw = parseFloat(amountEl.value);

    if (!amountEl.value || isNaN(raw) || raw <= 0) {
      showError('Enter an amount to continue.');
      amountEl.focus();
      return;
    }
    if (raw > 9_99_999) {
      showError('Amount too large. Max ₹9,99,999.');
      return;
    }

    const exp = {
      id:     uid(),
      amount: parseFloat(raw.toFixed(2)),
      cat:    state.selectedCat,
      emoji:  state.selectedEmoji,
      note:   noteEl.value.trim(),
      ts:     Date.now(),
    };

    state.expenses.push(exp);
    save();

    // Flash success
    haptic.success();
    setButtonState('success');

    // Insert at top of list
    const list    = $('#txList');
    const emptyEl = $('#txEmpty');
    emptyEl.classList.add('hidden');
    const item = buildTxItem(exp);
    item.classList.add('tx-item-entering');
    list.insertBefore(item, list.firstChild);

    renderTopBar();

    // Reset form
    amountEl.value = '';
    noteEl.value   = '';
    amountEl.focus();

    // Restore button
    setTimeout(() => setButtonState('default'), 1600);

    showToast(`${exp.emoji} ${fmt(exp.amount)} saved!`, 'ok');
  });

  // Auto-focus amount on load
  setTimeout(() => {
    if (window.innerWidth < 640) return; // skip on mobile to avoid layout shift
    amountEl.focus();
  }, 300);
}

/* ─── Button state ──────────────────────────────────────────── */
function setButtonState(mode) {
  const btn     = $('#saveBtn');
  const btnText = $('#saveBtnText');
  const btnIcon = $('#saveBtnIcon');

  btn.classList.remove('success-flash');

  if (mode === 'success') {
    btn.classList.add('success-flash');
    btnIcon.innerHTML = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
    btnText.textContent = 'Saved!';
  } else {
    btnIcon.innerHTML = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/></svg>`;
    btnText.textContent = 'Save Expense';
  }
}

/* ═══════════════════════════════════════════════════════════════
   BUDGET SHEET
   ═══════════════════════════════════════════════════════════════ */
function openBudgetSheet() {
  const overlay = $('#sheetOverlay');
  const input   = $('#budgetSheetInput');
  input.value   = state.budget > 0 ? String(state.budget) : '';
  overlay.hidden = false;
  setTimeout(() => input.focus(), 300);
}

function closeBudgetSheet() {
  $('#sheetOverlay').hidden = true;
}

function saveBudgetFromSheet() {
  const val = parseFloat($('#budgetSheetInput').value);
  if (!isNaN(val) && val >= 0) {
    state.budget = val;
    saveBudget();
    renderTopBar();
    haptic.success();
    showToast(`Budget set to ${fmt(val)} 💰`, 'ok');
  }
  closeBudgetSheet();
}

function initBudgetSheet() {
  const pill = $('#statBudget');
  pill.addEventListener('click', () => { haptic.tap(); openBudgetSheet(); });
  pill.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') openBudgetSheet(); });

  $('#sheetOverlay').addEventListener('click', e => {
    if (e.target === $('#sheetOverlay')) closeBudgetSheet();
  });
  $('#budgetModalClose')?.addEventListener('click', closeBudgetSheet);
  $('#sheetSaveBtn').addEventListener('click', saveBudgetFromSheet);
  $('#sheetCancelBtn').addEventListener('click', closeBudgetSheet);

  $('#budgetSheetInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') saveBudgetFromSheet();
  });

  // Only numeric
  $('#budgetSheetInput').addEventListener('input', () => {
    $('#budgetSheetInput').value = $('#budgetSheetInput').value.replace(/[^0-9.]/g, '');
  });

  document.querySelectorAll('.preset').forEach(btn => {
    btn.addEventListener('click', () => {
      haptic.tap();
      $('#budgetSheetInput').value = btn.dataset.v;
    });
  });
}

/* ═══════════════════════════════════════════════════════════════
   CLEAR ALL SHEET
   ═══════════════════════════════════════════════════════════════ */
function initClearAll() {
  $('#clearBtn').addEventListener('click', () => {
    if (state.expenses.length === 0) { showToast('Nothing to clear.', 'info'); return; }
    haptic.tap();
    $('#clearOverlay').hidden = false;
  });

  $('#clearOverlay').addEventListener('click', e => {
    if (e.target === $('#clearOverlay')) $('#clearOverlay').hidden = true;
  });

  $('#cancelClearBtn').addEventListener('click', () => { $('#clearOverlay').hidden = true; });

  $('#confirmClearBtn').addEventListener('click', () => {
    haptic.error();
    state.expenses = [];
    save();
    renderList();
    renderTopBar();
    $('#clearOverlay').hidden = true;
    showToast('All expenses cleared.', 'info');
  });
}

/* ═══════════════════════════════════════════════════════════════
   KEYBOARD: Escape closes sheets
   ═══════════════════════════════════════════════════════════════ */
function initKeyboard() {
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      if (!$('#sheetOverlay').hidden)  closeBudgetSheet();
      if (!$('#clearOverlay').hidden)  $('#clearOverlay').hidden = true;
    }
    // Enter on amount input = save
    if (e.key === 'Enter' && document.activeElement === $('#amountInput')) {
      $('#saveBtn').click();
    }
  });
}

/* ═══════════════════════════════════════════════════════════════
   TOAST
   ═══════════════════════════════════════════════════════════════ */
function showToast(msg, type = 'info', duration = 2800) {
  const container = $('#toastWrap');
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  t.setAttribute('role', 'status');
  t.innerHTML = `<span class="toast-dot"></span>${escHtml(msg)}`;
  container.appendChild(t);
  setTimeout(() => {
    t.classList.add('out');
    setTimeout(() => t.remove(), 400);
  }, duration);
}

/* ═══════════════════════════════════════════════════════════════
   RESIZE — keep bar height in sync
   ═══════════════════════════════════════════════════════════════ */
function initResize() {
  const ro = new ResizeObserver(() => syncBarHeight());
  ro.observe($('#topBar'));
  syncBarHeight();
}

/* ═══════════════════════════════════════════════════════════════
   BOOT
   ═══════════════════════════════════════════════════════════════ */
function init() {
  load();
  initChips();
  initSaveBtn();
  initBudgetSheet();
  initClearAll();
  initKeyboard();
  initResize();

  renderTopBar();
  renderList();

  // Welcome first-time users
  if (state.expenses.length === 0 && state.budget === 0) {
    setTimeout(() => showToast('👆 Tap "Left" to set your budget!', 'info', 4000), 1200);
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
