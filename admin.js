// Going That Way: admin page. Sign in with the email + password created in Supabase.
const db = makeClient();
const cfg = window.GTW_CONFIG || {};
let tab = "pay", data = { jobs: [], trips: [], biz: [], profiles: [], reports: [], oldPhotos: [], highValue: [] };

const T = {
  payReminder: j => `Hi ${j.sender_name}, it's Going That Way. Your job (${j.item}, ${j.from_town} to ${j.to_town}, by ${fmtDate(j.window_end)}) goes live once it's paid: $${Math.round(j.price_estimate || 0)} to ${cfg.BANK_NAME || "Going That Way"} ${cfg.BANK_ACCOUNT || "(account)"}, reference ${jobRef(j)}. We hold it until it's delivered.`,
  paidLive: j => `Thanks ${j.sender_name}, payment received for your ${j.item} (${jobRef(j)}). It's now on the board for drivers heading ${j.from_town} to ${j.to_town}. The driver will text you before pickup.`,
  driverWelcome: t => `Hi ${t.driver_name}, thanks for signing up to drive with Going That Way. Before your first job, please reply with a photo of your driver licence and your number plate. Once checked, your trips go live instantly and you can take jobs yourself.`,
  urgentAsk: (j, t) => `Hi ${(t.driver_name || "").split(" ")[0]}, it's Going That Way. Urgent job today: ${j.item}, ${j.from_town} to ${j.to_town}. It pays you $${driverPay(j)} and it's already paid for. Can you fit it in? Reply YES and I'll send the details.`,
  regularAsk: (j, p) => `Hi ${(p.name || "").split(" ")[0]}, it's Going That Way. Are you heading ${j.from_town} to ${j.to_town} today? Urgent job: ${j.item}, pays you $${driverPay(j)}. Reply YES if you can take it.`,
  urgentNoDriver: j => `Hi ${j.sender_name}, it's Going That Way about your urgent ${j.item} (${jobRef(j)}). We're still ringing around drivers heading that way today. We'll text you by 2 pm either way, and if we can't find anyone you get a full refund.`,
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
const verified = uid => { const p = data.profiles.find(p => p.id === uid); return !!p?.verified_driver && p?.driver_status === "verified"; };
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
const expectedPrice = j => estimate({ from: j.from_town, to: j.to_town, size: j.size, handover: j.handover, deadline: j.deadline_time || (j.job_date === j.window_end ? "express" : null), cover: 500, check: j.check_first, bonus: j.urgent_bonus })?.total;
const openReports = jobId => data.reports.filter(r => r.job_id === jobId && r.status === "open");
const DRIVER_OWED = ["delivered", "no_show", "declined"];
const CHECK_LABEL = { waiting: "photos sent, waiting for the buyer", approved: "buyer said yes", declined: "buyer said no" };

// ---------- login ----------
function loginView(msg = "") {
  $("#outBtn").hidden = true;
  $("#view").innerHTML = `<section><div class="card"><h3>Sign in</h3>${db ? "" : `<div class="err">Not connected: fill in config.js first.</div>`}
    <form id="login"><div class="fields">
      <div class="field full"><label for="l-email">Email</label><input id="l-email" type="email" autocomplete="username" required></div>
      <div class="field full"><label for="l-pass">Password</label><input id="l-pass" type="password" autocomplete="current-password" required></div>
    </div>${cfg.TURNSTILE_SITE_KEY ? `<div id="ts-admin" style="margin-top:10px"></div>` : ""}${msg ? `<div class="err">${esc(msg)}</div>` : ""}<button class="btn go" type="submit">Sign in</button></form></div></section>`;
  mountAdminTs();
}
let adminTs, adminTsTries = 0;
function mountAdminTs() {
  const el = document.getElementById("ts-admin"); if (!el || !cfg.TURNSTILE_SITE_KEY) return;
  if (!window.turnstile) { if (adminTsTries++ < 40) setTimeout(mountAdminTs, 250); return; }
  adminTs = window.turnstile.render(el, { sitekey: cfg.TURNSTILE_SITE_KEY, theme: "auto" });
}
async function load() {
  const [j, t, b, p, rp, op, hv] = await Promise.all([
    db.from("jobs").select("*").order("created_at", { ascending: false }),
    db.from("trips").select("*").order("trip_date"),
    db.from("business_interest").select("*").order("created_at", { ascending: false }),
    db.from("profiles").select("*"),
    db.from("job_reports").select("*").order("created_at", { ascending: false }),
    db.from("job_photos").select("id,path,created_at").lt("created_at", new Date(Date.now() - 365 * 864e5).toISOString()),
    db.from("high_value_requests").select("*").order("created_at", { ascending: false }),
  ]);
  const err = j.error || t.error || b.error || p.error;
  if (err) { $("#view").innerHTML = `<div class="err">Couldn't load data: ${esc(err.message)}. Have you run the latest database update?</div>`; return; }
  data = { jobs: j.data, trips: t.data, biz: b.data, profiles: p.data, reports: rp.error ? [] : rp.data, oldPhotos: op.error ? [] : op.data, highValue: hv.error ? [] : hv.data };
  render();
}

// ---------- cards ----------
function jobCard(j) {
  const t = tripOf(j), exp = expectedPrice(j), priceOk = exp == null || Math.abs(exp - (j.price_estimate || 0)) <= 2;
  const statusSel = `<select data-status="jobs:${j.id}" style="width:auto;font-size:14px;padding:5px 8px">${["new", "open", "matched", "collected", "delivered", "cancelled", "no_show", "declined"].map(o => `<option${o === j.status ? " selected" : ""}>${o}</option>`).join("")}</select>`;
  const paySel = `<select data-pay="${j.id}" style="width:auto;padding:2px 6px;font-size:13px">${["unpaid", "paid", "refunded", "part_refunded"].map(o => `<option${o === j.payment ? " selected" : ""}>${o}</option>`).join("")}</select>`;
  return `<div class="card">
    <div class="row"><div>${j.kind === "pickup" ? `<span class="tag">Pick-up-only buy</span> ` : j.kind === "collect" ? `<span class="tag">Click and collect</span> ` : ""}<span class="item">${esc(j.item)}</span>${j.urgent ? ` <span class="chip warn">Urgent today</span>` : ""}${openReports(j.id).length ? ` <span class="chip warn">Problem reported</span>` : ""}</div>${statusSel}</div>
    <dl class="kv">
      <dt>Ref / price</dt><dd class="num"><b>${jobRef(j)}</b> · $${Math.round(j.price_estimate || 0)} all in · driver $${driverPay(j)}${(j.urgent_bonus || j.admin_bonus) ? ` (incl. $${(j.urgent_bonus || 0) + (j.admin_bonus || 0)} bonus${j.admin_bonus ? `, $${j.admin_bonus} from us` : ""})` : ""}${priceOk ? "" : ` · <span style="color:var(--warn)">check price: expected $${exp}</span>`}</dd>
      <dt>Route</dt><dd>${esc(j.from_town)} → ${esc(j.to_town)} · ${fmtDate(j.job_date)} to ${fmtDate(j.window_end)}${j.deadline_time ? ", by " + fmtTime(j.deadline_time) : ""}</dd>
      <dt>Sender</dt><dd>${esc(j.sender_name)} · ${phoneLink(j.sender_phone)} ${idChip(profileOf(j.user_id).id_status)}</dd>
      ${j.seller_name || j.seller_phone ? `<dt>Seller</dt><dd>${esc(j.seller_name || "")} · ${phoneLink(j.seller_phone)}</dd>` : ""}
      ${j.kind === "collect" ? `<dt>Click and collect</dt><dd><b>${esc(j.store_name || "")}</b> · order <b class="num">${esc(j.order_ref || "")}</b> under ${esc(j.order_name || "")}</dd>` : ""}
      <dt>Collect</dt><dd>${esc(j.pickup_address || "–")} · ${esc(PICKUP_LABEL[j.pickup_mode] || "")}${j.pickup_hours ? " · " + esc(j.pickup_hours) : ""}${j.pickup_notes ? " · " + esc(j.pickup_notes) : ""}</dd>
      <dt>Deliver</dt><dd>${esc(j.drop_address || "–")}</dd>
      <dt>Item</dt><dd>${j.item_type ? esc(itemTypeShort(j.item_type)) + " · " : ""}${esc(SIZE_SHORT[j.size] || j.size)}${j.heavy ? " · <b>2-person lift</b>" : ""} · not insured (trial)</dd>
      ${j.check_first ? `<dt>Check first</dt><dd>${esc(CHECK_LABEL[j.check_status] || "not done yet")}${j.check_note ? ` · driver's note: "${esc(j.check_note)}"` : ""}</dd>` : ""}
      ${j.listing_url ? `<dt>Listing</dt><dd><a href="${esc(j.listing_url)}" target="_blank" rel="noopener">Open listing</a></dd>` : ""}
      ${j.description ? `<dt>Notes</dt><dd>${esc(j.description)}</dd>` : ""}
      ${t ? `<dt>Driver</dt><dd>${esc(t.driver_name)} · ${phoneLink(t.driver_phone)} · ${fmtDate(t.trip_date)} · <a href="${esc(mapWithJob(j, t))}" target="_blank" rel="noopener">route with job</a></dd>` : ""}
      ${j.collected_at ? `<dt>Collected</dt><dd>${new Date(j.collected_at).toLocaleString("en-NZ")}</dd>` : ""}
      ${j.delivered_at ? `<dt>Delivered</dt><dd>${new Date(j.delivered_at).toLocaleString("en-NZ")}</dd>` : ""}
      ${j.rating ? `<dt>Buyer</dt><dd>${j.rating > 0 ? "Thumbs up" : `<b style="color:var(--warn)">Thumbs down</b>`}${j.rating_note ? `: "${esc(j.rating_note)}"` : ""}</dd>` : ""}
    </dl>
    <div class="acts">
      ${j.status === "new" && j.payment === "unpaid" ? `<button class="btn small go" data-golive="${j.id}"${profileOf(j.user_id).id_status === "verified" ? "" : ` disabled title="Verify the sender's ID first"`}>Payment received: go live</button>${profileOf(j.user_id).id_status === "verified" ? "" : `<span class="fine">Verify the sender's ID first (ID checks).</span>`}${btnCopy("Copy payment reminder", T.payReminder(j))}` : ""}
      ${j.status === "open" ? btnCopy("Copy 'it's live' text", T.paidLive(j)) + btnCopy("Copy 'no driver yet' text", T.noDriver(j)) : ""}
      <label class="chip" style="display:inline-flex;gap:6px;align-items:center">Payment ${paySel}</label>
      ${DRIVER_OWED.includes(j.status) && ["paid", "part_refunded"].includes(j.payment) ? `<label class="chip" style="display:inline-flex;gap:6px;align-items:center"><input type="checkbox" data-dpaid="${j.id}"${j.driver_paid ? " checked" : ""} style="width:auto"> Driver paid</label>` : ""}
    </div>
    ${["matched", "collected", "delivered", "no_show", "declined"].includes(j.status) ? `<div data-photos="${j.id}"></div>` : ""}
    ${j.status === "declined" ? `<p class="fine">Buyer said no after the check photos, so it wasn't collected. Refund the buyer their payment minus the driver's pay ($${driverPay(j)}), then set payment to part_refunded. The driver's pay goes in the payout.</p>` : ""}
    ${j.status === "no_show" ? `<p class="fine">No-show: refund the sender their payment minus the driver's pay ($${driverPay(j)}), then set payment to part_refunded. The driver's pay goes in the payout.</p>` : ""}
    <textarea class="tmpl" hidden aria-label="Text to copy"></textarea>
  </div>`;
}
function reportCard(r) {
  const j = data.jobs.find(x => x.id === r.job_id) || {}, who = profileOf(r.reporter), t = tripOf(j);
  return `<div class="card"${r.status === "resolved" ? ' style="opacity:.75"' : ""}>
    <div class="row"><span class="item">${esc(REPORT_KINDS[r.kind] || r.kind)}</span><span class="chip ${r.status === "open" ? "warn" : "g"}">${r.status === "open" ? "Open" : "Sorted"}</span></div>
    <dl class="kv">
      <dt>Job</dt><dd><b class="num">${j.id ? jobRef(j) : "?"}</b> · ${esc(j.item || "")} · ${esc(j.from_town || "")} → ${esc(j.to_town || "")} · ${esc(j.status || "")}</dd>
      <dt>From</dt><dd>The ${esc(r.role)}: ${esc(who.name || "")} · ${phoneLink(who.phone)}</dd>
      <dt>When</dt><dd>${new Date(r.created_at).toLocaleString("en-NZ")}</dd>
      <dt>What happened</dt><dd style="white-space:pre-wrap">${esc(r.details)}</dd>
      ${j.id ? `<dt>Sender</dt><dd>${esc(j.sender_name || "")} · ${phoneLink(j.sender_phone)}</dd>` : ""}
      ${t ? `<dt>Driver</dt><dd>${esc(t.driver_name)} · ${phoneLink(t.driver_phone)}</dd>` : ""}
      ${r.admin_note ? `<dt>Your note</dt><dd>${esc(r.admin_note)}</dd>` : ""}
    </dl>
    ${j.id ? `<div data-photos="${j.id}"></div>` : ""}
    ${r.status === "open" ? `<div class="acts"><input id="rn-${r.id}" placeholder="What you did (the reporter sees this)" style="width:auto;flex:1;min-width:200px;font-size:14px;padding:6px 8px"><button class="btn small go" data-resolve="${r.id}">Mark sorted</button></div>` : ""}
  </div>`;
}
function approvedDriverCard(p) {
  const soon = todayISO(14), now = todayISO();
  const flag = d => !d ? `<span class="chip warn">No date</span>` : d < now ? `<span class="chip warn">Expired</span>` : d <= soon ? `<span class="chip y">Due soon</span>` : "";
  return `<div class="card"><div class="row"><span class="item">${esc(p.name || "")}</span><span class="chip g">Approved</span></div>
    <dl class="kv"><dt>Mobile</dt><dd>${phoneLink(p.phone)}</dd><dt>Vehicle</dt><dd><b class="num">${esc(p.vehicle_plate || "")}</b> · ${esc(p.vehicle_make || "")} · ${esc(SPACE_LABEL[p.vehicle_space] || "")}
      · <a href="https://transact.nzta.govt.nz/transactions/CheckExpiry/entry" target="_blank" rel="noopener">check on NZTA</a></dd>
      <dt>WoF</dt><dd>${p.wof_expiry ? fmtDate(p.wof_expiry) : "–"} ${flag(p.wof_expiry)}</dd><dt>Rego</dt><dd>${p.rego_expiry ? fmtDate(p.rego_expiry) : "–"} ${flag(p.rego_expiry)}</dd></dl>
    <div class="fields" style="grid-template-columns:1fr 1fr">
      <div class="field"><label for="wof-${p.id}">New WoF expiry</label><input id="wof-${p.id}" type="date" value="${esc(p.wof_expiry || "")}"></div>
      <div class="field"><label for="rego-${p.id}">New rego expiry</label><input id="rego-${p.id}" type="date" value="${esc(p.rego_expiry || "")}"></div>
    </div>
    <div class="acts"><button class="btn small go" data-redate="${p.id}">Update dates</button></div></div>`;
}
function urgentCard(j) {
  const today = todayISO(), trips = data.trips.filter(t => t.trip_date === today && t.status === "open");
  const on = trips.filter(t => jobFitsTrip(j, t)), near = trips.filter(t => !jobFitsTrip(j, t));
  const tripRow = (t, fits) => `<div class="sugg"><span><b>${esc(t.driver_name)}</b> · ${esc(t.from_town)} → ${esc(t.to_town)}${t.depart_time ? ", leaving " + fmtTime(t.depart_time) : ""} · ${esc(SPACE_LABEL[t.space] || "")}${fits ? "" : ` · <i>not an exact fit: ask about a detour</i>`}</span>
    <span class="acts"><a class="btn small" href="sms:${esc(String(t.driver_phone || "").replace(/\s/g, ""))}?&body=${encodeURIComponent(T.urgentAsk(j, t))}">Text</a>${phoneLink(t.driver_phone)}</span></div>`;
  const regulars = data.profiles.filter(p => p.verified_driver && p.driver_status === "verified" && !trips.some(t => t.user_id === p.id) && (SPACE_FITS[p.vehicle_space] || []).includes(j.size));
  return `${jobCard(j)}
    <div class="card" style="margin-top:-6px;border-top:0">
      <div class="label">Drivers out today on this route (${on.length})</div>${on.map(t => tripRow(t, true)).join("") || `<p class="fine">Nobody's posted a trip that covers this route today.</p>`}
      ${near.length ? `<div class="label">Other drivers out today</div>${near.map(t => tripRow(t, false)).join("")}` : ""}
      ${regulars.length ? `<div class="label">Approved drivers with room for it (no trip posted today)</div>${regulars.map(p => `<div class="sugg"><span><b>${esc(p.name || "")}</b> · ${esc(SPACE_LABEL[p.vehicle_space] || "")} ${esc(p.vehicle_make || "")}</span><span class="acts"><a class="btn small" href="sms:${esc(String(p.phone || "").replace(/\s/g, ""))}?&body=${encodeURIComponent(T.regularAsk(j, p))}">Text</a>${phoneLink(p.phone)}</span></div>`).join("")}` : ""}
      <div class="acts" style="margin-top:6px"><button class="btn small" data-bonus="${j.id}:10">+$10 to the driver (from us)</button>${j.admin_bonus ? `<button class="btn small" data-bonus="${j.id}:-10">−$10</button>` : ""}${btnCopy("Copy 'still looking' text to sender", T.urgentNoDriver(j))}</div>
      <p class="fine">The driver now gets $${driverPay(j)}. Bonuses you add come out of our side, so keep an eye on them.</p>
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
  owed.forEach(j => { const t = tripOf(j); if (!t) return; const k = t.user_id || t.driver_phone; (by[k] ||= { uid: t.user_id, name: t.driver_name, phone: t.driver_phone, jobs: [], total: 0 }); by[k].jobs.push(j); by[k].total += driverPay(j); });
  const list = Object.values(by);
  if (!list.length) return `<div class="empty">No driver payouts owed.</div>`;
  return list.map(d => { const p = profileOf(d.uid);
    return `<div class="card"><div class="row"><span class="item">${esc(d.name)}</span><b class="num">$${d.total}</b></div>
    <p class="sub">${phoneLink(d.phone)} · ${d.jobs.map(j => `${esc(j.item)} (${jobRef(j)}, $${driverPay(j)})`).join(", ")}</p>
    ${p.bank_account ? `<div class="sugg"><span>Pay <b class="num">$${d.total}</b> to <b class="num">${esc(p.bank_account)}</b> · ${esc(p.bank_account_name || "")} · reference <b>GTW payout</b></span><span class="acts">${btnCopy("Copy account", p.bank_account)}${btnCopy("Copy amount", String(d.total))}</span></div>`
      : `<div class="err">No bank account yet. Ask ${esc(d.name.split(" ")[0])} to add it under My account → Your earnings.</div>`}
    <button class="btn small go" data-payall="${d.jobs.map(j => j.id).join(",")}">Paid: mark all ${d.jobs.length} paid</button>
    <textarea class="tmpl" hidden aria-label="Text to copy"></textarea></div>`; }).join("");
}

async function cleanOldPhotos() {
  const rows = data.oldPhotos;
  for (let i = 0; i < rows.length; i += 100) {
    const batch = rows.slice(i, i + 100);
    const { error } = await db.storage.from("job-photos").remove(batch.map(r => r.path)); if (error) throw error;
    const { error: e2 } = await db.from("job_photos").delete().in("id", batch.map(r => r.id)); if (e2) throw e2;
  }
}
// ---------- Accounts: monthly summary and spreadsheet downloads ----------
let acctMonth = todayISO().slice(0, 7);
const RECEIVED = ["paid", "refunded", "part_refunded"];
function money(j) {
  const price = Math.round(Number(j.price_estimate) || 0), received = RECEIVED.includes(j.payment) ? price : 0;
  const owesDriver = received && DRIVER_OWED.includes(j.status) && j.matched_trip, driver = owesDriver ? driverPay(j) : 0;
  const refunded = j.payment === "refunded" ? price : j.payment === "part_refunded" ? Math.max(0, price - driver) : 0;
  return { price, received, refunded, driver, net: received - refunded - driver };
}
const monthJobs = m => data.jobs.filter(j => String(j.created_at).slice(0, 7) === m && RECEIVED.includes(j.payment));
function accounts() {
  const months = [...new Set(data.jobs.map(j => String(j.created_at).slice(0, 7)).concat(todayISO().slice(0, 7)))].sort().reverse();
  const js = monthJobs(acctMonth), tot = js.reduce((a, j) => { const m = money(j); a.received += m.received; a.refunded += m.refunded; a.driver += m.driver; a.net += m.net; return a; }, { received: 0, refunded: 0, driver: 0, net: 0 });
  const paidOut = data.jobs.filter(j => j.driver_paid && String(j.driver_paid_at || "").slice(0, 7) === acctMonth).reduce((n, j) => n + driverPay(j), 0);
  const label = m => new Date(m + "-01T00:00:00").toLocaleDateString("en-NZ", { month: "long", year: "numeric" });
  return `<div class="card"><div class="row"><h3>Accounts</h3><select id="acct-m" style="width:auto">${months.map(m => `<option value="${m}"${m === acctMonth ? " selected" : ""}>${label(m)}</option>`).join("")}</select></div>
    <div class="tiles">
      <div><span class="label">Jobs paid for</span><b class="num">${js.length}</b></div>
      <div><span class="label">Received</span><b class="num">$${tot.received}</b></div>
      <div><span class="label">Refunded</span><b class="num">$${tot.refunded}</b></div>
      <div><span class="label">Drivers' share</span><b class="num">$${tot.driver}</b></div>
      <div><span class="label">Kept by us</span><b class="num">$${tot.net}</b></div>
      <div><span class="label">Paid out to drivers this month</span><b class="num">$${paidOut}</b></div>
    </div>
    <p class="fine">Jobs are counted in the month they were posted. "Kept by us" is what we received, less refunds and the drivers' share (including any bonus we added). It's before costs. If you register for GST, check with your accountant how it applies to the fee and the drivers' share.</p>
    <div class="acts"><button class="btn small go" id="csv-jobs">Download jobs spreadsheet</button><button class="btn small" id="csv-payouts">Download driver payouts</button></div>
  </div>
  <div class="card"><h3>Old photos</h3>
    <p class="sub">The privacy policy says we keep job photos only while they're useful. Photos over 12 months old can be deleted.</p>
    ${data.oldPhotos.length ? `<p class="sub"><b>${data.oldPhotos.length}</b> photo${data.oldPhotos.length === 1 ? " is" : "s are"} over 12 months old.</p><div class="acts"><button class="btn small" id="cleanPhotos">Delete ${data.oldPhotos.length} old photo${data.oldPhotos.length === 1 ? "" : "s"}</button></div>` : `<p class="fine">None to delete.</p>`}
  </div>`;
}
function overView() {
  const r = data.highValue; if (!r.length) return `<div class="empty">No requests yet. They appear here when someone wants to send something worth more than $500.</div>`;
  const people = new Set(r.map(x => x.user_id)).size, total = r.reduce((n, x) => n + x.value, 0);
  const since = new Date(Date.now() - 30 * 864e5).toISOString(), recent = r.filter(x => x.created_at >= since).length;
  return `<div class="card"><h3>Demand for items over $500</h3>
    <div class="tiles"><div><span class="label">Requests</span><b class="num">${r.length}</b></div><div><span class="label">In the last 30 days</span><b class="num">${recent}</b></div>
      <div><span class="label">People</span><b class="num">${people}</b></div><div><span class="label">Total value</span><b class="num">$${total.toLocaleString("en-NZ")}</b></div></div>
    <p class="fine">These are jobs we couldn't take because of the $500 trial limit. When this list grows steadily, it's time to get goods-in-transit insurance quotes.</p></div>
    ${r.map(x => { const p = profileOf(x.user_id); return `<div class="card"><div class="row"><span class="item">${esc(x.item)}</span><b class="num">$${x.value.toLocaleString("en-NZ")}</b></div>
      <p class="sub">${esc(x.from_town || "?")} → ${esc(x.to_town || "?")} · ${new Date(x.created_at).toLocaleDateString("en-NZ")} · ${esc(p.name || "")} ${p.email ? "· " + esc(p.email) : ""}</p></div>`; }).join("")}`;
}
function csvDownload(name, rows) {
  const cell = v => { const s = v == null ? "" : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const blob = new Blob(["﻿" + rows.map(r => r.map(cell).join(",")).join("\r\n")], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}
function jobsCsv() {
  const rows = [["Posted", "Reference", "Type", "Item", "From", "To", "Status", "Payment", "Price", "Received", "Refunded", "Driver's share", "Kept by us", "Urgent bonus (sender)", "Bonus from us", "Driver", "Driver paid", "Driver paid on", "Delivered on"]];
  monthJobs(acctMonth).forEach(j => { const m = money(j), t = tripOf(j);
    rows.push([String(j.created_at).slice(0, 10), jobRef(j), j.kind, j.item, j.from_town, j.to_town, j.status, j.payment, m.price, m.received, m.refunded, m.driver, m.net, j.urgent_bonus || 0, j.admin_bonus || 0, t ? t.driver_name : "", j.driver_paid ? "yes" : "no", j.driver_paid_at ? String(j.driver_paid_at).slice(0, 10) : "", j.delivered_at ? String(j.delivered_at).slice(0, 10) : ""]); });
  csvDownload(`going-that-way-jobs-${acctMonth}.csv`, rows);
}
function payoutsCsv() {
  const rows = [["Paid on", "Driver", "Bank account", "Account name", "Reference", "Item", "Amount"]];
  data.jobs.filter(j => j.driver_paid && String(j.driver_paid_at || "").slice(0, 7) === acctMonth).forEach(j => { const t = tripOf(j) || {}, p = profileOf(t.user_id);
    rows.push([String(j.driver_paid_at).slice(0, 10), t.driver_name || "", p.bank_account || "", p.bank_account_name || "", jobRef(j), j.item, driverPay(j)]); });
  csvDownload(`going-that-way-driver-payouts-${acctMonth}.csv`, rows);
}

function render() {
  const J = s => data.jobs.filter(j => s.includes(j.status));
  const toPay = data.jobs.filter(j => j.status === "new" && j.payment === "unpaid");
  const idChecks = data.profiles.filter(p => p.id_status === "pending");
  const drChecks = data.profiles.filter(p => p.driver_status === "pending");
  const live = J(["open", "matched", "collected"]);
  const upcoming = data.trips.filter(t => t.trip_date >= todayISO() && ["open", "new"].includes(t.status));
  const owed = data.jobs.filter(j => DRIVER_OWED.includes(j.status) && ["paid", "part_refunded"].includes(j.payment) && !j.driver_paid).length;
  const urgent = data.jobs.filter(j => j.urgent && ["new", "open"].includes(j.status) && j.window_end >= todayISO());
  const probs = data.reports.filter(r => r.status === "open");
  const tabs = [["urgent", "Urgent", urgent.length], ["problems", "Problems", probs.length], ["pay", "Payments to check", toPay.length], ["ids", "ID checks", idChecks.length], ["drivers", "Driver checks", drChecks.length], ["live", "Live jobs", live.length], ["trips", "Trips", upcoming.length], ["payouts", "Payouts", owed], ["biz", "Businesses", data.biz.length], ["past", "Past", 0], ["accounts", "Accounts", 0], ["over500", "Over $500", data.highValue.length]];
  const body = {
    urgent: urgent.map(urgentCard).join("") || `<div class="empty">No urgent jobs waiting.</div>`,
    problems: (probs.map(reportCard).join("") || `<div class="empty">No open problems.</div>`) + (data.reports.some(r => r.status === "resolved") ? `<div class="label" style="margin-top:12px">Sorted</div>` + data.reports.filter(r => r.status === "resolved").slice(0, 20).map(reportCard).join("") : ""),
    pay: toPay.map(jobCard).join("") || `<div class="empty">No payments to check.</div>`,
    ids: idChecks.map(idCheckCard).join("") || `<div class="empty">No IDs waiting to be checked.</div>`,
    drivers: (drChecks.map(driverCheckCard).join("") || `<div class="empty">No drivers waiting to be checked.</div>`)
      + (() => { const ap = data.profiles.filter(p => p.driver_status === "verified").sort((a, b) => String([a.wof_expiry, a.rego_expiry].sort()[0]).localeCompare(String([b.wof_expiry, b.rego_expiry].sort()[0])));
        return ap.length ? `<div class="label" style="margin-top:14px">Approved drivers (soonest WoF or rego first)</div>` + ap.map(approvedDriverCard).join("") : ""; })(),
    live: live.map(jobCard).join("") || `<div class="empty">No live jobs.</div>`,
    trips: upcoming.map(tripCard).join("") || `<div class="empty">No upcoming trips.</div>`,
    payouts: payouts(),
    accounts: accounts(),
    over500: overView(),
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
  let captchaToken;
  if (cfg.TURNSTILE_SITE_KEY) { captchaToken = window.turnstile && adminTs !== undefined ? window.turnstile.getResponse(adminTs) : ""; if (!captchaToken) return loginView("Please complete the \"I'm human\" check first."); }
  const { error } = await db.auth.signInWithPassword({ email: $("#l-email").value.trim(), password: $("#l-pass").value, options: { captchaToken } });
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
  const rd = e.target.closest("[data-redate]");
  if (rd) return busyBtn(rd, async () => { const uid = rd.dataset.redate; const { error } = await db.rpc("admin_review_driver", { p_user: uid, p_ok: true, p_wof: $("#wof-" + uid)?.value || null, p_rego: $("#rego-" + uid)?.value || null, p_note: null }); if (error) throw error; });
  if (e.target.closest("#cleanPhotos")) { const b2 = e.target.closest("#cleanPhotos"); return busyBtn(b2, cleanOldPhotos); }
  const rs = e.target.closest("[data-resolve]");
  if (rs) return busyBtn(rs, async () => { const id = rs.dataset.resolve; const { error } = await db.from("job_reports").update({ status: "resolved", admin_note: ($("#rn-" + id)?.value || "").trim() || null, resolved_at: new Date().toISOString() }).eq("id", id); if (error) throw error; });
  const bn = e.target.closest("[data-bonus]");
  if (bn) { const [id, d] = bn.dataset.bonus.split(":"); const j = data.jobs.find(x => x.id === id); return update("jobs", id, { admin_bonus: Math.max(0, (j?.admin_bonus || 0) + Number(d)) }); }
  if (e.target.closest("#csv-jobs")) return jobsCsv();
  if (e.target.closest("#csv-payouts")) return payoutsCsv();
  const pa = e.target.closest("[data-payall]");
  if (pa) { for (const id of pa.dataset.payall.split(",")) { const { error } = await db.from("jobs").update({ driver_paid: true }).eq("id", id); if (error) return alertBox(error.message); } return load(); }
});
document.addEventListener("change", e => {
  if (e.target.id === "acct-m") { acctMonth = e.target.value; return render(); }
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
