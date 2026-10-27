// Teacher/admin helper for a forgotten password:
//   node reset-password.js <userid> <newpassword>
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const file = path.join(process.env.DATA_DIR || path.join(__dirname, 'data'), 'db.json');
const [, , id, pw] = process.argv;
if (!id || !pw || pw.length < 6) { console.log('Usage: node reset-password.js <userid> <newpassword (6+ chars)>'); process.exit(1); }
const db = JSON.parse(fs.readFileSync(file, 'utf8'));
const u = db.users[id.toLowerCase()];
if (!u) { console.log('No such user:', id); process.exit(1); }
u.salt = crypto.randomBytes(16).toString('hex');
u.hash = crypto.scryptSync(pw, u.salt, 64).toString('hex');
for (const k of Object.keys(db.sessions)) if (db.sessions[k].u === u.username) delete db.sessions[k];
fs.writeFileSync(file + '.tmp', JSON.stringify(db));
fs.renameSync(file + '.tmp', file);
console.log('Password reset for', u.username, '(they are logged out everywhere).');
