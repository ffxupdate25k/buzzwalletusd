# Buzz Wallet: Telegram Mini App + server

One Node.js server does everything: it serves the app, stores all data in Postgres, talks to your bot and runs the Admin panel.
Nothing is lost when users close the app, because balances, tasks and referrals live in the database.

## How referrals work
1. A friend opens `t.me/YourBot?start=ref_<referrer id>` and sends /start.
2. The bot replies with your welcome message and an **Open Buzz Wallet** button. The referral is saved as **pending** and the referrer gets a message.
3. The friend opens the Mini App. A **Join to continue** screen lists your required channels. They cannot get past it until the server confirms they are members.
4. The moment they pass, the referral becomes **completed**, the reward is credited and the referrer is notified.

Only brand-new users count, and nobody can refer themselves.

## Folder layout
```
package.json  .env.example  README.md
server/
  index.js        starts everything, sets the webhook and menu button
  config.js       environment settings
  db.js           tables, default settings, transactions
  auth.js         verifies Telegram login data, admin check, channel gate
  initdata.js     signature check
  telegram.js     Bot API helper
  services.js     referrals, gate, tasks, withdrawals, balance, broadcast
  errors.js
  routes/  user.js  admin.js  webhook.js
public/           the Mini App (index.html, style.css, js/...)
  js/pages/       gate, dashboard, profile, history, referral, task, withdrawal, admin
  js/pages/admin/ overview, settings, channels, tasks, proofs, payouts, users, broadcast
```

## Deploy (Render + free Postgres)
1. **Database:** create a free Postgres (Neon or Render Postgres) and copy its connection string.
2. **Code:** upload this folder to a GitHub repository.
3. **Render:** New > Web Service > pick the repo.
   - Build command: `npm install`
   - Start command: `npm start`
4. **Environment variables** (Render > Environment):
   - `BOT_TOKEN` = token from @BotFather
   - `DATABASE_URL` = the Postgres connection string
   - `ADMIN_IDS` = `7995243814` (comma separate to add more admins)
   - `PUBLIC_URL` = your Render address, like `https://buzz-wallet.onrender.com` (Render also provides it automatically)
5. Deploy. On startup the server creates the tables, sets the bot webhook and sets the bot's menu button to open the app. You do not need to set the Mini App URL in BotFather.
6. Open your bot and send /start. You should get the welcome message with the button.

The database tables are created automatically. Deploying a new version never deletes data.

> Use a host that runs a normal server (Render, Railway, Fly, a VPS). Static hosts like Vercel or Netlify cannot run this.
> Render's free plan sleeps when idle, so the first open can take about 30 seconds. A paid plan removes that.

## Admin panel
Open the app with the admin account and tap **Admin panel**. Everything is set here, nothing is hardcoded:

| Tab | What it does |
|-----|--------------|
| Overview | users, balances, referrals (joined/pending), tasks, proofs, withdrawals |
| Settings | referral reward, minimum and maximum withdrawal (0 = no maximum), bot welcome message |
| Channels | the channels/groups every user must join before using the app |
| Tasks | create tasks: **Auto** (bot checks channel/group membership) or **Screenshot** (you approve uploads) |
| Proofs | review task screenshots, approve to pay, reject to decline |
| Withdrawals | mark paid, or reject (the amount goes back to the user) |
| Users | search by ID or @username, add or remove balance |
| Broadcast | send a message to all users through the bot |

You get a bot message when a user requests a withdrawal or sends a screenshot.

### Channels and auto-verify tasks
The bot must be an **admin** in every channel or group you use, otherwise it cannot check membership. The panel warns you if it is not, and refuses to save a channel the bot cannot see.
Admins are never blocked by the join screen, so a mistake here cannot lock you out. Test the screen with a normal account.
Users who leave a required channel see the join screen again within about 10 minutes.

## Run on your computer (optional)
Copy `.env.example` to `.env`, fill it in, then `npm install` and `npm start`. Telegram needs an https address, so use a tunnel such as ngrok and set `PUBLIC_URL` to it.
