'use strict';

const STORAGE_KEY = 'husaini_ledger_transactions';
const BUDGET_KEY = 'husaini_ledger_budget';

const EXPENSE_CATEGORIES = [
  'Food & Dining','Transport','Education','Shopping',
  'Bills & Utilities','Entertainment','Health','Travel','Others'
];
const INCOME_CATEGORIES = [
  'Salary','Freelance','Business','Investment','Gift','Others'
];
const CAT_EMOJI = {
  'Food & Dining':'🍔','Transport':'🚗','Education':'📚','Shopping':'🛍️',
  'Bills & Utilities':'⚡','Entertainment':'🎬','Health':'❤️‍🩹','Travel':'✈️',
  'Salary':'💼','Freelance':'💻','Business':'🏢','Investment':'📈',
  'Gift':'🎁','Others':'📌'
};
const CHART_PALETTE_EXP = ['#f43f5e','#fb923c','#fbbf24','#a78bfa','#60a5fa','#34d399','#f472b6','#94a3b8','#e879f9'];
const CHART_PALETTE_INC = ['#10b981','#34d399','#6ee7b7','#059669','#047857','#a7f3d0','#6366f1','#818cf8','#c4b5fd'];

const state = {
  period: 'all',
  chartType: 'donut',
  searchQuery: '',
  transactions: [],
  budgetLimit: 0,
  pendingDelId: null,
  expChart: null,
  incChart: null
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const fmt = (value) => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(Math.abs(Number(value || 0)));
const todayISO = () => new Date().toISOString().slice(0, 10);

function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(`${iso}T12:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}

function loadTransactions() {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    state.transactions = Array.isArray(stored) ? stored : [];
  } catch {
    state.transactions = [];
  }

  const budget = Number(localStorage.getItem(BUDGET_KEY) || 0);
  state.budgetLimit = Number.isFinite(budget) && budget >= 0 ? budget : 0;
}

function saveTransactions() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state.transactions));
  localStorage.setItem(BUDGET_KEY, String(state.budgetLimit));
}

function getDateFromTx(tx) {
  return tx.date || tx.created_at?.slice(0, 10) || todayISO();
}

function getVisibleTransactions() {
  const list = state.transactions.filter((tx) => {
    const iso = getDateFromTx(tx);
    const d = new Date(`${iso}T12:00:00`);
    if (Number.isNaN(d.getTime())) return true;

    const now = new Date();
    const startOfWeek = new Date(now);
    startOfWeek.setHours(0, 0, 0, 0);
    startOfWeek.setDate(now.getDate() - ((now.getDay() + 6) % 7));

    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const startOfYear = new Date(now.getFullYear(), 0, 1);

    switch (state.period) {
      case 'week': return d >= startOfWeek;
      case 'month': return d >= startOfMonth;
      case 'year': return d >= startOfYear;
      default: return true;
    }
  });

  const query = state.searchQuery.trim().toLowerCase();
  if (!query) return list;

  return list.filter((tx) => {
    const haystack = `${tx.title || ''} ${tx.category || ''} ${tx.amount || ''}`.toLowerCase();
    return haystack.includes(query);
  });
}

function buildSummary() {
  const visible = getVisibleTransactions();
  const totalIncome = visible.filter((tx) => tx.type === 'income').reduce((sum, tx) => sum + Number(tx.amount || 0), 0);
  const totalExpenses = visible.filter((tx) => tx.type === 'expense').reduce((sum, tx) => sum + Number(tx.amount || 0), 0);
  const balance = totalIncome - totalExpenses;

  const monthExpenses = state.transactions.filter((tx) => {
    const iso = getDateFromTx(tx);
    const d = new Date(`${iso}T12:00:00`);
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    return tx.type === 'expense' && d >= startOfMonth;
  }).reduce((sum, tx) => sum + Number(tx.amount || 0), 0);

  const budgetLimit = state.budgetLimit || 0;
  const budgetRemaining = budgetLimit > 0 ? budgetLimit - monthExpenses : null;
  const budgetPercent = budgetLimit > 0 ? (monthExpenses / budgetLimit) * 100 : 0;

  return { balance, total_income: totalIncome, total_expenses: totalExpenses, budget_limit: budgetLimit, budget_remaining: budgetRemaining, month_expenses: monthExpenses, budget_percent: budgetPercent };
}

function renderSummary() {
  const summary = buildSummary();
  const totalBalance = $('#totalBalance');
  const totalIncome = $('#totalIncome');
  const totalExpenses = $('#totalExpenses');
  const budgetRemaining = $('#budgetRemaining');

  totalBalance.textContent = fmt(summary.balance);
  totalIncome.textContent = fmt(summary.total_income);
  totalExpenses.textContent = fmt(summary.total_expenses);
  budgetRemaining.textContent = summary.budget_limit > 0 && summary.budget_remaining !== null ? fmt(summary.budget_remaining) : 'No limit';

  const budgetUsed = $('#budgetUsed');
  const budgetLimit = $('#budgetLimit');
  const budgetPct = $('#budgetPct');
  const fill = $('#progressFill');
  const msg = $('#budgetMsg');

  budgetUsed.textContent = fmt(summary.month_expenses);
  budgetLimit.textContent = summary.budget_limit > 0 ? fmt(summary.budget_limit) : '—';
  budgetPct.textContent = summary.budget_limit > 0 ? `${Math.round(summary.budget_percent || 0)}%` : '0%';

  const percentValue = Math.min(summary.budget_percent || 0, 100);
  fill.style.width = `${percentValue}%`;
  fill.className = 'progress-fill';
  msg.className = 'budget-msg';

  if (!summary.budget_limit) {
    fill.style.width = '0%';
    msg.textContent = 'Set a monthly budget to track spending.';
    return;
  }

  if (summary.budget_percent >= 100) {
    fill.classList.add('over');
    msg.classList.add('over');
    msg.textContent = `⚠️ Over budget by ${fmt(Math.max(0, summary.month_expenses - summary.budget_limit))}!`;
  } else if (summary.budget_percent >= 85) {
    fill.classList.add('danger');
    msg.classList.add('danger');
    msg.textContent = `⚡ Almost at limit — ${fmt(summary.budget_remaining)} left this month.`;
  } else if (summary.budget_percent >= 60) {
    fill.classList.add('warn');
    msg.classList.add('warn');
    msg.textContent = `📊 ${Math.round(summary.budget_percent)}% of budget used — ${fmt(summary.budget_remaining)} remaining.`;
  } else {
    msg.classList.add('safe');
    msg.textContent = `✅ You're on track — ${fmt(summary.budget_remaining)} remaining this month.`;
  }
}

function buildChartData(breakdown, palette) {
  if (!breakdown || !breakdown.length) return null;
  return {
    labels: breakdown.map((item) => item.category),
    datasets: [{
      data: breakdown.map((item) => item.total),
      backgroundColor: palette.slice(0, breakdown.length),
      borderWidth: 0,
      hoverOffset: 4
    }]
  };
}

function renderLegend(containerId, breakdown, palette) {
  const el = document.getElementById(containerId);
  if (!el) return;
  if (!breakdown || !breakdown.length) {
    el.innerHTML = '';
    return;
  }
  el.innerHTML = breakdown.slice(0, 6).map((item, index) => `
    <span class="legend-item">
      <span class="legend-dot" style="background:${palette[index % palette.length]}"></span>
      ${esc(item.category)}
    </span>
  `).join('');
}

function updateCharts(expBreakdown, incBreakdown) {
  const expCanvas = $('#expChart');
  const incCanvas = $('#incChart');
  const expData = buildChartData(expBreakdown, CHART_PALETTE_EXP);
  const incData = buildChartData(incBreakdown, CHART_PALETTE_INC);
  const expEmpty = $('#expEmpty');
  const incEmpty = $('#incEmpty');

  if (state.expChart) {
    state.expChart.destroy();
    state.expChart = null;
  }
  if (state.incChart) {
    state.incChart.destroy();
    state.incChart = null;
  }

  if (expData) {
    expEmpty.hidden = true;
    state.expChart = new Chart(expCanvas, {
      type: state.chartType === 'bar' ? 'bar' : 'doughnut',
      data: expData,
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 400 },
        plugins: { legend: { display: false } },
        indexAxis: state.chartType === 'bar' ? 'y' : undefined,
        scales: state.chartType === 'bar' ? {
          x: { ticks: { color: '#5c6180', font: { size: 10 } }, grid: { color: 'rgba(255,255,255,0.04)' } },
          y: { ticks: { color: '#9ea3c0', font: { size: 11 } }, grid: { display: false } }
        } : undefined,
        cutout: state.chartType === 'bar' ? 0 : '68%'
      }
    });
    renderLegend('expLegend', expBreakdown, CHART_PALETTE_EXP);
  } else {
    expEmpty.hidden = false;
    renderLegend('expLegend', [], CHART_PALETTE_EXP);
  }

  if (incData) {
    incEmpty.hidden = true;
    state.incChart = new Chart(incCanvas, {
      type: state.chartType === 'bar' ? 'bar' : 'doughnut',
      data: incData,
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 400 },
        plugins: { legend: { display: false } },
        indexAxis: state.chartType === 'bar' ? 'y' : undefined,
        scales: state.chartType === 'bar' ? {
          x: { ticks: { color: '#5c6180', font: { size: 10 } }, grid: { color: 'rgba(255,255,255,0.04)' } },
          y: { ticks: { color: '#9ea3c0', font: { size: 11 } }, grid: { display: false } }
        } : undefined,
        cutout: state.chartType === 'bar' ? 0 : '68%'
      }
    });
    renderLegend('incLegend', incBreakdown, CHART_PALETTE_INC);
  } else {
    incEmpty.hidden = false;
    renderLegend('incLegend', [], CHART_PALETTE_INC);
  }
}

function getBreakdown(type) {
  const totals = {};
  getVisibleTransactions().forEach((tx) => {
    if (tx.type !== type) return;
    totals[tx.category] = (totals[tx.category] || 0) + Number(tx.amount || 0);
  });

  return Object.entries(totals)
    .map(([category, total]) => ({ category, total }))
    .sort((a, b) => b.total - a.total);
}

function buildTxItemHTML(tx) {
  const emoji = CAT_EMOJI[tx.category] || '📌';
  const sign = tx.type === 'income' ? '+' : '-';
  const receiptBadge = tx.receipt_url ? `<a href="${esc(tx.receipt_url)}" target="_blank" rel="noopener" class="receipt-badge" title="View receipt">📎 Receipt</a>` : '';

  return `
    <div class="tx-item" role="listitem" id="txItem-${esc(tx.id)}">
      <div class="tx-accent ${esc(tx.type)}"></div>
      <div class="tx-emoji ${esc(tx.type)}">${emoji}</div>
      <div class="tx-info">
        <p class="tx-title">${esc(tx.title)}</p>
        <div class="tx-meta">
          <span class="tx-date">${fmtDate(getDateFromTx(tx))}</span>
          <span class="tx-cat">${esc(tx.category)}</span>
          ${receiptBadge}
        </div>
      </div>
      <div class="tx-right">
        <span class="tx-amount ${esc(tx.type)}">${sign}${fmt(tx.amount)}</span>
        <button class="tx-del-btn" data-id="${esc(tx.id)}" data-title="${esc(tx.title)}" aria-label="Delete ${esc(tx.title)}">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/>
          </svg>
        </button>
      </div>
    </div>
  `;
}

function renderTransactions(txs) {
  const list = $('#txList');
  const empty = $('#txEmpty');
  const count = $('#txCount');

  if (!txs.length) {
    list.hidden = true;
    empty.hidden = false;
    count.hidden = true;
    return;
  }

  list.hidden = false;
  empty.hidden = true;
  count.hidden = false;
  count.textContent = `${txs.length} transaction${txs.length === 1 ? '' : 's'}`;

  const groups = {};
  txs.forEach((tx) => {
    const iso = getDateFromTx(tx);
    if (!groups[iso]) groups[iso] = [];
    groups[iso].push(tx);
  });

  const sortedDates = Object.keys(groups).sort((a, b) => b.localeCompare(a));
  list.innerHTML = sortedDates.map((iso) => {
    const dayLabel = iso === todayISO() ? 'Today' : fmtDate(iso);
    const items = groups[iso].map(buildTxItemHTML).join('');
    return `
      <div class="tx-day-group">
        <p class="tx-day-label">${esc(dayLabel)}</p>
        ${items}
      </div>
    `;
  }).join('');

  list.querySelectorAll('.tx-del-btn').forEach((btn) => {
    btn.addEventListener('click', () => openDeleteModal(btn.dataset.id, btn.dataset.title));
  });
}

function updateCategories(type) {
  const select = $('#txCategory');
  const categories = type === 'income' ? INCOME_CATEGORIES : EXPENSE_CATEGORIES;
  const current = select.value;
  select.innerHTML = '<option value="">— Select —</option>' + categories.map((category) => `
    <option value="${esc(category)}" ${category === current ? 'selected' : ''}>${esc(category)}</option>
  `).join('');
}

function clearErrors() {
  $$('.field-error').forEach((el) => { el.textContent = ''; });
  $$('.form-input.error').forEach((el) => el.classList.remove('error'));
}

function setFieldError(fieldId, errId, msg) {
  const field = document.getElementById(fieldId);
  const err = document.getElementById(errId);
  if (field) field.classList.add('error');
  if (err) err.textContent = msg;
}

function setFormBusy(busy, label = 'Add Transaction') {
  const btn = $('#addTxBtn');
  const labelEl = $('#addTxBtnLabel');
  btn.disabled = busy;
  labelEl.innerHTML = busy ? '<span class="spinner"></span> Saving…' : label;
}

async function uploadReceipt(file) {
  if (!file) return null;

  const statusEl = $('#receiptStatus');
  statusEl.className = 'receipt-upload-status uploading';
  statusEl.textContent = '⏳ Preparing receipt…';
  statusEl.hidden = false;

  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => {
      statusEl.className = 'receipt-upload-status done';
      statusEl.textContent = '✅ Receipt attached locally';
      resolve(reader.result);
    };
    reader.onerror = () => {
      statusEl.className = 'receipt-upload-status error';
      statusEl.textContent = '❌ File could not be read';
      resolve(null);
    };
    reader.readAsDataURL(file);
  });
}

function renderDashboard() {
  renderSummary();
  updateCharts(getBreakdown('expense'), getBreakdown('income'));
  renderTransactions(getVisibleTransactions());
  $('#txSkeleton').hidden = true;
}

function saveAndRender() {
  saveTransactions();
  renderDashboard();
}

async function handleFormSubmit(event) {
  event.preventDefault();
  clearErrors();

  const type = $('input[name="txType"]:checked')?.value || 'expense';
  const title = $('#txTitle').value.trim();
  const amount = Number($('#txAmount').value);
  const category = $('#txCategory').value;
  const date = $('#txDate').value || todayISO();
  const file = $('#receiptInput').files[0] || null;

  let hasError = false;
  if (!title) { setFieldError('txTitle', 'titleErr', 'Description is required.'); hasError = true; }
  if (!amount || amount <= 0) { setFieldError('txAmount', 'amountErr', 'Enter a valid positive amount.'); hasError = true; }
  if (!category) { setFieldError('txCategory', 'catErr', 'Please select a category.'); hasError = true; }
  if (hasError) return;

  setFormBusy(true);
  const receiptUrl = await uploadReceipt(file);
  const tx = {
    id: (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : `tx-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    title,
    amount,
    type,
    category,
    date,
    created_at: new Date().toISOString(),
    receipt_url: receiptUrl
  };

  state.transactions = [tx, ...state.transactions];
  saveTransactions();
  renderDashboard();
  resetForm();
  $('#txTitle').focus();

  const successEl = $('#formSuccess');
  successEl.textContent = `✅ ${type === 'income' ? '+' : '-'}${fmt(amount)} — ${title}`;
  successEl.hidden = false;
  setTimeout(() => { successEl.hidden = true; }, 3000);

  showToast(`${type === 'income' ? '💚' : '🔴'} ${title} — ${fmt(amount)} saved`, 'success');
  setFormBusy(false);
}

function resetForm() {
  $('#txTitle').value = '';
  $('#txAmount').value = '';
  $('#txDate').value = todayISO();
  $('#txCategory').value = '';
  $('#receiptInput').value = '';
  $('#receiptFileName').textContent = 'Click or drag a receipt here';
  $('#receiptStatus').hidden = true;
  clearErrors();
}

function initForm() {
  $('#txDate').value = todayISO();
  updateCategories('expense');

  $$('.type-option').forEach((label) => {
    const input = label.querySelector('input');
    input.addEventListener('change', () => {
      $$('.type-option').forEach((item) => item.classList.remove('active'));
      label.classList.add('active');
      updateCategories(input.value);
    });
  });

  $('#receiptInput').addEventListener('change', (event) => {
    const file = event.target.files[0];
    $('#receiptFileName').textContent = file ? file.name : 'Click or drag a receipt here';
    $('#receiptStatus').hidden = true;
  });

  const zone = $('#fileDropZone');
  zone.addEventListener('dragover', (event) => {
    event.preventDefault();
    zone.classList.add('drag-over');
  });
  zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
  zone.addEventListener('drop', (event) => {
    event.preventDefault();
    zone.classList.remove('drag-over');
    const file = event.dataTransfer?.files[0];
    if (file) {
      const dt = new DataTransfer();
      dt.items.add(file);
      $('#receiptInput').files = dt.files;
      $('#receiptFileName').textContent = file.name;
      $('#receiptStatus').hidden = true;
    }
  });

  $('#txForm').addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && event.target.tagName !== 'TEXTAREA' && event.target.type !== 'submit') {
      event.preventDefault();
      if (!$('#addTxBtn').disabled) $('#txForm').requestSubmit();
    }
  });

  $('#txForm').addEventListener('submit', handleFormSubmit);
}

function openDeleteModal(id, title) {
  state.pendingDelId = id;
  $('#deleteModalMsg').textContent = `Are you sure you want to delete "${title}"?`;
  $('#deleteModal').hidden = false;
  $('#confirmDeleteBtn').focus();
}

function closeDeleteModal() {
  $('#deleteModal').hidden = true;
  state.pendingDelId = null;
}

function performDelete() {
  const id = state.pendingDelId;
  if (!id) return;
  closeDeleteModal();

  state.transactions = state.transactions.filter((tx) => tx.id !== id);
  saveTransactions();
  renderDashboard();
  showToast('Transaction deleted.', 'success');
}

function openBudgetModal() {
  $('#budgetInput').value = state.budgetLimit ? String(state.budgetLimit) : '';
  $('#budgetErr').textContent = '';
  $('#budgetModal').hidden = false;
  setTimeout(() => $('#budgetInput').focus(), 80);
}

function saveBudget() {
  const value = Number($('#budgetInput').value);
  if (Number.isNaN(value) || value < 0) {
    $('#budgetErr').textContent = 'Enter a valid amount.';
    return;
  }

  state.budgetLimit = Number(value.toFixed(2));
  saveTransactions();
  $('#budgetModal').hidden = true;
  renderDashboard();
  showToast(`Budget set to ${fmt(value)} / month ✅`, 'success');
}

function clearAll() {
  $('#clearModal').hidden = true;
  state.transactions = [];
  saveTransactions();
  renderDashboard();
  showToast('All transactions cleared.', 'success');
}

function initPeriodTabs() {
  $$('.period-tab').forEach((button) => {
    button.addEventListener('click', () => {
      $$('.period-tab').forEach((tab) => {
        tab.classList.remove('active');
        tab.setAttribute('aria-selected', 'false');
      });
      button.classList.add('active');
      button.setAttribute('aria-selected', 'true');
      state.period = button.dataset.period;
      renderDashboard();
    });
  });
}

function initChartToggle() {
  $('#btnDonut').addEventListener('click', () => {
    state.chartType = 'donut';
    $$('.chart-toggle-btn').forEach((button) => {
      button.classList.remove('active');
      button.setAttribute('aria-pressed', 'false');
    });
    $('#btnDonut').classList.add('active');
    $('#btnDonut').setAttribute('aria-pressed', 'true');
    renderDashboard();
  });

  $('#btnBar').addEventListener('click', () => {
    state.chartType = 'bar';
    $$('.chart-toggle-btn').forEach((button) => {
      button.classList.remove('active');
      button.setAttribute('aria-pressed', 'false');
    });
    $('#btnBar').classList.add('active');
    $('#btnBar').setAttribute('aria-pressed', 'true');
    renderDashboard();
  });
}

function initSearch() {
  let timeoutId;
  $('#searchInput').addEventListener('input', (event) => {
    state.searchQuery = event.target.value;
    clearTimeout(timeoutId);
    timeoutId = setTimeout(() => renderDashboard(), 150);
  });
}

function showToast(message, type = 'info', duration = 3500) {
  const container = $('#toastContainer');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `<span class="toast-dot"></span><span>${esc(message)}</span>`;
  container.appendChild(el);
  setTimeout(() => {
    el.classList.add('out');
    el.addEventListener('animationend', () => el.remove(), { once: true });
  }, duration);
}

function initModals() {
  $('#editBudgetBtn').addEventListener('click', openBudgetModal);
  $('#closeBudgetModal').addEventListener('click', () => { $('#budgetModal').hidden = true; });
  $('#cancelBudgetBtn').addEventListener('click', () => { $('#budgetModal').hidden = true; });
  $('#saveBudgetBtn').addEventListener('click', saveBudget);
  $('#budgetInput').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') saveBudget();
  });
  $$('.preset-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      $('#budgetInput').value = chip.dataset.v;
    });
  });

  $('#closeDeleteModal').addEventListener('click', closeDeleteModal);
  $('#cancelDeleteBtn').addEventListener('click', closeDeleteModal);
  $('#confirmDeleteBtn').addEventListener('click', performDelete);

  $('#clearAllBtn').addEventListener('click', () => { $('#clearModal').hidden = false; });
  $('#closeClearModal').addEventListener('click', () => { $('#clearModal').hidden = true; });
  $('#cancelClearBtn').addEventListener('click', () => { $('#clearModal').hidden = true; });
  $('#confirmClearBtn').addEventListener('click', clearAll);

  $$('.modal-overlay').forEach((overlay) => {
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) overlay.hidden = true;
    });
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      $$('.modal-overlay').forEach((mod) => { mod.hidden = true; });
    }
  });
}

function exportData() {
  const data = {
    version: 1,
    exported_at: new Date().toISOString(),
    transactions: state.transactions,
    budget_limit: state.budgetLimit
  };

  const json = JSON.stringify(data, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `husaini-ledger-backup-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);

  showToast('📥 Data exported successfully!', 'success');
}

function importData() {
  const fileInput = $('#importFileInput');
  fileInput.click();
}

function handleImportFile(event) {
  const file = event.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const data = JSON.parse(e.target.result);
      
      if (!Array.isArray(data.transactions)) {
        showToast('❌ Invalid file format: missing transactions', 'error');
        return;
      }

      const count = data.transactions.length;
      state.transactions = data.transactions;
      if (data.budget_limit !== undefined) {
        state.budgetLimit = data.budget_limit;
      }

      saveTransactions();
      renderDashboard();
      showToast(`✅ Imported ${count} transaction${count === 1 ? '' : 's'} successfully!`, 'success');
    } catch (err) {
      showToast('❌ Failed to import: invalid JSON file', 'error');
      console.error('Import error:', err);
    }
  };

  reader.onerror = () => {
    showToast('❌ Failed to read file', 'error');
  };

  reader.readAsText(file);
  event.target.value = '';
}

function init() {
  loadTransactions();
  initPeriodTabs();
  initChartToggle();
  initModals();
  initSearch();
  initForm();
  
  // Export/Import data backup
  $('#exportDataBtn').addEventListener('click', exportData);
  $('#importDataBtn').addEventListener('click', importData);
  $('#importFileInput').addEventListener('change', handleImportFile);
  
  renderDashboard();
}

document.addEventListener('DOMContentLoaded', init);
