import { api } from "../../api.js";
import { notify, haptic } from "../../telegram.js";
import { esc, fail } from "../../utils.js";

export default {
  async render(el) {
    const s = await api.admin.getSettings();
    el.innerHTML = `
      <div class="card">
        <label for="s-ref">Referral reward (USD per friend)</label>
        <input id="s-ref" type="number" inputmode="decimal" step="any" value="${esc(s.referral_reward)}">
        <p class="hint">Paid to the referrer after the new user opens the app and joins every required channel.</p>

        <label for="s-min">Minimum withdrawal (USD)</label>
        <input id="s-min" type="number" inputmode="decimal" step="any" value="${esc(s.min_withdraw)}">

        <label for="s-max">Maximum withdrawal (USD)</label>
        <input id="s-max" type="number" inputmode="decimal" step="any" value="${esc(s.max_withdraw)}">
        <p class="hint">Use 0 for no maximum.</p>

        <label for="s-welcome">Bot welcome message (sent on /start)</label>
        <textarea id="s-welcome" maxlength="1000">${esc(s.welcome_text)}</textarea>

        <div class="gap" style="height:16px"></div>
        <button class="btn" id="save">Save settings</button>
      </div>`;

    const btn = el.querySelector("#save");
    btn.onclick = async () => {
      btn.disabled = true;
      try {
        await api.admin.saveSettings({
          referral_reward: el.querySelector("#s-ref").value,
          min_withdraw: el.querySelector("#s-min").value,
          max_withdraw: el.querySelector("#s-max").value,
          welcome_text: el.querySelector("#s-welcome").value
        });
        haptic("success");
        notify("Settings saved.");
      } catch (err) {
        fail(err);
      }
      btn.disabled = false;
    };
  }
};
