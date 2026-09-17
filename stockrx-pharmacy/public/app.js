let token = localStorage.getItem('token');
let user = JSON.parse(localStorage.getItem('user') || 'null');
let medState = { page: 1, sort: 'name', dir: 'asc' };
let batchState = { page: 1, sort: 'expiry_date', dir: 'asc' };
let medicinesCache = [];

function api(path, opts = {}) {
  opts.headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
  if (token) opts.headers.Authorization = 'Bearer ' + token;
  return fetch(path, opts).then(async r => {
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || 'Request failed');
    return data;
  });
}

function showMsg(elId, text, ok = true) {
  const el = document.getElementById(elId);
  el.innerHTML = `<div class="msg ${ok ? 'ok' : 'err'}">${text}</div>`;
  setTimeout(() => { el.innerHTML = ''; }, 5000);
}

function renderAuth() {
  if (token && user) {
    document.getElementById('authView').style.display = 'none';
    document.getElementById('mainView').style.display = 'block';
    document.getElementById('userBox').innerHTML = `<span style="margin-right:14px">Hi, ${user.name}</span><button class="secondary" onclick="logout()">Logout</button>`;
    bootstrap();
  } else {
    document.getElementById('authView').style.display = 'block';
    document.getElementById('mainView').style.display = 'none';
    document.getElementById('userBox').innerHTML = '';
  }
}

function logout() {
  token = null; user = null;
  localStorage.removeItem('token'); localStorage.removeItem('user');
  renderAuth();
}

document.querySelectorAll('[data-auth]').forEach(t => {
  t.onclick = () => {
    document.querySelectorAll('[data-auth]').forEach(x => x.classList.remove('active'));
    t.classList.add('active');
    document.getElementById('loginForm').style.display = t.dataset.auth === 'login' ? 'block' : 'none';
    document.getElementById('registerForm').style.display = t.dataset.auth === 'register' ? 'block' : 'none';
  };
});

document.getElementById('loginForm').onsubmit = async (e) => {
  e.preventDefault();
  try {
    const data = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({
      email: document.getElementById('loginEmail').value,
      password: document.getElementById('loginPassword').value,
    })});
    token = data.token; user = data.user;
    localStorage.setItem('token', token); localStorage.setItem('user', JSON.stringify(user));
    renderAuth();
  } catch (err) { showMsg('authMsg', err.message, false); }
};

document.getElementById('registerForm').onsubmit = async (e) => {
  e.preventDefault();
  try {
    const data = await api('/api/auth/register', { method: 'POST', body: JSON.stringify({
      name: document.getElementById('regName').value,
      email: document.getElementById('regEmail').value,
      password: document.getElementById('regPassword').value,
    })});
    token = data.token; user = data.user;
    localStorage.setItem('token', token); localStorage.setItem('user', JSON.stringify(user));
    renderAuth();
  } catch (err) { showMsg('authMsg', err.message, false); }
};

document.querySelectorAll('[data-panel]').forEach(t => {
  t.onclick = () => {
    document.querySelectorAll('[data-panel]').forEach(x => x.classList.remove('active'));
    document.querySelectorAll('.panel').forEach(x => x.classList.remove('active'));
    t.classList.add('active');
    document.getElementById('panel-' + t.dataset.panel).classList.add('active');
    if (t.dataset.panel === 'outbox') loadOutbox();
  };
});

async function bootstrap() {
  await loadMedicines(1);
  await loadBatches(1);
}

// ---------- medicines ----------
async function loadMedicines(page) {
  medState.page = page || medState.page;
  const search = document.getElementById('medSearch').value;
  const data = await api(`/api/medicines?search=${encodeURIComponent(search)}&page=${medState.page}&sort=${medState.sort}&dir=${medState.dir}`);
  medicinesCache = data.data;
  document.getElementById('medTable').innerHTML = data.data.map(m => `
    <tr><td>${m.name}</td><td>${m.reorder_level}</td><td>${m.in_date_stock}</td>
    <td>${m.in_date_stock > 0 ? '✅ Yes' : '❌ No'}</td></tr>`).join('') || '<tr><td colspan=4>No medicines yet</td></tr>';
  const totalPages = Math.max(1, Math.ceil(data.total / data.pageSize));
  document.getElementById('medPager').innerHTML = `
    <button class="secondary" ${medState.page<=1?'disabled':''} onclick="loadMedicines(${medState.page-1})">Prev</button>
    <span>Page ${medState.page} / ${totalPages}</span>
    <button class="secondary" ${medState.page>=totalPages?'disabled':''} onclick="loadMedicines(${medState.page+1})">Next</button>`;
  refreshMedicineDropdowns(data.data);
}
function sortMed(col) {
  medState.dir = (medState.sort === col && medState.dir === 'asc') ? 'desc' : 'asc';
  medState.sort = col;
  loadMedicines(1);
}
async function addMedicine() {
  const name = document.getElementById('medName').value.trim();
  const reorder_level = parseInt(document.getElementById('medReorder').value) || 10;
  if (!name) return;
  try {
    await api('/api/medicines', { method: 'POST', body: JSON.stringify({ name, reorder_level }) });
    document.getElementById('medName').value = '';
    showMsg('globalMsg', 'Medicine added.');
    loadMedicines(1);
  } catch (err) { showMsg('globalMsg', err.message, false); }
}

function refreshMedicineDropdowns(all) {
  const opts = all.map(m => `<option value="${m.id}">${m.name}</option>`).join('');
  ['batchMedId', 'dispenseMedId'].forEach(id => {
    const el = document.getElementById(id);
    const cur = el.value;
    el.innerHTML = opts;
    if (cur) el.value = cur;
  });
  const filterEl = document.getElementById('batchFilterMed');
  filterEl.innerHTML = '<option value="">All medicines</option>' + opts;
}

// ---------- batches ----------
async function loadBatches(page) {
  batchState.page = page || batchState.page;
  const medId = document.getElementById('batchFilterMed').value;
  const status = document.getElementById('batchFilterStatus').value;
  let url = `/api/batches?page=${batchState.page}&sort=${batchState.sort}&dir=${batchState.dir}`;
  if (medId) url += `&medicine_id=${medId}`;
  if (status) url += `&status=${status}`;
  const data = await api(url);
  document.getElementById('batchTable').innerHTML = data.data.map(b => `
    <tr><td>${b.batch_no}</td><td>${b.medicine_name}</td><td>${b.quantity}</td><td>${b.expiry_date}</td>
    <td><span class="badge ${b.status}">${b.status}</span>${b.flagged ? '<span class="badge flag">expiring soon</span>' : ''}</td></tr>`
  ).join('') || '<tr><td colspan=5>No batches yet</td></tr>';
  const totalPages = Math.max(1, Math.ceil(data.total / data.pageSize));
  document.getElementById('batchPager').innerHTML = `
    <button class="secondary" ${batchState.page<=1?'disabled':''} onclick="loadBatches(${batchState.page-1})">Prev</button>
    <span>Page ${batchState.page} / ${totalPages}</span>
    <button class="secondary" ${batchState.page>=totalPages?'disabled':''} onclick="loadBatches(${batchState.page+1})">Next</button>`;
}
function sortBatch(col) {
  batchState.dir = (batchState.sort === col && batchState.dir === 'asc') ? 'desc' : 'asc';
  batchState.sort = col;
  loadBatches(1);
}
async function addBatch() {
  const medicine_id = document.getElementById('batchMedId').value;
  const batch_no = document.getElementById('batchNo').value.trim();
  const quantity = parseInt(document.getElementById('batchQty').value);
  const expiry_date = document.getElementById('batchExpiry').value;
  if (!medicine_id || !batch_no || !quantity || !expiry_date) return showMsg('globalMsg', 'Fill all batch fields.', false);
  try {
    await api('/api/batches', { method: 'POST', body: JSON.stringify({ medicine_id, batch_no, quantity, expiry_date }) });
    showMsg('globalMsg', 'Batch added.');
    document.getElementById('batchNo').value = ''; document.getElementById('batchQty').value = '';
    loadBatches(1); loadMedicines(medState.page);
  } catch (err) { showMsg('globalMsg', err.message, false); }
}

// ---------- dispense ----------
async function doDispense() {
  const medicine_id = document.getElementById('dispenseMedId').value;
  const quantity = parseInt(document.getElementById('dispenseQty').value);
  if (!medicine_id || !quantity) return;
  try {
    const data = await api('/api/dispense', { method: 'POST', body: JSON.stringify({ medicine_id, quantity }) });
    document.getElementById('dispenseResult').innerHTML = `<div class="msg ok">Dispensed ${data.dispensed} units from: ${data.from_batches.map(b => `${b.batch_no} (${b.taken}, exp ${b.expiry_date})`).join(', ')}</div>`;
    loadBatches(batchState.page); loadMedicines(medState.page);
  } catch (err) {
    document.getElementById('dispenseResult').innerHTML = `<div class="msg err">${err.message}</div>`;
  }
}

// ---------- import ----------
async function doImport() {
  let rows;
  try { rows = JSON.parse(document.getElementById('importData').value); }
  catch { return showMsg('importResult', 'Invalid JSON.', false); }
  try {
    const data = await api('/api/import', { method: 'POST', body: JSON.stringify({ rows }) });
    document.getElementById('importResult').innerHTML = `<div class="msg ok">Imported: ${data.imported}, Deduped: ${data.deduped}, Rejected: ${data.rejected}</div>
      ${data.rejectedDetails.length ? '<pre style="font-size:12px;white-space:pre-wrap">' + JSON.stringify(data.rejectedDetails, null, 2) + '</pre>' : ''}`;
    loadMedicines(1); loadBatches(1);
  } catch (err) { showMsg('importResult', err.message, false); }
}

// ---------- clock ----------
async function setClock() {
  const date = document.getElementById('clockDate').value;
  if (!date) return;
  try {
    const r = await fetch('/clock', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ date }) });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error);
    document.getElementById('clockResult').innerHTML = `<div class="msg ok">Clock set to ${data.current_date}. Quarantined: ${data.quarantined}. Flagged expiring soon: ${data.flagged_expiring_soon}.</div>`;
    loadMedicines(1); loadBatches(1);
  } catch (err) { document.getElementById('clockResult').innerHTML = `<div class="msg err">${err.message}</div>`; }
}

// ---------- outbox ----------
async function loadOutbox() {
  const r = await fetch('/outbox');
  const data = await r.json();
  document.getElementById('outboxTable').innerHTML = data.data.map(o => `
    <tr><td>${o.medicine_name}</td><td>${o.message}</td><td>${o.in_date_stock}</td><td>${o.reorder_level}</td><td>${o.created_at}</td></tr>
  `).join('') || '<tr><td colspan=5>No notifications yet</td></tr>';
}

// ---------- search ----------
let searchTimer;
async function doSearch() {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(async () => {
    const q = document.getElementById('searchQ').value;
    const data = await api('/api/search?q=' + encodeURIComponent(q));
    document.getElementById('searchMed').innerHTML = data.medicines.map(m => `<tr><td>${m.name}</td><td>reorder: ${m.reorder_level}</td></tr>`).join('');
    document.getElementById('searchBatch').innerHTML = data.batches.map(b => `<tr><td>${b.batch_no}</td><td>${b.medicine_name}</td><td>${b.quantity}</td><td>${b.expiry_date}</td></tr>`).join('');
  }, 250);
}

renderAuth();
