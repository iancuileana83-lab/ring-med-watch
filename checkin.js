// One-time "I checked in" tokens. The email carries the token; only its SHA-256 hash is stored,
// so a database leak cannot be used to resolve alerts.
const crypto = require('crypto');

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/; // 32 random bytes, base64url

function newToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

module.exports = { newToken, hashToken, TOKEN_RE };
