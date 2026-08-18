/**
 * SpendWise – script.js
 * Ultra-fast, zero-friction expense logger
 * Four interaction modes: Notepad · Grid · Tap · Feed
 */

'use strict';

/* ═══════════════════════════════════════════════════════════════
   STORAGE
   ═══════════════════════════════════════════════════════════════ */
const SK = { EXP: 'sw_exp', BUD: 'sw_bud' };

let expenses = [];
let budget   = 0;

function loadData() {
  try { expenses = JSON.parse(localStorage.getItem(SK.EXP)) || []; } catch { expenses = []; }
  budget = parseFloat(localStorage.getItem(SK.BUD)) || 0;
}

function saveData() {
  try {
    localStorage.setItem(SK.EXP, JSON.stringify(expenses));
  } catch {
    expenses = expenses.slice(-Math.floor(expenses.length * 0.8));
    localStorage.setItem(SK.EXP, JSON.stringify(expenses));
  }
}

/* ═══════════════════════════════════════════════════════════════
   UTILS
   ═══════════════════════════════════════════════════════════════ */
const $ = (s) => document.querySelector(s);
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
const esc = (s) => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const vib = (p) => { try { navigator.vibrate?.(p); } catch {} };

function fmt(n) {
  n = Number(n) || 0;
  if (n >= 1e5) return '₹' + (n / 1e5).toFixed(1) + 'L';
  if (n >= 1e3) return '₹' + n.toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return '₹' + n.toFixed(0);
}

function ftime(ts) {
  return new Date(ts).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });
}

function todayStart() { const d = new Date(); d.setHours(0,0,0,0); return d.getTime(); }
function monthStart() { const d = new Date(); d.setDate(1); d.setHours(0,0,0,0); return d.getTime(); }

/* ─── Category auto-detect ────────────────────────────────── */
const CAT_RULES = [
  { cat:'Food',      emoji:'🍔', rx:/\b(food|lunch|dinner|breakfast|meal|biryani|rice|roti|dal|sabzi|veg|pizza|burger|sandwich|thali|hotel|restaurant|cafe|dhaba|curry|idli|dosa|paratha|pav|chaat|samosa|maggi|noodle)\b/i },
  { cat:'Transport', emoji:'🚖', rx:/\b(auto|bus|metro|train|cab|taxi|rickshaw|petrol|fuel|uber|ola|rapido|travel|fare|ticket|oil|diesel|parking|rapido|tuk|cycle)\b/i },
  { cat:'Snacks',    emoji:'☕', rx:/\b(chai|tea|coffee|snack|biscuit|juice|drink|nimbu|lassi|ice.?cream|shake|soda|water|bottle|namkeen)\b/i },
  { cat:'Study',     emoji:'📚', rx:/\b(book|print|printout|xerox|photocopy|stationery|pen|pencil|paper|notebook|notes|tuition|fees|library|exam|course|pdf|highlighter|eraser|ruler|staple)\b/i },
  { cat:'Bills',     emoji:'⚡', rx:/\b(electricity|bill|wifi|internet|phone|mobile|recharge|data|water|gas|rent|maintenance|emi|insurance|subscription|netflix|spotify|prime|amazon|toll|fine|gym)\b/i },
  { cat:'Shopping',  emoji:'🛍️', rx:/\b(shopping|clothes|shirt|pant|jeans|shoes|bag|grocery|vegetable|fruit|supermarket|kirana|amazon|flipkart|mall|purchase|buy|delivery|soap|shampoo|toothpaste)\b/i },
];

function detectCat(text) {
  const s = text.toLowerCase();
  for (const r of CAT_RULES) if (r.rx.test(s)) return { cat: r.cat, emoji: r.emoji };
  return { cat: 'Other', emoji: '📦' };
}

/* ─── Add expense ─────────────────────────────────────────── */
function addExpense({ amount, note, cat, emoji, ts }) {
  expenses.push({ id: uid(), amount: parseFloat(amount.toFixed(2)), note, cat, emoji, ts: ts || Date.now() });
  saveData();
  renderHeader();
  renderFeed();
}

/* ═══════════════════════════════════════════════════════════════
   HEADER
   ═══════════════════════════════════════════════════════════════ */
function renderHeader() {
  const td = todayStart(), mo = monthStart();
  const tTotal = expenses.filter(e => e.ts >= td).reduce((s,e) => s + e.amount, 0);
  const mTotal = expenses.filter(e => e.ts >= mo).reduce((s,e) => s + e.amount, 0);

  $('#hdrToday').textContent = fmt(tTotal);
  $('#hdrMonth').textContent = fmt(mTotal);

  const fill = $('#burnFill');
  if (budget > 0) {
    const pct = Math.min((mTotal / budget) * 100, 100);
    fill.style.width = pct + '%';
    $('#burnBar').setAttribute('aria-valuenow', Math.round(pct));
    fill.className = 'burn-fill' + (pct >= 100 ? ' over' : pct >= 70 ? ' warn' : '');
  } else {
    fill.style.width = '0%';
  }

  // sync hdr-h CSS var
  document.documentElement.style.setProperty('--hdr-h', $('#hdr').offsetHeight + 'px');
}

/* ═══════════════════════════════════════════════════════════════
   ██  01 NOTEPAD
   ═══════════════════════════════════════════════════════════════ */

/* Parse a single line: "50 chai" or "chai 50" or just "50" */
function parseLine(raw) {
  const s = raw.trim();
  if (!s) return null;

  // number-first: "50 chai", "₹50 chai"
  let m = s.match(/^[₹]?\s*(\d+(?:\.\d{1,2})?)\s*(.*)?$/);
  if (m && parseFloat(m[1]) > 0) {
    const amount = parseFloat(m[1]);
    const note   = (m[2] || '').trim();
    if (amount > 999999) return { error: true, raw: s };
    const { cat, emoji } = detectCat(note || s);
    return { amount, note: note || cat, cat, emoji };
  }

  // word-first: "chai 50"
  m = s.match(/^(.+?)\s+[₹]?(\d+(?:\.\d{1,2})?)$/);
  if (m && parseFloat(m[2]) > 0) {
    const amount = parseFloat(m[2]);
    const note   = m[1].trim();
    const { cat, emoji } = detectCat(note);
    return { amount, note, cat, emoji };
  }

  return { error: true, raw: s };
}

function parseNotepad(text) {
  return text
    .split(/\n|,(?=\s*[₹\d])/)
    .map(parseLine)
    .filter(Boolean);
}

function updateParseStrip() {
  const text  = $('#notepad').value;
  const strip = $('#parseStrip');

  if (!text.trim()) { strip.hidden = true; return; }

  const items  = parseNotepad(text);
  const valid  = items.filter(i => !i.error);
  const errors = items.filter(i => i.error);
  if (!items.length) { strip.hidden = true; return; }

  strip.hidden = false;
  const total  = valid.reduce((s, i) => s + i.amount, 0);

  strip.innerHTML = [
    ...valid.map(i =>
      `<span class="ps-chip">${esc(i.emoji)} <span class="ps-amt">${fmt(i.amount)}</span> ${esc(i.note)}</span>`
    ),
    ...errors.map(i =>
      `<span class="ps-chip ps-err">⚠ ${esc(i.raw)}</span>`
    ),
    valid.length > 1
      ? `<span class="ps-chip" style="border-color:rgba(124,108,240,.3);color:var(--a2)"><span class="ps-amt">${fmt(total)}</span> total</span>`
      : ''
  ].join('');
}

function initNotepad() {
  let debounce;
  $('#notepad').addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(updateParseStrip, 200);
  });

  // Ctrl/Cmd + Enter shortcut
  $('#notepad').addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      $('#logAllBtn').click();
    }
  });

  $('#logAllBtn').addEventListener('click', () => {
    const text  = $('#notepad').value.trim();
    if (!text) { flashLog('Type some expenses first!', true); return; }

    const items = parseNotepad(text).filter(i => !i.error);
    if (!items.length) {
      flashLog('Nothing parseable. Format: "50 chai" per line.', true);
      vib([20,10,20]);
      return;
    }

    const now = Date.now();
    items.forEach((item, i) => addExpense({ ...item, ts: now + i }));

    const total = items.reduce((s, i) => s + i.amount, 0);
    vib([10, 40, 15]);

    // Button done state
    const btn = $('#logAllBtn');
    btn.classList.add('done');
    btn.querySelector('svg').style.display = 'none';
    const label = btn.querySelector('span') || btn;
    label.textContent = `✓ ${items.length} entries — ${fmt(total)}`;
    setTimeout(() => {
      btn.classList.remove('done');
      btn.querySelector('svg').style.display = '';
      label.innerHTML = `Log All Entries &nbsp;<kbd>Ctrl+↵</kbd>`;
    }, 2400);

    flashLog(`✓ ${items.length} item${items.length > 1 ? 's' : ''} saved — ${fmt(total)}`, false);
    $('#notepad').value = '';
    $('#parseStrip').hidden = true;
    showToast(`${items.length} expenses logged in one tap ⚡`, 'ok');
  });
}

function flashLog(msg, isErr) {
  const el = $('#logFlash');
  el.textContent = msg;
  el.className = 'log-flash show' + (isErr ? ' err' : '');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), 3000);
}

/* ═══════════════════════════════════════════════════════════════
   ██  02 QUICK GRID
   ═══════════════════════════════════════════════════════════════ */
const GRID_ROWS = 5;

function buildGridRows() {
  const wrap = $('#gridWrap');
  wrap.innerHTML = '';

  for (let i = 0; i < GRID_ROWS; i++) {
    const row = document.createElement('div');
    row.className = 'grid-row';
    row.id = `grow-${i}`;
    row.innerHTML = `
      <span class="grid-row-num">${i + 1}</span>
      <input type="text" inputmode="decimal" class="grid-amt" id="gamt-${i}"
        placeholder="₹ amt" maxlength="7" autocomplete="off"
        aria-label="Row ${i+1} amount" />
      <input type="text" class="grid-note" id="gnote-${i}"
        placeholder="note" maxlength="50" autocomplete="off" spellcheck="false"
        aria-label="Row ${i+1} note" />
      <span class="grid-row-saved-label" id="gsaved-${i}"></span>
    `;
    wrap.appendChild(row);
  }

  // Wire up events
  for (let i = 0; i < GRID_ROWS; i++) {
    const amtEl  = $(`#gamt-${i}`);
    const noteEl = $(`#gnote-${i}`);

    // Only allow numeric in amount field
    amtEl.addEventListener('input', () => {
      const v = amtEl.value.replace(/[^0-9.]/g, '');
      const parts = v.split('.');
      amtEl.value = parts.length > 2 ? parts[0] + '.' + parts.slice(1).join('') : v;
    });

    // Enter on amount → jump to note
    amtEl.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); noteEl.focus(); }
    });

    // Enter on note → save row + move to next
    noteEl.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        e.preventDefault();
        saveGridRow(i);
      }
    });

    // Tab from last note → wrap to first amount
    if (i === GRID_ROWS - 1) {
      noteEl.addEventListener('keydown', e => {
        if (e.key === 'Tab' && !e.shiftKey) {
          e.preventDefault();
          $(`#gamt-0`).focus();
        }
      });
    }
  }
}

function saveGridRow(idx) {
  const amtEl  = $(`#gamt-${idx}`);
  const noteEl = $(`#gnote-${idx}`);
  const row    = $(`#grow-${idx}`);
  const saved  = $(`#gsaved-${idx}`);

  const amount = parseFloat(amtEl.value);
  if (!amount || amount <= 0) {
    amtEl.focus();
    amtEl.style.borderColor = 'rgba(240,80,112,.5)';
    setTimeout(() => { amtEl.style.borderColor = ''; }, 800);
    return;
  }

  const note = noteEl.value.trim();
  const { cat, emoji } = detectCat(note || '');

  addExpense({ amount, note: note || cat, cat, emoji });
  vib([8, 20, 8]);

  // Flash saved state
  saved.textContent = `✓ ${fmt(amount)}`;
  row.classList.add('saved');
  amtEl.value  = '';
  noteEl.value = '';

  setTimeout(() => {
    row.classList.remove('saved');
    saved.textContent = '';
  }, 1200);

  // Advance to next row
  const next = (idx + 1) % GRID_ROWS;
  $(`#gamt-${next}`).focus();
}

/* ═══════════════════════════════════════════════════════════════
   ██  03 INSTANT TAP
   ═══════════════════════════════════════════════════════════════ */
let tapAmt  = 0;   // 0 = not selected
let tapSrc  = '';  // 'pill' | 'custom'

function updateTapState() {
  const amtEl = $('#tapStateAmt');
  const catEl = $('#tapStateCat');
  const clrBtn = $('#tapClearAmt');

  if (tapAmt > 0) {
    amtEl.textContent = fmt(tapAmt);
    amtEl.classList.add('selected');
    catEl.textContent = '← tap a category to log';
    catEl.classList.add('ready');
    clrBtn.hidden = false;
  } else {
    amtEl.textContent = '—';
    amtEl.classList.remove('selected');
    catEl.textContent = 'pick a category';
    catEl.classList.remove('ready');
    clrBtn.hidden = true;
  }
}

function clearTapAmt() {
  tapAmt = 0; tapSrc = '';
  document.querySelectorAll('.apill').forEach(p => {
    p.classList.remove('active');
    p.setAttribute('aria-pressed', 'false');
  });
  $('#tapCustom').value = '';
  updateTapState();
}

function commitTap(cat, emoji) {
  if (!tapAmt || tapAmt <= 0) {
    showToast('Pick an amount first (pill or custom)', 'warn');
    return;
  }
  addExpense({ amount: tapAmt, note: cat, cat, emoji });
  vib([10, 30, 15]);

  // Animate category chip
  const chip = document.querySelector(`.cchip[data-cat="${cat}"]`);
  if (chip) {
    chip.classList.add('boom');
    chip.addEventListener('animationend', () => chip.classList.remove('boom'), { once: true });
  }

  showToast(`${emoji} ${fmt(tapAmt)} → ${cat}`, 'ok', 2000);
  clearTapAmt();
}

function initTap() {
  // Amount pills
  document.querySelectorAll('.apill').forEach(pill => {
    pill.addEventListener('click', () => {
      vib(6);
      // Toggle: clicking same pill deselects
      if (pill.classList.contains('active')) { clearTapAmt(); return; }

      document.querySelectorAll('.apill').forEach(p => { p.classList.remove('active'); p.setAttribute('aria-pressed','false'); });
      pill.classList.add('active');
      pill.setAttribute('aria-pressed', 'true');

      tapAmt = parseFloat(pill.dataset.v);
      tapSrc = 'pill';
      $('#tapCustom').value = '';
      updateTapState();
    });
  });

  // Custom amount field
  const customEl = $('#tapCustom');
  customEl.addEventListener('input', () => {
    // strip non-numeric
    const v = customEl.value.replace(/[^0-9.]/g, '');
    const parts = v.split('.');
    customEl.value = parts.length > 2 ? parts[0] + '.' + parts.slice(1).join('') : v;

    const n = parseFloat(customEl.value);
    if (n > 0) {
      // Deselect pills
      document.querySelectorAll('.apill').forEach(p => { p.classList.remove('active'); p.setAttribute('aria-pressed','false'); });
      tapAmt = n; tapSrc = 'custom';
    } else {
      if (tapSrc === 'custom') { tapAmt = 0; tapSrc = ''; }
    }
    updateTapState();
  });

  // Category chips
  document.querySelectorAll('.cchip').forEach(chip => {
    chip.addEventListener('click', () => {
      vib(8);
      commitTap(chip.dataset.cat, chip.dataset.emoji);
    });
  });

  // Clear button
  $('#tapClearAmt').addEventListener('click', clearTapAmt);

  updateTapState();
}

/* ═══════════════════════════════════════════════════════════════
   ██  04 TODAY'S LIVE FEED
   ═══════════════════════════════════════════════════════════════ */
function renderFeed() {
  const feed     = $('#feed');
  const emptyEl  = $('#feedEmpty');
  const totalRow = $('#feedTotalRow');
  const totalVal = $('#feedTotal');

  // Today's entries, newest first
  const today = expenses
    .filter(e => e.ts >= todayStart())
    .sort((a, b) => b.ts - a.ts);

  // Remove existing items
  feed.querySelectorAll('.fi').forEach(el => el.remove());

  if (!today.length) {
    emptyEl.classList.remove('hidden');
    totalRow.hidden = true;
    return;
  }

  emptyEl.classList.add('hidden');
  totalRow.hidden = false;
  totalVal.textContent = fmt(today.reduce((s, e) => s + e.amount, 0));

  today.forEach(exp => {
    const li = document.createElement('li');
    li.className = 'fi';
    li.dataset.id = exp.id;
    li.innerHTML = `
      <span class="fi-time">${ftime(exp.ts)}</span>
      <span class="fi-emoji" aria-hidden="true">${esc(exp.emoji)}</span>
      <span class="fi-note" title="${esc(exp.note)}">${esc(exp.note)}</span>
      <span class="fi-cat">${esc(exp.cat)}</span>
      <span class="fi-amt">${fmt(exp.amount)}</span>
      <button class="fi-del" data-id="${exp.id}" aria-label="Delete ${esc(exp.note)}">✕</button>
    `;

    li.querySelector('.fi-del').addEventListener('click', () => {
      vib(10);
      li.classList.add('removing');
      setTimeout(() => {
        expenses = expenses.filter(e => e.id !== exp.id);
        saveData();
        renderHeader();
        renderFeed();
      }, 220);
    });

    feed.appendChild(li);
  });
}

function initFeed() {
  $('#clrTodayBtn').addEventListener('click', () => {
    const td = todayStart();
    const count = expenses.filter(e => e.ts >= td).length;
    if (!count) { showToast('Nothing to clear today.', 'warn'); return; }
    if (!confirm(`Clear ${count} entr${count > 1 ? 'ies' : 'y'} from today?`)) return;
    expenses = expenses.filter(e => e.ts < td);
    saveData();
    renderHeader();
    renderFeed();
    showToast(`Cleared ${count} entries.`, 'ok');
  });
}

/* ═══════════════════════════════════════════════════════════════
   TOAST
   ═══════════════════════════════════════════════════════════════ */
function showToast(msg, type = 'ok', ms = 2800) {
  const zone = $('#toasts');
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  t.setAttribute('role', 'status');
  t.innerHTML = `<span class="tdot"></span>${esc(msg)}`;
  zone.appendChild(t);
  setTimeout(() => {
    t.classList.add('out');
    setTimeout(() => t.remove(), 200);
  }, ms);
}

/* ═══════════════════════════════════════════════════════════════
   RESIZE
   ═══════════════════════════════════════════════════════════════ */
function initResize() {
  const ro = new ResizeObserver(() => {
    document.documentElement.style.setProperty('--hdr-h', $('#hdr').offsetHeight + 'px');
  });
  ro.observe($('#hdr'));
}

/* ═══════════════════════════════════════════════════════════════
   BOOT
   ═══════════════════════════════════════════════════════════════ */
function init() {
  loadData();

  // Render static parts
  buildGridRows();
  initNotepad();
  initTap();
  initFeed();
  initResize();

  // Render live data
  renderHeader();
  renderFeed();

  // Focus notepad on load (desktop)
  if (window.innerWidth >= 600) {
    setTimeout(() => $('#notepad').focus(), 200);
  }

  // Keyboard shortcut legend
  document.addEventListener('keydown', e => {
    // Esc in notepad = clear parse strip
    if (e.key === 'Escape' && document.activeElement === $('#notepad')) {
      $('#notepad').value = '';
      $('#parseStrip').hidden = true;
    }
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
