// Going That Way: public site.
// Senders post and pay ahead; the job goes live once the admin sees the payment.
// Drivers decide on the day: post a trip, see paid jobs on their route, take one, collect, deliver.

const db = makeClient();
const cfg = window.GTW_CONFIG || {};
let cur = "send", sendMode = "pickup";

// ---------- remembered details (this device only) ----------
const memo = {
  get() { try { return JSON.parse(localStorage.getItem("gtw-contact") || "{}"); } catch { return {}; } },
  set(v) { try { localStorage.setItem("gtw-contact", JSON.stringify({ ...memo.get(), ...v })); } catch {} },
};
async function ensureSession() {
  const { data } = await db.auth.getSession();
  if (data.session) return data.session;
  const { data: d2, error } = await db.auth.signInAnonymously();
  if (error) throw error;
  return d2.session;
}
async function myId() { if (!db) return null; const { data } = await db.auth.getSession(); return data.session?.user?.id || null; }

// ---------- small pieces ----------
const v = id => ($("#" + id)?.value || "").trim();
const contactFields = who => { const m = memo.get(); return `
  <div class="field"><label for="c-name">Your name</label><input id="c-name" autocomplete="given-name" required value="${esc(m.name || "")}"></div>
  <div class="field"><label for="c-phone">Mobile</label><input id="c-phone" type="tel" inputmode="tel" autocomplete="tel" required placeholder="021 123 4567" value="${esc(m.phone || "")}"></div>
  <p class="fine" style="grid-column:1/-1">Your name and number are never shown publicly. ${who}</p>`; };
const notConnected = () => db ? "" : `<div class="err">The site isn't connected to its database yet, so posts can't be saved.</div>`;
const plate = (f, t) => `<div class="plate"><div class="towns">${esc(f)} → ${esc(t)}</div><div class="km">${(f in KM && t in KM) ? dist(f, t) + " km" : ""}</div></div>`;
const windowText = j => j.window_end && j.window_end !== j.job_date ? `${fmtDate(j.job_date)} to ${fmtDate(j.window_end)}` : fmtDate(j.job_date);
const smsLink = (phone, body) => `sms:${String(phone || "").replace(/\s/g, "")}?&body=${encodeURIComponent(body)}`;
const telLink = phone => `tel:${String(phone || "").replace(/\s/g, "")}`;

function payPanel(j) {
  const amount = Math.round(j.price_estimate || 0), ref = jobRef(j);
  return `<div class="card" style="border:2px solid var(--sign)"><h3>Pay $${amount} to make it live</h3>
    ${bankSet() ? `<dl class="kv" style="display:grid;grid-template-columns:90px 1fr;gap:4px 10px;font-size:14px;margin:0">
      <dt style="color:var(--ink3)">Amount</dt><dd class="num" style="margin:0">$${amount}</dd>
      <dt style="color:var(--ink3)">Account</dt><dd class="num" style="margin:0">${esc(cfg.BANK_NAME || "Going That Way")} ${esc(cfg.BANK_ACCOUNT)}</dd>
      <dt style="color:var(--ink3)">Reference</dt><dd class="num" style="margin:0"><b>${ref}</b></dd></dl>`
      : `<p class="sub">We'll text you the bank details with your reference <b class="num">${ref}</b>.</p>`}
    <p class="fine">Your job goes on the board as soon as we see the payment, usually within a few hours. We hold your money and only pay the driver once it's delivered. If no driver takes it by ${fmtDate(j.window_end || j.job_date)}, you get a full refund.</p></div>`;
}

// =====================================================================
// SEND
// =====================================================================
function send() {
  const pickup = sendMode === "pickup";
  return `<section>
    <h2>${pickup ? "Bought something pick-up only in another town?" : "Send it with someone going that way"}</h2>
    <div class="seg" role="tablist">
      <button type="button" role="tab" data-mode="pickup" aria-selected="${pickup}">Pick-up-only buy</button>
      <button type="button" role="tab" data-mode="parcel" aria-selected="${!pickup}">Send a parcel</button>
    </div>
    ${notConnected()}
    <div class="card"><form id="jobForm" novalidate>
      <div class="fields">
        ${pickup ? `<div class="field full"><label for="j-link">Listing link <span class="hint">(Trade Me, Marketplace)</span></label><input id="j-link" type="url" inputmode="url" placeholder="Paste the link"></div>` : ""}
        <div class="field full"><label for="j-item">${pickup ? "What did you buy?" : "What is it?"}</label><input id="j-item" required placeholder="${pickup ? "e.g. Kids' bike, rimu table" : "e.g. Box of parts, trailer tyre"}"></div>
        <div class="field"><label for="j-from">${pickup ? "Seller's town" : "From"}</label><select id="j-from">${townOptions("Christchurch")}</select></div>
        <div class="field"><label for="j-to">${pickup ? "Your town" : "To"}</label><select id="j-to">${townOptions("Timaru")}</select></div>
        <div class="field full"><label for="j-pa">${pickup ? "Seller's address" : "Pickup address"}</label><input id="j-pa" required autocomplete="off" placeholder="Street and suburb. Only your driver sees it."></div>
        ${pickup ? `<div class="field"><label for="j-sn">Seller's name</label><input id="j-sn" required></div>
        <div class="field"><label for="j-sp">Seller's mobile</label><input id="j-sp" type="tel" inputmode="tel" required placeholder="So the driver can arrange pickup"></div>` : ""}
        <div class="field full"><label for="j-da">Deliver to</label><input id="j-da" required autocomplete="street-address" placeholder="Street and suburb. Only your driver sees it."></div>
        <div class="field"><label for="j-size">Size</label><select id="j-size">${Object.entries(SIZE_LABEL).map(([k, lab]) => `<option value="${k}"${k === (pickup ? "large" : "medium") ? " selected" : ""}>${lab}</option>`).join("")}</select></div>
        <div class="field"><label for="j-by">Deliver by</label><input id="j-by" type="date" min="${todayISO()}" value="${todayISO(6)}" required></div>
        <p class="fine" style="grid-column:1/-1">The more days you allow, the more drivers can take it. Today only is express (+25%).</p>
        <div class="field full"><label for="j-pm">How can the driver collect it?</label><select id="j-pm">${Object.entries(PICKUP_LABEL).map(([k, lab]) => `<option value="${k}">${lab}</option>`).join("")}</select></div>
        <div class="field full" id="pm-hours-f"><label for="j-ph" id="pm-hours-l">When is someone there?</label><input id="j-ph" placeholder="e.g. weekdays 8 am to 5 pm, or any time"></div>
        <div class="field full" id="pm-notes-f" hidden><label for="j-pn" id="pm-notes-l">Where is it left?</label><input id="j-pn" placeholder="e.g. under the carport. Only your driver sees this."></div>
        ${contactFields("We'll text you if anything changes.")}
      </div>
      <details class="more"><summary>More options</summary><div class="fields">
        <div class="field"><label for="j-from-d">Earliest pickup</label><input id="j-from-d" type="date" min="${todayISO()}" value="${todayISO()}"></div>
        <div class="field"><label for="j-dl">Arrival on the last day</label><select id="j-dl"><option value="">Any time</option><option value="by">By a set time (+25%)</option></select></div>
        <div class="field"><label for="j-dlt">Arrive by</label><input id="j-dlt" type="time" value="13:00"></div>
        <div class="field full"><label for="j-desc">Anything the driver should know?</label><textarea id="j-desc" placeholder="e.g. Seller will help load. Keep upright."></textarea></div>
      </div></details>
      <div id="j-price"></div>
      <label class="check"><input type="checkbox" id="c-ok" required> <span>It's worth less than $500 and isn't dangerous goods, cash, drugs, weapons or a live animal. I understand items aren't insured during the trial, and that if the driver arrives when I said and it isn't available, a no-show fee covering their trip is kept from my payment.</span></label>
      <div id="j-err"></div>
      <button class="btn go" type="submit">Post and pay</button>
    </form></div>
    <div id="j-done"></div>
  </section>`;
}
function jobValues() {
  const pm = v("j-pm") || "home";
  const jobDate = v("j-from-d") || todayISO(), windowEnd = v("j-by");
  return {
    kind: sendMode, item: v("j-item"), listing_url: v("j-link") || null, from_town: v("j-from"), to_town: v("j-to"),
    pickup_address: v("j-pa") || null, drop_address: v("j-da") || null, seller_name: v("j-sn") || null, seller_phone: v("j-sp") || null,
    size: v("j-size"), job_date: jobDate, window_end: windowEnd,
    deadline_time: v("j-dl") === "by" ? (v("j-dlt") || null) : null,
    pickup_mode: pm, handover: pm === "meet" ? "route" : "door",
    pickup_hours: pm === "left_out" ? "any time" : (v("j-ph") || null), pickup_notes: v("j-pn") || null,
    description: v("j-desc") || null, cover: 500, sender_name: v("c-name"), sender_phone: v("c-phone"),
  };
}
function jobPrice(j) {
  const express = isExpress(j.job_date, j.window_end);
  return estimate({ from: j.from_town, to: j.to_town, size: j.size, handover: j.handover, deadline: j.deadline_time || (express ? "express" : null), cover: 500 });
}
function updPickupMode() {
  const pm = v("j-pm"); if (!pm) return;
  const hoursF = $("#pm-hours-f"), notesF = $("#pm-notes-f");
  hoursF.hidden = pm === "left_out"; notesF.hidden = !(pm === "left_out" || pm === "meet");
  $("#pm-hours-l").textContent = { home: "When is someone there?", business: "Opening hours", meet: "When can you meet?" }[pm] || "";
  $("#pm-notes-l").textContent = pm === "meet" ? "Where on the route? (e.g. Rakaia BP)" : "Where is it left?";
}
function updPrice() {
  const box = $("#j-price"); if (!box) return;
  const j = jobValues(), e = jobPrice(j);
  if (!e) { box.innerHTML = `<p class="fine">Pick two different towns to see a price.</p>`; return; }
  const express = isExpress(j.job_date, j.window_end);
  box.innerHTML = `<div class="allin"><span>Price, all in</span><b class="num">$${e.total}</b></div>
    <p class="fine" style="margin-top:6px">${e.onRoute} km${j.handover === "route" ? ", meeting on the route" : ", door to door"}. You pay when you post, and we hold it until it's delivered. Full refund if no driver takes it by ${fmtDate(j.window_end)}.</p>
    ${e.prem ? `<div class="note" style="margin-top:6px">Includes a $${e.prem} ${express ? "same-day express" : "set-time"} premium, paid to the driver. Delays like road closures, crashes or weather can still happen. If it arrives late, you only pay the normal rate ($${e.normal}).</div>` : ""}
    <div class="note" style="margin-top:6px"><b>Trial service: items aren't insured yet.</b> Please don't send anything worth more than $500.</div>`;
}

// =====================================================================
// DRIVE
// =====================================================================
function drive() {
  return `<section>
    <h2>Heading between Christchurch and Timaru today?</h2>
    <p class="sub">Post your trip and see paid jobs on your route straight away. Take the ones that suit you.</p>
    ${notConnected()}
    <div class="card"><form id="tripForm" novalidate>
      <div class="fields">
        <div class="field"><label for="t-from">From</label><select id="t-from">${townOptions("Christchurch")}</select></div>
        <div class="field"><label for="t-to">To</label><select id="t-to">${townOptions("Timaru")}</select></div>
        <div class="field full"><label for="t-fa">Leaving from</label><input id="t-fa" required placeholder="Street, suburb, or e.g. Christchurch CBD" value="${esc(memo.get().tfa || "")}"></div>
        <div class="field full"><label for="t-ta">Arriving at</label><input id="t-ta" required placeholder="Street, suburb, or e.g. Timaru CBD" value="${esc(memo.get().tta || "")}"></div>
        <div class="field"><label for="t-date">Day</label><input id="t-date" type="date" min="${todayISO()}" value="${todayISO()}" required></div>
        <div class="field"><label for="t-time">Leaving about</label><input id="t-time" type="time" value="08:00"></div>
        <div class="field"><label for="t-space">Space</label><select id="t-space">${Object.entries(SPACE_LABEL).map(([k, lab]) => `<option value="${k}"${k === (memo.get().tspace || "ute") ? " selected" : ""}>${lab}</option>`).join("")}</select></div>
        <div class="field"><label for="t-det">Max detour</label><select id="t-det"><option value="5">5 km</option><option value="10">10 km</option><option value="20" selected>20 km</option><option value="30">30 km</option></select></div>
        ${contactFields("")}
      </div>
      <details class="more"><summary>More options</summary><div class="fields">
        <div class="field full"><label for="t-veh">Your vehicle</label><input id="t-veh" placeholder="e.g. Toyota Hilux double cab" value="${esc(memo.get().tveh || "")}"></div>
        <div class="field full"><label for="t-note">Space available</label><input id="t-note" placeholder="e.g. Open tray 1.5 × 1.5 m, straps"></div>
        <div class="field full"><label class="check"><input type="checkbox" id="t-reg"> <span>I do this run most weeks</span></label></div>
      </div></details>
      <p class="fine">New drivers: before your first job we check your licence and vehicle once. After that, your trips go live instantly.</p>
      <div id="t-err"></div>
      <button class="btn go" type="submit">Post my trip and see jobs</button>
    </form></div>
    <div id="t-done"></div>
  </section>`;
}

// Jobs on a trip's route: taken jobs (full details) and available ones (take it)
async function tripJobsPanel(t, verified) {
  const [taken, board] = await Promise.all([
    db.from("jobs").select("*").eq("matched_trip", t.id),
    db.from("board_jobs").select("*").eq("status", "open"),
  ]);
  const mine = (taken.data || []).filter(j => ["matched", "collected", "delivered"].includes(j.status));
  const avail = (board.data || []).filter(j => jobFitsTrip(j, t));
  const takenHtml = mine.map(j => takenJobCard(j, t)).join("");
  const availHtml = avail.map(j => `<div class="card">
      <div class="row"><div>${j.kind === "pickup" ? `<span class="tag">Pick-up-only buy</span> ` : ""}<span class="item">${esc(j.item)}</span></div><span class="chip g num">You get $${driverFromPrice(j.price_estimate)}</span></div>
      <div class="meta"><span>${esc(j.from_town)} → ${esc(j.to_town)}</span><span class="chip">${esc(SIZE_LABEL[j.size]?.split(" (")[0])}</span><span class="chip">${esc(PICKUP_LABEL[j.pickup_mode] || "")}${j.pickup_hours ? ": " + esc(j.pickup_hours) : ""}</span><span>by ${fmtDate(j.window_end)}${j.deadline_time ? ", " + fmtTime(j.deadline_time) : ""}</span></div>
      ${t.status === "open" && verified ? `<button class="btn go" data-claim="${j.id}:${t.id}">Take it</button>` : ""}
    </div>`).join("");
  return `${takenHtml ? `<div class="label">Jobs you've taken</div>${takenHtml}` : ""}
    <div class="label">Paid jobs on your route${t.trip_date === todayISO() ? " today" : " on " + fmtDate(t.trip_date)}</div>
    ${!verified || t.status !== "open" ? `<div class="note">We'll check your licence and vehicle once (we'll text you). Then you can take jobs, and future trips go live instantly.</div>` : ""}
    ${availHtml || `<div class="empty">No paid jobs on your route ${t.trip_date === todayISO() ? "today" : "that day"} yet. New ones can appear any time; check back before you leave.</div>`}`;
}
function takenJobCard(j, t) {
  const who = j.kind === "pickup" && j.seller_phone ? { name: j.seller_name || "the seller", phone: j.seller_phone } : { name: j.sender_name, phone: j.sender_phone };
  const confirmMsg = `Hi ${who.name}, it's ${t.driver_name} from Going That Way. I'm collecting the ${j.item} ${t.trip_date === todayISO() ? "today" : "on " + fmtDate(t.trip_date)}, around ${fmtTime(t.depart_time) || "(time)"}. Can you confirm it'll be ready? Thanks!`;
  const step = j.status === "matched" ? `<div style="display:flex;gap:6px;flex-wrap:wrap"><label class="btn go camera">Collected: take pickup photo<input type="file" accept="image/*" capture="environment" data-photo="${j.id}:pickup"></label><button class="btn small" data-release="${j.id}">Give it back</button><label class="btn small camera">Nobody there? Photo the door<input type="file" accept="image/*" capture="environment" data-photo="${j.id}:no_show"></label></div>`
    : j.status === "collected" ? `<label class="btn go camera">Delivered: take drop-off photo<input type="file" accept="image/*" capture="environment" data-photo="${j.id}:dropoff"></label>` : `<span class="chip g">Delivered. Thanks! Paid in the weekly payout.</span>`;
  return `<div class="card" style="border:2px solid var(--mark)">
    <div class="row"><span class="item">${esc(j.item)}</span><span class="chip g num">You get $${driverFromPrice(j.price_estimate)}</span></div>
    <dl style="display:grid;grid-template-columns:92px 1fr;gap:3px 10px;font-size:13.5px;margin:0">
      <dt style="color:var(--ink3)">Collect</dt><dd style="margin:0">${esc(j.pickup_address)}, ${esc(j.from_town)}</dd>
      <dt style="color:var(--ink3)">How</dt><dd style="margin:0">${esc(PICKUP_LABEL[j.pickup_mode] || "")}${j.pickup_hours ? " · " + esc(j.pickup_hours) : ""}${j.pickup_notes ? " · " + esc(j.pickup_notes) : ""}</dd>
      <dt style="color:var(--ink3)">Deliver</dt><dd style="margin:0">${esc(j.drop_address)}, ${esc(j.to_town)} · by ${fmtDate(j.window_end)}${j.deadline_time ? ", " + fmtTime(j.deadline_time) : ""}</dd>
      <dt style="color:var(--ink3)">Contact</dt><dd style="margin:0">${esc(who.name)} · <a href="${telLink(who.phone)}">${esc(who.phone)}</a>${j.kind === "pickup" ? ` · buyer ${esc(j.sender_name)} <a href="${telLink(j.sender_phone)}">${esc(j.sender_phone)}</a>` : ""}</dd>
      ${j.description ? `<dt style="color:var(--ink3)">Notes</dt><dd style="margin:0">${esc(j.description)}</dd>` : ""}
      <dt style="color:var(--ink3)">Job ref</dt><dd class="num" style="margin:0">${jobRef(j)}</dd>
    </dl>
    <div style="display:flex;gap:6px;flex-wrap:wrap">
      ${j.status === "matched" ? `<a class="btn small go" href="${smsLink(who.phone, confirmMsg)}">Text ${esc(who.name.split(" ")[0])} to confirm pickup</a>` : ""}
      <a class="btn small" href="${mapWithJob(j, t)}" target="_blank" rel="noopener">Route with this job</a>
    </div>
    <p class="fine">Don't set off for the pickup until they've confirmed, unless it's left out. The photos confirm collection and delivery, and protect you if anything's questioned.</p>
    <div data-photos="${j.id}"></div>
    ${step}
  </div>`;
}

// =====================================================================
// BUSINESS
// =====================================================================
function business() {
  return `<section>
    <h2>Send from your business</h2>
    <p class="sub">Post urgent parts and orders first thing. If no driver takes a job by your cut-off (say 3:30 pm), we text you to book your usual courier, so you never lose a day.</p>
    ${notConnected()}
    <div class="card"><form id="bizForm" novalidate><div class="fields">
      <div class="field full"><label for="b-name">Business name</label><input id="b-name" required></div>
      <div class="field"><label for="b-town">Town</label><select id="b-town">${townOptions("Ashburton")}</select></div>
      <div class="field"><label for="b-vol">Items sent a week</label><select id="b-vol"><option>1 to 5</option><option>5 to 20</option><option>20 or more</option></select></div>
      ${contactFields("")}
      <div class="field full"><label for="b-email">Email (optional)</label><input id="b-email" type="email" autocomplete="email"></div>
      <div class="field full"><label for="b-notes">What do you usually send, and where?</label><textarea id="b-notes" placeholder="e.g. Parts from our Ashburton store to Timaru customers, most days"></textarea></div>
    </div>
    <div id="b-err"></div>
    <button class="btn go" type="submit">Register interest</button></form></div>
    <div id="b-done"></div>
  </section>`;
}

// =====================================================================
// BOARD
// =====================================================================
function board() {
  setTimeout(loadBoard, 0);
  return `<section><h2>On the road this week</h2><p class="sub">Paid jobs waiting for a driver, and trips people are making. Addresses and contact details are never shown.</p>
    <div class="label">Paid jobs</div><div id="bj" class="empty">Loading…</div>
    <div class="label">Drivers heading out</div><div id="bt" class="empty">Loading…</div></section>`;
}
async function loadBoard() {
  if (!db) { $("#bj").textContent = $("#bt").textContent = "Not connected yet."; return; }
  const [j, t] = await Promise.all([
    db.from("board_jobs").select("*").order("window_end").limit(60),
    db.from("board_trips").select("*").order("trip_date").limit(60),
  ]);
  const bj = $("#bj"), bt = $("#bt"); if (!bj) return;
  if (j.error || t.error) { bj.textContent = bt.textContent = "Couldn't load the board. Try again shortly."; return; }
  bj.className = bt.className = "";
  bj.innerHTML = j.data.length ? j.data.map(r => `<div class="card" style="margin-bottom:8px"><div class="row"><div>${r.kind === "pickup" ? `<span class="tag">Pick-up-only buy</span> ` : ""}<span class="item">${esc(r.item)}</span></div><span class="chip g num">$${Math.round(r.price_estimate || 0)}</span></div>${plate(r.from_town, r.to_town)}<div class="meta"><span>by ${fmtDate(r.window_end)}</span><span class="chip">${esc(SIZE_LABEL[r.size]?.split(" (")[0] || r.size)}</span><span class="chip">${esc(PICKUP_LABEL[r.pickup_mode] || "")}</span>${r.status !== "open" ? `<span class="chip y">Driver found</span>` : ""}</div></div>`).join("")
    : `<div class="empty">No paid jobs right now. Be the first: post a job.</div>`;
  bt.innerHTML = t.data.length ? t.data.map(r => `<div class="card" style="margin-bottom:8px">${plate(r.from_town, r.to_town)}<div class="meta"><span>${fmtDate(r.trip_date)}${r.depart_time ? ", leaving " + fmtTime(r.depart_time) : ""}</span><span class="chip">${esc(SPACE_LABEL[r.space] || r.space)}</span></div></div>`).join("")
    : `<div class="empty">No trips posted yet. Driving this week? Post your trip.</div>`;
}

// =====================================================================
// MY POSTS
// =====================================================================
function mine() {
  setTimeout(loadMine, 0);
  return `<section><h2>My posts</h2><p class="sub">Jobs and trips posted from this phone or computer.</p><div id="mine" class="empty">Loading…</div></section>`;
}
const JOB_STATUS = { new: ["Waiting for payment", "y"], open: ["Paid · waiting for a driver", "g"], matched: ["Driver on the way", "g"], collected: ["Collected · on its way", "g"], delivered: ["Delivered", "g"], cancelled: ["Cancelled", ""], no_show: ["No-show", ""] };
const TRIP_STATUS = { new: ["Waiting for licence check", "y"], open: ["Live", "g"], full: ["Full", ""], done: ["Done", "g"], cancelled: ["Cancelled", ""] };
async function loadMine() {
  const box = $("#mine");
  if (!db) { box.textContent = "Not connected yet."; return; }
  const uid = await myId();
  if (!uid) { box.innerHTML = `<div class="empty">You haven't posted anything from this device yet.</div>`; return; }
  const [j, t, p] = await Promise.all([
    db.from("jobs").select("*").eq("user_id", uid).order("created_at", { ascending: false }),
    db.from("trips").select("*").eq("user_id", uid).order("trip_date", { ascending: false }),
    db.from("profiles").select("verified_driver").eq("id", uid).single(),
  ]);
  const verified = !!p.data?.verified_driver;
  const parts = [];
  for (const r of (t.data || [])) {
    const [s, c] = TRIP_STATUS[r.status] || [r.status, ""];
    const live = ["new", "open"].includes(r.status) && r.trip_date >= todayISO();
    parts.push(`<div class="card" style="margin-bottom:8px"><div class="row"><span class="item">Your trip</span><span class="chip ${c}">${s}</span></div>${plate(r.from_town, r.to_town)}
      <div class="meta"><span>${fmtDate(r.trip_date)}${r.depart_time ? ", leaving " + fmtTime(r.depart_time) : ""}</span>${live ? `<button class="btn small" data-cancel="trips:${r.id}" style="margin-left:auto">Cancel trip</button>` : ""}</div>
      ${live ? `<div data-trippanel="${r.id}" class="empty">Loading jobs on your route…</div>` : ""}</div>`);
  }
  for (const r of (j.data || [])) {
    const [s, c] = JOB_STATUS[r.status] || [r.status, ""];
    const canCancel = ["new", "open"].includes(r.status);
    parts.push(`<div class="card" style="margin-bottom:8px"><div class="row"><span class="item">${esc(r.item)}</span><span class="chip ${c}">${s}</span></div>${plate(r.from_town, r.to_town)}
      <div class="meta"><span>by ${fmtDate(r.window_end || r.job_date)}</span><span class="num">$${Math.round(r.price_estimate || 0)} · ${jobRef(r)}</span>${canCancel ? `<button class="btn small" data-cancel="jobs:${r.id}" style="margin-left:auto">Cancel</button>` : ""}</div>
      ${["matched", "collected", "delivered"].includes(r.status) ? `<div data-driverfor="${r.id}" class="fine">Finding driver details…</div><div data-photos="${r.id}"></div>` : ""}
      ${r.status === "new" && r.payment === "unpaid" ? payPanel(r) : ""}</div>`);
  }
  box.className = "";
  box.innerHTML = parts.join("") || `<div class="empty">You haven't posted anything from this device yet.</div>`;
  for (const r of (t.data || [])) { const el = document.querySelector(`[data-trippanel="${r.id}"]`); if (el) { el.className = ""; el.innerHTML = await tripJobsPanel(r, verified); } }
  showPhotos(db);
  for (const r of (j.data || [])) {
    const el = document.querySelector(`[data-driverfor="${r.id}"]`); if (!el) continue;
    const { data } = await db.rpc("my_job_driver", { p_job: r.id });
    const d = data?.[0];
    el.innerHTML = d ? `Driver: <b>${esc(d.driver_name)}</b> · <a href="${telLink(d.driver_phone)}">${esc(d.driver_phone)}</a> · ${fmtDate(d.trip_date)}${d.depart_time ? ", leaving " + fmtTime(d.depart_time) : ""}. They'll text you before pickup.` : "";
  }
}

// =====================================================================
// HOW IT WORKS
// =====================================================================
function info() {
  const sec = (t, b) => `<div class="card"><h3>${t}</h3>${b}</div>`;
  return `<section><h2>How it works</h2>
    ${sec("For senders", `<ol class="steps"><li><b>Post it and pay.</b> Choose a deliver-by day and how it can be collected. We hold your money.</li><li><b>It goes on the board</b> for drivers heading that way.</li><li><b>A driver takes it</b> and texts you to confirm pickup.</li><li><b>It's delivered.</b> Photos at pickup and drop-off, then the driver is paid. Full refund if nobody takes it in time.</li></ol>`)}
    ${sec("For drivers", `<ol class="steps"><li><b>Heading somewhere today?</b> Post your trip.</li><li><b>See paid jobs on your route</b> and what each one pays you.</li><li><b>Take the ones that suit you,</b> text the sender to confirm, collect and deliver.</li><li><b>Get paid weekly</b> by bank transfer.</li></ol>`)}
    ${sec("Pricing", `<p class="sub">One all-in price, shown before you post. Our cut is 15% (minimum $3), and the driver always gets the rest.</p><div class="rates">
      <div><span class="num">5–15c/km</span><span>along the route, depending on size.</span></div>
      <div><span class="num">80c/km</span><span>for the detour to the door and back.</span></div>
      <div><span class="num">$23.95/h</span><span>for the driver's extra time, at the NZ minimum wage.</span></div>
      <div><span class="num">+25%</span><span>on km for same-day express or a set arrival time. If it's late, you pay the normal rate.</span></div>
      <div><span class="num">$0</span><span>detour if you meet the driver on the route.</span></div></div>`)}
    ${sec("Collection and no-shows", `<p class="sub">Say how it can be collected: someone's home (and when), left out, at a business, or meet on the route. Drivers text you before they set off. If they arrive when you said and it isn't available, a no-show fee covering their trip is kept from your payment, and the rest refunded.</p>`)}
    ${sec("For businesses", `<p class="sub">Post jobs first thing. If no driver takes it by your cut-off, we text you to book your usual courier. <button class="linkbtn" data-tab-link="business" type="button">Register interest</button></p>`)}
    ${sec("Trial service", `<ul class="plainlist"><li>Items aren't insured yet, so please only send things worth less than $500</li><li>Drivers' licences and vehicles are checked before their first job</li><li>Addresses are only shared with your driver</li><li>Your payment is held until delivery is confirmed</li></ul>`)}
  </section>`;
}

// =====================================================================
// rendering & events
// =====================================================================
const views = { send, drive, board, info, mine, business };
function render() {
  $("#view").innerHTML = views[cur]();
  document.querySelectorAll(".tabs button").forEach(b => b.setAttribute("aria-selected", b.dataset.tab === cur));
  updPickupMode(); updPrice();
}
function go(tab) { cur = tab; render(); window.scrollTo(0, 0); }
function showErr(box, msg) { $(box).innerHTML = msg ? `<div class="err">${msg}</div>` : ""; }
function checkContact(errBox) {
  const name = v("c-name"), phone = v("c-phone");
  $("#c-phone").setAttribute("aria-invalid", String(!validPhone(phone)));
  if (!name) return showErr(errBox, "Please add your name."), false;
  if (!validPhone(phone)) return showErr(errBox, "Please enter a NZ mobile number, like 021 123 4567."), false;
  memo.set({ name, phone });
  return true;
}
const niceError = e => { const m = e?.message || ""; return /someone else|outside|licence|isn't live|yours to update|give back/i.test(m) ? esc(m) : "That didn't go through. Check your connection and try again." + (m ? ` <span style="display:block;font-size:12px;opacity:.8;margin-top:4px">Details: ${esc(m)}</span>` : ""); };
async function save(table, row, errBox, btn) {
  if (!db) return showErr(errBox, "The site isn't connected yet, so this can't be saved."), null;
  btn.disabled = true; const label = btn.textContent; btn.textContent = "Sending…";
  try {
    await ensureSession();
    const { data, error } = await db.from(table).insert(row).select("*").single();
    if (error) throw error;
    return data;
  } catch (e) { console.error(e); showErr(errBox, niceError(e)); return null; }
  finally { btn.disabled = false; btn.textContent = label; }
}

document.addEventListener("click", async e => {
  const tab = e.target.closest(".tabs [data-tab]"); if (tab) return go(tab.dataset.tab);
  const link = e.target.closest("[data-tab-link]"); if (link) return go(link.dataset.tabLink);
  if (e.target.closest("#mineBtn")) return go("mine");
  const md = e.target.closest("[data-mode]"); if (md) { sendMode = md.dataset.mode; return render(); }
  const cx = e.target.closest("[data-cancel]");
  if (cx) {
    if (cx.dataset.confirm !== "1") { cx.dataset.confirm = "1"; cx.textContent = "Tap again to cancel"; return; }
    const [t, id] = cx.dataset.cancel.split(":"); cx.disabled = true;
    const { error } = await db.from(t).update({ status: "cancelled" }).eq("id", id);
    if (error) { cx.textContent = "Couldn't cancel. Text us instead."; return; }
    return loadMine();
  }
  const cl = e.target.closest("[data-claim]");
  if (cl) {
    const [job, trip] = cl.dataset.claim.split(":"); cl.disabled = true; cl.textContent = "Taking it…";
    const { error } = await db.rpc("claim_job", { p_job: job, p_trip: trip });
    if (error) { cl.outerHTML = `<div class="err">${niceError(error)}</div>`; return; }
    return cur === "mine" ? loadMine() : refreshTripPanel(trip);
  }
  const st = e.target.closest("[data-step]");
  if (st) {
    const [job, step] = st.dataset.step.split(":");
    if (st.dataset.confirm !== "1") { st.dataset.confirm = "1"; st.textContent = step === "collected" ? "Tap again: collected, photo taken" : "Tap again: delivered, photo taken"; return; }
    st.disabled = true;
    const { error } = await db.rpc("job_progress", { p_job: job, p_step: step });
    if (error) { st.outerHTML = `<div class="err">${niceError(error)}</div>`; return; }
    return cur === "mine" ? loadMine() : refreshTripPanel(lastTrip?.id);
  }
  const rl = e.target.closest("[data-release]");
  if (rl) {
    if (rl.dataset.confirm !== "1") { rl.dataset.confirm = "1"; rl.textContent = "Tap again to give it back"; return; }
    rl.disabled = true;
    const { error } = await db.rpc("release_job", { p_job: rl.dataset.release });
    if (error) { rl.outerHTML = `<div class="err">${niceError(error)}</div>`; return; }
    return cur === "mine" ? loadMine() : refreshTripPanel(lastTrip?.id);
  }
});
let lastTrip = null;
async function refreshTripPanel(tripId) {
  const box = $("#t-done"); if (!box || !tripId) return loadMine();
  const [{ data: t }, uid] = await Promise.all([db.from("trips").select("*").eq("id", tripId).single(), myId()]);
  const { data: p } = await db.from("profiles").select("verified_driver").eq("id", uid).single();
  lastTrip = t;
  setTimeout(() => showPhotos(db), 0);
  box.innerHTML = `<div class="ok"><h3>${t.status === "open" ? "Your trip is live" : "Trip posted, thanks!"}</h3><p class="sub">${esc(t.from_town)} → ${esc(t.to_town)}, ${fmtDate(t.trip_date)}. You can find it any time under My posts.</p></div>` + await tripJobsPanel(t, !!p?.verified_driver);
}
document.addEventListener("input", e => { if (e.target.closest("#jobForm")) updPrice(); });
document.addEventListener("change", async e => {
  const inp = e.target.closest("[data-photo]"); if (!inp || !inp.files?.[0]) return;
  const [job, kind] = inp.dataset.photo.split(":"), btn = inp.closest("label"), label = btn.firstChild.textContent;
  btn.firstChild.textContent = "Uploading photo…"; inp.disabled = true;
  try {
    await uploadJobPhoto(db, job, kind, inp.files[0]);
    if (kind === "pickup" || kind === "dropoff") {
      const { error } = await db.rpc("job_progress", { p_job: job, p_step: kind === "pickup" ? "collected" : "delivered" });
      if (error) throw error;
    } else {
      btn.outerHTML = `<div class="note">Photo saved. We'll contact the sender and sort out the no-show fee; you'll still be paid for your trip.</div>`;
      return showPhotos(db);
    }
    return cur === "mine" ? loadMine() : refreshTripPanel(lastTrip?.id);
  } catch (err) { console.error(err); btn.firstChild.textContent = label; inp.disabled = false; inp.value = ""; btn.insertAdjacentHTML("afterend", `<div class="err">Photo didn't upload. Check your signal and try again. <span style="display:block;font-size:12px;opacity:.8">Details: ${esc(err.message || err)}</span></div>`); }
});
document.addEventListener("change", e => { if (e.target.closest("#jobForm")) { updPickupMode(); updPrice(); } });

document.addEventListener("submit", async e => {
  e.preventDefault();
  const f = e.target, btn = f.querySelector("button[type=submit]");
  if (f.id === "jobForm") {
    const j = jobValues();
    if (!j.item) return showErr("#j-err", "Please say what it is.");
    if (j.from_town === j.to_town) return showErr("#j-err", "Pick two different towns.");
    if (!j.pickup_address || !j.drop_address) return showErr("#j-err", "Please add the pickup and delivery addresses, so your driver knows where to go. Only your driver sees them.");
    if (j.kind === "pickup" && (!j.seller_name || !validPhone(j.seller_phone || ""))) return showErr("#j-err", "Please add the seller's name and mobile, so the driver can arrange pickup.");
    if (j.pickup_mode === "left_out" && !j.pickup_notes) return showErr("#j-err", "Please say where it's left, so the driver can find it.");
    if (!j.window_end || j.window_end < todayISO()) return showErr("#j-err", "Pick a deliver-by day, today or later.");
    if (j.job_date > j.window_end) return showErr("#j-err", "The earliest pickup day is after the deliver-by day.");
    if (!checkContact("#j-err")) return;
    if (!$("#c-ok").checked) return showErr("#j-err", "Please tick the box to agree to the trial terms.");
    showErr("#j-err", "");
    const row = { ...j, price_estimate: jobPrice(j)?.total ?? null };
    const saved = await save("jobs", row, "#j-err", btn);
    if (saved) {
      f.closest(".card").hidden = true;
      $("#j-done").innerHTML = `<div class="ok"><h3>Posted. One step left.</h3><p class="sub">Your ${esc(j.item)} (${esc(j.from_town)} → ${esc(j.to_town)}, by ${fmtDate(j.window_end)}) goes on the board once it's paid.</p></div>` + payPanel(saved)
        + `<button class="linkbtn" type="button" data-tab-link="mine">See my posts</button>`;
    }
  }
  if (f.id === "tripForm") {
    const row = { from_town: v("t-from"), to_town: v("t-to"), from_suburb: v("t-fa") || null, to_suburb: v("t-ta") || null, trip_date: v("t-date"), depart_time: v("t-time") || null,
      space: v("t-space"), max_detour_km: +v("t-det"), vehicle: v("t-veh") || null, space_note: v("t-note") || null, regular: $("#t-reg").checked, driver_name: v("c-name"), driver_phone: v("c-phone") };
    if (row.from_town === row.to_town) return showErr("#t-err", "Pick two different towns.");
    if (!row.from_suburb || !row.to_suburb) return showErr("#t-err", "Please say roughly where you're leaving from and arriving at. A suburb or \"CBD\" is fine.");
    if (!row.trip_date || row.trip_date < todayISO()) return showErr("#t-err", "Pick today or a later day.");
    if (!checkContact("#t-err")) return;
    showErr("#t-err", "");
    memo.set({ tfa: row.from_suburb, tta: row.to_suburb, tspace: row.space, tveh: row.vehicle || "" });
    const saved = await save("trips", row, "#t-err", btn);
    if (saved) { f.closest(".card").hidden = true; await refreshTripPanel(saved.id); }
  }
  if (f.id === "bizForm") {
    if (!v("b-name")) return showErr("#b-err", "Please add your business name.");
    if (!checkContact("#b-err")) return;
    showErr("#b-err", "");
    const row = { business_name: v("b-name"), town: v("b-town"), sends_per_week: v("b-vol"), contact_name: v("c-name"), contact_phone: v("c-phone"), contact_email: v("b-email") || null, notes: v("b-notes") || null };
    if (await save("business_interest", row, "#b-err", btn)) {
      f.closest(".card").hidden = true;
      $("#b-done").innerHTML = `<div class="ok"><h3>Thanks. We'll be in touch.</h3><p class="sub">We'll call or text ${esc(row.contact_name)} about setting up ${esc(row.business_name)}.</p></div>`;
    }
  }
});

render();
