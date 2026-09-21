// Entry point: Telegram-only gate, required-channel gate, router, back button.
import { isTelegram, initTelegram, backButton, notify, askWriteAccess } from "./telegram.js";
import { api } from "./api.js";
import { esc } from "./utils.js";

import gate       from "./pages/gate.js";
import dashboard  from "./pages/dashboard.js";
import profile    from "./pages/profile.js";
import history    from "./pages/history.js";
import referral   from "./pages/referral.js";
import task       from "./pages/task.js";
import withdrawal from "./pages/withdrawal.js";
import admin      from "./pages/admin.js";

const routes = { home: dashboard, profile, history, referral, task, withdrawal, admin };

if (!isTelegram()) {
  document.getElementById("blocked").hidden = false;
} else {
  boot();
}

function boot() {
  initTelegram();
  const app = document.getElementById("app");
  app.hidden = false;
  askWriteAccess();

  function showError(err) {
    app.innerHTML = `<div class="empty">${esc(err.message)}<div class="gap"></div><button class="btn sm" id="retry">Try again</button></div>`;
    app.querySelector("#retry").onclick = enter;
  }

  // Step 1: make sure the user is in every required channel. Step 2: show the app.
  async function enter() {
    backButton.hide();
    app.innerHTML = `<div class="loading">Loading…</div>`;
    try {
      const g = await api.getGate();
      if (!g.passed) return gate.render(app, { gate: g, onPass: enter });
    } catch (err) {
      return showError(err);
    }
    go("home");
  }

  async function go(name) {
    const page = routes[name] || routes.home;
    app.innerHTML = `<div class="loading">Loading…</div>`;
    window.scrollTo(0, 0);
    name === "home" ? backButton.hide() : backButton.show();
    try {
      await page.render(app, { go });
    } catch (err) {
      if (err.gate) return enter(); // user left a required channel: show the gate again
      app.innerHTML = `<div class="empty">Couldn't load this page.<br>${esc(err.message)}</div>`;
    }
  }

  backButton.onClick(() => go("home"));
  window.addEventListener("bw:gate", enter); // any page can request the gate
  enter();
}
