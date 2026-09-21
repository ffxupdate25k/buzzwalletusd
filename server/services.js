// Business logic. Every money movement happens inside a database transaction.
const { pool, tx, getSettings } = require('./db');
const tgApi = require('./telegram');
const { ADMIN_IDS } = require('./config');
const { HttpError } = require('./errors');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function money(n) {
  const v = Number(n);
  const two = v.toFixed(2);
  return '$' + (Number(two) === v ? two : v.toFixed(4).replace(/0+$/, ''));
}

function displayName(u) {
  const full = [u.first_name, u.last_name].filter(Boolean).join(' ');
  return full || (u.username ? '@' + u.username : 'User ' + u.id);
}

// ---------- Messaging ----------
async function notifyUser(id, text, extra) {
  try {
    await tgApi.sendMessage(id, text, extra);
    return true;
  } catch (e) {
    if (e.code === 403) pool.query('UPDATE users SET bot_blocked = TRUE WHERE id = $1', [id]).catch(() => {});
    console.warn('Could not message', id, '-', e.message);
    return false;
  }
}

function notifyAdmins(text) {
  ADMIN_IDS.forEach((id) => { notifyUser(id, text); });
}

// ---------- Users and referrals ----------
async function registerUser(u, refId) {
  const { rows } = await pool.query(
    `INSERT INTO users (id, first_name, last_name, username, language_code, photo_url)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (id) DO UPDATE SET
       first_name = EXCLUDED.first_name,
       last_name = EXCLUDED.last_name,
       username = EXCLUDED.username,
       language_code = EXCLUDED.language_code,
       photo_url = COALESCE(EXCLUDED.photo_url, users.photo_url),
       last_seen = now()
     RETURNING *, (xmax = 0) AS inserted`,
    [u.id, u.first_name || null, u.last_name || null, u.username || null, u.language_code || null, u.photo_url || null]
  );
  const user = rows[0];
  // A referral is only saved for brand-new users, and never for yourself.
  if (user.inserted && refId && Number(refId) !== Number(user.id)) {
    await createPendingReferral(user, Number(refId));
  }
  return user;
}

// Saved when a new user sends /start (or opens the app) with a referral link. No money moves yet.
async function createPendingReferral(user, referrerId) {
  let reward = 0;
  try {
    const ok = await tx(async (c) => {
      const ref = await c.query('SELECT id FROM users WHERE id = $1', [referrerId]);
      if (!ref.rowCount) return false;
      reward = (await getSettings(c)).referral_reward;
      await c.query('UPDATE users SET referred_by = $1 WHERE id = $2', [referrerId, user.id]);
      await c.query(
        `INSERT INTO referrals (referred_id, referrer_id, reward, status) VALUES ($1, $2, 0, 'pending')`,
        [user.id, referrerId]
      );
      return true;
    });
    if (!ok) return;
  } catch (e) {
    console.error('Could not save referral:', e.message);
    return;
  }
  const earn = reward > 0 ? ` You'll earn ${money(reward)} once they open the app and join the required channels.` : '';
  notifyUser(referrerId, `👋 ${displayName(user)} started the bot with your referral link.${earn}`);
}

// Pays the referrer. Called when the referred user passes the channel gate. Safe to call many times.
async function completeReferral(userId) {
  let done = null;
  try {
    done = await tx(async (c) => {
      const { rows } = await c.query(
        `SELECT referrer_id FROM referrals WHERE referred_id = $1 AND status = 'pending' FOR UPDATE`,
        [userId]
      );
      if (!rows.length) return null;
      const referrerId = rows[0].referrer_id;
      const reward = (await getSettings(c)).referral_reward;
      const u = await c.query('SELECT id, first_name, last_name, username FROM users WHERE id = $1', [userId]);
      const name = displayName(u.rows[0]);
      await c.query(
        `UPDATE referrals SET status = 'completed', reward = $2, completed_at = now() WHERE referred_id = $1`,
        [userId, reward]
      );
      if (reward > 0) {
        await c.query('UPDATE users SET balance = balance + $1 WHERE id = $2', [reward, referrerId]);
        await c.query(
          `INSERT INTO transactions (user_id, amount, type, title) VALUES ($1, $2, 'referral', $3)`,
          [referrerId, reward, 'Referral: ' + name]
        );
      }
      return { referrerId, reward, name };
    });
  } catch (e) {
    console.error('Referral completion failed:', e.message);
    return;
  }
  if (done) {
    const line = done.reward > 0 ? `\nYou earned ${money(done.reward)}.` : '';
    notifyUser(done.referrerId, `🎉 ${done.name} opened the app and joined the required channels!${line}`);
  }
}

// ---------- Required-channel gate ----------
const GATE_TTL_MS = 10 * 60 * 1000; // a passed check is trusted this long before re-checking
const gatePass = new Map(); // userId -> time until which the pass is trusted

const isMember = (m) =>
  ['creator', 'administrator', 'member'].includes(m.status) || (m.status === 'restricted' && m.is_member === true);

function clearGateCache() { gatePass.clear(); }

async function checkGate(userId, { force = false } = {}) {
  if (!force) {
    const until = gatePass.get(userId);
    if (until && until > Date.now()) return { passed: true, channels: [] };
  }

  const { rows } = await pool.query('SELECT id, title, chat_id, url FROM channels WHERE active ORDER BY id');
  const channels = await Promise.all(rows.map(async (ch) => {
    let joined = false;
    let error = false;
    try {
      joined = isMember(await tgApi.getChatMember(ch.chat_id, userId));
    } catch (e) {
      error = true;
      console.error(`Gate check failed for channel ${ch.id} (${ch.chat_id}):`, e.message);
    }
    return { id: ch.id, title: ch.title, url: ch.url, joined, error };
  }));

  const passed = channels.every((c) => c.joined);
  if (passed) {
    if (gatePass.size > 20000) {
      const now = Date.now();
      for (const [k, v] of gatePass) if (v < now) gatePass.delete(k);
    }
    gatePass.set(userId, Date.now() + GATE_TTL_MS);
    await completeReferral(userId); // the referrer is paid the moment the user gets through
  } else {
    gatePass.delete(userId);
  }
  return { passed, channels };
}

// ---------- Tasks ----------
async function completeAutoTask(task, userId) {
  return tx(async (c) => {
    try {
      await c.query(
        `INSERT INTO task_submissions (task_id, user_id, status, reviewed_at) VALUES ($1, $2, 'approved', now())`,
        [task.id, userId]
      );
    } catch (e) {
      if (e.code === '23505') throw new HttpError(409, 'You already completed this task.');
      throw e;
    }
    const r = await c.query('UPDATE users SET balance = balance + $1 WHERE id = $2 RETURNING balance', [task.reward, userId]);
    await c.query(
      `INSERT INTO transactions (user_id, amount, type, title) VALUES ($1, $2, 'task', $3)`,
      [userId, task.reward, 'Task: ' + task.title]
    );
    return r.rows[0].balance;
  });
}

async function reviewSubmission(id, approve, adminId) {
  const s = await tx(async (c) => {
    const { rows } = await c.query(
      `SELECT s.id, s.user_id, t.title, t.reward
         FROM task_submissions s JOIN tasks t ON t.id = s.task_id
        WHERE s.id = $1 AND s.status = 'pending' FOR UPDATE OF s`,
      [id]
    );
    if (!rows.length) throw new HttpError(404, 'Already reviewed or not found.');
    const sub = rows[0];
    await c.query(
      `UPDATE task_submissions SET status = $2, reviewed_at = now(), reviewed_by = $3 WHERE id = $1`,
      [id, approve ? 'approved' : 'rejected', adminId]
    );
    if (approve) {
      await c.query('UPDATE users SET balance = balance + $1 WHERE id = $2', [sub.reward, sub.user_id]);
      await c.query(
        `INSERT INTO transactions (user_id, amount, type, title) VALUES ($1, $2, 'task', $3)`,
        [sub.user_id, sub.reward, 'Task: ' + sub.title]
      );
    }
    return sub;
  });
  notifyUser(
    s.user_id,
    approve
      ? `✅ Your task "${s.title}" was approved. You earned ${money(s.reward)}.`
      : `❌ Your screenshot for "${s.title}" was rejected. Open the app to submit a new one.`
  );
}

// ---------- Withdrawals ----------
async function createWithdrawal(user, amountIn, addressIn) {
  const s = await getSettings();
  const amount = Math.round(Number(amountIn) * 10000) / 10000;
  const address = String(addressIn || '').trim();
  if (!(amount > 0)) throw new HttpError(400, 'Enter a valid amount.');
  if (amount < s.min_withdraw) throw new HttpError(400, `Minimum withdrawal is ${money(s.min_withdraw)}.`);
  if (s.max_withdraw > 0 && amount > s.max_withdraw) throw new HttpError(400, `Maximum withdrawal is ${money(s.max_withdraw)}.`);
  if (address.length < 10 || address.length > 200) throw new HttpError(400, 'Enter a valid wallet address.');

  const result = await tx(async (c) => {
    const r = await c.query(
      'UPDATE users SET balance = balance - $1 WHERE id = $2 AND balance >= $1 RETURNING balance',
      [amount, user.id]
    );
    if (!r.rowCount) throw new HttpError(400, 'Amount is higher than your balance.');
    const t = await c.query(
      `INSERT INTO transactions (user_id, amount, type, title, status)
       VALUES ($1, $2, 'withdrawal', 'Withdrawal', 'pending') RETURNING id`,
      [user.id, -amount]
    );
    const w = await c.query(
      `INSERT INTO withdrawals (user_id, amount, address, transaction_id) VALUES ($1, $2, $3, $4) RETURNING id`,
      [user.id, amount, address, t.rows[0].id]
    );
    return { id: w.rows[0].id, balance: r.rows[0].balance };
  });
  notifyAdmins(`💸 New withdrawal request: ${money(amount)} from ${displayName(user)} (ID ${user.id}). Open the Admin panel > Withdrawals.`);
  return result;
}

async function processWithdrawal(id, action, adminId) {
  const w = await tx(async (c) => {
    const { rows } = await c.query(`SELECT * FROM withdrawals WHERE id = $1 AND status = 'pending' FOR UPDATE`, [id]);
    if (!rows.length) throw new HttpError(404, 'Already processed or not found.');
    const row = rows[0];
    if (action === 'paid') {
      await c.query(`UPDATE withdrawals SET status = 'paid', processed_at = now(), processed_by = $2 WHERE id = $1`, [id, adminId]);
      await c.query(`UPDATE transactions SET status = 'completed' WHERE id = $1`, [row.transaction_id]);
    } else {
      await c.query(`UPDATE withdrawals SET status = 'rejected', processed_at = now(), processed_by = $2 WHERE id = $1`, [id, adminId]);
      await c.query(`UPDATE transactions SET status = 'rejected' WHERE id = $1`, [row.transaction_id]);
      await c.query('UPDATE users SET balance = balance + $1 WHERE id = $2', [row.amount, row.user_id]);
      await c.query(
        `INSERT INTO transactions (user_id, amount, type, title) VALUES ($1, $2, 'refund', 'Withdrawal refunded')`,
        [row.user_id, row.amount]
      );
    }
    return row;
  });
  notifyUser(
    w.user_id,
    action === 'paid'
      ? `✅ Your withdrawal of ${money(w.amount)} has been paid.`
      : `❌ Your withdrawal of ${money(w.amount)} was rejected. The amount is back in your balance.`
  );
}

// ---------- Admin balance changes ----------
async function adjustBalance(userId, delta, note) {
  return tx(async (c) => {
    const u = await c.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [userId]);
    if (!u.rowCount) throw new HttpError(404, 'User not found.');
    const r = await c.query(
      'UPDATE users SET balance = balance + $1 WHERE id = $2 AND balance + $1 >= 0 RETURNING balance',
      [delta, userId]
    );
    if (!r.rowCount) throw new HttpError(400, "Balance can't go below zero.");
    const title = note ? 'Admin: ' + note : delta > 0 ? 'Bonus from admin' : 'Balance adjusted by admin';
    await c.query(
      `INSERT INTO transactions (user_id, amount, type, title) VALUES ($1, $2, 'adjustment', $3)`,
      [userId, delta, title]
    );
    return r.rows[0].balance;
  });
}

// ---------- Broadcast ----------
async function runBroadcast(id, text) {
  let sent = 0;
  let failed = 0;
  try {
    const { rows } = await pool.query('SELECT id FROM users WHERE bot_blocked = FALSE');
    await pool.query('UPDATE broadcasts SET total = $1 WHERE id = $2', [rows.length, id]);

    for (const row of rows) {
      let done = false;
      for (let attempt = 0; attempt < 2 && !done; attempt++) {
        try {
          await tgApi.sendMessage(row.id, text);
          sent++;
          done = true;
        } catch (e) {
          if (e.code === 429 && e.retryAfter) {
            await sleep((e.retryAfter + 1) * 1000);
            continue; // retry once
          }
          if (e.code === 403) await pool.query('UPDATE users SET bot_blocked = TRUE WHERE id = $1', [row.id]).catch(() => {});
          failed++;
          done = true;
        }
      }
      if ((sent + failed) % 20 === 0) {
        await pool.query('UPDATE broadcasts SET sent = $1, failed = $2 WHERE id = $3', [sent, failed, id]);
      }
      await sleep(50); // stay well under Telegram's ~30 messages/second limit
    }
    await pool.query(`UPDATE broadcasts SET sent = $1, failed = $2, status = 'done' WHERE id = $3`, [sent, failed, id]);
  } catch (e) {
    console.error('Broadcast failed:', e.message);
    await pool.query(`UPDATE broadcasts SET sent = $1, failed = $2, status = 'error' WHERE id = $3`, [sent, failed, id]).catch(() => {});
  }
}

module.exports = {
  money, displayName, notifyUser, notifyAdmins,
  registerUser, completeReferral, checkGate, clearGateCache, completeAutoTask, reviewSubmission,
  createWithdrawal, processWithdrawal, adjustBalance, runBroadcast
};
