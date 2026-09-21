// Withdrawal requests: mark as paid, or reject (the amount is refunded to the user).
import { api } from "../../api.js";
import { confirmBox, haptic, notify } from "../../telegram.js";
import { esc, money, fmtDate, fail } from "../../utils.js";

let filter = "pending";

export default {
  async render(el) {
    async function show() {
      const list = await api.admin.withdrawals(filter);
      el.innerHTML = `
        <div class="tabs small">
          ${["pending", "paid", "rejected"].map((s) =>
            `<button class="tab${s === filter ? " on" : ""}" data-filter="${s}">${s[0].toUpperCase() + s.slice(1)}</button>`).join("")}
        </div>
        ${list.length ? list.map((w) => `
          <div class="card">
            <div class="head" style="display:flex;justify-content:space-between;gap:8px">
              <b>${money(w.amount)}</b>
              <span class="hint" style="margin:0">${esc(fmtDate(w.date))}</span>
            </div>
            <div class="hint">${esc(w.name)}${w.username ? " · @" + esc(w.username) : ""} · ID ${esc(w.user_id)}</div>
            <div class="link mono" style="margin:10px 0">${esc(w.address)}</div>
            <div class="acts">
              <button class="btn sm ghost" data-act="copy" data-addr="${esc(w.address)}">Copy address</button>
              ${w.status === "pending" ? `
                <button class="btn sm" data-act="paid" data-id="${w.id}">Mark paid</button>
                <button class="btn sm danger" data-act="reject" data-id="${w.id}">Reject</button>` : ""}
            </div>
          </div>`).join("") : `<div class="card empty">No ${filter} withdrawals.</div>`}`;

      el.querySelectorAll("[data-filter]").forEach((b) => { b.onclick = () => { filter = b.dataset.filter; show(); }; });
      el.querySelectorAll("[data-act]").forEach((b) => {
        b.onclick = async () => {
          try {
            if (b.dataset.act === "copy") {
              await navigator.clipboard.writeText(b.dataset.addr).catch(() => {});
              haptic("success");
              return notify("Address copied.");
            }
            const id = Number(b.dataset.id);
            if (b.dataset.act === "paid") {
              if (!(await confirmBox("Mark as paid? Make sure you already sent the money."))) return;
              b.disabled = true;
              await api.admin.payWithdrawal(id);
            } else {
              if (!(await confirmBox("Reject and refund this withdrawal?"))) return;
              b.disabled = true;
              await api.admin.rejectWithdrawal(id);
            }
            haptic("success");
            show();
          } catch (err) {
            b.disabled = false;
            fail(err);
            if (err.status === 404) show();
          }
        };
      });
    }
    await show();
  }
};
