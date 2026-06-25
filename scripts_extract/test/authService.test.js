const test = require('node:test');
const assert = require('node:assert/strict');
const { hashPassword, verifyPassword, signToken, verifyToken } = require('../src/services/authService');

test('password hashes verify without storing the original password', () => {
  const hash = hashPassword('correct horse battery staple');
  assert.equal(verifyPassword('correct horse battery staple', hash), true);
  assert.equal(verifyPassword('wrong password', hash), false);
  assert.equal(hash.includes('correct horse'), false);
});

test('signed authentication tokens reject tampering', () => {
  const token = signToken({ _id: 'user-123', role: 'owner' });
  assert.equal(verifyToken(token).sub, 'user-123');
  assert.throws(() => verifyToken(`${token}x`));
});
