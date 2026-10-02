// Going That Way: admin page. Sign in with the email + password created in Supabase.
const db = makeClient();
const cfg = window.GTW_CONFIG || {};
let tab = "pay", data = { jobs: [], trips: [], biz: [], profiles: [] };

const T = {
  payReminder: j => `Hi ${j.sender_name}, it's Going That Way. Your job (${j.item}, ${j.from_town} to ${j.to_town}, by ${fmtDate(j.window_end)}) goes live once it's paid: $${Math.round(j.price_estimate || 0)} to ${cfg.BANK_NAME || "Going That Way"} ${cfg.BANK_ACCOUNT || "(account)"}, reference ${jobRef(j)}. We hold it until it's delivered.`,
  paidLive: j => `Thanks ${j.sender_name}, payment received for your ${j.item} (${jobRef(j)}). It's now on the board for drivers heading ${j.from_town} to ${j.to_town}. The driver will text you before pickup.`,
  driverWelcome: t => `Hi ${t.driver_name}, thanks for signing up to drive with Going That Way. Before your first job, please reply with a photo of your driver licence and your number plate. Once checked, your trips go live instantly and you can take jobs yourself.`,
  noDriver: j => `Hi ${j.sender_name}, no driver has taken your ${j.item} yet (${jobRef(j)}). You can: 1) give it more days, 2) meet the driver on the route (cheaper, more drivers say yes), or 3) cancel for a full refund. Just reply 1, 2 or 3.`,
};
async function copy(text, btn) {
  try { await navigator.clipboard.writeText(text); btn.textContent = "Copied"; }
  catch { const ta = btn.closest(".card").querySelector("textarea.tmpl"); if (ta) { ta.value = text; ta.hidden = false; ta.select(); } btn.textContent = "Select and copy below"; }
  setTimeout(() => (btn.textContent = btn.dataset.label), 1800);
}
const phoneLink = p => p ? `<a href="tel:${esc(String(p).replace(/\s/g, ""))}">${esc(p)}</a>` : "–";
const btnCopy = (label, text) => `<button class="btn small" type="button" data-copy="${esc(text)}" data-label="${label}">${label}</button>`;
const tripOf = j => data.trips.find(t => t.id === j.matched_trip);
const verified = uid => !!data.profiles.find(p => p.id === uid)?.verified_driver;
const profileOf = uid => data.profiles.find(p => p.id === uid) || {};
const ID_LABEL = { driver_licence: "Driver licence", passport: "Passport", kiwi_access: "Kiwi Access card", other: "Other photo ID" };
const idChip = st => st === "verified" ? `<span class="chip g">ID verified</span>` : st === "pending" ? `<span class="chip y">ID being checked</span>` : `<span class="chip">ID not verified</span>`;

// Show a member's uploaded documents (only the admin can read them)
async function showDocs(root = document) {
  for (const el of root.querySelectorAll("[data-docs]")) {
    const uid = el.dataset.docs;
    const { data: files, error } = await db.storage.from("id-docs").list(uid, { sortBy: { column: "created_at", order: "asc" } });
    if (error || !files?.length) { el.innerHTML = `<p class="fine">No documents on file${error ? ": " + esc(error.message) : "."}</p>`; continue; }
    const paths = files.map(f => `${uid}/${f.name}`);
    const { data: signed } = await db.storage.from("id-docs").createSignedUrls(paths, 600);
    el.dataset.paths = paths.join("|");
    el.innerHTML = `<div class="photos">${paths.map(p => { const u = signed?.find(s => s.path === p)?.signedUrl; const k = p.split("/")[1].split("-")[0]; return u ? `<a href="${esc(u)}" target="_blank" rel="noopener" style="width:150px"><img src="${esc(u)}" alt="${esc(k)}" style="width:150px;height:150px"><span>${esc(k)}</span></a>` : ""; }).join("")}</div>`;
  }
}
async function deleteDocs(uid) {
  const { data: files } = await db.storage.from("id-docs").list(uid);
  if (files?.length) { const { error } = await db.storage.from("id-docs").remove(files.map(f => `${uid}/${f.name}`)); if (error) throw error; }
}
function idCheckCard(p) {
  return `<div class="card">
    <div class="row"><span class="item">${esc(p.name || "(no name)")}</span><span class="chip y">${esc(ID_LABEL[p.id_type] || "ID")}</span></div>
    <dl class="kv"><dt>Email</dt><dd>${esc(p.email || "")}</dd><dt>Mobile</dt><dd>${phoneLink(p.phone)}</dd><dt>Address</dt><dd>${esc(p.address || "–")}</dd></dl>
    <div data-docs="${p.id}"><p class="fine">Loading documents…</p></div>
    <p class="fine">Check: the name matches the account, the ID isn't expired, and the selfie is the same person as the ID photo.</p>
    <div class="acts"><button class="btn small go" data-idok="${p.id}">Verified: delete photos</button>
      <input id="note-${p.id}" placeholder="Reason if not (e.g. photo blurry)" style="width:auto;flex:1;min-width:160px;font-size:14px;padding:6px 8px">
      <button class="btn small" data-idno="${p.id}">Can't verify</button></div>
  </div>`;
}
function driverCheckCard(p) {
  const plate = esc(p.vehicle_plate || "");
  return `<div class="card">
    <div class="row"><span class="item">${esc(p.name || "(no name)")}</span>${idChip(p.id_status)}</div>
    <dl class="kv"><dt>Mobile</dt><dd>${phoneLink(p.phone)}</dd><dt>Address</dt><dd>${esc(p.address || "–")}</dd>
      <dt>Licence</dt><dd>${esc(p.licence_class || "?")}</dd>
      <dt>Vehicle</dt><dd><b class="num">${plate}</b> · ${esc(p.vehicle_make || "")} · ${esc(SPACE_LABEL[p.vehicle_space] || "")}
        · <a href="https://www.carjam.co.nz/car/?plate=${plate}" target="_blank" rel="noopener">make and model on CarJam</a>
        · <a href="https://transact.nzta.govt.nz/transactions/CheckExpiry/entry" target="_blank" rel="noopener">WoF and rego expiry on NZTA</a> (type in ${plate})</dd></dl>
    <div data-docs="${p.id}"><p class="fine">Loading documents…</p></div>
    <p class="fine">Check: a full or restricted licence (not a learner's), not expired, name matches, selfie matches. Check the make and model match on CarJam, then get the WoF and rego expiry dates from NZTA and enter them below.</p>
    <div class="fields" style="grid-template-columns:1fr 1fr">
      <div class="field"><label for="wof-${p.id}">WoF expires</label><input id="wof-${p.id}" type="date"></div>
      <div class="field"><label for="rego-${p.id}">Rego expires</label><input id="rego-${p.id}" type="date"></div>
    </div>
    <div class="acts"><button class="btn small go" data-drok="${p.id}">Approve driver: delete photos</button>
      <input id="note-${p.id}" placeholder="Reason if not" style="width:auto;flex:1;min-width:160px;font-size:14px;padding:6px 8px">
      <button class="btn small" data-drno="${p.id}">Can't approve</button></div>
  </div>`;
}
const expectedPrice = j => estimate({ from: j.from_town, to: j.to_town, size: j.size, handover: j.handover, deadline: j.deadline_time || (j.job_date === j.window_end ? "express" : null), cover: 500, check: j.check_first })?.total;
const DRIVER_OWED = ["delivered", "no_show", "declined"];
const CHECK_LABEL = { waiting: "photos sent, waiting for the buyer", approved: "buyer said yes", declined: "buyer said no" };

// ---------- login ----------
function loginView(msg = "") {
  $("#outBtn").hidden = true;
  $("#view").innerHTML = `<section><div class="card"><h3>Sign in</h3>${db ? "" : `<div class="err">Not connected: fill in config.js first.</div>`}
    <form id="login"><div class="fields">
      <div class="field full"><label for="l-email">Email</label><input id="l-email" type="email" autocomplete="username" required></div>
      <div class="field full"><label for="l-pass">Password</label><input id="l-pass" type="password" autocomplete="current-password" required></div>
    </div>${msg ? `<div class="err">${esc(msg)}</div>` : ""}<button class="btn go" type="submit">Sign in</button></form></div></section>`;
}
async function load() {
  const [j, t, b, p] = await Promise.all([
    db.from("jobs").select("*").order("created_at", { ascending: false }),
    db.from("trips").select("*").order("trip_date"),
    db.from("business_interest").select("*").order("created_at", { ascending: false }),
    db.from("profiles").select("*"),
  ]);
  const err = j.error || t.error || b.error || p.error;
  if (err) { $("#view").innerHTML = `<div class="err">Couldn't load data: ${esc(err.message)}. Have you run the latest database update?</div>`; return; }
  data = { jobs: j.data, trips: t.data, biz: b.data, profiles: p.data };
  render();
}

// ---------- cards ----------
function jobCard(j) {
  const t = tripOf(j), exp = expectedPrice(j), priceOk = exp == null || Math.abs(exp - (j.price_estimate || 0)) <= 2;
  const statusSel = `<select data-status="jobs:${j.id}" style="width:auto;font-size:14px;padding:5px 8px">${["new", "open", "matched", "collected", "delivered", "cancelled", "no_show", "declined"].map(o => `<option${o === j.status ? " selected" : ""}>${o}</option>`).join("")}</select>`;
  const paySel = `<select data-pay="${j.id}" style="width:auto;padding:2px 6px;font-size:13px">${["unpaid", "paid", "refunded", "part_refunded"].map(o => `<option${o === j.payment ? " selected" : ""}>${o}</option>`).join("")}</select>`;
  return `<div class="card">
    <div class="row"><div>${j.kind === "pickup" ? `<span class="tag">Pick-up-only buy</span> ` : ""}<span class="item">${esc(j.item)}</span></div>${statusSel}</div>
    <dl class="kv">
      <dt>Ref / price</dt><dd class="num"><b>${jobRef(j)}</b> · $${Math.round(j.price_estimate || 0)} all in · driver $${driverFromPrice(j.price_estimate)}${priceOk ? "" : ` · <span style="color:var(--warn)">check price: expected $${exp}</span>`}</dd>
      <dt>Route</dt><dd>${esc(j.from_town)} → ${esc(j.to_town)} · ${fmtDate(j.job_date)} to ${fmtDate(j.window_end)}${j.deadline_time ? ", by " + fmtTime(j.deadline_time) : ""}</dd>
      <dt>Sender</dt><dd>${esc(j.sender_name)} · ${phoneLink(j.sender_phone)} ${idChip(profileOf(j.user_id).id_status)}</dd>
      ${j.seller_name || j.seller_phone ? `<dt>Seller</dt><dd>${esc(j.seller_name || "")} · ${phoneLink(j.seller_phone)}</dd>` : ""}
      <dt>Collect</dt><dd>${esc(j.pickup_address || "–")} · ${esc(PICKUP_LABEL[j.pickup_mode] || "")}${j.pickup_hours ? " · " + esc(j.pickup_hours) : ""}${j.pickup_notes ? " · " + esc(j.pickup_notes) : ""}</dd>
      <dt>Deliver</dt><dd>${esc(j.drop_address || "–")}</dd>
      <dt>Item</dt><dd>${j.item_type ? esc(itemTypeShort(j.item_type)) + " · " : ""}${esc(SIZE_SHORT[j.size] || j.size)} · not insured (trial)</dd>
      ${j.check_first ? `<dt>Check first</dt><dd>${esc(CHECK_LABEL[j.check_status] || "not done yet")}${j.check_note ? ` · driver's note: "${esc(j.check_note)}"` : ""}</dd>` : ""}
      ${j.listing_url ? `<dt>Listing</dt><dd><a href="${esc(j.listing_url)}" target="_blank" rel="noopener">Open listing</a></dd>` : ""}
      ${j.description ? `<dt>Notes</dt><dd>${esc(j.description)}</dd>` : ""}
      ${t ? `<dt>Driver</dt><dd>${esc(t.driver_name)} · ${phoneLink(t.driver_phone)} · ${fmtDate(t.trip_date)} · <a href="${esc(mapWithJob(j, t))}" target="_blank" rel="noopener">route with job</a></dd>` : ""}
      ${j.collected_at ? `<dt>Collected</dt><dd>${new Date(j.collected_at).toLocaleString("en-NZ")}</dd>` : ""}
      ${j.delivered_at ? `<dt>Delivered</dt><dd>${new Date(j.delivered_at).toLocaleString("en-NZ")}</dd>` : ""}
    </dl>
    <div class="acts">
      ${j.status === "new" && j.payment === "unpaid" ? `<button class="btn small go" data-golive="${j.id}"${profileOf(j.user_id).id_status === "verified" ? "" : ` disabled title="Verify the sender's ID first"`}>Payment received: go live</button>${profileOf(j.user_id).id_status === "verified" ? "" : `<span class="fine">Verify the sender's ID first (ID checks).</span>`}${btnCopy("Copy payment reminder", T.payReminder(j))}` : ""}
      ${j.status === "open" ? btnCopy("Copy 'it's live' text", T.paidLive(j)) + btnCopy("Copy 'no driver yet' text", T.noDriver(j)) : ""}
      <label class="chip" style="display:inline-flex;gap:6px;align-items:center">Payment ${paySel}</label>
      ${DRIVER_OWED.includes(j.status) && ["paid", "part_refunded"].includes(j.payment) ? `<label class="chip" style="display:inline-flex;gap:6px;align-items:center"><input type="checkbox" data-dpaid="${j.id}"${j.driver_paid ? " checked" : ""} style="width:auto"> Driver paid</label>` : ""}
    </div>
    ${["matched", "collected", "delivered", "no_show", "declined"].includes(j.status) ? `<div data-photos="${j.id}"></div>` : ""}
    ${j.status === "declined" ? `<p class="fine">Buyer said no after the check photos, so it wasn't collected. Refund the buyer their payment minus the driver's pay ($${driverFromPrice(j.price_estimate)}), then set payment to part_refunded. The driver's pay goes in the payout.</p>` : ""}
    ${j.status === "no_show" ? `<p class="fine">No-show: refund the sender their payment minus the driver's pay ($${driverFromPrice(j.price_estimate)}), then set payment to part_refunded. The driver's pay goes in the payout.</p>` : ""}
    <textarea class="tmpl" hidden aria-label="Text to copy"></textarea>
  </div>`;
}
function tripCard(t) {
  const jobs = data.jobs.filter(j => j.matched_trip === t.id);
  const v = verified(t.user_id);
  return `<div class="card">
    <div class="row"><span class="item">${esc(t.from_town)} → ${esc(t.to_town)}</span>${v ? `<span class="chip g">Verified driver</span>` : `<span class="chip y">Not verified</span>`}</div>
    <dl class="kv">
      <dt>Driver</dt><dd>${esc(t.driver_name)} · ${phoneLink(t.driver_phone)}</dd>
      <dt>From / to</dt><dd>${esc(t.from_suburb || "?")}, ${esc(t.from_town)} → ${esc(t.to_suburb || "?")}, ${esc(t.to_town)}</dd>
      <dt>When</dt><dd>${fmtDate(t.trip_date)}${t.depart_time ? ", leaving " + fmtTime(t.depart_time) : ""}${t.regular ? " · regular run" : ""} · ${esc(t.status)}</dd>
      <dt>Vehicle</dt><dd>${esc(SPACE_LABEL[t.space])}${t.vehicle ? " · " + esc(t.vehicle) : ""}${t.space_note ? " · " + esc(t.space_note) : ""}</dd>
      ${jobs.length ? `<dt>Jobs</dt><dd>${jobs.map(j => `${esc(j.item)} (${esc(j.status)})`).join(", ")}</dd>` : ""}
    </dl>
    ${v ? "" : `<p class="fine">This driver isn't approved yet. Check them under Driver checks.</p>`}
    <textarea class="tmpl" hidden aria-label="Text to copy"></textarea>
  </div>`;
}
const bizCard = b => `<div class="card"><span class="item">${esc(b.business_name)}</span><dl class="kv">
  <dt>Town</dt><dd>${esc(b.town)} · sends ${esc(b.sends_per_week || "?")} a week</dd>
  <dt>Contact</dt><dd>${esc(b.contact_name)} · ${phoneLink(b.contact_phone)}${b.contact_email ? " · " + esc(b.contact_email) : ""}</dd>
  ${b.notes ? `<dt>Notes</dt><dd>${esc(b.notes)}</dd>` : ""}</dl></div>`;
function payouts() {
  const owed = data.jobs.filter(j => DRIVER_OWED.includes(j.status) && ["paid", "part_refunded"].includes(j.payment) && !j.driver_paid && j.matched_trip);
  const by = {};
  owed.forEach(j => { const t = tripOf(j); if (!t) return; (by[t.driver_phone] ||= { name: t.driver_name, phone: t.driver_phone, jobs: [], total: 0 }); by[t.driver_phone].jobs.push(j); by[t.driver_phone].total += driverFromPrice(j.price_estimate); });
  const list = Object.values(by);
  if (!list.length) return `<div class="empty">No driver payouts owed.</div>`;
  return list.map(d => `<div class="card"><div class="row"><span class="item">${esc(d.name)}</span><b class="num">$${d.total}</b></div>
    <p class="sub">${phoneLink(d.phone)} · ${d.jobs.map(j => `${esc(j.item)} (${jobRef(j)}, $${driverFromPrice(j.price_estimate)})`).join(", ")}</p>
    <p class="fine">Pay by bank transfer, reference "GTW payout". Ask for their account number the first time.</p>
    <button class="btn small go" data-payall="${d.jobs.map(j => j.id).join(",")}">Mark all ${d.jobs.length} paid</button></div>`).join("");
}

function render() {
  const J = s => data.jobs.filter(j => s.includes(j.status));
  const toPay = data.jobs.filter(j => j.status === "new" && j.payment === "unpaid");
  const idChecks = data.profiles.filter(p => p.id_status === "pending");
  const drChecks = data.profiles.filter(p => p.driver_status === "pending");
  const live = J(["open", "matched", "collected"]);
  const upcoming = data.trips.filter(t => t.trip_date >= todayISO() && ["open", "new"].includes(t.status));
  const owed = data.jobs.filter(j => DRIVER_OWED.includes(j.status) && ["paid", "part_refunded"].includes(j.payment) && !j.driver_paid).length;
  const tabs = [["pay", "Payments to check", toPay.length], ["ids", "ID checks", idChecks.length], ["drivers", "Driver checks", drChecks.length], ["live", "Live jobs", live.length], ["trips", "Trips", upcoming.length], ["payouts", "Payouts", owed], ["biz", "Businesses", data.biz.length], ["past", "Past", 0]];
  const body = {
    pay: toPay.map(jobCard).join("") || `<div class="empty">No payments to check.</div>`,
    ids: idChecks.map(idCheckCard).join("") || `<div class="empty">No IDs waiting to be checked.</div>`,
    drivers: drChecks.map(driverCheckCard).join("") || `<div class="empty">No drivers waiting to be checked.</div>`,
    live: live.map(jobCard).join("") || `<div class="empty">No live jobs.</div>`,
    trips: upcoming.map(tripCard).join("") || `<div class="empty">No upcoming trips.</div>`,
    payouts: payouts(),
    biz: data.biz.map(bizCard).join("") || `<div class="empty">No businesses yet.</div>`,
    past: J(["delivered", "cancelled", "no_show", "declined"]).map(jobCard).join("") || `<div class="empty">Nothing yet.</div>`,
  }[tab];
  const bankWarn = bankSet() ? "" : `<div class="err">Add your business bank account to config.js, so senders see where to pay.</div>`;
  $("#outBtn").hidden = false;
  setTimeout(() => { showPhotos(db); showDocs(); }, 0);
  $("#view").innerHTML = bankWarn + `<nav class="a-tabs">${tabs.map(([k, l, n]) => `<button data-tab="${k}" aria-selected="${tab === k}">${l}${n ? `<span class="count">${n}</span>` : ""}</button>`).join("")}<button class="btn small" id="refresh" style="margin-left:auto">Refresh</button></nav><section>${body}</section>`;
}

async function update(table, id, patch) {
  const { error } = await db.from(table).update(patch).eq("id", id);
  if (error) return alertBox(error.message);
  await load();
}
function alertBox(msg) { const s = document.querySelector("#view section"); if (s) s.insertAdjacentHTML("afterbegin", `<div class="err">${esc(msg)}</div>`); }

document.addEventListener("submit", async e => {
  if (e.target.id !== "login") return; e.preventDefault();
  const { error } = await db.auth.signInWithPassword({ email: $("#l-email").value.trim(), password: $("#l-pass").value });
  if (error) return loginView("Sign-in failed: " + error.message);
  start();
});
document.addEventListener("click", async e => {
  const t = e.target.closest(".a-tabs [data-tab]"); if (t) { tab = t.dataset.tab; return render(); }
  if (e.target.closest("#refresh")) return load();
  if (e.target.closest("#outBtn")) { await db.auth.signOut(); return loginView(); }
  const c = e.target.closest("[data-copy]"); if (c) return copy(c.dataset.copy, c);
  const gl = e.target.closest("[data-golive]"); if (gl) return update("jobs", gl.dataset.golive, { payment: "paid", status: "open" });
  const busyBtn = async (btn, fn) => { btn.disabled = true; const l = btn.textContent; btn.textContent = "Working…"; try { await fn(); await load(); } catch (err) { btn.disabled = false; btn.textContent = l; alertBox(err.message || String(err)); } };
  const ok = e.target.closest("[data-idok]");
  if (ok) return busyBtn(ok, async () => { const uid = ok.dataset.idok; const { error } = await db.rpc("admin_review_id", { p_user: uid, p_ok: true, p_note: null }); if (error) throw error; await deleteDocs(uid); });
  const no = e.target.closest("[data-idno]");
  if (no) return busyBtn(no, async () => { const uid = no.dataset.idno; const note = ($("#note-" + uid)?.value || "").trim() || null; const { error } = await db.rpc("admin_review_id", { p_user: uid, p_ok: false, p_note: note }); if (error) throw error; await deleteDocs(uid); });
  const dok = e.target.closest("[data-drok]");
  if (dok) return busyBtn(dok, async () => { const uid = dok.dataset.drok; const wof = $("#wof-" + uid)?.value || null, rego = $("#rego-" + uid)?.value || null;
    const { error } = await db.rpc("admin_review_driver", { p_user: uid, p_ok: true, p_wof: wof, p_rego: rego, p_note: null }); if (error) throw error; await deleteDocs(uid); });
  const dno = e.target.closest("[data-drno]");
  if (dno) return busyBtn(dno, async () => { const uid = dno.dataset.drno; const note = ($("#note-" + uid)?.value || "").trim() || null;
    const { error } = await db.rpc("admin_review_driver", { p_user: uid, p_ok: false, p_wof: null, p_rego: null, p_note: note }); if (error) throw error; await deleteDocs(uid); });
  const vf = e.target.closest("[data-verify]");
  if (vf) { const { error } = await db.rpc("admin_verify_driver", { p_user: vf.dataset.verify, p_ok: true }); if (error) return alertBox(error.message); return load(); }
  const pa = e.target.closest("[data-payall]");
  if (pa) { for (const id of pa.dataset.payall.split(",")) { const { error } = await db.from("jobs").update({ driver_paid: true }).eq("id", id); if (error) return alertBox(error.message); } return load(); }
});
document.addEventListener("change", e => {
  const py = e.target.closest("[data-pay]"); if (py) return update("jobs", py.dataset.pay, { payment: py.value });
  const dp = e.target.closest("[data-dpaid]"); if (dp) return update("jobs", dp.dataset.dpaid, { driver_paid: dp.checked });
  const s = e.target.closest("[data-status]"); if (s) { const [tb, id] = s.dataset.status.split(":"); return update(tb, id, { status: s.value }); }
});

async function start() {
  if (!db) return loginView();
  const { data: s } = await db.auth.getSession();
  if (!s.session || s.session.user.is_anonymous) return loginView();
  const { data: p } = await db.from("profiles").select("is_admin").eq("id", s.session.user.id).single();
  if (!p?.is_admin) { await db.auth.signOut(); return loginView("This account isn't an admin yet."); }
  load();
}
start();
