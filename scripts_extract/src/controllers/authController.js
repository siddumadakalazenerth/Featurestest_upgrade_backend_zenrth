const User = require('../models/User');
const { hashPassword, verifyPassword, signToken } = require('../services/authService');
const Listing = require('../models/Listing');

function publicUser(user) {
  return {
    _id: user._id,
    name: user.name,
    email: user.email,
    role: user.role,
    plan: user.plan,
    monthlyToolLimit: user.monthlyToolLimit,
  };
}

async function register(req, res, next) {
  try {
    const name = String(req.body?.name || '').trim();
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    if (!name || !email.includes('@') || password.length < 8) {
      return res.status(400).json({ error: 'Name, valid email, and an 8-character password are required.' });
    }
    if (await User.exists({ email })) return res.status(409).json({ error: 'An account already exists.' });
    const user = await User.create({ name, email, passwordHash: hashPassword(password) });
    // Smooth migration for the original single-user prototype data.
    await Listing.updateMany({ owner: { $exists: false } }, { owner: user._id });
    res.status(201).json({ token: signToken(user), user: publicUser(user) });
  } catch (error) {
    next(error);
  }
}

async function login(req, res, next) {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    const user = await User.findOne({ email, active: true }).select('+passwordHash');
    if (!user || !verifyPassword(password, user.passwordHash)) {
      return res.status(401).json({ error: 'Email or password is incorrect.' });
    }
    res.json({ token: signToken(user), user: publicUser(user) });
  } catch (error) {
    next(error);
  }
}

function me(req, res) {
  res.json(publicUser(req.user));
}

module.exports = { register, login, me };
