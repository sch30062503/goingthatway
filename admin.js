// Going That Way v1: admin page. Signs in with email + password (created in the Supabase dashboard).
const db = makeClient();
let tab = "new", data = { jobs: [], trips: [], biz: [] };

const SIZE_FITS = { boot: ["small", "medium"], ute: ["small", "medium", "large"], trailer: ["small", "medium", "large"], van: ["small", "medium", "large"] };
// Trips on the same day, heading the same way, covering both towns, with room for the item
function suggestTrips(j) {
  return data.trips.filter(t => t.status === "open" && t.trip_date === j.job_date && SIZE_FITS[t.space]?.includes(j.size) && [t.from_town, t.to_town, j.from_town, j.to_town].every(x => x in KM)
    && (() => { const a = KM[t.from_town], b = KM[t.to_town], p = KM[j.from_town], d = KM[j.to_town], lo = Math.min(a, b), hi = Math.max(a, b);
      return (b - a) * (d - p) > 0 && p >= lo && p <= hi && d >= lo && d <= hi; })());
}
const driverPay = j => estimate({ from: j.from_town, to: j.to_town, size: j.size, handover: j.handover, deadline: j.deadline_time, cover: j.cover })?.driver;

// Google Maps links: the driver's normal route, and the route with this job added
const place = (addr, town) => encodeURIComponent([addr, town, "New Zealand"].filter(Boolean).join(", "));
const tripStart = t => place(t.from_suburb, t.from_town), tripEnd = t => place(t.to_suburb, t.to_town);
const mapWithJob = (j, t) => `https://www.google.com/maps/dir/?api=1&travelmode=driving&origin=${tripStart(t)}&destination=${tripEnd(t)}&waypoints=${place(j.pickup_address, j.from_town)}%7C${place(j.drop_address, j.to_town)}`;
const mapNormal = t => `https://www.google.com/maps/dir/?api=1&travelmode=driving&origin=${tripStart(t)}&destination=${tripEnd(t)}`;
const ref = j => "GTW-" + j.id.replace(/-/g, "").slice(0, 6).toUpperCase();
const cfg = window.GTW_CONFIG || {};

const T = {
  jobConfirm: j => `Hi ${j.sender_name}, it's Going That Way. Got your request to move: ${j.item}, ${j.from_town} to ${j.to_town} on ${fmtDate(j.job_date)}${j.deadline_time ? ", arriving by " + fmtTime(j.deadline_time) : ""}. Estimated price $${Math.round(j.price_estimate || 0)} all in. Once we've found a driver, you pay to lock in the booking and we hold the money until it's delivered. Reply YES to confirm and we'll find a driver.`,
  tripConfirm: t => `Hi ${t.driver_name}, thanks for posting your ${t.from_town} to ${t.to_town} trip on ${fmtDate(t.trip_date)}. Before your first job, please reply with a photo of your driver licence and your number plate. We'll text you any jobs on your route.`,
  toDriver: (j, t) => `Hi ${t.driver_name}, a job on your ${t.from_town} to ${t.to_town} trip (${fmtDate(t.trip_date)}): ${j.item} (${j.size}). Pickup: ${j.pickup_address || j.from_town}, ${j.from_town}. Drop-off: ${j.drop_address || j.to_town}, ${j.to_town}${j.deadline_time ? ", by " + fmtTime(j.deadline_time) : ""}. Pays you about $${driverPay(j)}. The sender has already paid; we hold it and pay you by bank transfer in the weekly payout after the drop-off photo. Your route with this job added (check the extra km): ${mapWithJob(j, t)} Your normal route for comparison: ${mapNormal(t)} Sender: ${j.sender_name} ${j.sender_phone}. Job ref ${ref(j)}. Reply YES to take it.`,
  toSender: (j, t) => `Good news ${j.sender_name}: ${t.driver_name} is driving ${t.from_town} to ${t.to_town} on ${fmtDate(t.trip_date)} and will bring your ${j.item}. To lock in the booking, please pay $${Math.round(j.price_estimate || 0)} now by bank transfer to ${cfg.BANK_NAME || "Going That Way"} ${cfg.BANK_ACCOUNT || "(account)"}, reference ${ref(j)}. We hold it and only pay the driver once your item is delivered. If anything falls through, you get a full refund. They'll text you before pickup.`,
};

async function copy(text, btn) {
  try { await navigator.clipboard.writeText(text); btn.textContent = "Copied"; }
  catch { const ta = btn.closest(".card").querySelector("textarea.tmpl"); if (ta) { ta.value = text; ta.hidden = false; ta.select(); } btn.textContent = "Select and copy below"; }
  setTimeout(() => (btn.textContent = btn.dataset.label), 1800);
}

// ---------- login ----------
function loginView(msg = "") {
  $("#outBtn").hidden = true;
  $("#view").innerHTML = `<section><div class="card"><h3>Sign in</h3>
    ${db ? "" : `<div class="err">Not connected: fill in config.js first.</div>`}
    <form id="login"><div class="fields">
      <div class="field full"><label for="l-email">Email</label><input id="l-email" type="email" autocomplete="username" required></div>
      <div class="field full"><label for="l-pass">Password</label><input id="l-pass" type="password" autocomplete="current-password" required></div>
    </div>${msg ? `<div class="err">${esc(msg)}</div>` : ""}<button class="btn go" type="submit">Sign in</button></form></div></section>`;
}

async function load() {
  const [j, t, b] = await Promise.all([
    db.from("jobs").select("*").order("created_at", { ascending: false }),
    db.from("trips").select("*").order("trip_date"),
    db.from("business_interest").select("*").order("created_at", { ascending: false }),
  ]);
  if (j.error || t.error || b.error) { $("#view").innerHTML = `<div class="err">Couldn't load data: ${esc((j.error || t.error || b.error).message)}</div>`; return; }
  data = { jobs: j.data, trips: t.data, biz: b.data };
  render();
}

const phoneLink = p => `<a href="tel:${esc(String(p).replace(/\s/g, ""))}">${esc(p)}</a>`;
const btnCopy = (label, text) => `<button class="btn small" type="button" data-copy="${esc(text)}" data-label="${label}">${label}</button>`;
const statusSel = (kind, r, opts) => `<select data-status="${kind}:${r.id}" style="width:auto;font-size:14px;padding:5px 8px">${opts.map(o => `<option${o === r.status ? " selected" : ""}>${o}</option>`).join("")}</select>`;

function jobCard(j) {
  const sug = j.status === "open" ? suggestTrips(j) : [];
  const matched = j.matched_trip ? data.trips.find(t => t.id === j.matched_trip) : null;
  return `<div class="card">
    <div class="row"><div>${j.kind === "pickup" ? `<span class="tag">Pick-up-only buy</span> ` : ""}<span class="item">${esc(j.item)}</span> ${payChip(j)}</div>${statusSel("jobs", j, ["new", "open", "matched", "delivered", "cancelled"])}</div>
    <dl class="kv">
      <dt>Route</dt><dd>${esc(j.from_town)} → ${esc(j.to_town)}, ${fmtDate(j.job_date)}${j.deadline_time ? ", by " + fmtTime(j.deadline_time) : ", any time"}</dd>
      <dt>Sender</dt><dd>${esc(j.sender_name)} · ${phoneLink(j.sender_phone)}</dd>
      <dt>Pickup</dt><dd>${esc(j.pickup_address || "–")}</dd><dt>Drop-off</dt><dd>${esc(j.drop_address || "–")}</dd>
      <dt>Size</dt><dd>${esc(j.size)} · ${j.handover === "route" ? "meets on route" : "door to door"} · not insured (trial)</dd>
      <dt>Price</dt><dd class="num">$${Math.round(j.price_estimate || 0)} all in · driver ~$${driverPay(j) ?? "?"}</dd>
      ${j.listing_url ? `<dt>Listing</dt><dd><a href="${esc(j.listing_url)}" target="_blank" rel="noopener">Open listing</a></dd>` : ""}
      ${j.description ? `<dt>Notes</dt><dd>${esc(j.description)}</dd>` : ""}
      ${matched ? `<dt>Driver</dt><dd>${esc(matched.driver_name)} · ${phoneLink(matched.driver_phone)} · <a href="${esc(mapWithJob(j, matched))}" target="_blank" rel="noopener">route with job</a> · <a href="${esc(mapNormal(matched))}" target="_blank" rel="noopener">normal route</a></dd>` : ""}
      <dt>Job ref</dt><dd class="num">${ref(j)}</dd>
    </dl>
    <div class="acts">
      ${j.status === "new" ? `<button class="btn small go" data-set="jobs:${j.id}:open">Approve</button>${btnCopy("Copy confirm text", T.jobConfirm(j))}` : ""}
      ${matched ? btnCopy("1. Copy payment text to sender", T.toSender(j, matched)) : ""}
      ${matched && j.payment === "paid" ? btnCopy("2. Copy job text to driver", T.toDriver(j, matched)) : ""}
      ${matched || ["delivered", "cancelled"].includes(j.status) ? `<label class="chip" style="display:inline-flex;gap:6px;align-items:center">Payment <select data-pay="${j.id}" style="width:auto;padding:2px 6px;font-size:13px">${["unpaid", "paid", "refunded", "part_refunded"].map(o => `<option${o === j.payment ? " selected" : ""}>${o}</option>`).join("")}</select></label>` : ""}
      ${j.status === "delivered" && j.payment === "paid" ? `<label class="chip" style="display:inline-flex;gap:6px;align-items:center"><input type="checkbox" data-dpaid="${j.id}"${j.driver_paid ? " checked" : ""} style="width:auto"> Driver paid</label>` : ""}
    </div>
    ${sug.length ? `<div class="label">Drivers on this route</div>${sug.map(t => `<div class="sugg"><span>${esc(t.driver_name)} · ${esc(SPACE_LABEL[t.space])} · leaving ${fmtTime(t.depart_time) || "?"} from ${esc(t.from_suburb || t.from_town)} · <a href="${esc(mapWithJob(j, t))}" target="_blank" rel="noopener">check detour</a></span><button class="btn small go" data-match="${j.id}:${t.id}">Match</button></div>`).join("")}`
      : j.status === "open" ? `<p class="fine">No matching trips yet. Businesses: text them before their courier cut-off.</p>` : ""}
    ${matched && j.payment !== "paid" && j.status === "matched" ? `<p class="fine">Send the job to the driver once the sender's payment has arrived.</p>` : ""}
    <textarea class="tmpl" hidden aria-label="Text to copy"></textarea>
  </div>`;
}
const payChip = j => j.payment === "paid" ? `<span class="chip g">Paid, held</span>` : j.payment === "refunded" ? `<span class="chip">Refunded</span>` : j.payment === "part_refunded" ? `<span class="chip">Part refunded</span>` : ["matched", "delivered"].includes(j.status) ? `<span class="chip y">Awaiting payment</span>` : "";
function payouts() {
  const owed = data.jobs.filter(j => j.status === "delivered" && j.payment === "paid" && !j.driver_paid && j.matched_trip);
  const byDriver = {};
  owed.forEach(j => { const t = data.trips.find(x => x.id === j.matched_trip); if (!t) return;
    const k = t.driver_phone; (byDriver[k] ||= { name: t.driver_name, phone: t.driver_phone, jobs: [], total: 0 }); byDriver[k].jobs.push(j); byDriver[k].total += driverPay(j) || 0; });
  const list = Object.values(byDriver);
  if (!list.length) return `<div class="empty">No driver payouts owed. Delivered, paid jobs appear here until you tick "Driver paid".</div>`;
  return list.map(d => `<div class="card"><div class="row"><span class="item">${esc(d.name)}</span><b class="num">$${d.total}</b></div>
    <p class="sub">${phoneLink(d.phone)} · ${d.jobs.length} job${d.jobs.length > 1 ? "s" : ""}: ${d.jobs.map(j => `${esc(j.item)} (${ref(j)}, $${driverPay(j)})`).join(", ")}</p>
    <p class="fine">Ask the driver for their bank account the first time. Use reference "GTW payout". Then tick "Driver paid" on each job, or:</p>
    <button class="btn small go" data-payall="${d.jobs.map(j => j.id).join(",")}">Mark all ${d.jobs.length} paid</button></div>`).join("");
}
function tripCard(t) {
  const jobs = data.jobs.filter(j => j.matched_trip === t.id);
  return `<div class="card">
    <div class="row"><span class="item">${esc(t.from_town)} → ${esc(t.to_town)}</span>${statusSel("trips", t, ["new", "open", "full", "done", "cancelled"])}</div>
    <dl class="kv">
      <dt>From / to</dt><dd>${esc(t.from_suburb || "?")}, ${esc(t.from_town)} → ${esc(t.to_suburb || "?")}, ${esc(t.to_town)}</dd>
      <dt>When</dt><dd>${fmtDate(t.trip_date)}${t.depart_time ? ", leaving " + fmtTime(t.depart_time) : ""}${t.regular ? " · regular run" : ""}</dd>
      <dt>Driver</dt><dd>${esc(t.driver_name)} · ${phoneLink(t.driver_phone)}</dd>
      <dt>Space</dt><dd>${esc(SPACE_LABEL[t.space])}${t.space_note ? " · " + esc(t.space_note) : ""}${t.vehicle ? " · " + esc(t.vehicle) : ""} · up to ${t.max_detour_km} km detour</dd>
      ${jobs.length ? `<dt>Jobs</dt><dd>${jobs.map(j => esc(j.item)).join(", ")}</dd>` : ""}
    </dl>
    <div class="acts">${t.status === "new" ? `<button class="btn small go" data-set="trips:${t.id}:open">Approve</button>${btnCopy("Copy welcome text", T.tripConfirm(t))}` : ""}</div>
    <textarea class="tmpl" hidden aria-label="Text to copy"></textarea>
  </div>`;
}
function bizCard(b) {
  return `<div class="card"><span class="item">${esc(b.business_name)}</span><dl class="kv">
    <dt>Town</dt><dd>${esc(b.town)} · sends ${esc(b.sends_per_week || "?")} a week</dd>
    <dt>Contact</dt><dd>${esc(b.contact_name)} · ${phoneLink(b.contact_phone)}${b.contact_email ? " · " + esc(b.contact_email) : ""}</dd>
    ${b.notes ? `<dt>Notes</dt><dd>${esc(b.notes)}</dd>` : ""}</dl></div>`;
}

function render() {
  const newJobs = data.jobs.filter(j => j.status === "new"), newTrips = data.trips.filter(t => t.status === "new");
  const liveJobs = data.jobs.filter(j => ["open", "matched"].includes(j.status));
  const liveTrips = data.trips.filter(t => ["open", "full"].includes(t.status));
  const past = data.jobs.filter(j => ["delivered", "cancelled"].includes(j.status));
  const tabs = [["new", "To approve", newJobs.length + newTrips.length], ["jobs", "Jobs", liveJobs.length], ["trips", "Trips", liveTrips.length], ["pay", "Payouts", data.jobs.filter(j => j.status === "delivered" && j.payment === "paid" && !j.driver_paid).length], ["biz", "Businesses", data.biz.length], ["past", "Past", 0]];
  const body = {
    new: [...newJobs.map(jobCard), ...newTrips.map(tripCard)].join("") || `<div class="empty">Nothing waiting. Nice.</div>`,
    jobs: liveJobs.map(jobCard).join("") || `<div class="empty">No live jobs.</div>`,
    trips: liveTrips.map(tripCard).join("") || `<div class="empty">No live trips.</div>`,
    pay: payouts(),
    biz: data.biz.map(bizCard).join("") || `<div class="empty">No businesses yet.</div>`,
    past: past.map(jobCard).join("") || `<div class="empty">Nothing yet.</div>`,
  }[tab];
  $("#outBtn").hidden = false;
  const bankWarn = !cfg.BANK_ACCOUNT || cfg.BANK_ACCOUNT.startsWith("00-0000") ? `<div class="err">Add your business bank account to config.js before texting senders, so they know where to pay.</div>` : "";
  $("#view").innerHTML = bankWarn + `<nav class="a-tabs">${tabs.map(([k, l, n]) => `<button data-tab="${k}" aria-selected="${tab === k}">${l}${n ? `<span class="count">${n}</span>` : ""}</button>`).join("")}<button class="btn small" id="refresh" style="margin-left:auto">Refresh</button></nav><section>${body}</section>`;
}

async function update(table, id, patch) {
  const { error } = await db.from(table).update(patch).eq("id", id);
  if (error) { alertBox(error.message); return; }
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
  const s = e.target.closest("[data-set]"); if (s) { const [tb, id, st] = s.dataset.set.split(":"); return update(tb, id, { status: st }); }
  const pa = e.target.closest("[data-payall]"); if (pa) { for (const id of pa.dataset.payall.split(",")) { await db.from("jobs").update({ driver_paid: true }).eq("id", id); } return load(); }
  const m = e.target.closest("[data-match]"); if (m) { const [jid, tid] = m.dataset.match.split(":"); return update("jobs", jid, { status: "matched", matched_trip: tid }); }
});
document.addEventListener("change", e => {
  const py = e.target.closest("[data-pay]"); if (py) return update("jobs", py.dataset.pay, { payment: py.value });
  const dp = e.target.closest("[data-dpaid]"); if (dp) return update("jobs", dp.dataset.dpaid, { driver_paid: dp.checked });
  const s = e.target.closest("[data-status]"); if (!s) return;
  const [tb, id] = s.dataset.status.split(":"); update(tb, id, { status: s.value });
});

async function start() {
  if (!db) return loginView();
  const { data: s } = await db.auth.getSession();
  if (!s.session || s.session.user.is_anonymous) return loginView();
  const { data: p } = await db.from("profiles").select("is_admin").eq("id", s.session.user.id).single();
  if (!p?.is_admin) { await db.auth.signOut(); return loginView("This account isn't an admin yet. Run the last line of schema.sql with your email."); }
  load();
}
start();
