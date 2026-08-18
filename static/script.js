/**
 * SpendWise – static/script.js
 * Flask-backed Smart Budget & Expense Tracker
 * All data comes from /api/* endpoints — no localStorage required.
 */

'use strict';

/* ═══════════════════════════════════════════════════════════════
   CONSTANTS
   ═══════════════════════════════════════════════════════════════ */
const API = {
  TRANSACTIONS: '/api/transactions',
  BUDGET:       '/api/budget',
  EXPORT:       '/api/transactions/export',
};

const CATEGORY_META = {
  'Food & Dining':     { emoji: '🍔', color: '#f59e0b' },
  'Transport':         { emoji: '🚗', color: '#3b82f6' },
  'Education':         { emoji: '📚', color: '#8b5cf6' },
  'Shopping':          { emoji: '🛍️', color: '#ec4899' },
  'Bills & Utilities': { emoji: '💡', color: '#06b6d4' },
  'Entertainment':     { emoji: '🎬', color: '#f43f5e' },
  'Health':            { emoji: '💊', color: '#10b981' },
  'Travel':            { emoji: '✈️', color: '#0ea5e9' },
  'Others':            { emoji: '📦', color: '#9ca3af' },
  'Income':            { emoji: '💰', color: '#10b981' },
};

const CHART_PALETTE = [
  '#f59e0b','#3b82f6','#8b5cf6','#ec4899',
  '#06b6d4','#f43f5e','#10b981','#0ea5e9',
  '#9ca3af','#e879f9','#fb923c','#34d399',
];

/* ═══════════════════════════════════════════════════════════════
   STATE
   ═══════════════════════════════════════════════════════════════ */
const state = {
  chartInstance:        null,
  incomeChartInstance:  null,
  chartType:            'donut',
  filter:               'all',
  search:               '',
  sort:                 'date_desc',
  page:                 1,
  perPage:              15,
  totalPages:           1,
  pendingDeleteId:      null,
  // cached from last API response
  summary:              {},
  breakdown:            [],   // expense breakdown
  incomeBreakdown:      [],   // income breakdown
};

/* ═══════════════════════════════════════════════════════════════
   DOM HELPERS
   ═══════════════════════════════════════════════════════════════ */
const $ = (sel, ctx = document) => ctx.querySelector(sel);
const $$ = (sel, ctx = document) => [...ctx.querySelectorAll(sel)];

function fmt(amount) {
  if (amount === null || amount === undefined) return '₹—';
  const abs = Math.abs(amount);
  if (abs >= 1e7) return `₹${(amount / 1e7).toFixed(2)}Cr`;
  if (abs >= 1e5) return `₹${(amount / 1e5).toFixed(2)}L`;
  return `₹${parseFloat(amount).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;
}

function fmtDate(dateStr) {
  if (!dateStr) return '—';
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function escHtml(str) {
  return String(str)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function animateValue(el, newText) {
  if (!el || el.textContent === newText) return;
  el.textContent = newText;
  el.classList.remove('updating');
  void el.offsetWidth;
  el.classList.add('updating');
}

/* ═══════════════════════════════════════════════════════════════
   API LAYER
   ═══════════════════════════════════════════════════════════════ */
async function apiFetch(url, opts = {}) {
  try {
    const res = await fetch(url, {
      headers: { 'Content-Type': 'application/json', ...opts.headers },
      ...opts,
    });
    const data = await res.json();
    if (!res.ok) {
      const msg = data.error || data.errors
        ? (typeof data.errors === 'object'
            ? Object.values(data.errors).join(' ')
            : data.error)
        : `HTTP ${res.status}`;
      throw new ApiError(msg, res.status, data.errors || null);
    }
    return data;
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw new ApiError('Network error — is Flask running?', 0, null);
  }
}

class ApiError extends Error {
  constructor(msg, status, fieldErrors) {
    super(msg);
    this.status = status;
    this.fieldErrors = fieldErrors;
  }
}

/* Fetch transactions + summary from backend */
async function fetchTransactions() {
  const params = new URLSearchParams({
    filter:   state.filter,
    search:   state.search,
    sort:     state.sort,
    page:     state.page,
    per_page: state.perPage,
  });
  return apiFetch(`${API.TRANSACTIONS}?${params}`);
}

/* ═══════════════════════════════════════════════════════════════
   THEME
   ═══════════════════════════════════════════════════════════════ */
function applyTheme(isDark) {
  document.documentElement.setAttribute('data-theme', isDark ? 'dark' : 'light');
  const toggle = $('#themeToggle');
  toggle.checked = isDark;
  toggle.setAttribute('aria-checked', String(isDark));
  localStorage.setItem('spendwise_theme', isDark ? 'dark' : 'light');
}

function initTheme() {
  const saved = localStorage.getItem('spendwise_theme');
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  applyTheme(saved ? saved === 'dark' : prefersDark);

  $('#themeToggle').addEventListener('change', (e) => {
    applyTheme(e.target.checked);
    setTimeout(() => updateBothCharts(state.breakdown, state.incomeBreakdown), 100);
  });
}

/* ═══════════════════════════════════════════════════════════════
   SUMMARY DASHBOARD
   ═══════════════════════════════════════════════════════════════ */
function renderSummary(summary) {
  state.summary = summary || {};
  const { total_income, total_expenses, balance, budget_limit,
          month_expenses, budget_remaining, budget_percent } = summary || {};

  animateValue($('#totalBalance'),   fmt(balance));
  animateValue($('#totalIncome'),    fmt(total_income));
  animateValue($('#totalExpenses'),  fmt(total_expenses));
  animateValue($('#budgetRemaining'), budget_remaining !== null && budget_remaining !== undefined
    ? fmt(budget_remaining) : '₹—');

  // Balance color
  const balEl = $('#totalBalance');
  if (balEl) balEl.style.color = (balance >= 0) ? 'var(--income)' : 'var(--expense)';

  // Progress bar
  renderBudgetProgress({ budget_limit, month_expenses, budget_percent });
}

function renderBudgetProgress({ budget_limit, month_expenses, budget_percent }) {
  const fill    = $('#budgetProgressFill');
  const msg     = $('#budgetStatusMsg');
  const track   = $('.progress-track');
  const usedLbl = $('#budgetUsedLabel');
  const limLbl  = $('#budgetLimitLabel');
  const pctLbl  = $('#budgetPercentLabel');

  usedLbl.textContent = fmt(month_expenses || 0);
  limLbl.textContent  = fmt(budget_limit || 0);
  pctLbl.textContent  = budget_limit ? `${Math.min(budget_percent, 100).toFixed(1)}%` : '0%';

  if (track) track.setAttribute('aria-valuenow', Math.round(budget_percent || 0));

  const displayPct = Math.min(budget_percent || 0, 100);
  fill.style.width = `${displayPct}%`;

  fill.className = 'progress-fill';
  msg.className  = 'budget-status-msg';

  if (!budget_limit) {
    msg.textContent = 'Set a monthly budget to track your progress.';
    msg.classList.add('safe');
    return;
  }

  const pct      = budget_percent || 0;
  const remaining = budget_limit - (month_expenses || 0);

  if (pct >= 100) {
    fill.classList.add('over');
    msg.classList.add('over');
    msg.textContent = `⚠️ Budget exceeded by ${fmt(Math.abs(remaining))}!`;
  } else if (pct >= 80) {
    fill.classList.add('danger');
    msg.classList.add('danger');
    msg.textContent = `🔴 Only ${fmt(remaining)} left — ${(100 - pct).toFixed(1)}% remaining.`;
  } else if (pct >= 60) {
    fill.classList.add('warn');
    msg.classList.add('warn');
    msg.textContent = `🟡 Heads up! ${(100 - pct).toFixed(1)}% of budget still available (${fmt(remaining)}).`;
  } else {
    msg.classList.add('safe');
    msg.textContent = `✅ On track — ${fmt(remaining)} remaining (${(100 - pct).toFixed(1)}% left).`;
  }
}

/* Shared chart builder — used for both expense and income charts */
function buildChart(canvas, breakdown, label) {
  const labels = breakdown.map(b => b.category);
  const data   = breakdown.map(b => b.total);
  const colors = labels.map((l, i) =>
    CATEGORY_META[l] ? CATEGORY_META[l].color : CHART_PALETTE[i % CHART_PALETTE.length]
  );

  const tc      = getThemeColors();
  const isDonut = state.chartType === 'donut';

  // Legend HTML
  const legendHtml = labels.map((lbl, i) => `
    <div class="legend-item">
      <span class="legend-dot" style="background:${colors[i]}"></span>
      <span>${escHtml(lbl)}</span>
    </div>
  `).join('');

  const instance = new Chart(canvas, {
    type: isDonut ? 'doughnut' : 'bar',
    data: {
      labels,
      datasets: [{
        data,
        backgroundColor: colors,
        borderWidth:      0,
        borderRadius:     isDonut ? 0 : 8,
        hoverOffset:      isDonut ? 12 : 0,
        hoverBackgroundColor: colors.map(c => c + 'cc'),
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 600, easing: 'easeInOutQuart' },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: 'rgba(13,15,23,0.95)',
          titleColor: '#f0f2ff',
          bodyColor:  '#9ea3c0',
          borderColor: 'rgba(255,255,255,0.08)',
          borderWidth: 1,
          padding: 12,
          cornerRadius: 10,
          callbacks: {
            label: (ctx) => {
              const total = ctx.dataset.data.reduce((a, b) => a + b, 0);
              const pct   = ((ctx.raw / total) * 100).toFixed(1);
              return ` ${fmt(ctx.raw)} (${pct}%)`;
            },
          },
        },
      },
      scales: isDonut ? {} : {
        x: { grid: { display: false }, ticks: { color: tc.text, font: { size: 11, family: 'Inter' }, maxRotation: 30 } },
        y: { grid: { color: tc.grid }, ticks: { color: tc.text, font: { size: 11, family: 'Inter' }, callback: v => `₹${v >= 1000 ? (v/1000).toFixed(0)+'K' : v}` }, border: { color: 'transparent' } },
      },
      cutout: isDonut ? '65%' : undefined,
    },
  });

  return { instance, legendHtml };
}

/* Expense chart */
function updateChart(breakdown) {
  state.breakdown = breakdown || [];
  const canvas   = $('#chartCanvas');
  const emptyEl  = $('#chartEmpty');
  const legendEl = $('#chartLegend');

  if (state.chartInstance) { state.chartInstance.destroy(); state.chartInstance = null; }

  if (!breakdown || breakdown.length === 0) {
    canvas.style.display = 'none';
    emptyEl.classList.remove('hidden');
    legendEl.innerHTML = '';
    return;
  }

  canvas.style.display = '';
  emptyEl.classList.add('hidden');

  const { instance, legendHtml } = buildChart(canvas, breakdown, 'Expense');
  state.chartInstance = instance;
  legendEl.innerHTML  = legendHtml;
}

/* Income chart */
function updateIncomeChart(breakdown) {
  state.incomeBreakdown = breakdown || [];
  const canvas   = $('#incomeChartCanvas');
  const emptyEl  = $('#incomeChartEmpty');
  const legendEl = $('#incomeChartLegend');

  if (!canvas) return;  // guard if element not yet in DOM
  if (state.incomeChartInstance) { state.incomeChartInstance.destroy(); state.incomeChartInstance = null; }

  if (!breakdown || breakdown.length === 0) {
    canvas.style.display = 'none';
    emptyEl.classList.remove('hidden');
    legendEl.innerHTML = '';
    return;
  }

  canvas.style.display = '';
  emptyEl.classList.add('hidden');

  const { instance, legendHtml } = buildChart(canvas, breakdown, 'Income');
  state.incomeChartInstance = instance;
  legendEl.innerHTML         = legendHtml;
}

/* Convenience: update both charts at once */
function updateBothCharts(expBreakdown, incBreakdown) {
  updateChart(expBreakdown);
  updateIncomeChart(incBreakdown);
}

function switchChartType(type) {
  state.chartType = type;
  $$('.chart-tab').forEach(btn => {
    const active = (btn.id === 'tabDonut' && type === 'donut') || (btn.id === 'tabBar' && type === 'bar');
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-selected', String(active));
  });
  // Redraw both charts with cached data
  updateBothCharts(state.breakdown, state.incomeBreakdown);
}

/* ═══════════════════════════════════════════════════════════════
   TRANSACTION LIST
   ═══════════════════════════════════════════════════════════════ */
function renderTransactions(transactions, pagination) {
  const list     = $('#transactionList');
  const loading  = $('#listLoading');
  const emptyEl  = $('#txEmpty');
  const countEl  = $('#txCount');
  const pgEl     = $('#pagination');

  loading.classList.add('hidden');
  list.hidden = false;

  // Clear previous items
  $$('.tx-item', list).forEach(el => el.remove());

  if (!transactions || transactions.length === 0) {
    emptyEl.classList.remove('hidden');
    countEl.innerHTML = `Showing <strong>0</strong> transactions`;
    pgEl.hidden = true;
    return;
  }

  emptyEl.classList.add('hidden');
  const { page, per_page, total, total_pages } = pagination;
  const start = (page - 1) * per_page + 1;
  const end   = Math.min(page * per_page, total);

  countEl.innerHTML = `Showing <strong>${start}–${end}</strong> of <strong>${total}</strong> transactions`;

  // Render rows
  for (const tx of transactions) {
    list.appendChild(buildTxItem(tx));
  }

  // Pagination controls
  state.page       = page;
  state.totalPages = total_pages;
  if (total_pages > 1) {
    pgEl.hidden = false;
    $('#pageInfo').textContent = `${page} / ${total_pages}`;
    $('#prevPage').disabled = page <= 1;
    $('#nextPage').disabled = page >= total_pages;
  } else {
    pgEl.hidden = true;
  }
}

function buildTxItem(tx) {
  const meta   = CATEGORY_META[tx.type === 'income' ? 'Income' : tx.category] || { emoji: '💰', color: '#6366f1' };
  const sign   = tx.type === 'income' ? '+' : '-';

  const item   = document.createElement('div');
  item.className = 'tx-item';
  item.setAttribute('role', 'listitem');
  item.dataset.id = tx.id;

  item.innerHTML = `
    <div class="tx-item-accent ${tx.type}"></div>
    <div class="tx-icon ${tx.type}" aria-hidden="true">${meta.emoji}</div>
    <div class="tx-details">
      <p class="tx-desc" title="${escHtml(tx.title)}">${escHtml(tx.title)}</p>
      <div class="tx-meta">
        <span class="tx-date">${fmtDate(tx.date)}</span>
        <span class="tx-badge">${escHtml(tx.category)}</span>
      </div>
    </div>
    <span class="tx-amount ${tx.type}">${sign}${fmt(tx.amount)}</span>
    <button class="tx-delete-btn" data-id="${tx.id}" aria-label="Delete: ${escHtml(tx.title)}" title="Delete">🗑️</button>
  `;

  item.querySelector('.tx-delete-btn').addEventListener('click', () => {
    openDeleteModal(tx.id, tx.title);
  });
  return item;
}

/* ═══════════════════════════════════════════════════════════════
   LOADING STATE
   ═══════════════════════════════════════════════════════════════ */
function showLoading() {
  $('#listLoading').classList.remove('hidden');
  $('#transactionList').hidden = true;
}

/* ═══════════════════════════════════════════════════════════════
   MAIN DATA FETCH & RENDER
   ═══════════════════════════════════════════════════════════════ */
async function loadData() {
  showLoading();
  try {
    const data = await fetchTransactions();
    renderSummary(data.summary);
    updateBothCharts(data.breakdown, data.income_breakdown || []);
    renderTransactions(data.transactions, data.pagination);
  } catch (err) {
    $('#listLoading').classList.add('hidden');
    $('#transactionList').hidden = false;
    showToast(err.message, 'error', 5000);
  }
}

/* ═══════════════════════════════════════════════════════════════
   ADD TRANSACTION FORM — Optimistic UI
   ═══════════════════════════════════════════════════════════════ */
function initForm() {
  const dateEl  = $('#txDate');
  dateEl.value  = todayISO();
  dateEl.max    = todayISO();

  $('#transactionForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    clearFormErrors();

    const titleEl    = $('#txTitle');
    const amountEl   = $('#txAmount');
    const categoryEl = $('#txCategory');
    const dateInputEl = $('#txDate');

    const title    = titleEl.value.trim();
    const amount   = amountEl.value;
    const type     = document.querySelector('input[name="txType"]:checked')?.value || 'expense';
    const category = categoryEl.value;
    const date     = dateInputEl.value || todayISO();

    // Client-side validation
    let hasError = false;
    if (!title)    { showFieldError('titleError', 'txTitle', 'Description is required.'); hasError = true; }
    if (!amount || parseFloat(amount) <= 0) { showFieldError('amountError', 'txAmount', 'Enter a valid amount.'); hasError = true; }
    if (!category) { showFieldError('catError', 'txCategory', 'Please select a category.'); hasError = true; }
    if (hasError) return;

    const parsedAmount = parseFloat(amount);

    /* ── OPTIMISTIC: build a temp transaction and show it immediately ── */
    const optimisticId = 'opt-' + Date.now();
    const optimisticTx = {
      id:       optimisticId,
      title,
      amount:   parsedAmount,
      type,
      category,
      date,
    };

    // 1. Inject the row at the top of the list instantly
    const list    = $('#transactionList');
    const emptyEl = $('#txEmpty');
    list.hidden   = false;
    emptyEl.classList.add('hidden');
    const optimisticRow = buildTxItem(optimisticTx);
    optimisticRow.classList.add('optimistic');
    optimisticRow.style.opacity = '0.65';
    optimisticRow.querySelector('.tx-delete-btn').disabled = true; // disable until confirmed
    list.insertBefore(optimisticRow, list.firstChild);

    // 2. Locally update the summary cards (instant feedback)
    const prev    = state.summary;
    const prevInc = parseFloat(prev.total_income)  || 0;
    const prevExp = parseFloat(prev.total_expenses) || 0;
    const newInc  = type === 'income'  ? prevInc + parsedAmount : prevInc;
    const newExp  = type === 'expense' ? prevExp + parsedAmount : prevExp;
    renderSummary({
      ...prev,
      total_income:    newInc,
      total_expenses:  newExp,
      balance:         newInc - newExp,
      budget_remaining: (prev.budget_limit || 0) - newExp,
      budget_percent:   prev.budget_limit ? (newExp / prev.budget_limit) * 100 : 0,
      month_expenses:   type === 'expense'
        ? (parseFloat(prev.month_expenses) || 0) + parsedAmount
        : parseFloat(prev.month_expenses) || 0,
    });

    // 3. Reset & re-focus form immediately — ready for next entry
    amountEl.value   = '';
    categoryEl.value = '';
    dateInputEl.value = todayISO();
    document.getElementById('typeExpense').checked = true;
    clearFormErrors();
    titleEl.value = '';
    titleEl.focus();

    // 4. Sync with server in the background
    try {
      const data = await apiFetch(API.TRANSACTIONS, {
        method: 'POST',
        body: JSON.stringify({ title, amount: parsedAmount, type, category, date }),
      });

      // Replace optimistic row with confirmed data
      optimisticRow.remove();

      // Server response has ground-truth summary + breakdown
      renderSummary(data.summary);
      updateBothCharts(data.breakdown, data.income_breakdown || []);

      // Reload list (page 1) to get server-assigned ID, correct order, pagination
      state.page = 1;
      await loadData();

      showFormSuccess('Transaction added successfully!');
      showToast('Transaction added! 🎉', 'success');
    } catch (err) {
      // Rollback optimistic row
      optimisticRow.remove();
      renderSummary(state.summary); // restore previous summary

      if (err.fieldErrors) {
        const fe = err.fieldErrors;
        if (fe.title)    showFieldError('titleError',  'txTitle',    fe.title);
        if (fe.amount)   showFieldError('amountError', 'txAmount',   fe.amount);
        if (fe.category) showFieldError('catError',    'txCategory', fe.category);
        titleEl.focus();
      } else {
        showToast(err.message, 'error');
      }
    }
  });
}

function setFormLoading(loading) {
  const btn   = $('#addTxBtn');
  const label = $('#addTxBtnLabel');
  btn.disabled = loading;
  if (loading) {
    label.innerHTML = '<span class="spinner"></span> Adding…';
  } else {
    label.textContent = 'Add Transaction';
  }
}

function showFieldError(errId, fieldId, msg) {
  const errEl = document.getElementById(errId);
  const field = document.getElementById(fieldId);
  if (errEl) { errEl.textContent = msg; errEl.classList.add('visible'); }
  if (field)  field.classList.add('error');
}

function clearFormErrors() {
  $$('.field-error').forEach(el => { el.textContent = ''; el.classList.remove('visible'); });
  $$('.form-input.error').forEach(el => el.classList.remove('error'));
}

function resetForm() {
  $('#txTitle').value = '';
  $('#txAmount').value = '';
  $('#txCategory').value = '';
  $('#txDate').value = todayISO();
  document.getElementById('typeExpense').checked = true;
  clearFormErrors();
}

function showFormSuccess(msg) {
  const el = $('#formSuccess');
  el.textContent = msg;
  el.classList.add('visible');
  setTimeout(() => { el.classList.remove('visible'); el.textContent = ''; }, 3000);
}

/* ═══════════════════════════════════════════════════════════════
   BUDGET MODAL
   ═══════════════════════════════════════════════════════════════ */
function openBudgetModal() {
  $('#budgetInput').value = state.summary.budget_limit || '';
  $('#budgetError').textContent = '';
  $('#budgetError').classList.remove('visible');
  $('#budgetModal').hidden = false;
  setTimeout(() => $('#budgetInput').focus(), 50);
}

function closeBudgetModal() {
  $('#budgetModal').hidden = true;
}

async function saveBudget() {
  const val = parseFloat($('#budgetInput').value);
  if (isNaN(val) || val < 0) {
    $('#budgetError').textContent = 'Enter a valid budget amount (≥ 0).';
    $('#budgetError').classList.add('visible');
    return;
  }

  const btn   = $('#saveBudgetBtn');
  const label = $('#saveBudgetLabel');
  btn.disabled = true;
  label.innerHTML = '<span class="spinner"></span> Saving…';

  try {
    const data = await apiFetch(API.BUDGET, {
      method: 'POST',
      body: JSON.stringify({ monthly_limit: val }),
    });
    renderSummary(data.summary);
    closeBudgetModal();
    showToast(`Budget set to ${fmt(val)} 💰`, 'success');
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    btn.disabled = false;
    label.textContent = 'Save Budget';
  }
}

function initBudgetModal() {
  $('#editBudgetBtn').addEventListener('click', openBudgetModal);
  $('#budgetModalClose').addEventListener('click', closeBudgetModal);
  $('#cancelBudgetBtn').addEventListener('click', closeBudgetModal);
  $('#saveBudgetBtn').addEventListener('click', saveBudget);
  $('#budgetInput').addEventListener('keydown', e => { if (e.key === 'Enter') saveBudget(); });
  $$('.preset-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      $('#budgetInput').value = btn.dataset.value;
      $('#budgetError').classList.remove('visible');
    });
  });
  $('#budgetModal').addEventListener('click', e => { if (e.target === $('#budgetModal')) closeBudgetModal(); });
}

/* ═══════════════════════════════════════════════════════════════
   DELETE MODAL
   ═══════════════════════════════════════════════════════════════ */
function openDeleteModal(id, title) {
  state.pendingDeleteId = id;
  $('#deleteModalMsg').textContent = `Delete "${title}"? This cannot be undone.`;
  $('#deleteModal').hidden = false;
  setTimeout(() => $('#confirmDeleteBtn').focus(), 50);
}

function closeDeleteModal() {
  $('#deleteModal').hidden = true;
  state.pendingDeleteId = null;
}

async function performDelete() {
  const id = state.pendingDeleteId;
  if (!id) return;

  const btn = $('#confirmDeleteBtn');
  btn.disabled = true;
  btn.textContent = 'Deleting…';

  // Animate row out
  const row = $(`.tx-item[data-id="${id}"]`);
  if (row) row.classList.add('removing');

  closeDeleteModal();

  try {
    const data = await apiFetch(`${API.TRANSACTIONS}/${id}`, { method: 'DELETE' });
    renderSummary(data.summary);
    updateBothCharts(data.breakdown, data.income_breakdown || []);
    // Wait for animation then reload
    setTimeout(async () => {
      await loadData();
      showToast(data.message || 'Transaction deleted.', 'info');
    }, 360);
  } catch (err) {
    if (row) row.classList.remove('removing');
    showToast(err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Delete';
  }
}

function initDeleteModal() {
  $('#deleteModalClose').addEventListener('click', closeDeleteModal);
  $('#cancelDeleteBtn').addEventListener('click', closeDeleteModal);
  $('#confirmDeleteBtn').addEventListener('click', performDelete);
  $('#deleteModal').addEventListener('click', e => { if (e.target === $('#deleteModal')) closeDeleteModal(); });
}

/* ═══════════════════════════════════════════════════════════════
   CLEAR ALL MODAL
   ═══════════════════════════════════════════════════════════════ */
function openClearModal() {
  $('#clearModal').hidden = false;
  setTimeout(() => $('#confirmClearBtn').focus(), 50);
}

function closeClearModal() {
  $('#clearModal').hidden = true;
}

async function performClearAll() {
  const btn = $('#confirmClearBtn');
  btn.disabled = true;
  btn.textContent = 'Clearing…';
  closeClearModal();

  try {
    // Delete all transactions one-by-one via the API
    // Fetch all transaction IDs first (no filter, large page)
    const data = await apiFetch(`${API.TRANSACTIONS}?per_page=999`);
    const ids  = data.transactions.map(t => t.id);

    if (ids.length === 0) {
      showToast('No transactions to clear.', 'warning');
      return;
    }

    // Fire all deletes in parallel
    await Promise.all(ids.map(id => apiFetch(`${API.TRANSACTIONS}/${id}`, { method: 'DELETE' })));

    await loadData();
    showToast('All transactions deleted.', 'info');
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Clear Everything';
  }
}

function initClearModal() {
  $('#clearAllBtn').addEventListener('click', openClearModal);
  $('#clearModalClose').addEventListener('click', closeClearModal);
  $('#cancelClearBtn').addEventListener('click', closeClearModal);
  $('#confirmClearBtn').addEventListener('click', performClearAll);
  $('#clearModal').addEventListener('click', e => { if (e.target === $('#clearModal')) closeClearModal(); });
}

/* ═══════════════════════════════════════════════════════════════
   FILTER / SEARCH / SORT
   ═══════════════════════════════════════════════════════════════ */
function initFilters() {
  $$('.filter-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      state.filter = btn.dataset.filter;
      state.page = 1;
      $$('.filter-tab').forEach(b => {
        b.classList.toggle('active', b === btn);
        b.setAttribute('aria-selected', String(b === btn));
      });
      loadData();
    });
  });

  let searchTimer;
  $('#searchInput').addEventListener('input', e => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.search = e.target.value.trim();
      state.page   = 1;
      loadData();
    }, 350);
  });

  $('#sortSelect').addEventListener('change', e => {
    state.sort = e.target.value;
    state.page = 1;
    loadData();
  });
}

/* ═══════════════════════════════════════════════════════════════
   PAGINATION
   ═══════════════════════════════════════════════════════════════ */
function initPagination() {
  $('#prevPage').addEventListener('click', () => {
    if (state.page > 1) { state.page--; loadData(); }
  });
  $('#nextPage').addEventListener('click', () => {
    if (state.page < state.totalPages) { state.page++; loadData(); }
  });
}

/* ═══════════════════════════════════════════════════════════════
   CHART TABS
   ═══════════════════════════════════════════════════════════════ */
function initChartTabs() {
  $('#tabDonut').addEventListener('click', () => switchChartType('donut'));
  $('#tabBar').addEventListener('click', () => switchChartType('bar'));
}

/* ═══════════════════════════════════════════════════════════════
   KEYBOARD SHORTCUTS
   ═══════════════════════════════════════════════════════════════ */
function initKeyboard() {
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      if (!$('#budgetModal').hidden) closeBudgetModal();
      if (!$('#deleteModal').hidden) closeDeleteModal();
      if (!$('#clearModal').hidden)  closeClearModal();
    }
  });
}

/* ═══════════════════════════════════════════════════════════════
   TOAST
   ═══════════════════════════════════════════════════════════════ */
function showToast(message, type = 'info', duration = 3500) {
  const container = $('#toastContainer');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.setAttribute('role', 'status');
  toast.innerHTML = `<span class="toast-dot"></span>${escHtml(message)}`;
  container.appendChild(toast);
  setTimeout(() => {
    toast.classList.add('out');
    setTimeout(() => toast.remove(), 400);
  }, duration);
}

/* ═══════════════════════════════════════════════════════════════
   INIT
   ═══════════════════════════════════════════════════════════════ */
async function init() {
  initTheme();
  initForm();
  initBudgetModal();
  initDeleteModal();
  initClearModal();
  initFilters();
  initPagination();
  initChartTabs();
  initKeyboard();

  // Set date max
  $('#txDate').max = todayISO();

  // Initial load
  await loadData();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
