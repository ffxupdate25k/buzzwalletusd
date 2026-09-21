require('dotenv').config();
const path = require('path');
const express = require('express');
const config = require('./config');
const { init } = require('./db');
const tgApi = require('./telegram');
const { HttpError } = require('./errors');

if (!config.BOT_TOKEN) { console.error('BOT_TOKEN is missing. Add it to your environment variables.'); process.exit(1); }
if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is missing. Add it to your environment variables.'); process.exit(1); }

const app = express();
app.disable('x-powered-by');

app.get('/healthz', (req, res) => res.send('ok'));
app.use('/telegram', require('./routes/webhook'));

// Screenshot uploads are larger than normal JSON requests.
const json = (req, res, next) => {
  const big = req.method === 'POST' && /^\/tasks\/\d+\/submit$/.test(req.path);
  return express.json({ limit: big ? '6mb' : '100kb' })(req, res, next);
};
app.use('/api/admin', json, require('./routes/admin'));
app.use('/api', json, require('./routes/user'));
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

app.use(express.static(path.join(__dirname, '..', 'public')));

app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  if (err instanceof HttpError) return res.status(err.status).json({ ...err.extra, error: err.message });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'That file is too large.' });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Bad request.' });
  console.error(err);
  res.status(500).json({ error: 'Something went wrong. Please try again.' });
});

(async () => {
  await init();
  app.listen(config.PORT, () => console.log('Server running on port ' + config.PORT));

  try {
    const me = await tgApi.getMe();
    config.state.bot.id = me.id;
    config.state.bot.username = me.username;
    console.log('Bot: @' + me.username);
  } catch (e) {
    console.error('Could not reach Telegram. Is BOT_TOKEN correct?', e.message);
    process.exit(1);
  }

  if (config.PUBLIC_URL) {
    try {
      await tgApi.setWebhook(config.PUBLIC_URL + '/telegram/webhook', config.WEBHOOK_SECRET);
      await tgApi.setChatMenuButton('Open', config.PUBLIC_URL);
      console.log('Webhook and menu button set to ' + config.PUBLIC_URL);
    } catch (e) {
      console.error('Could not set webhook:', e.message);
    }
  } else {
    console.warn('PUBLIC_URL is not set: the bot cannot receive /start, so referral notifications and the welcome message are off.');
  }
})().catch((e) => { console.error('Startup failed:', e); process.exit(1); });
