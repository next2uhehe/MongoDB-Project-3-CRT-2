'use strict';

require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const { MongoClient, ObjectId, EJSON } = require('mongodb');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const DB_NAME = process.env.DB_NAME || 'LibraryManagementOfficial';
const LOAN_DAYS = Number(process.env.LOAN_DAYS) || 14;
const FINE_PER_DAY = Number(process.env.FINE_PER_DAY) || 5;
const MAX_ACTIVE_LOANS = Number(process.env.MAX_ACTIVE_LOANS) || 5;
const JWT_SECRET = process.env.JWT_SECRET || '';
const MONGODB_URI = process.env.MONGODB_URI;
let client;
let db;

app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false, limit: '1mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

const clean = (value, max = 160) => String(value ?? '').trim().slice(0, max);
const isObjectId = value => ObjectId.isValid(String(value || '')) && String(new ObjectId(String(value))) === String(value);
const escapeRegex = value => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const todayUtc = () => new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00.000Z');
const dateOnly = value => {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
  }
  const text = String(value ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const [year, month, day] = text.split('-').map(Number);
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null;
  return d;
};
const addDays = (date, days) => new Date(date.getTime() + days * 86400000);
const lateDays = (dueDate, returnedAt = new Date()) => Math.max(0, Math.ceil((dateOnly(returnedAt) - dateOnly(dueDate)) / 86400000));
const validEmail = value => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '').trim());
const validIsbn = value => /^[0-9Xx-]{10,17}$/.test(String(value || '').trim());
const escapeHtmlText = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

function fail(res, status, message) { return res.status(status).json({ error: message }); }
function requireFields(body, fields) {
  return fields.filter(field => body[field] === undefined || body[field] === null || String(body[field]).trim() === '');
}
function csvCell(value) {
  let text = String(value ?? '');
  if (/^\s*[=+@-]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

async function createIndexes() {
  await Promise.all([
    db.collection('books').createIndex({ isbn: 1 }, { unique: true, name: 'uq_books_isbn' }),
    db.collection('books').createIndex({ title: 'text', author: 'text', category: 'text' }, { name: 'books_text_search' }),
    db.collection('books').createIndex({ category: 1, availableCopies: 1 }, { name: 'books_category_availability' }),
    db.collection('members').createIndex({ memberCode: 1 }, { unique: true, name: 'uq_members_code' }),
    db.collection('members').createIndex({ email: 1 }, { unique: true, name: 'uq_members_email' }),
    db.collection('members').createIndex({ name: 1 }),
    db.collection('transactions').createIndex({ memberId: 1, status: 1 }, { name: 'transactions_member_status' }),
    db.collection('transactions').createIndex({ memberId: 1, issueDate: -1 }, { name: 'transactions_member_history' }),
    db.collection('transactions').createIndex({ bookId: 1, status: 1 }, { name: 'transactions_book_status' }),
    db.collection('transactions').createIndex({ status: 1, dueDate: 1 }, { name: 'transactions_due_status' }),
    db.collection('transactions').createIndex({ bookId: 1, memberId: 1 }, { unique: true, partialFilterExpression: { status: 'Issued' }, name: 'uq_active_member_book' }),
    db.collection('reservations').createIndex({ bookId: 1, status: 1, createdAt: 1 }, { name: 'reservations_queue' }),
    db.collection('reservations').createIndex({ memberId: 1, status: 1 }, { name: 'reservations_member_status' }),
    db.collection('admins').createIndex({ email: 1 }, { unique: true, name: 'uq_admin_email' }),
  ]);
}

async function ensureAdmin() {
  const email = clean(process.env.ADMIN_EMAIL, 180).toLowerCase();
  const password = String(process.env.ADMIN_PASSWORD || '');
  if (!validEmail(email)) throw new Error('Set a valid ADMIN_EMAIL in .env before starting LibraFlow.');
  if (password.length < 12) throw new Error('Set ADMIN_PASSWORD to at least 12 characters in .env before starting LibraFlow.');
  if (JWT_SECRET.length < 32) throw new Error('Set JWT_SECRET to a random secret of at least 32 characters in .env.');
  const admins = db.collection('admins');
  const existing = await admins.findOne({ email });
  if (!existing) {
    await admins.insertOne({
      email,
      passwordHash: await bcrypt.hash(password, 12),
      name: clean(process.env.ADMIN_NAME || 'Library Administrator', 100),
      role: 'admin',
      status: 'Active',
      createdAt: new Date(),
    });
  }
}

async function seedDemoData() {
  await ensureAdmin();
  const books = db.collection('books');
  const members = db.collection('members');
  const bookSamples = [
    { isbn: '9780132350884', title: 'Clean Code', author: 'Robert C. Martin', category: 'Programming', publisher: 'Prentice Hall', shelf: 'A-01', totalCopies: 5, description: 'A handbook of agile software craftsmanship.' },
    { isbn: '9780131103627', title: 'The C Programming Language', author: 'Brian W. Kernighan, Dennis M. Ritchie', category: 'Programming', publisher: 'Prentice Hall', shelf: 'A-02', totalCopies: 4, description: 'Classic introduction to C programming.' },
    { isbn: '9780262033848', title: 'Introduction to Algorithms', author: 'Thomas H. Cormen et al.', category: 'Computer Science', publisher: 'MIT Press', shelf: 'B-01', totalCopies: 3, description: 'Comprehensive algorithms reference.' },
    { isbn: '9780134685991', title: 'Effective Java', author: 'Joshua Bloch', category: 'Programming', publisher: 'Addison-Wesley', shelf: 'A-03', totalCopies: 3, description: 'Best practices for the Java platform.' },
    { isbn: '9780073523323', title: 'Database System Concepts', author: 'Abraham Silberschatz et al.', category: 'Database', publisher: 'McGraw Hill', shelf: 'B-02', totalCopies: 4, description: 'Database design, transactions and systems.' },
    { isbn: '9781491950296', title: 'Designing Data-Intensive Applications', author: 'Martin Kleppmann', category: 'Computer Science', publisher: "O'Reilly Media", shelf: 'B-03', totalCopies: 2, description: 'Modern data systems and distributed architecture.' },
    { isbn: '9780135957059', title: 'The Pragmatic Programmer', author: 'David Thomas, Andrew Hunt', category: 'Programming', publisher: 'Addison-Wesley', shelf: 'A-04', totalCopies: 3, description: 'Practical approaches to software development.' },
    { isbn: '9789355423488', title: 'Let Us C', author: 'Yashavant Kanetkar', category: 'Programming', publisher: 'BPB Publications', shelf: 'C-01', totalCopies: 6, description: 'A student-friendly guide to C programming.' },
    { isbn: '9780596007126', title: 'Head First Design Patterns', author: 'Eric Freeman et al.', category: 'Software Engineering', publisher: "O'Reilly Media", shelf: 'C-02', totalCopies: 2, description: 'Visual introduction to reusable design patterns.' },
    { isbn: '9781119722102', title: 'Artificial Intelligence: A Modern Approach', author: 'Stuart Russell, Peter Norvig', category: 'Artificial Intelligence', publisher: 'Pearson', shelf: 'D-01', totalCopies: 3, description: 'Foundational AI concepts and methods.' },
  ];
  for (const sample of bookSamples) {
    await books.updateOne({ isbn: sample.isbn }, { $setOnInsert: {
      ...sample,
      availableCopies: sample.totalCopies,
      createdAt: new Date(),
      updatedAt: new Date(),
    } }, { upsert: true });
  }
  const memberSamples = [
    { memberCode: 'LIB-STU-001', name: 'Aarav Sharma', email: 'aarav.demo@college.edu', branch: 'AI & Data Science', semester: 5, phone: '9000000001' },
    { memberCode: 'LIB-STU-002', name: 'Isha Meena', email: 'isha.demo@college.edu', branch: 'Computer Science', semester: 5, phone: '9000000002' },
    { memberCode: 'LIB-STU-003', name: 'Rahul Singh', email: 'rahul.demo@college.edu', branch: 'Information Technology', semester: 3, phone: '9000000003' },
    { memberCode: 'LIB-STU-004', name: 'Priya Sharma', email: 'priya.demo@college.edu', branch: 'Electronics & Communication', semester: 7, phone: '9000000004' },
    { memberCode: 'LIB-STU-005', name: 'Aman Verma', email: 'aman.demo@college.edu', branch: 'Mechanical Engineering', semester: 1, phone: '9000000005' },
    { memberCode: 'LIB-FAC-001', name: 'Anjali Dubey', email: 'anjali.demo@college.edu', branch: 'Faculty', semester: null, phone: '9000000006' },
  ];
  for (const sample of memberSamples) {
    await members.updateOne({ memberCode: sample.memberCode }, { $setOnInsert: { ...sample, status: 'Active', createdAt: new Date() } }, { upsert: true });
  }
  const transactions = db.collection('transactions');
  if (await transactions.countDocuments() === 0) {
    const cleanCode = await books.findOne({ isbn: '9780132350884' });
    const dbBook = await books.findOne({ isbn: '9780073523323' });
    const letUsC = await books.findOne({ isbn: '9789355423488' });
    const radhe = await members.findOne({ memberCode: 'LIB-STU-001' });
    const isha = await members.findOne({ memberCode: 'LIB-STU-002' });
    const rahul = await members.findOne({ memberCode: 'LIB-STU-003' });
    const now = todayUtc();
    const demoTransactions = [
      { book: cleanCode, member: radhe, status: 'Issued', issueDate: addDays(now, -5), dueDate: addDays(now, LOAN_DAYS - 5), returnDate: null, fineAmount: 0, finePaid: true },
      { book: dbBook, member: isha, status: 'Issued', issueDate: addDays(now, -17), dueDate: addDays(now, -3), returnDate: null, fineAmount: 0, finePaid: true },
      { book: letUsC, member: rahul, status: 'Returned', issueDate: addDays(now, -30), dueDate: addDays(now, -16), returnDate: addDays(now, -15), fineAmount: FINE_PER_DAY, finePaid: true },
    ].filter(row => row.book && row.member);
    if (demoTransactions.length) {
      await transactions.insertMany(demoTransactions.map(row => ({
        bookId: row.book._id, memberId: row.member._id, bookTitle: row.book.title, bookIsbn: row.book.isbn,
        memberName: row.member.name, memberCode: row.member.memberCode, issueDate: row.issueDate, dueDate: row.dueDate,
        returnDate: row.returnDate, status: row.status, fineAmount: row.fineAmount, finePaid: row.finePaid,
        createdAt: row.issueDate, updatedAt: row.returnDate || new Date(), demoRecord: true,
      })));
      for (const row of demoTransactions.filter(item => item.status === 'Issued')) {
        await books.updateOne({ _id: row.book._id, availableCopies: { $gt: 0 } }, { $inc: { availableCopies: -1 } });
      }
    }
  }
  return { books: bookSamples.length, members: memberSamples.length, transactions: await transactions.countDocuments() };
}

async function authMiddleware(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) return fail(res, 401, 'Please sign in to continue.');
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    const role = req.user.role;
    if (!isObjectId(req.user.sub) || !['admin', 'librarian', 'member'].includes(role)) return fail(res, 401, 'Your session is invalid. Please sign in again.');
    const collection = ['admin', 'librarian'].includes(role) ? db.collection('admins') : db.collection('members');
    const account = await collection.findOne({ _id: new ObjectId(req.user.sub), status: { $ne: 'Inactive' } }, { projection: { tokenVersion: 1 } });
    if (!account || Number(account.tokenVersion || 0) !== Number(req.user.tokenVersion || 0)) return fail(res, 401, 'Your account session has expired. Please sign in again.');
    return next();
  } catch (error) {
    if (error?.name === 'JsonWebTokenError' || error?.name === 'TokenExpiredError' || error?.name === 'NotBeforeError') return fail(res, 401, 'Your session has expired. Please sign in again.');
    return handleMongoError(error, res);
  }
}
function requireStaff(req, res, next) {
  if (!['admin', 'librarian'].includes(req.user?.role)) return fail(res, 403, 'This area is available to library staff only.');
  return next();
}
function requireMember(req, res, next) {
  if (req.user?.role !== 'member' || !isObjectId(req.user?.sub)) return fail(res, 403, 'This area is available to registered library members only.');
  return next();
}
function validPassword(value) { return typeof value === 'string' && value.length >= 12 && value.length <= 128; }
const loginAttempts = new Map();
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 8;
function loginRateState(key, now = Date.now()) {
  const current = loginAttempts.get(key);
  if (!current || now - current.startedAt >= LOGIN_WINDOW_MS) return { count: 0, startedAt: now, blocked: false };
  return { ...current, blocked: current.count >= LOGIN_MAX_ATTEMPTS };
}
function recordLoginFailure(key, now = Date.now()) {
  const state = loginRateState(key, now);
  loginAttempts.set(key, { startedAt: state.startedAt, count: state.count + 1 });
  if (loginAttempts.size > 5000) {
    for (const [entry, value] of loginAttempts) if (now - value.startedAt >= LOGIN_WINDOW_MS) loginAttempts.delete(entry);
  }
}


function handleMongoError(error, res) {
  if (error?.code === 11000) return fail(res, 409, 'This ISBN, member code, or email already exists.');
  console.error(error);
  return fail(res, 500, 'Something went wrong while processing the request.');
}

app.get('/api/health', (req, res) => res.json({ status: 'ok', application: 'LibraFlow', database: db ? 'connected' : 'not connected' }));

app.post('/api/auth/login', async (req, res) => {
  try {
    const email = clean(req.body.email, 180).toLowerCase();
    const password = String(req.body.password || '');
    if (!validEmail(email) || !password) return fail(res, 400, 'Enter your registered email address and password.');
    const attemptKey = `${req.ip || req.socket.remoteAddress || 'unknown'}|${email}`;
    const rateState = loginRateState(attemptKey);
    if (rateState.blocked) return fail(res, 429, 'Too many unsuccessful sign-in attempts. Try again in 15 minutes.');

    const admin = await db.collection('admins').findOne({ email, status: { $ne: 'Inactive' } });
    if (admin && await bcrypt.compare(password, admin.passwordHash)) {
      const user = { id: String(admin._id), name: admin.name, email: admin.email, role: admin.role || 'admin' };
      await db.collection('admins').updateOne({ _id: admin._id }, { $set: { lastLoginAt: new Date() } });
      const token = jwt.sign({ sub: user.id, email: user.email, name: user.name, role: user.role, tokenVersion: Number(admin.tokenVersion || 0) }, JWT_SECRET, { expiresIn: '8h' });
      loginAttempts.delete(attemptKey);
      return res.json({ token, user });
    }

    const member = await db.collection('members').findOne({ email, status: 'Active', passwordHash: { $exists: true, $ne: '' } });
    if (!member || !(await bcrypt.compare(password, member.passwordHash))) {
      recordLoginFailure(attemptKey);
      return fail(res, 401, 'The email or password is incorrect, or the account is not active.');
    }
    const user = { id: String(member._id), memberCode: member.memberCode, name: member.name, email: member.email, role: 'member' };
    await db.collection('members').updateOne({ _id: member._id }, { $set: { lastLoginAt: new Date() } });
    const token = jwt.sign({ sub: user.id, email: user.email, name: user.name, role: user.role, memberCode: user.memberCode, tokenVersion: Number(member.tokenVersion || 0) }, JWT_SECRET, { expiresIn: '8h' });
    loginAttempts.delete(attemptKey);
    return res.json({ token, user });
  } catch (error) { handleMongoError(error, res); }
});

app.use('/api', authMiddleware);

app.get('/api/auth/me', async (req, res) => {
  try {
    if (['admin', 'librarian'].includes(req.user.role)) {
      const staff = await db.collection('admins').findOne({ _id: new ObjectId(req.user.sub), status: { $ne: 'Inactive' } }, { projection: { passwordHash: 0 } });
      if (!staff) return fail(res, 401, 'Your staff account is no longer active.');
      return res.json({ user: { id: String(staff._id), name: staff.name, email: staff.email, role: staff.role || 'admin' } });
    }
    if (req.user.role === 'member' && isObjectId(req.user.sub)) {
      const member = await db.collection('members').findOne({ _id: new ObjectId(req.user.sub), status: 'Active' }, { projection: { passwordHash: 0 } });
      if (!member) return fail(res, 401, 'Your library membership is no longer active.');
      return res.json({ user: { id: String(member._id), memberCode: member.memberCode, name: member.name, email: member.email, role: 'member' } });
    }
    return fail(res, 401, 'Your account could not be verified.');
  } catch (error) { handleMongoError(error, res); }
});

app.post('/api/auth/change-password', async (req, res) => {
  try {
    const currentPassword = String(req.body.currentPassword || '');
    const newPassword = String(req.body.newPassword || '');
    if (!currentPassword || !validPassword(newPassword)) return fail(res, 400, 'Enter your current password and a new password of at least 12 characters.');
    const collection = ['admin', 'librarian'].includes(req.user.role) ? db.collection('admins') : db.collection('members');
    if (!isObjectId(req.user.sub)) return fail(res, 401, 'Your account could not be verified.');
    const account = await collection.findOne({ _id: new ObjectId(req.user.sub) });
    if (!account || !(await bcrypt.compare(currentPassword, account.passwordHash))) return fail(res, 400, 'Your current password is incorrect.');
    await collection.updateOne({ _id: account._id }, { $set: { passwordHash: await bcrypt.hash(newPassword, 12), passwordUpdatedAt: new Date() }, $inc: { tokenVersion: 1 } });
    res.json({ message: 'Password updated. Sign in again with your new password.' });
  } catch (error) { handleMongoError(error, res); }
});

app.get('/api/me/loans', requireMember, async (req, res) => {
  try {
    const memberId = new ObjectId(req.user.sub);
    const rows = await db.collection('transactions').find({ memberId }).sort({ issueDate: -1, createdAt: -1 }).limit(300).toArray();
    const today = todayUtc();
    const items = rows.map(row => {
      const liveFine = row.status === 'Issued' && row.dueDate < today ? lateDays(row.dueDate, today) * FINE_PER_DAY : 0;
      return { _id: row._id, bookTitle: row.bookTitle, bookIsbn: row.bookIsbn, issueDate: row.issueDate, dueDate: row.dueDate, returnDate: row.returnDate, status: row.status, fineAmount: row.status === 'Returned' ? (row.fineAmount || 0) : liveFine, finePaid: Boolean(row.finePaid), overdueDays: row.status === 'Issued' && row.dueDate < today ? lateDays(row.dueDate, today) : 0, fineIsEstimate: row.status === 'Issued' && liveFine > 0 };
    });
    res.json({ items, finePerDay: FINE_PER_DAY, loanDays: LOAN_DAYS });
  } catch (error) { handleMongoError(error, res); }
});

app.get('/api/me/reservations', requireMember, async (req, res) => {
  try {
    const items = await db.collection('reservations').find({ memberId: new ObjectId(req.user.sub), status: { $in: ['Waiting', 'Ready'] } }).sort({ createdAt: -1 }).limit(100).toArray();
    res.json({ items });
  } catch (error) { handleMongoError(error, res); }
});

app.post('/api/me/reservations', requireMember, async (req, res) => {
  try {
    const bookIdValue = String(req.body.bookId || '');
    if (!isObjectId(bookIdValue)) return fail(res, 400, 'Choose a valid book.');
    const bookId = new ObjectId(bookIdValue);
    const memberId = new ObjectId(req.user.sub);
    const [book, member] = await Promise.all([
      db.collection('books').findOne({ _id: bookId }),
      db.collection('members').findOne({ _id: memberId, status: 'Active' }),
    ]);
    if (!book) return fail(res, 404, 'Book not found.');
    if (!member) return fail(res, 403, 'Your membership is not active.');
    if (book.availableCopies > 0) return fail(res, 409, 'A copy is available. Please contact the library desk to borrow it.');
    const existing = await db.collection('reservations').findOne({ bookId, memberId, status: { $in: ['Waiting', 'Ready'] } });
    if (existing) return fail(res, 409, 'You already have an active reservation for this book.');
    const createdAt = new Date();
    const result = await db.collection('reservations').insertOne({ bookId, memberId, bookTitle: book.title, memberName: member.name, memberCode: member.memberCode, status: 'Waiting', createdAt });
    const position = await db.collection('reservations').countDocuments({ bookId, status: 'Waiting', createdAt: { $lte: createdAt } });
    res.status(201).json({ message: `Reservation placed. Your queue position is ${position}.`, item: { _id: result.insertedId, position } });
  } catch (error) { handleMongoError(error, res); }
});

app.post('/api/me/reservations/:id/cancel', requireMember, async (req, res) => {
  try {
    if (!isObjectId(req.params.id)) return fail(res, 400, 'Invalid reservation ID.');
    const reservation = await db.collection('reservations').findOne({ _id: new ObjectId(req.params.id), memberId: new ObjectId(req.user.sub), status: { $in: ['Waiting', 'Ready'] } });
    if (!reservation) return fail(res, 404, 'Active reservation not found.');
    const changed = await db.collection('reservations').updateOne({ _id: reservation._id, memberId: new ObjectId(req.user.sub), status: reservation.status }, { $set: { status: 'Cancelled', cancelledAt: new Date() } });
    if (!changed.modifiedCount) return fail(res, 409, 'Reservation was already processed. Refresh and try again.');
    if (reservation.status === 'Ready') {
      const next = await db.collection('reservations').find({ bookId: reservation.bookId, status: 'Waiting' }).sort({ createdAt: 1 }).limit(1).next();
      if (next) await db.collection('reservations').updateOne({ _id: next._id, status: 'Waiting' }, { $set: { status: 'Ready', readyAt: new Date(), pickupBy: addDays(todayUtc(), 2) } });
      else await db.collection('books').updateOne({ _id: reservation.bookId }, { $inc: { availableCopies: 1 } });
    }
    res.json({ message: 'Reservation cancelled.' });
  } catch (error) { handleMongoError(error, res); }
});

app.get('/api/dashboard', requireStaff, async (req, res) => {
  try {
    const [totalBooks, totalMembers, activeLoans, overdueLoans, availableBooks, categoryStats, popularBooks] = await Promise.all([
      db.collection('books').countDocuments(),
      db.collection('members').countDocuments({ status: 'Active' }),
      db.collection('transactions').countDocuments({ status: 'Issued' }),
      db.collection('transactions').countDocuments({ status: 'Issued', dueDate: { $lt: todayUtc() } }),
      db.collection('books').aggregate([{ $group: { _id: null, total: { $sum: '$availableCopies' } } }]).toArray(),
      db.collection('books').aggregate([{ $group: { _id: '$category', titles: { $sum: 1 }, copies: { $sum: '$totalCopies' } } }, { $sort: { titles: -1 } }, { $limit: 6 }]).toArray(),
      db.collection('transactions').aggregate([{ $group: { _id: '$bookId', issueCount: { $sum: 1 }, title: { $first: '$bookTitle' } } }, { $sort: { issueCount: -1 } }, { $limit: 5 }]).toArray(),
    ]);
    const recent = await db.collection('transactions').find().sort({ createdAt: -1 }).limit(6).toArray();
    res.json({ stats: { totalBooks, totalMembers, activeLoans, overdueLoans, availableCopies: availableBooks[0]?.total || 0 }, categoryStats, popularBooks, recent });
  } catch (error) { handleMongoError(error, res); }
});

app.get('/api/books', async (req, res) => {
  try {
    const search = clean(req.query.search, 100);
    const category = clean(req.query.category, 80);
    const query = {};
    if (category && category !== 'All') query.category = category;
    if (search) {
      const regex = new RegExp(escapeRegex(search), 'i');
      query.$or = [{ title: regex }, { author: regex }, { isbn: regex }, { category: regex }];
    }
    const items = await db.collection('books').find(query).sort({ title: 1 }).limit(250).toArray();
    const categories = await db.collection('books').distinct('category');
    res.json({ items, categories });
  } catch (error) { handleMongoError(error, res); }
});

app.post('/api/books', requireStaff, async (req, res) => {
  try {
    const body = req.body || {};
    const missing = requireFields(body, ['isbn', 'title', 'author', 'category', 'totalCopies']);
    if (missing.length) return fail(res, 400, `Required fields: ${missing.join(', ')}.`);
    const totalCopies = Number(body.totalCopies);
    if (!validIsbn(body.isbn) || !Number.isInteger(totalCopies) || totalCopies < 1 || totalCopies > 10000) return fail(res, 400, 'Enter a valid ISBN and a total copy count from 1 to 10,000.');
    const doc = {
      isbn: clean(body.isbn, 20).replace(/-/g, ''), title: clean(body.title, 160), author: clean(body.author, 140),
      category: clean(body.category, 80), publisher: clean(body.publisher, 120), shelf: clean(body.shelf, 40),
      description: clean(body.description, 500), totalCopies, availableCopies: totalCopies,
      createdAt: new Date(), updatedAt: new Date(),
    };
    const result = await db.collection('books').insertOne(doc);
    res.status(201).json({ message: 'Book added successfully.', item: { ...doc, _id: result.insertedId } });
  } catch (error) { handleMongoError(error, res); }
});

app.put('/api/books/:id', requireStaff, async (req, res) => {
  try {
    if (!isObjectId(req.params.id)) return fail(res, 400, 'Invalid book ID.');
    const books = db.collection('books');
    const current = await books.findOne({ _id: new ObjectId(req.params.id) });
    if (!current) return fail(res, 404, 'Book not found.');
    const body = req.body || {};
    const totalCopies = body.totalCopies === undefined ? current.totalCopies : Number(body.totalCopies);
    const issuedOrReserved = current.totalCopies - current.availableCopies;
    if (!Number.isInteger(totalCopies) || totalCopies < issuedOrReserved || totalCopies > 10000) return fail(res, 400, `Total copies cannot be less than ${issuedOrReserved} copies currently issued or reserved.`);
    const update = {
      title: body.title === undefined ? current.title : clean(body.title, 160),
      author: body.author === undefined ? current.author : clean(body.author, 140),
      category: body.category === undefined ? current.category : clean(body.category, 80),
      publisher: body.publisher === undefined ? current.publisher : clean(body.publisher, 120),
      shelf: body.shelf === undefined ? current.shelf : clean(body.shelf, 40),
      description: body.description === undefined ? current.description : clean(body.description, 500),
      totalCopies,
      availableCopies: current.availableCopies + (totalCopies - current.totalCopies),
      updatedAt: new Date(),
    };
    await books.updateOne({ _id: current._id }, { $set: update });
    res.json({ message: 'Book updated successfully.' });
  } catch (error) { handleMongoError(error, res); }
});

app.delete('/api/books/:id', requireStaff, async (req, res) => {
  try {
    if (!isObjectId(req.params.id)) return fail(res, 400, 'Invalid book ID.');
    const bookId = new ObjectId(req.params.id);
    const hasActive = await db.collection('transactions').findOne({ bookId, status: 'Issued' });
    const hasQueue = await db.collection('reservations').findOne({ bookId, status: { $in: ['Waiting', 'Ready'] } });
    if (hasActive || hasQueue) return fail(res, 409, 'This book has active loans or reservations and cannot be deleted.');
    const result = await db.collection('books').deleteOne({ _id: bookId });
    if (!result.deletedCount) return fail(res, 404, 'Book not found.');
    res.json({ message: 'Book deleted.' });
  } catch (error) { handleMongoError(error, res); }
});

app.get('/api/members', requireStaff, async (req, res) => {
  try {
    const search = clean(req.query.search, 100);
    const query = search ? { $or: [{ name: new RegExp(escapeRegex(search), 'i') }, { memberCode: new RegExp(escapeRegex(search), 'i') }, { email: new RegExp(escapeRegex(search), 'i') }] } : {};
    const items = await db.collection('members').find(query).sort({ name: 1 }).limit(300).toArray();
    res.json({ items: items.map(({ passwordHash, ...item }) => ({ ...item, hasPortalAccess: Boolean(passwordHash) })) });
  } catch (error) { handleMongoError(error, res); }
});

app.post('/api/members', requireStaff, async (req, res) => {
  try {
    const body = req.body || {};
    const missing = requireFields(body, ['memberCode', 'name', 'email', 'password']);
    if (missing.length) return fail(res, 400, `Required fields: ${missing.join(', ')}.`);
    const email = clean(body.email, 180).toLowerCase();
    if (!validEmail(email)) return fail(res, 400, 'Enter a valid email address.');
    if (!validPassword(String(body.password))) return fail(res, 400, 'Set an initial portal password of at least 12 characters.');
    const semester = body.semester === '' || body.semester === undefined || body.semester === null ? null : Number(body.semester);
    if (semester !== null && (!Number.isInteger(semester) || semester < 1 || semester > 8)) return fail(res, 400, 'Semester must be between 1 and 8.');
    const doc = { memberCode: clean(body.memberCode, 32).toUpperCase(), name: clean(body.name, 120), email, branch: clean(body.branch, 100), semester, phone: clean(body.phone, 25), status: 'Active', passwordHash: await bcrypt.hash(String(body.password), 12), portalAccessCreatedAt: new Date(), createdAt: new Date() };
    const result = await db.collection('members').insertOne(doc);
    const { passwordHash, ...safeDoc } = doc;
    res.status(201).json({ message: 'Member registered and portal access created. Share the initial password securely; it cannot be viewed again.', item: { ...safeDoc, hasPortalAccess: true, _id: result.insertedId } });
  } catch (error) { handleMongoError(error, res); }
});

app.put('/api/members/:id', requireStaff, async (req, res) => {
  try {
    if (!isObjectId(req.params.id)) return fail(res, 400, 'Invalid member ID.');
    const body = req.body || {};
    const current = await db.collection('members').findOne({ _id: new ObjectId(req.params.id) });
    if (!current) return fail(res, 404, 'Member not found.');
    const email = body.email === undefined ? current.email : clean(body.email, 180).toLowerCase();
    if (!validEmail(email)) return fail(res, 400, 'Enter a valid email address.');
    const status = body.status === undefined ? current.status : clean(body.status, 20);
    if (!['Active', 'Inactive'].includes(status)) return fail(res, 400, 'Member status must be Active or Inactive.');
    if (status === 'Inactive') {
      const [activeLoan, activeReservation] = await Promise.all([
        db.collection('transactions').findOne({ memberId: current._id, status: 'Issued' }),
        db.collection('reservations').findOne({ memberId: current._id, status: { $in: ['Waiting', 'Ready'] } }),
      ]);
      if (activeLoan || activeReservation) return fail(res, 409, 'Resolve active loans and reservations before deactivating this member.');
    }
    const semester = body.semester === undefined ? current.semester : (body.semester === null || body.semester === '' ? null : Number(body.semester));
    if (semester !== null && (!Number.isInteger(semester) || semester < 1 || semester > 8)) return fail(res, 400, 'Semester must be between 1 and 8.');
    const update = { name: body.name === undefined ? current.name : clean(body.name, 120), email, branch: body.branch === undefined ? current.branch : clean(body.branch, 100), semester, phone: body.phone === undefined ? current.phone : clean(body.phone, 25), status, updatedAt: new Date() };
    if (body.password !== undefined && String(body.password).length) {
      if (!validPassword(String(body.password))) return fail(res, 400, 'A reset password must contain at least 12 characters.');
      update.passwordHash = await bcrypt.hash(String(body.password), 12);
      update.passwordUpdatedAt = new Date();
      update.tokenVersion = Number(current.tokenVersion || 0) + 1;
    }
    await db.collection('members').updateOne({ _id: current._id }, { $set: update });
    res.json({ message: body.password ? 'Member updated and portal password reset.' : 'Member updated successfully.' });
  } catch (error) { handleMongoError(error, res); }
});

app.delete('/api/members/:id', requireStaff, async (req, res) => {
  try {
    if (!isObjectId(req.params.id)) return fail(res, 400, 'Invalid member ID.');
    const memberId = new ObjectId(req.params.id);
    const activeLoan = await db.collection('transactions').findOne({ memberId, status: 'Issued' });
    const activeReservation = await db.collection('reservations').findOne({ memberId, status: { $in: ['Waiting', 'Ready'] } });
    if (activeLoan || activeReservation) return fail(res, 409, 'This member has active loans or reservations.');
    const result = await db.collection('members').deleteOne({ _id: memberId });
    if (!result.deletedCount) return fail(res, 404, 'Member not found.');
    res.json({ message: 'Member deleted.' });
  } catch (error) { handleMongoError(error, res); }
});

app.get('/api/transactions', requireStaff, async (req, res) => {
  try {
    const status = clean(req.query.status, 20);
    const query = {};
    if (status === 'Issued' || status === 'Returned') query.status = status;
    const items = await db.collection('transactions').find(query).sort({ createdAt: -1 }).limit(300).toArray();
    const now = todayUtc();
    const result = items.map(item => ({ ...item, overdueDays: item.status === 'Issued' && item.dueDate < now ? lateDays(item.dueDate, now) : 0, estimatedFine: item.status === 'Issued' && item.dueDate < now ? lateDays(item.dueDate, now) * FINE_PER_DAY : item.fineAmount || 0 }));
    res.json({ items: result, loanDays: LOAN_DAYS, finePerDay: FINE_PER_DAY });
  } catch (error) { handleMongoError(error, res); }
});

app.post('/api/transactions/issue', requireStaff, async (req, res) => {
  try {
    const body = req.body || {};
    const missing = requireFields(body, ['bookId', 'memberId']);
    if (missing.length) return fail(res, 400, `Required fields: ${missing.join(', ')}.`);
    if (!isObjectId(body.bookId) || !isObjectId(body.memberId)) return fail(res, 400, 'Select a valid book and member.');
    const bookId = new ObjectId(body.bookId);
    const memberId = new ObjectId(body.memberId);
    const [book, member] = await Promise.all([db.collection('books').findOne({ _id: bookId }), db.collection('members').findOne({ _id: memberId, status: 'Active' })]);
    if (!book) return fail(res, 404, 'Book not found.');
    if (!member) return fail(res, 404, 'Active member not found.');
    const duplicateLoan = await db.collection('transactions').findOne({ bookId, memberId, status: 'Issued' });
    if (duplicateLoan) return fail(res, 409, 'This member already has this book issued.');
    const activeLoanCount = await db.collection('transactions').countDocuments({ memberId, status: 'Issued' });
    if (activeLoanCount >= MAX_ACTIVE_LOANS) return fail(res, 409, `This member has reached the limit of ${MAX_ACTIVE_LOANS} active books.`);
    const readyReservation = await db.collection('reservations').findOne({ bookId, memberId, status: 'Ready' });
    let reservedCopy = false;
    if (readyReservation) {
      reservedCopy = true;
      const reservationUpdate = await db.collection('reservations').updateOne({ _id: readyReservation._id, status: 'Ready' }, { $set: { status: 'Fulfilled', fulfilledAt: new Date() } });
      if (!reservationUpdate.modifiedCount) return fail(res, 409, 'This reservation has already been processed. Refresh the page and try again.');
    } else {
      const stock = await db.collection('books').updateOne({ _id: bookId, availableCopies: { $gt: 0 } }, { $inc: { availableCopies: -1 }, $set: { updatedAt: new Date() } });
      if (!stock.modifiedCount) return fail(res, 409, 'No copies are currently available. Place a reservation instead.');
    }
    const issueDate = todayUtc();
    const parsedDueDate = body.dueDate ? dateOnly(body.dueDate) : null;
    if (body.dueDate && !parsedDueDate) {
      if (reservedCopy) await db.collection('reservations').updateOne({ _id: readyReservation._id }, { $set: { status: 'Ready', fulfilledAt: null } });
      else await db.collection('books').updateOne({ _id: bookId }, { $inc: { availableCopies: 1 } });
      return fail(res, 400, 'Enter a valid due date.');
    }
    const dueDate = parsedDueDate || addDays(issueDate, LOAN_DAYS);
    const minDue = addDays(issueDate, 1);
    const maxDue = addDays(issueDate, 60);
    if (dueDate < minDue || dueDate > maxDue) {
      if (reservedCopy) await db.collection('reservations').updateOne({ _id: readyReservation._id }, { $set: { status: 'Ready', fulfilledAt: null } });
      else await db.collection('books').updateOne({ _id: bookId }, { $inc: { availableCopies: 1 } });
      return fail(res, 400, 'Due date must be between tomorrow and 60 days from today.');
    }
    const transaction = { bookId, memberId, bookTitle: book.title, bookIsbn: book.isbn, memberName: member.name, memberCode: member.memberCode, issueDate, dueDate, returnDate: null, status: 'Issued', fineAmount: 0, finePaid: true, createdAt: new Date(), updatedAt: new Date() };
    try {
      const result = await db.collection('transactions').insertOne(transaction);
      res.status(201).json({ message: `Book issued successfully. Due on ${dueDate.toISOString().slice(0, 10)}.`, item: { ...transaction, _id: result.insertedId } });
    } catch (error) {
      if (reservedCopy) await db.collection('reservations').updateOne({ _id: readyReservation._id }, { $set: { status: 'Ready', fulfilledAt: null } });
      else await db.collection('books').updateOne({ _id: bookId }, { $inc: { availableCopies: 1 } });
      throw error;
    }
  } catch (error) { handleMongoError(error, res); }
});

app.post('/api/transactions/:id/return', requireStaff, async (req, res) => {
  try {
    if (!isObjectId(req.params.id)) return fail(res, 400, 'Invalid transaction ID.');
    const transactions = db.collection('transactions');
    const transaction = await transactions.findOne({ _id: new ObjectId(req.params.id), status: 'Issued' });
    if (!transaction) return fail(res, 404, 'Active issued transaction not found.');
    const returnDate = todayUtc();
    const daysLate = lateDays(transaction.dueDate, returnDate);
    const fineAmount = daysLate * FINE_PER_DAY;
    const returnUpdate = await transactions.updateOne({ _id: transaction._id, status: 'Issued' }, { $set: { status: 'Returned', returnDate, fineAmount, finePaid: fineAmount === 0, updatedAt: new Date() } });
    if (!returnUpdate.modifiedCount) return fail(res, 409, 'This book has already been returned. Refresh the page.');
    const waiting = await db.collection('reservations').find({ bookId: transaction.bookId, status: 'Waiting' }).sort({ createdAt: 1 }).limit(1).next();
    if (waiting) {
      await db.collection('reservations').updateOne({ _id: waiting._id, status: 'Waiting' }, { $set: { status: 'Ready', readyAt: new Date(), pickupBy: addDays(todayUtc(), 2) } });
    } else {
      await db.collection('books').updateOne({ _id: transaction.bookId }, { $inc: { availableCopies: 1 }, $set: { updatedAt: new Date() } });
    }
    res.json({ message: fineAmount ? `Book returned. Late fee: ₹${fineAmount}.` : 'Book returned successfully. No fine due.', fineAmount, overdueDays: daysLate, reservationReady: Boolean(waiting) });
  } catch (error) { handleMongoError(error, res); }
});

app.post('/api/transactions/:id/pay-fine', requireStaff, async (req, res) => {
  try {
    if (!isObjectId(req.params.id)) return fail(res, 400, 'Invalid transaction ID.');
    const result = await db.collection('transactions').updateOne({ _id: new ObjectId(req.params.id), status: 'Returned', fineAmount: { $gt: 0 }, finePaid: false }, { $set: { finePaid: true, finePaidAt: new Date(), updatedAt: new Date() } });
    if (!result.modifiedCount) return fail(res, 404, 'Unpaid fine not found for this transaction.');
    res.json({ message: 'Fine marked as paid.' });
  } catch (error) { handleMongoError(error, res); }
});

app.get('/api/reservations', requireStaff, async (req, res) => {
  try {
    const items = await db.collection('reservations').find({ status: { $in: ['Waiting', 'Ready'] } }).sort({ createdAt: 1 }).limit(300).toArray();
    res.json({ items });
  } catch (error) { handleMongoError(error, res); }
});

app.post('/api/reservations', requireStaff, async (req, res) => {
  try {
    const body = req.body || {};
    const missing = requireFields(body, ['bookId', 'memberId']);
    if (missing.length) return fail(res, 400, `Required fields: ${missing.join(', ')}.`);
    if (!isObjectId(body.bookId) || !isObjectId(body.memberId)) return fail(res, 400, 'Select a valid book and member.');
    const bookId = new ObjectId(body.bookId);
    const memberId = new ObjectId(body.memberId);
    const [book, member] = await Promise.all([db.collection('books').findOne({ _id: bookId }), db.collection('members').findOne({ _id: memberId, status: 'Active' })]);
    if (!book) return fail(res, 404, 'Book not found.');
    if (!member) return fail(res, 404, 'Active member not found.');
    if (book.availableCopies > 0) return fail(res, 409, 'A copy is available. Issue the book instead of reserving it.');
    const existing = await db.collection('reservations').findOne({ bookId, memberId, status: { $in: ['Waiting', 'Ready'] } });
    if (existing) return fail(res, 409, 'This member already has an active reservation for this book.');
    const result = await db.collection('reservations').insertOne({ bookId, memberId, bookTitle: book.title, memberName: member.name, memberCode: member.memberCode, status: 'Waiting', createdAt: new Date() });
    const position = await db.collection('reservations').countDocuments({ bookId, status: 'Waiting', createdAt: { $lte: new Date() } });
    res.status(201).json({ message: `Reservation added. Current queue position: ${position}.`, item: { _id: result.insertedId, position } });
  } catch (error) { handleMongoError(error, res); }
});

app.post('/api/reservations/:id/cancel', requireStaff, async (req, res) => {
  try {
    if (!isObjectId(req.params.id)) return fail(res, 400, 'Invalid reservation ID.');
    const reservation = await db.collection('reservations').findOne({ _id: new ObjectId(req.params.id), status: { $in: ['Waiting', 'Ready'] } });
    if (!reservation) return fail(res, 404, 'Active reservation not found.');
    await db.collection('reservations').updateOne({ _id: reservation._id }, { $set: { status: 'Cancelled', cancelledAt: new Date() } });
    if (reservation.status === 'Ready') {
      const next = await db.collection('reservations').find({ bookId: reservation.bookId, status: 'Waiting' }).sort({ createdAt: 1 }).limit(1).next();
      if (next) await db.collection('reservations').updateOne({ _id: next._id }, { $set: { status: 'Ready', readyAt: new Date(), pickupBy: addDays(todayUtc(), 2) } });
      else await db.collection('books').updateOne({ _id: reservation.bookId }, { $inc: { availableCopies: 1 } });
    }
    res.json({ message: 'Reservation cancelled.' });
  } catch (error) { handleMongoError(error, res); }
});

app.get('/api/reports/summary', requireStaff, async (req, res) => {
  try {
    const [monthly, categories, topMembers, fines] = await Promise.all([
      db.collection('transactions').aggregate([
        { $match: { createdAt: { $gte: addDays(new Date(), -180) } } },
        { $group: { _id: { $dateToString: { format: '%Y-%m', date: '$createdAt' } }, issues: { $sum: 1 }, fines: { $sum: '$fineAmount' } } },
        { $sort: { _id: 1 } },
      ]).toArray(),
      db.collection('books').aggregate([{ $group: { _id: '$category', titles: { $sum: 1 }, copies: { $sum: '$totalCopies' } } }, { $sort: { copies: -1 } }]).toArray(),
      db.collection('transactions').aggregate([{ $group: { _id: '$memberId', memberName: { $first: '$memberName' }, memberCode: { $first: '$memberCode' }, borrowed: { $sum: 1 } } }, { $sort: { borrowed: -1 } }, { $limit: 5 }]).toArray(),
      db.collection('transactions').aggregate([{ $group: { _id: null, total: { $sum: '$fineAmount' }, paid: { $sum: { $cond: ['$finePaid', '$fineAmount', 0] } }, unpaidCount: { $sum: { $cond: [{ $and: [{ $gt: ['$fineAmount', 0] }, { $eq: ['$finePaid', false] }] }, 1, 0] } } } }]).toArray(),
    ]);
    res.json({ monthly, categories, topMembers, fines: fines[0] || { total: 0, paid: 0, unpaidCount: 0 } });
  } catch (error) { handleMongoError(error, res); }
});

app.get('/api/reports/export.csv', requireStaff, async (req, res) => {
  try {
    const rows = await db.collection('transactions').find().sort({ createdAt: -1 }).limit(5000).toArray();
    const header = ['Transaction ID', 'Book', 'ISBN', 'Member', 'Member Code', 'Issue Date', 'Due Date', 'Return Date', 'Status', 'Fine (INR)', 'Fine Paid'];
    const lines = [header.map(csvCell).join(',')];
    for (const row of rows) lines.push([row._id, row.bookTitle, row.bookIsbn, row.memberName, row.memberCode, row.issueDate?.toISOString().slice(0, 10), row.dueDate?.toISOString().slice(0, 10), row.returnDate?.toISOString().slice(0, 10) || '', row.status, row.fineAmount || 0, row.finePaid ? 'Yes' : 'No'].map(csvCell).join(','));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="library-transactions.csv"');
    res.send('\uFEFF' + lines.join('\r\n'));
  } catch (error) { handleMongoError(error, res); }
});

app.post('/api/system/backup', requireStaff, async (req, res) => {
  try {
    const names = ['books', 'members', 'transactions', 'reservations', 'admins'];
    const payload = { application: 'LibraFlow', database: DB_NAME, createdAt: new Date().toISOString(), collections: {} };
    const counts = {};
    for (const name of names) {
      payload.collections[name] = await db.collection(name).find().toArray();
      counts[name] = payload.collections[name].length;
    }
    const directory = path.join(__dirname, '..', 'backups');
    fs.mkdirSync(directory, { recursive: true });
    const filename = `library-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    fs.writeFileSync(path.join(directory, filename), EJSON.stringify(payload, null, 2));
    res.json({ message: 'Backup created successfully on this server.', filename, counts });
  } catch (error) { handleMongoError(error, res); }
});

app.get('/api/system/replication', requireStaff, async (req, res) => {
  try {
    const info = await db.admin().command({ hello: 1 });
    res.json({ replicaSet: info.setName || null, isWritablePrimary: Boolean(info.isWritablePrimary), hosts: info.hosts || [], message: info.setName ? 'Connected to a replica set.' : 'This connection does not report a replica-set name. Atlas replication depends on your cluster configuration.' });
  } catch (error) { handleMongoError(error, res); }
});

app.get('/api/system/indexes', requireStaff, async (req, res) => {
  try {
    const names = ['books', 'members', 'transactions', 'reservations'];
    const indexes = {};
    for (const name of names) indexes[name] = await db.collection(name).listIndexes().toArray();
    let explain = null;
    const sample = await db.collection('books').findOne({}, { projection: { category: 1 } });
    if (sample?.category) explain = await db.collection('books').find({ category: sample.category }).explain('executionStats');
    res.json({ indexes, sampleQuery: explain ? { namespace: `${DB_NAME}.books`, executionStats: explain.executionStats, winningPlan: explain.queryPlanner?.winningPlan } : null });
  } catch (error) { handleMongoError(error, res); }
});

app.use('/api', (req, res) => fail(res, 404, 'API endpoint not found.'));
app.use((error, req, res, next) => {
  console.error(error);
  if (res.headersSent) return next(error);
  return fail(res, 500, 'An unexpected server error occurred.');
});

async function connect() {
  if (!MONGODB_URI) throw new Error('MONGODB_URI is missing. Add your MongoDB connection string to .env.');
  client = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 10000, maxPoolSize: 10 });
  await client.connect();
  db = client.db(DB_NAME);
  await createIndexes();
  await ensureAdmin();
}

async function createBackup() {
  if (!MONGODB_URI) throw new Error('MONGODB_URI is missing.');
  const backupClient = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 10000 });
  await backupClient.connect();
  try {
    const database = backupClient.db(DB_NAME);
    const names = ['books', 'members', 'transactions', 'reservations', 'admins'];
    const payload = { application: 'LibraFlow', database: DB_NAME, createdAt: new Date().toISOString(), collections: {} };
    for (const name of names) payload.collections[name] = await database.collection(name).find().toArray();
    const directory = path.join(__dirname, '..', 'backups');
    fs.mkdirSync(directory, { recursive: true });
    const filename = `library-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    fs.writeFileSync(path.join(directory, filename), EJSON.stringify(payload, null, 2));
    process.stdout.write(`Backup created: backups/${filename}\n`);
  } finally { await backupClient.close(); }
}

async function restoreBackup(file) {
  if (!file) throw new Error('Provide a backup path: npm run restore -- backups/filename.json');
  const fullPath = path.resolve(process.cwd(), file);
  if (!fs.existsSync(fullPath)) throw new Error(`Backup file not found: ${fullPath}`);
  const payload = EJSON.parse(fs.readFileSync(fullPath, 'utf8'));
  if (!payload || payload.application !== 'LibraFlow' || !payload.collections || typeof payload.collections !== 'object') throw new Error('This is not a valid LibraFlow backup file.');
  process.stdout.write('WARNING: restore replaces the selected collections in the target database. Type RESTORE to continue: ');
  const readline = require('readline');
  const answer = await new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question('', value => { rl.close(); resolve(value); });
  });
  if (answer !== 'RESTORE') { process.stdout.write('Restore cancelled.\n'); return; }
  if (!MONGODB_URI) throw new Error('MONGODB_URI is missing.');
  const restoreClient = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 10000 });
  await restoreClient.connect();
  try {
    const database = restoreClient.db(DB_NAME);
    for (const [name, docs] of Object.entries(payload.collections)) {
      if (!['books', 'members', 'transactions', 'reservations', 'admins'].includes(name) || !Array.isArray(docs)) continue;
      const collection = database.collection(name);
      await collection.deleteMany({});
      if (docs.length) await collection.insertMany(docs);
      process.stdout.write(`${name}: restored ${docs.length} records\n`);
    }
    await Promise.all([
      database.collection('books').createIndex({ isbn: 1 }, { unique: true, name: 'uq_books_isbn' }),
      database.collection('members').createIndex({ memberCode: 1 }, { unique: true, name: 'uq_members_code' }),
      database.collection('members').createIndex({ email: 1 }, { unique: true, name: 'uq_members_email' }),
      database.collection('transactions').createIndex({ status: 1, dueDate: 1 }, { name: 'transactions_due_status' }),
    ]);
    process.stdout.write(`Restore complete in ${DB_NAME}.\n`);
  } finally { await restoreClient.close(); }
}

function runTests() {
  const assert = require('node:assert/strict');
  const tests = [
    ['valid email', () => assert.equal(validEmail('student@college.edu'), true)],
    ['reject short portal passwords', () => assert.equal(validPassword('short'), false)],
    ['accept strong portal passwords', () => assert.equal(validPassword('Library-Access-2026'), true)],
    ['login lockout activates after eight failures', () => { const key = `test-${Date.now()}`; for (let i = 0; i < LOGIN_MAX_ATTEMPTS; i++) recordLoginFailure(key); assert.equal(loginRateState(key).blocked, true); loginAttempts.delete(key); }],
    ['invalid email', () => assert.equal(validEmail('wrong-email'), false)],
    ['valid ISBN-like value', () => assert.equal(validIsbn('9780132350884'), true)],
    ['invalid ISBN-like value', () => assert.equal(validIsbn('abc123'), false)],
    ['safe search regex escaping', () => assert.equal(new RegExp(escapeRegex('C++')).test('C++ programming'), true)],
    ['late days', () => assert.equal(lateDays(new Date('2026-01-01'), new Date('2026-01-04')), 3)],
    ['no late days when returned on due date', () => assert.equal(lateDays(new Date('2026-01-04'), new Date('2026-01-04')), 0)],
    ['late fine calculation', () => assert.equal(lateDays(new Date('2026-01-01'), new Date('2026-01-04')) * 5, 15)],
    ['valid Mongo ObjectId', () => assert.equal(isObjectId('507f1f77bcf86cd799439011'), true)],
    ['invalid Mongo ObjectId', () => assert.equal(isObjectId('not-an-id'), false)],
    ['CSV values with commas and quotes', () => assert.equal(csvCell('A, "B"'), '"A, ""B"""')],
    ['date-only normalisation', () => assert.equal(dateOnly('2026-03-10').toISOString(), '2026-03-10T00:00:00.000Z')],
    ['reject impossible calendar date', () => assert.equal(dateOnly('2026-02-31'), null)],
    ['reject unbounded or non-date input', () => assert.equal(dateOnly('99999999-99-99'), null)],
    ['prevent CSV formula injection', () => assert.equal(csvCell('=SUM(A1:A2)'), '"\'=SUM(A1:A2)"')],
    ['loan days default', () => assert.equal(LOAN_DAYS > 0 && LOAN_DAYS <= 60, true)],
    ['fine rate default', () => assert.equal(FINE_PER_DAY > 0 && FINE_PER_DAY <= 1000, true)],
    ['active loan limit is sensible', () => assert.equal(MAX_ACTIVE_LOANS > 0 && MAX_ACTIVE_LOANS <= 20, true)],
  ];
  let passed = 0;
  for (const [name, test] of tests) {
    try { test(); passed++; process.stdout.write(`✓ ${name}\n`); }
    catch (error) { process.stderr.write(`✗ ${name}: ${error.message}\n`); process.exitCode = 1; }
  }
  process.stdout.write(`\n${passed}/${tests.length} tests passed.\n`);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--test')) return runTests();
  if (args.includes('--backup')) return createBackup();
  if (args.includes('--restore')) return restoreBackup(args[args.indexOf('--restore') + 1]);
  await connect();
  if (args.includes('--seed')) {
    const counts = await seedDemoData();
    process.stdout.write(`Seed complete. ${counts.books} sample book titles, ${counts.members} members and ${counts.transactions} circulation records are available.\n`);
    await client.close();
    return;
  }
  const server = app.listen(PORT, () => process.stdout.write(`LibraFlow running at http://localhost:${PORT}\nDatabase connected: ${DB_NAME}\n`));
  const shutdown = async () => { server.close(); if (client) await client.close(); process.exit(0); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (require.main === module) {
  main().catch(async error => {
    console.error(error.message || error);
    if (client) await client.close().catch(() => {});
    process.exit(1);
  });
}

module.exports = { app, validEmail, validIsbn, escapeRegex, lateDays, dateOnly, isObjectId, csvCell, validPassword, loginRateState, recordLoginFailure, requireStaff, requireMember };
