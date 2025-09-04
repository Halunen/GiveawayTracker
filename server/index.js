// Giveaway Dashboard - full server (session-only total + pending chat view)
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const tmi = require('tmi.js');
const path = require('path');

const {
  PORT = 8080,
  TWITCH_CHANNEL,
  TWITCH_BOT,
  TWITCH_OAUTH,
  SHEET_WEBHOOK,         // POST URL (Apps Script doPost)
  NIGHTBOT_ACCESS_TOKEN = '',
  ADMIN_TOKEN = '',
  SHEET_KEY = '',        // optional: shared secret for Apps Script ?key=
  MOD_NAME = ''          // optional: default mod name if UI doesn't send one
} = process.env;

// Guard required env (SHEET_TOTAL no longer required for session totals)
if (!TWITCH_CHANNEL || !TWITCH_BOT || !TWITCH_OAUTH || !SHEET_WEBHOOK) {
  console.error('❌ Missing env vars:', {
    TWITCH_CHANNEL: !!TWITCH_CHANNEL,
    TWITCH_BOT: !!TWITCH_BOT,
    TWITCH_OAUTH: !!TWITCH_OAUTH,
    SHEET_WEBHOOK: !!SHEET_WEBHOOK
  });
  process.exit(1);
}

const app = express();
app.use(cors());
app.use(express.json());

// Serve the static dashboard from ../web
app.use('/', express.static(path.join(__dirname, '..', 'web')));

// Healthcheck
app.get('/ping', (_, res) => res.send('pong'));

// Simple auth for POST routes (optional)
function requireAdmin(req, res, next) {
  if (!ADMIN_TOKEN) return next(); // disabled if not set
  const token = req.headers['x-admin-token'] || req.query.token;
  if (token !== ADMIN_TOKEN) return res.status(401).json({ error: 'unauthorized' });
  next();
}

// Giveaway state (in-memory)
let state = {
  open: false,
  keyword: 'yo',
  entrants: new Set(),
  pendingWinner: null,  // { user, gid }
  pendingSince: null,   // ms timestamp when a winner was selected
  history: []           // { winner, gid, at }
};

// ---- Session-only total (server process memory) ----
let sessionTotal = 0;
const sessionDedup = new Set(); // gid or "manual:winner"

function bumpSessionTotal(amount, dedupeId) {
  const amt = Number(amount);
  if (!Number.isFinite(amt)) return { ok: false, error: 'invalid amount' };
  if (dedupeId && sessionDedup.has(String(dedupeId))) {
    return { ok: true, deduped: true, total: sessionTotal };
    }
  sessionTotal += amt;
  if (dedupeId) sessionDedup.add(String(dedupeId));
  return { ok: true, total: sessionTotal };
}
// ---------------------------------------------------

// Rolling buffer of recent messages per user (for winner_msgs and pending chat)
const recentMsgs = new Map(); // username -> [{ text, at }]
const MSG_KEEP_MS = 5 * 60 * 1000; // keep last 5 minutes
const MAX_PER_USER = 50;           // cap per user
const MAX_ENTRANTS = 7500;         // hard cap on unique entrants (first 7,500)

// Twitch IRC client
const client = new tmi.Client({
  identity: { username: TWITCH_BOT, password: TWITCH_OAUTH },
  channels: [TWITCH_CHANNEL]
});

client.on('connected', () => {
  console.log('✅ Connected to Twitch IRC as', TWITCH_BOT, 'listening in', TWITCH_CHANNEL);
});

client.connect().catch((e) => {
  console.error('❌ Failed to connect to Twitch IRC', e);
  process.exit(1);
});

// Collect entrants while open & buffer recent messages
client.on('message', (channel, tags, message, self) => {
  if (self) return;
  const display = (tags['display-name'] || tags.username || '').trim();
  const text = (message || '').trim();
  const lower = text.toLowerCase();

  // --- entrants: unique + cap at 7500 ---
  if (state.open && lower === (state.keyword || '').toLowerCase()) {
    if (state.entrants.size < MAX_ENTRANTS || state.entrants.has(display)) {
      state.entrants.add(display); // Set ensures one entry per person
    }
  }

  // --- record recent messages (for winner_msgs & pending chat view) ---
  const now = Date.now();
  const arr = recentMsgs.get(display) || [];
  arr.push({ text, at: now });

  // trim per-user buffer and drop too-old messages
  while (arr.length > MAX_PER_USER) arr.shift();
  while (arr.length && (now - arr[0].at) > MSG_KEEP_MS) arr.shift();

  recentMsgs.set(display, arr);
});

// Helpers
async function sayInChat(msg) {
  if (NIGHTBOT_ACCESS_TOKEN) {
    try {
      await fetch('https://api.nightbot.tv/1/channel/send', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${NIGHTBOT_ACCESS_TOKEN}`,
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: new URLSearchParams({ message: msg })
      });
    } catch (e) { console.error('Nightbot send failed:', e.message); }
  } else {
    try { await client.say(TWITCH_CHANNEL, msg); }
    catch (e) { console.error('Bot say failed:', e.message); }
  }
}

// Webhook with ?key= and simple retries
async function logToSheet(payload) {
  try {
    const url = new URL(SHEET_WEBHOOK);
    if (SHEET_KEY) url.searchParams.set('key', SHEET_KEY);

    const attempts = [500, 1000, 2000]; // backoff in ms
    const body = JSON.stringify(payload);

    for (let i = 0; i < attempts.length; i++) {
      try {
        const r = await fetch(url.toString(), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body
        });
        const text = await r.text();
        let json = {};
        try { json = JSON.parse(text); } catch (_) {}
        if (r.ok && json.ok !== false) return json;
        console.error('Webhook non-OK', r.status, text);
      } catch (e) {
        console.error('Webhook error', e.message);
      }
      await new Promise(res => setTimeout(res, attempts[i]));
    }
  } catch (e) {
    console.error('Webhook fatal', e.message);
  }
  throw new Error('Failed to log to sheet after retries');
}

function newGid() { return Date.now().toString(); }

// API
app.get('/status', (req, res) => {
  res.json({
    channel: TWITCH_CHANNEL,
    open: state.open,
    keyword: state.keyword,
    entrantCount: state.entrants.size,
    entrants: [...state.entrants],
    pendingWinner: state.pendingWinner,
    pendingSince: state.pendingSince,  // <-- expose since timestamp
    history: state.history,
    maxEntrants: MAX_ENTRANTS,
    maxReached: state.entrants.size >= MAX_ENTRANTS,
    // optional: expose session total in status
    sessionTotal
  });
});

// Read-only endpoint for session total if needed by the UI
app.get('/session-total', (req, res) => {
  res.json({ ok: true, total: sessionTotal });
});

// New: fetch a user's recent messages, optionally since a timestamp
// GET /user-messages?user=<displayName>&since=<ms>
app.get('/user-messages', (req, res) => {
  const user = String(req.query.user || '').trim();
  const since = req.query.since ? Number(req.query.since) : null;
  if (!user) return res.status(400).json({ ok: false, error: 'missing user' });

  const now = Date.now();
  const arr = (recentMsgs.get(user) || [])
    .filter(m => now - m.at <= MSG_KEEP_MS)       // only keep messages in our buffer window
    .filter(m => (since ? m.at >= since : true))  // if since provided, filter
    .slice(-50);                                  // cap

  res.json({ ok: true, user, messages: arr });
});

app.post('/start', requireAdmin, async (req, res) => {
  const { keyword = 'yo' } = req.body || {};
  state.open = true;
  state.keyword = String(keyword || 'yo');
  state.entrants = new Set();
  state.pendingWinner = null;
  state.pendingSince = null;

  console.log(`✅ Giveaway started with keyword "${state.keyword}"`);
  setTimeout(() => sayInChat(`Giveaway started — type ${state.keyword} to enter! Giveaway is open until closed.`), 0);
  res.json({ ok: true });
});

// Manual close endpoint
app.post('/close', requireAdmin, async (req, res) => {
  if (!state.open) return res.status(400).json({ error: 'Giveaway is not open.' });
  state.open = false;
  state.pendingWinner = null;
  state.pendingSince = null;
  console.log('✅ Giveaway closed');
  setTimeout(() => sayInChat(`Giveaway is now closed.`), 0);
  res.json({ ok: true });
});

// ✅ Roll — instant response + console log
app.post('/roll', requireAdmin, async (req, res) => {
  const arr = [...state.entrants];

  if (!arr.length) {
    state.pendingWinner = null;
    state.pendingSince = null;
    console.log('⚠️ Tried to roll, but no entrants');
    return res.json({ ok: true, pendingWinner: null });
  }

  const pick = arr[Math.floor(Math.random() * arr.length)];
  state.pendingWinner = { user: pick, gid: newGid() };
  state.pendingSince = Date.now(); // <-- start tracking for chat view

  console.log('🎲 Rolled winner:', pick);
  res.json({ ok: true, pendingWinner: state.pendingWinner });

  // fire-and-forget chat message
  setTimeout(() => sayInChat(`Winner is @${pick}! Respond in chat!`), 0);
});

// ✅ Reroll — instant response + console log
app.post('/reroll', requireAdmin, async (req, res) => {
  const arr = [...state.entrants];

  if (!arr.length) {
    state.pendingWinner = null;
    state.pendingSince = null;
    console.log('⚠️ Tried to reroll, but no entrants');
    return res.json({ ok: true, pendingWinner: null });
  }

  const pick = arr[Math.floor(Math.random() * arr.length)];
  state.pendingWinner = { user: pick, gid: newGid() };
  state.pendingSince = Date.now(); // <-- start tracking for chat view

  console.log('🎲 Rerolled winner:', pick);
  res.json({ ok: true, pendingWinner: state.pendingWinner });

  // fire-and-forget chat message
  setTimeout(() => sayInChat(`New winner is @${pick}!`), 0);
});

app.post('/cancel', requireAdmin, (req, res) => {
  state.pendingWinner = null;
  state.pendingSince = null; // clear tracking
  console.log('⚠️ Pending winner cancelled');
  res.json({ ok: true });
});

app.post('/confirm', requireAdmin, async (req, res) => {
  const { winner, amount = '', note = '', mod: modFromBody } = req.body || {};
  const picked = winner || state.pendingWinner?.user;
  if (!picked) return res.status(400).json({ error: 'No winner to confirm.' });

  // Collect winner's recent messages (last 5 min), up to 10 lines
  const now = Date.now();
  const msgs = (recentMsgs.get(picked) || [])
    .filter(m => now - m.at <= MSG_KEEP_MS)
    .map(m => m.text)
    .slice(-10);
  const winner_msgs = msgs.join(' | ');

  // Determine mod name
  const mod = (modFromBody && String(modFromBody)) || MOD_NAME || '';

  console.log('✅ Confirmed winner:', picked);
  setTimeout(() => sayInChat(`Confirmed @${picked}! 🎉`), 0);

  // Minimal payload; Apps Script computes ET timestamp & viewer card link
  await logToSheet({
    channel: TWITCH_CHANNEL.replace('#',''),
    winner: picked,
    amount,
    winner_msgs,
    mod
  });

  // ---- Session total bump (server process) ----
  // Prefer pending gid; for manual confirms, dedupe by the winner string.
  const dedupeId = state.pendingWinner?.gid ? state.pendingWinner.gid : `manual:${picked}`;
  const bump = bumpSessionTotal(amount, dedupeId);
  if (bump.deduped) {
    console.log('ℹ️ Session total dedupe hit for', dedupeId);
  } else if (!bump.ok) {
    console.warn('⚠️ Session total not bumped:', bump.error);
  }
  // ---------------------------------------------

  state.history.unshift({ winner: picked, gid: state.pendingWinner?.gid || newGid(), at: Date.now() });
  if (state.history.length > 50) state.history.pop();
  state.pendingWinner = null;
  state.pendingSince = null; // clear after confirm

  res.json({ ok: true, sessionTotal });
});

// 404
app.use((req,res) => res.status(404).json({error:'not found'}));

// Start
app.listen(Number(PORT), () => {
  console.log('✅ Server listening', {
    PORT,
    channel: TWITCH_CHANNEL,
    bot: TWITCH_BOT,
    hasOAuth: !!TWITCH_OAUTH,
    hasWebhook: !!SHEET_WEBHOOK
  });
});

process.on('unhandledRejection', (r) => console.error('UNHANDLED', r));
process.on('uncaughtException', (e) => console.error('UNCAUGHT', e));
