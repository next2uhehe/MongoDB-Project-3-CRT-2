'use strict';

const API = '/api';
let token = localStorage.getItem('libraflow_token') || '';
let currentUser = null;
let bookCache = [];
let memberCache = [];
let dashboardCache = null;
const byId = id => document.getElementById(id);
const isStaff = () => ['admin', 'librarian'].includes(currentUser?.role);
const isMember = () => currentUser?.role === 'member';
const money = value => `₹${Number(value || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
const dateText = value => value ? new Date(value).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '—';
const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

async function api(path, options = {}) {
  const headers = { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`${API}${path}`, { ...options, headers });
  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('text/csv')) {
    if (!response.ok) throw new Error('Unable to download the report.');
    return response;
  }
  const data = await response.json().catch(() => ({}));
  if (response.status === 401) {
    logout(false);
    throw new Error(data.error || 'Please sign in again.');
  }
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status}).`);
  return data;
}

function toast(message, type = 'success') {
  const region = byId('toastRegion');
  if (!region) return;
  const item = document.createElement('div');
  item.className = `toast ${type}`;
  item.textContent = message;
  region.appendChild(item);
  window.setTimeout(() => item.remove(), 3600);
}
function setMessage(id, message, success = false) {
  const node = byId(id);
  if (!node) return;
  node.textContent = message || '';
  node.classList.toggle('success', Boolean(success));
}
function emptyRow(columns, message) { return `<tr><td colspan="${columns}" class="empty-cell">${esc(message)}</td></tr>`; }
function statusPill(status) {
  const cls = status === 'Issued' || status === 'Ready' ? 'pill-blue' : status === 'Returned' || status === 'Fulfilled' ? 'pill-green' : status === 'Waiting' ? 'pill-amber' : 'pill-gray';
  return `<span class="pill ${cls}">${esc(status)}</span>`;
}

function showApp() {
  byId('loginView').classList.add('hidden');
  byId('appView').classList.remove('hidden');
  const name = currentUser?.name || 'Library user';
  byId('userName').textContent = name;
  byId('userRole').textContent = currentUser?.role === 'member' ? 'Library member' : (currentUser?.role === 'librarian' ? 'Librarian' : 'Administrator');
  byId('userAvatar').textContent = name.split(/\s+/).map(part => part[0]).slice(0, 2).join('').toUpperCase();
  byId('todayLabel').textContent = new Date().toLocaleDateString('en-IN', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' });
  document.querySelectorAll('[data-role="staff"]').forEach(node => node.classList.toggle('hidden', !isStaff()));
  document.querySelectorAll('[data-role="member"]').forEach(node => node.classList.toggle('hidden', !isMember()));
}
function logout(showToast = true) {
  token = '';
  currentUser = null;
  localStorage.removeItem('libraflow_token');
  byId('appView').classList.add('hidden');
  byId('loginView').classList.remove('hidden');
  byId('loginPassword').value = '';
  if (showToast) toast('You have signed out.', 'success');
}

const pageMeta = {
  dashboard: ['Library overview', 'A clear view of the library collection and circulation.'],
  books: ['Book catalogue', 'Discover titles and check current availability.'],
  members: ['Library members', 'Manage membership records and secure portal access.'],
  circulation: ['Issue & return desk', 'Manage active loans, returns, due dates and fines.'],
  reservations: ['Reservations & waitlist', 'Manage requests for books that are currently unavailable.'],
  reports: ['Reports & insights', 'Review circulation patterns and database health.'],
  'my-library': ['My library', 'Your personal borrowing overview.'],
  'my-loans': ['My borrowing history', 'Your issued and returned books, due dates and fines.'],
  'my-reservations': ['My reservations', 'Track requests placed from your library account.'],
};
const pageLoaders = {
  dashboard: loadDashboard,
  books: loadBooks,
  members: loadMembers,
  circulation: loadCirculation,
  reservations: loadReservations,
  reports: loadReports,
  'my-library': loadMyLibrary,
  'my-loans': loadMyLoans,
  'my-reservations': loadMyReservations,
};
function pageAllowed(page) {
  return isStaff() ? ['dashboard', 'books', 'members', 'circulation', 'reservations', 'reports'].includes(page)
    : isMember() && ['books', 'my-library', 'my-loans', 'my-reservations'].includes(page);
}
function switchPage(page) {
  if (!pageMeta[page] || !pageAllowed(page)) page = isStaff() ? 'dashboard' : 'my-library';
  document.querySelectorAll('.page').forEach(section => section.classList.toggle('active-page', section.id === `page-${page}`));
  document.querySelectorAll('.nav-link').forEach(link => link.classList.toggle('active', link.dataset.page === page));
  byId('pageTitle').textContent = pageMeta[page][0];
  byId('pageSubtitle').textContent = pageMeta[page][1];
  byId('breadcrumbPage').textContent = pageMeta[page][0];
  const quickAdd = byId('quickAddBook');
  if (quickAdd) quickAdd.classList.toggle('hidden', !isStaff() || page !== 'dashboard');
  const loader = pageLoaders[page];
  if (loader) loader().catch(error => toast(error.message, 'error'));
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function renderCategoryChart(items, target) {
  const node = byId(target);
  if (!node) return;
  if (!items?.length) { node.innerHTML = '<div class="empty-state">No category data available.</div>'; return; }
  const max = Math.max(...items.map(item => item.titles), 1);
  node.innerHTML = items.map(item => `<div class="category-row"><span class="category-name" title="${esc(item._id)}">${esc(item._id || 'Uncategorised')}</span><div class="bar-track"><div class="bar-fill" style="width:${Math.max(4, item.titles / max * 100)}%"></div></div><span class="category-value">${item.titles}</span></div>`).join('');
}

async function loadDashboard() {
  const data = await api('/dashboard');
  dashboardCache = data;
  byId('statBooks').textContent = data.stats.totalBooks.toLocaleString('en-IN');
  byId('statMembers').textContent = data.stats.totalMembers.toLocaleString('en-IN');
  byId('statLoans').textContent = data.stats.activeLoans.toLocaleString('en-IN');
  byId('statOverdue').textContent = data.stats.overdueLoans.toLocaleString('en-IN');
  byId('navBooks').textContent = data.stats.totalBooks;
  renderCategoryChart(data.categoryStats, 'categoryChart');
  byId('popularBooks').innerHTML = data.popularBooks.length ? data.popularBooks.map((book, index) => `<div class="popular-item"><div class="book-mini">${index + 1}</div><div class="popular-copy"><strong>${esc(book.title || 'Book')}</strong><small>Borrowing activity</small></div><span class="popular-count">${book.issueCount} loans</span></div>`).join('') : '<div class="empty-state">No borrowing history yet.</div>';
  byId('recentTransactions').innerHTML = data.recent.length ? data.recent.map(row => `<tr><td><div class="book-cell"><strong>${esc(row.bookTitle)}</strong><small>${esc(row.bookIsbn)}</small></div></td><td>${esc(row.memberName)}</td><td>${dateText(row.issueDate)}</td><td>${dateText(row.dueDate)}</td><td>${statusPill(row.status)}</td></tr>`).join('') : emptyRow(5, 'No transactions yet. Issue your first book.');
}

async function loadBooks() {
  const params = new URLSearchParams();
  const search = byId('bookSearch').value.trim();
  const category = byId('bookCategory').value || 'All';
  if (search) params.set('search', search);
  if (category) params.set('category', category);
  const data = await api(`/books?${params}`);
  bookCache = data.items;
  byId('bookCategory').innerHTML = `<option value="All">All categories</option>${data.categories.map(item => `<option value="${esc(item)}">${esc(item)}</option>`).join('')}`;
  byId('bookCategory').value = data.categories.includes(category) ? category : 'All';
  byId('bookCount').textContent = `${data.items.length} title${data.items.length === 1 ? '' : 's'}`;
  byId('booksTable').innerHTML = data.items.length ? data.items.map(book => {
    const actions = isStaff()
      ? `<div class="action-group"><button class="mini-action" data-edit-book="${book._id}" type="button">Edit</button><button class="mini-action danger" data-delete-book="${book._id}" type="button">Delete</button></div>`
      : (book.availableCopies > 0 ? '<span class="muted">Visit library desk</span>' : `<button class="mini-action" data-student-reserve="${book._id}" type="button">Reserve</button>`);
    return `<tr><td><div class="book-cell"><strong>${esc(book.title)}</strong><small>${esc(book.author)}</small></div></td><td>${esc(book.isbn)}</td><td>${esc(book.category)}</td><td>${esc(book.shelf || '—')}</td><td>${book.availableCopies}/${book.totalCopies}</td><td>${book.availableCopies > 0 ? '<span class="pill pill-green">Available</span>' : '<span class="pill pill-red">Out of stock</span>'}</td><td>${actions}</td></tr>`;
  }).join('') : emptyRow(7, 'No books match this search.');
  if (isStaff()) refreshSelectOptions();
}
function openBookForm(book = null) {
  byId('bookForm').reset();
  byId('bookEditId').value = book?._id || '';
  byId('bookFormTitle').textContent = book ? 'Edit book details' : 'Add a book';
  byId('bookIsbn').value = book?.isbn || '';
  byId('bookIsbn').disabled = Boolean(book);
  byId('bookTitle').value = book?.title || '';
  byId('bookAuthor').value = book?.author || '';
  byId('bookCategoryInput').value = book?.category || '';
  byId('bookPublisher').value = book?.publisher || '';
  byId('bookShelf').value = book?.shelf || '';
  byId('bookCopies').value = book?.totalCopies ?? 1;
  byId('bookDescription').value = book?.description || '';
  byId('bookFormWrap').classList.remove('hidden');
  byId('bookFormWrap').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
async function saveBook(event) {
  event.preventDefault();
  const id = byId('bookEditId').value;
  const payload = { isbn: byId('bookIsbn').value.trim(), title: byId('bookTitle').value.trim(), author: byId('bookAuthor').value.trim(), category: byId('bookCategoryInput').value, publisher: byId('bookPublisher').value.trim(), shelf: byId('bookShelf').value.trim(), totalCopies: Number(byId('bookCopies').value), description: byId('bookDescription').value.trim() };
  try {
    if (id) { delete payload.isbn; await api(`/books/${id}`, { method: 'PUT', body: JSON.stringify(payload) }); }
    else await api('/books', { method: 'POST', body: JSON.stringify(payload) });
    byId('bookFormWrap').classList.add('hidden');
    toast(id ? 'Book updated.' : 'Book added.');
    await loadBooks();
    if (isStaff()) await loadDashboard();
  } catch (error) { setMessage('bookFormMessage', error.message); }
}
async function deleteBook(id) {
  if (!confirm('Delete this title from the catalogue?')) return;
  try { const result = await api(`/books/${id}`, { method: 'DELETE' }); toast(result.message); await loadBooks(); await loadDashboard(); }
  catch (error) { toast(error.message, 'error'); }
}
async function reserveForCurrentMember(bookId) {
  if (!confirm('This title is currently unavailable. Join its reservation queue?')) return;
  try {
    const result = await api('/me/reservations', { method: 'POST', body: JSON.stringify({ bookId }) });
    toast(result.message);
    await loadBooks();
    await loadMyReservations();
  } catch (error) { toast(error.message, 'error'); }
}

async function loadMembers() {
  const search = encodeURIComponent(byId('memberSearch').value.trim());
  const data = await api(`/members?search=${search}`);
  memberCache = data.items;
  byId('memberCount').textContent = `${data.items.length} member${data.items.length === 1 ? '' : 's'}`;
  byId('membersTable').innerHTML = data.items.length ? data.items.map(member => `<tr><td><div class="book-cell"><strong>${esc(member.name)}</strong><small>${esc(member.email)}</small></div></td><td>${esc(member.memberCode)}</td><td>${esc(member.branch || '—')}</td><td>${member.semester || '—'}</td><td>${member.hasPortalAccess ? '<span class="pill pill-green">Enabled</span>' : '<span class="pill pill-amber">Password not set</span>'}</td><td>${member.status === 'Active' ? '<span class="pill pill-green">Active</span>' : '<span class="pill pill-gray">Inactive</span>'}</td><td><div class="action-group"><button class="mini-action" data-edit-member="${member._id}" type="button">Edit / reset access</button><button class="mini-action danger" data-delete-member="${member._id}" type="button">Delete</button></div></td></tr>`).join('') : emptyRow(7, 'No members match this search.');
  refreshSelectOptions();
}
function openMemberForm(member = null) {
  byId('memberForm').reset();
  byId('memberEditId').value = member?._id || '';
  byId('memberFormTitle').textContent = member ? 'Update member access' : 'Register a member';
  byId('memberCode').value = member?.memberCode || '';
  byId('memberCode').disabled = Boolean(member);
  byId('memberName').value = member?.name || '';
  byId('memberEmail').value = member?.email || '';
  byId('memberPhone').value = member?.phone || '';
  byId('memberBranch').value = member?.branch || '';
  byId('memberSemester').value = member?.semester || '';
  byId('memberStatusWrap').classList.toggle('hidden', !member);
  if (member) byId('memberStatus').value = member.status || 'Active';
  byId('memberPassword').required = !member;
  byId('memberPassword').value = '';
  byId('memberPasswordLabel').firstChild.textContent = member ? 'Reset portal password (optional)' : 'Initial portal password *';
  byId('memberPassword').placeholder = member ? 'Leave blank to keep current password' : 'At least 12 characters';
  byId('memberFormWrap').classList.remove('hidden');
  byId('memberFormWrap').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
async function saveMember(event) {
  event.preventDefault();
  const id = byId('memberEditId').value;
  const password = byId('memberPassword').value;
  const payload = { memberCode: byId('memberCode').value.trim(), name: byId('memberName').value.trim(), email: byId('memberEmail').value.trim(), phone: byId('memberPhone').value.trim(), branch: byId('memberBranch').value.trim(), semester: byId('memberSemester').value ? Number(byId('memberSemester').value) : null };
  if (password) payload.password = password;
  if (id) { delete payload.memberCode; payload.status = byId('memberStatus').value; }
  try {
    if (id) await api(`/members/${id}`, { method: 'PUT', body: JSON.stringify(payload) });
    else await api('/members', { method: 'POST', body: JSON.stringify(payload) });
    byId('memberFormWrap').classList.add('hidden');
    byId('memberPassword').value = '';
    toast(id ? (password ? 'Member updated and password reset.' : 'Member updated.') : 'Member and portal account created.');
    await loadMembers();
    await loadDashboard();
  } catch (error) { setMessage('memberFormMessage', error.message); }
}
async function deleteMember(id) {
  if (!confirm('Delete this member account? A member with active loans or reservations cannot be deleted.')) return;
  try { const result = await api(`/members/${id}`, { method: 'DELETE' }); toast(result.message); await loadMembers(); await loadDashboard(); }
  catch (error) { toast(error.message, 'error'); }
}

function refreshSelectOptions() {
  const available = bookCache.filter(book => book.availableCopies > 0);
  const unavailable = bookCache.filter(book => book.availableCopies <= 0);
  const activeMembers = memberCache.filter(member => member.status === 'Active');
  const makeOptions = (items, label, kind) => `<option value="">${label}</option>${items.map(item => `<option value="${item._id}">${esc(item.title || item.name)}${kind === 'member' ? ` · ${esc(item.memberCode)}` : ` · ${item.availableCopies} available`}</option>`).join('')}`;
  if (byId('issueBook')) byId('issueBook').innerHTML = makeOptions(available, 'Choose an available book', 'book');
  if (byId('issueMember')) byId('issueMember').innerHTML = makeOptions(activeMembers, 'Choose a member', 'member');
  if (byId('reservationBook')) byId('reservationBook').innerHTML = makeOptions(unavailable, 'Choose an unavailable book', 'book');
  if (byId('reservationMember')) byId('reservationMember').innerHTML = makeOptions(activeMembers, 'Choose a member', 'member');
}

async function loadCirculation() {
  const [books, members, transactions] = await Promise.all([api('/books'), api('/members'), api(`/transactions?status=${encodeURIComponent(byId('transactionFilter').value)}`)]);
  bookCache = books.items; memberCache = members.items; refreshSelectOptions();
  byId('loanDaysLabel').textContent = transactions.loanDays;
  byId('fineRate').textContent = `${money(transactions.finePerDay)} / day`;
  const availableCopies = books.items.reduce((sum, item) => sum + Number(item.availableCopies || 0), 0);
  const active = transactions.items.filter(item => item.status === 'Issued');
  byId('availableCopies').textContent = availableCopies;
  byId('activeLoans').textContent = active.length;
  byId('overdueLoans').textContent = active.filter(item => item.overdueDays > 0).length;
  byId('transactionsTable').innerHTML = transactions.items.length ? transactions.items.map(row => {
    const fine = row.estimatedFine || row.fineAmount || 0;
    const action = row.status === 'Issued' ? `<button class="mini-action" data-return="${row._id}" type="button">Return</button>` : (fine && !row.finePaid ? `<button class="mini-action" data-pay-fine="${row._id}" type="button">Mark fine paid</button>` : '—');
    return `<tr><td><div class="book-cell"><strong>${esc(row.bookTitle)}</strong><small>${esc(row.bookIsbn)}</small></div></td><td><div class="book-cell"><strong>${esc(row.memberName)}</strong><small>${esc(row.memberCode)}</small></div></td><td>${dateText(row.issueDate)}</td><td>${dateText(row.dueDate)} ${row.overdueDays ? '<span class="pill pill-red">Overdue</span>' : ''}</td><td>${fine ? `${money(fine)} ${row.finePaid ? '<span class="pill pill-green">Paid</span>' : '<span class="pill pill-amber">Unpaid</span>'}` : '—'}</td><td>${dateText(row.returnDate)}</td><td>${statusPill(row.status)}</td><td>${action}</td></tr>`;
  }).join('') : emptyRow(8, 'No transactions match this filter.');
}
async function issueBook(event) {
  event.preventDefault();
  try {
    const result = await api('/transactions/issue', { method: 'POST', body: JSON.stringify({ bookId: byId('issueBook').value, memberId: byId('issueMember').value, dueDate: byId('issueDueDate').value || undefined }) });
    setMessage('issueMessage', result.message, true);
    toast('Book issued successfully.');
    byId('issueForm').reset();
    await loadCirculation(); await loadBooks(); await loadDashboard();
  } catch (error) { setMessage('issueMessage', error.message); }
}
async function returnBook(id) {
  if (!confirm('Confirm that this book has been returned?')) return;
  try { const result = await api(`/transactions/${id}/return`, { method: 'POST', body: '{}' }); toast(result.message); await loadCirculation(); await loadReservations(); await loadBooks(); await loadDashboard(); }
  catch (error) { toast(error.message, 'error'); }
}
async function payFine(id) {
  if (!confirm('Mark this late-return fine as paid?')) return;
  try { const result = await api(`/transactions/${id}/pay-fine`, { method: 'POST', body: '{}' }); toast(result.message); await loadCirculation(); await loadReports(); }
  catch (error) { toast(error.message, 'error'); }
}
async function loadReservations() {
  const [books, members, reservations] = await Promise.all([api('/books'), api('/members'), api('/reservations')]);
  bookCache = books.items; memberCache = members.items; refreshSelectOptions();
  byId('reservationsTable').innerHTML = reservations.items.length ? reservations.items.map(row => `<tr><td><strong>${esc(row.bookTitle)}</strong></td><td>${esc(row.memberName)}</td><td>${esc(row.memberCode)}</td><td>${dateText(row.createdAt)}</td><td>${dateText(row.pickupBy)}</td><td>${statusPill(row.status)}</td><td><button class="mini-action danger" data-cancel-reservation="${row._id}" type="button">Cancel</button></td></tr>`).join('') : emptyRow(7, 'No active reservations.');
}
async function createReservation(event) {
  event.preventDefault();
  try { const result = await api('/reservations', { method: 'POST', body: JSON.stringify({ bookId: byId('reservationBook').value, memberId: byId('reservationMember').value }) }); setMessage('reservationMessage', result.message, true); toast('Reservation created.'); byId('reservationForm').reset(); await loadReservations(); }
  catch (error) { setMessage('reservationMessage', error.message); }
}
async function cancelReservation(id) {
  if (!confirm('Cancel this reservation?')) return;
  try { const result = await api(`/reservations/${id}/cancel`, { method: 'POST', body: '{}' }); toast(result.message); await loadReservations(); await loadDashboard(); }
  catch (error) { toast(error.message, 'error'); }
}
async function loadReports() {
  const data = await api('/reports/summary');
  byId('reportFineTotal').textContent = money(data.fines.total);
  byId('reportFinePaid').textContent = money(data.fines.paid);
  byId('reportUnpaid').textContent = data.fines.unpaidCount;
  byId('reportTopBook').textContent = dashboardCache?.popularBooks?.[0]?.title || '—';
  if (data.monthly.length) {
    const max = Math.max(...data.monthly.map(item => item.issues), 1);
    byId('monthlyChart').innerHTML = data.monthly.map(item => `<div class="month-bar-wrap"><span class="month-value">${item.issues}</span><div class="month-bar" style="height:${Math.max(5, item.issues / max * 130)}px"></div><span class="month-label">${esc(item._id)}</span></div>`).join('');
  } else byId('monthlyChart').innerHTML = '<div class="empty-state">No circulation activity yet.</div>';
  byId('reportCategories').innerHTML = data.categories.length ? data.categories.map(item => `<div class="report-category"><span>${esc(item._id)}</span><strong>${item.titles} titles · ${item.copies} copies</strong></div>`).join('') : '<div class="empty-state">No categories available.</div>';
  byId('topMembers').innerHTML = data.topMembers.length ? data.topMembers.map((member, index) => `<div class="popular-item"><div class="book-mini">${index + 1}</div><div class="popular-copy"><strong>${esc(member.memberName)}</strong><small>${esc(member.memberCode)}</small></div><span class="popular-count">${member.borrowed} loans</span></div>`).join('') : '<div class="empty-state">No borrowing history yet.</div>';
}
async function downloadCsv(event) {
  event.preventDefault();
  try { const response = await api('/reports/export.csv'); const blob = await response.blob(); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = 'library-transactions.csv'; a.click(); URL.revokeObjectURL(url); }
  catch (error) { toast(error.message, 'error'); }
}
async function systemAction(kind) {
  const output = byId('systemOutput'); output.textContent = 'Loading diagnostic information…';
  try {
    if (kind === 'indexes') {
      const data = await api('/system/indexes');
      const names = Object.entries(data.indexes).map(([collection, indexes]) => `${collection}: ${indexes.map(item => item.name).join(', ')}`).join('\n');
      const stats = data.sampleQuery?.executionStats;
      output.textContent = `${names}\n\nSample query execution:\n${stats ? `Documents examined: ${stats.totalDocsExamined}\nKeys examined: ${stats.totalKeysExamined}\nExecution time: ${stats.executionTimeMillis} ms` : 'No sample book available yet.'}`;
    } else if (kind === 'replication') {
      const data = await api('/system/replication');
      output.textContent = `${data.message}\nReplica set: ${data.replicaSet || 'Not reported'}\nWritable primary: ${data.isWritablePrimary}\nHosts:\n${(data.hosts || []).join('\n') || 'Not reported by this connection'}`;
    } else {
      const data = await api('/system/backup', { method: 'POST', body: '{}' });
      output.textContent = `${data.message}\nFile: ${data.filename}\nRecords: ${JSON.stringify(data.counts)}`;
      toast('Database backup created.');
    }
  } catch (error) { output.textContent = error.message; toast(error.message, 'error'); }
}

async function loadMyLoans() {
  const data = await api('/me/loans');
  const items = data.items;
  byId('myLoansTable').innerHTML = items.length ? items.map(row => {
    const fineCell = row.fineAmount ? `<strong>${money(row.fineAmount)}</strong><small>${row.fineIsEstimate ? 'Current estimate' : 'Final fine'}</small>` : '—';
    return `<tr><td><div class="book-cell"><strong>${esc(row.bookTitle)}</strong><small>${esc(row.bookIsbn)}</small></div></td><td>${dateText(row.issueDate)}</td><td>${dateText(row.dueDate)} ${row.overdueDays ? '<span class="pill pill-red">Overdue</span>' : ''}</td><td>${dateText(row.returnDate)}</td><td><div class="fine-cell">${fineCell}</div></td><td>${row.fineAmount > 0 ? (row.finePaid ? '<span class="pill pill-green">Paid</span>' : '<span class="pill pill-amber">Unpaid</span>') : '<span class="muted">No fine</span>'}</td><td>${statusPill(row.status)}</td></tr>`;
  }).join('') : emptyRow(7, 'No borrowing history is linked to your account yet.');
  return items;
}
async function loadMyLibrary() {
  const [profile, loans] = await Promise.all([api('/auth/me'), api('/me/loans')]);
  currentUser = profile.user;
  byId('myMemberName').textContent = `Welcome back, ${currentUser.name.split(/\s+/)[0]}.`;
  byId('myMemberCode').textContent = currentUser.memberCode || 'Library member';
  const active = loans.items.filter(row => row.status === 'Issued');
  const dueSoon = active.filter(row => {
    const due = new Date(row.dueDate); const days = Math.ceil((Date.UTC(due.getUTCFullYear(), due.getUTCMonth(), due.getUTCDate()) - Date.now()) / 86400000);
    return days >= 0 && days <= 3;
  }).length;
  const outstanding = loans.items.reduce((sum, row) => sum + (row.finePaid ? 0 : Number(row.fineAmount || 0)), 0);
  byId('myActiveLoans').textContent = active.length;
  byId('myDueSoon').textContent = dueSoon;
  byId('myOutstandingFine').textContent = money(outstanding);
  byId('myReturnedLoans').textContent = loans.items.filter(row => row.status === 'Returned').length;
  byId('myLoanPreview').innerHTML = active.length ? active.slice(0, 6).map(row => `<tr><td><div class="book-cell"><strong>${esc(row.bookTitle)}</strong><small>${esc(row.bookIsbn)}</small></div></td><td>${dateText(row.issueDate)}</td><td>${dateText(row.dueDate)} ${row.overdueDays ? '<span class="pill pill-red">Overdue</span>' : ''}</td><td>${row.fineAmount ? `${money(row.fineAmount)}${row.fineIsEstimate ? ' <small>estimated</small>' : ''}` : '—'}</td><td>${statusPill(row.status)}</td></tr>`).join('') : emptyRow(5, 'You have no active loans. Browse the catalogue to discover books.');
}
async function loadMyReservations() {
  const data = await api('/me/reservations');
  byId('myReservationsTable').innerHTML = data.items.length ? data.items.map(row => `<tr><td><strong>${esc(row.bookTitle)}</strong></td><td>${dateText(row.createdAt)}</td><td>${statusPill(row.status)}</td><td>${dateText(row.pickupBy)}</td><td><button class="mini-action danger" data-cancel-my-reservation="${row._id}" type="button">Cancel request</button></td></tr>`).join('') : emptyRow(5, 'You have no active reservations.');
}

function openPasswordDialog() {
  byId('changePasswordForm').reset();
  setMessage('changePasswordMessage', '');
  byId('passwordDialog').showModal();
}
async function changePassword(event) {
  event.preventDefault();
  const newPassword = byId('newPassword').value;
  if (newPassword !== byId('confirmPassword').value) return setMessage('changePasswordMessage', 'The new passwords do not match.');
  try {
    const result = await api('/auth/change-password', { method: 'POST', body: JSON.stringify({ currentPassword: byId('currentPassword').value, newPassword }) });
    byId('passwordDialog').close();
    toast(result.message);
    token = ''; currentUser = null; localStorage.removeItem('libraflow_token');
    byId('passwordDialog').close(); byId('appView').classList.add('hidden'); byId('loginView').classList.remove('hidden');
  } catch (error) { setMessage('changePasswordMessage', error.message); }
}

function bindEvents() {
  byId('loginForm').addEventListener('submit', async event => {
    event.preventDefault(); setMessage('loginMessage', '');
    const submit = event.currentTarget.querySelector('button[type="submit"]');
    submit.disabled = true; submit.textContent = 'Signing in…';
    try {
      const response = await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: byId('loginEmail').value.trim(), password: byId('loginPassword').value }) });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'Unable to sign in.');
      token = data.token; currentUser = data.user; localStorage.setItem('libraflow_token', token);
      showApp(); switchPage(isStaff() ? 'dashboard' : 'my-library');
      byId('loginForm').reset();
      toast('Signed in successfully.');
    } catch (error) { setMessage('loginMessage', error.message); }
    finally { submit.disabled = false; submit.innerHTML = 'Sign in <span aria-hidden="true">→</span>'; }
  });
  byId('toggleLoginPassword').addEventListener('click', () => {
    const field = byId('loginPassword'); const visible = field.type === 'password';
    field.type = visible ? 'text' : 'password';
    byId('toggleLoginPassword').textContent = visible ? 'Hide' : 'Show';
    byId('toggleLoginPassword').setAttribute('aria-label', visible ? 'Hide password' : 'Show password');
  });
  byId('logoutBtn').addEventListener('click', () => logout());
  byId('changePasswordBtn').addEventListener('click', openPasswordDialog);
  byId('changePasswordForm').addEventListener('submit', changePassword);
  document.querySelectorAll('[data-close-dialog]').forEach(button => button.addEventListener('click', () => byId(button.dataset.closeDialog).close()));
  document.querySelectorAll('.nav-link').forEach(link => link.addEventListener('click', () => switchPage(link.dataset.page)));
  document.querySelectorAll('[data-home]').forEach(link => link.addEventListener('click', event => { event.preventDefault(); switchPage(isStaff() ? 'dashboard' : 'my-library'); }));
  document.querySelectorAll('[data-goto]').forEach(button => button.addEventListener('click', () => switchPage(button.dataset.goto)));
  byId('quickAddBook').addEventListener('click', () => { switchPage('books'); openBookForm(); });
  byId('addBookBtn').addEventListener('click', () => openBookForm());
  byId('bookForm').addEventListener('submit', saveBook);
  byId('bookSearch').addEventListener('input', debounce(() => loadBooks().catch(error => toast(error.message, 'error')), 250));
  byId('bookCategory').addEventListener('change', () => loadBooks().catch(error => toast(error.message, 'error')));
  byId('addMemberBtn').addEventListener('click', () => openMemberForm());
  byId('memberForm').addEventListener('submit', saveMember);
  byId('memberSearch').addEventListener('input', debounce(() => loadMembers().catch(error => toast(error.message, 'error')), 250));
  byId('issueForm').addEventListener('submit', issueBook);
  byId('transactionFilter').addEventListener('change', () => loadCirculation().catch(error => toast(error.message, 'error')));
  byId('reservationForm').addEventListener('submit', createReservation);
  byId('showReserveFromDesk').addEventListener('click', () => switchPage('reservations'));
  byId('exportCsv').addEventListener('click', downloadCsv);
  byId('checkIndexes').addEventListener('click', () => systemAction('indexes'));
  byId('checkReplication').addEventListener('click', () => systemAction('replication'));
  byId('backupBtn').addEventListener('click', () => systemAction('backup'));
  document.addEventListener('click', event => {
    const target = event.target.closest('button');
    if (!target) return;
    if (target.dataset.close) byId(target.dataset.close).classList.add('hidden');
    if (target.dataset.editBook) openBookForm(bookCache.find(book => String(book._id) === target.dataset.editBook));
    if (target.dataset.deleteBook) deleteBook(target.dataset.deleteBook);
    if (target.dataset.editMember) openMemberForm(memberCache.find(member => String(member._id) === target.dataset.editMember));
    if (target.dataset.deleteMember) deleteMember(target.dataset.deleteMember);
    if (target.dataset.return) returnBook(target.dataset.return);
    if (target.dataset.payFine) payFine(target.dataset.payFine);
    if (target.dataset.cancelReservation) cancelReservation(target.dataset.cancelReservation);
    if (target.dataset.studentReserve) reserveForCurrentMember(target.dataset.studentReserve);
    if (target.dataset.cancelMyReservation) cancelMyReservation(target.dataset.cancelMyReservation);
  });
}
async function cancelMyReservation(id) {
  if (!confirm('Cancel this reservation?')) return;
  try { const result = await api(`/me/reservations/${id}/cancel`, { method: 'POST', body: '{}' }); toast(result.message); await loadMyReservations(); await loadBooks(); }
  catch (error) { toast(error.message, 'error'); }
}
function debounce(fn, delay) { let timer; return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), delay); }; }

async function init() {
  bindEvents();
  const due = new Date(); due.setDate(due.getDate() + 14);
  byId('issueDueDate').value = due.toISOString().slice(0, 10);
  byId('issueDueDate').min = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  byId('issueDueDate').max = new Date(Date.now() + 60 * 86400000).toISOString().slice(0, 10);
  if (!token) return;
  try {
    const data = await api('/auth/me');
    currentUser = data.user;
    showApp();
    switchPage(isStaff() ? 'dashboard' : 'my-library');
  } catch { /* expired or revoked tokens return to the sign-in view */ }
}

document.addEventListener('DOMContentLoaded', init);
