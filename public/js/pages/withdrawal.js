import { api } from "../api.js";
import { notify, haptic } from "../telegram.js";
import { money, pageTop, fail } from "../utils.js";

export default {
  async render(el, { go }) {
    const me = await api.getMe();
    const maxText = me.max_withdraw > 0 ? money(me.max_withdraw) : "No limit";

    el.innerHTML = `
      <section class="page">
        ${pageTop("Withdrawal", "Cash out your balance")}
        <div class="body">
          <div class="card">
            <div class="row"><span class="l">Available</span><span class="r">${money(me.balance)}</span></div>
            <div class="row"><span class="l">Minimum</span><span class="r">${money(me.min_withdraw)}</span></div>
            <div class="row"><span class="l">Maximum</span><span class="r">${maxText}</span></div>
            <label for="amount">Amount (USD)</label>
            <input id="amount" type="number" inputmode="decimal" step="any" placeholder="0.00">
            <label for="addr">Wallet address</label>
            <input id="addr" type="text" placeholder="Paste your wallet address">
            <div style="height:16px"></div>
            <button class="btn" id="submit">Request withdrawal</button>
          </div>
        </div>
      </section>`;

    const btn = el.querySelector("#submit");
    btn.onclick = async () => {
      const amount = parseFloat(el.querySelector("#amount").value);
      const address = el.querySelector("#addr").value.trim();

      if (!amount || amount < me.min_withdraw) { haptic("error"); return notify("Minimum withdrawal is " + money(me.min_withdraw) + "."); }
      if (me.max_withdraw > 0 && amount > me.max_withdraw) { haptic("error"); return notify("Maximum withdrawal is " + money(me.max_withdraw) + "."); }
      if (amount > me.balance) { haptic("error"); return notify("Amount is higher than your balance."); }
      if (address.length < 10) { haptic("error"); return notify("Enter a valid wallet address."); }

      btn.disabled = true;
      try {
        await api.requestWithdrawal({ amount, address });
        haptic("success");
        notify("Withdrawal requested. It's now pending review.");
        go("history");
      } catch (err) {
        btn.disabled = false;
        fail(err);
      }
    };
  }
};
