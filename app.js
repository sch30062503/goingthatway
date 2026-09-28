// Going That Way v1: public site.
// People post without creating an account (an anonymous sign-in happens quietly on first post).
// Every post starts as "new"; the admin texts the poster to confirm, then it appears on the board.

const db = makeClient();
let cur = "send", sendMode = "pickup";

// ---------- remembered contact details (this device only) ----------
const memo = {
  get() { try { return JSON.parse(localStorage.getItem("gtw-contact") || "{}"); } catch { return {}; } },
  set(v) { try { localStorage.setItem("gtw-contact", JSON.stringify(v)); } catch {} },
};

async function ensureSession() {
  const { data } = await db.auth.getSession();
  if (data.session) return data.session;
  const { data: d2, error } = await db.auth.signInAnonymously();
  if (error) throw error;
  return d2.session;
}

// ---------- shared form pieces ----------
const contactFields = (who) => { const m = memo.get(); return `
  <div class="field"><label for="c-name">Your name</label><input id="c-name" autocomplete="given-name" required value="${esc(m.name || "")}"></div>
  <div class="field"><label for="c-phone">Mobile</label><input id="c-phone" type="tel" inputmode="tel" autocomplete="tel" required placeholder="021 123 4567" value="${esc(m.phone || "")}"></div>
  <p class="fine" style="grid-column:1/-1">We'll text you to confirm before your ${who} goes live. Your name and number are never shown publicly.</p>`; };
const banned = `<label class="check"><input type="checkbox" id="c-ok" required> <span>It's worth less than $500, it's not dangerous goods, cash, drugs, weapons or a live animal, and I understand items aren't insured during the trial.</span></label>`;
const notConnected = () => db ? "" : `<div class="err">The site isn't connected to its database yet, so posts can't be saved. (Setup step: fill in config.js.)</div>`;

// ---------- SEND ----------
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
        <div class="field"><label for="j-size">Size</label><select id="j-size">${Object.entries(SIZE_LABEL).map(([k, v]) => `<option value="${k}"${k === (pickup ? "large" : "medium") ? " selected" : ""}>${v}</option>`).join("")}</select></div>
        <div class="field"><label for="j-date">Day</label><input id="j-date" type="date" min="${todayISO()}" value="${todayISO(1)}" required></div>
        ${contactFields("job")}
      </div>
      <details class="more"><summary>More options</summary><div class="fields">
        <div class="field full"><label for="j-pa">${pickup ? "Seller's address or suburb" : "Pickup address"}</label><input id="j-pa" placeholder="Only shared with your driver"></div>
        <div class="field full"><label for="j-da">Deliver to (address)</label><input id="j-da" placeholder="Only shared with your driver"></div>
        <div class="field"><label for="j-dl">Arrival</label><select id="j-dl"><option value="">Any time that day</option><option value="by">By a set time (+25%)</option></select></div>
        <div class="field"><label for="j-dlt">Arrive by</label><input id="j-dlt" type="time" value="13:00"></div>
        <div class="field full"><label for="j-hand">Handover</label><select id="j-hand"><option value="door">Door to door</option><option value="route">Meet the driver on the route (cheapest)</option></select></div>
        <div class="field full"><label for="j-desc">Anything the driver should know?</label><textarea id="j-desc" placeholder="e.g. Seller will help load. Keep upright."></textarea></div>
      </div></details>
      <div id="j-price"></div>
      ${banned}
      <div id="j-err"></div>
      <button class="btn go" type="submit">${pickup ? "Find a driver to collect it" : "Find a driver"}</button>
    </form></div>
    <div id="j-done"></div>
  </section>`;
}
function jobValues() {
  const v = id => ($("#" + id)?.value || "").trim();
  return {
    kind: sendMode, item: v("j-item"), listing_url: v("j-link") || null, from_town: v("j-from"), to_town: v("j-to"),
    size: v("j-size"), job_date: v("j-date"), deadline_time: v("j-dl") === "by" ? (v("j-dlt") || null) : null,
    handover: v("j-hand") || "door", cover: +(v("j-cover") || 500), pickup_address: v("j-pa") || null, drop_address: v("j-da") || null,
    description: v("j-desc") || null, sender_name: v("c-name"), sender_phone: v("c-phone"),
  };
}
function updPrice() {
  const box = $("#j-price"); if (!box) return;
  const j = jobValues();
  const e = estimate({ from: j.from_town, to: j.to_town, size: j.size, handover: j.handover, deadline: j.deadline_time, cover: j.cover });
  if (!e) { box.innerHTML = `<p class="fine">Pick two different towns to see a price.</p>`; return; }
  box.innerHTML = `<div class="allin"><span>Estimated all-in price</span><b class="num">$${e.total}</b></div>
    <p class="fine" style="margin-top:6px">${e.onRoute} km. The final price is confirmed by text before anything is booked; you pay on delivery.</p>
    <div class="note" style="margin-top:6px"><b>Trial service: items aren't insured yet.</b> We take photos at pickup and drop-off and handle everything with care, but please don't send anything worth more than $500.</div>
    ${e.prem ? `<div class="note" style="margin-top:6px">Includes a $${e.prem} premium for a set arrival time, paid to the driver. Delays like road closures, crashes or weather can still happen. If it arrives after your set time, you only pay the normal rate ($${e.normal}).</div>` : ""}`;
}

// ---------- DRIVE ----------
function drive() {
  return `<section>
    <h2>Driving between Christchurch and Timaru anyway?</h2>
    <p class="sub">Post your trip. We'll text you parcels and pick-up-only buys on your route, at a fair price for any detour. You choose what you take.</p>
    ${notConnected()}
    <div class="card"><form id="tripForm" novalidate>
      <div class="fields">
        <div class="field"><label for="t-from">From</label><select id="t-from">${townOptions("Christchurch")}</select></div>
        <div class="field"><label for="t-to">To</label><select id="t-to">${townOptions("Timaru")}</select></div>
        <div class="field"><label for="t-date">Day</label><input id="t-date" type="date" min="${todayISO()}" value="${todayISO(1)}" required></div>
        <div class="field"><label for="t-time">Leaving about</label><input id="t-time" type="time" value="08:00"></div>
        <div class="field"><label for="t-space">Space</label><select id="t-space">${Object.entries(SPACE_LABEL).map(([k, v]) => `<option value="${k}"${k === "ute" ? " selected" : ""}>${v}</option>`).join("")}</select></div>
        <div class="field"><label for="t-det">Max detour</label><select id="t-det"><option value="5">5 km</option><option value="10">10 km</option><option value="20" selected>20 km</option><option value="30">30 km</option></select></div>
        ${contactFields("trip")}
      </div>
      <details class="more"><summary>More options</summary><div class="fields">
        <div class="field full"><label for="t-veh">Your vehicle</label><input id="t-veh" placeholder="e.g. Toyota Hilux double cab"></div>
        <div class="field full"><label for="t-note">Space available</label><input id="t-note" placeholder="e.g. Open tray 1.5 × 1.5 m, straps"></div>
        <div class="field full"><label class="check"><input type="checkbox" id="t-reg"> <span>I do this run most weeks</span></label></div>
      </div></details>
      <p class="fine">Before your first job we'll check your driver licence and vehicle. Passengers aren't part of the trial yet.</p>
      <div id="t-err"></div>
      <button class="btn go" type="submit">Post my trip</button>
    </form></div>
    <div id="t-done"></div>
  </section>`;
}

// ---------- BUSINESS ----------
function business() {
  return `<section>
    <h2>Send from your business</h2>
    <p class="sub">Post urgent parts and orders first thing. If no driver takes a job by your cut-off (say 3:30 pm), we text you to book your usual courier, so you never lose a day.</p>
    ${notConnected()}
    <div class="card"><form id="bizForm" novalidate><div class="fields">
      <div class="field full"><label for="b-name">Business name</label><input id="b-name" required></div>
      <div class="field"><label for="b-town">Town</label><select id="b-town">${townOptions("Ashburton")}</select></div>
      <div class="field"><label for="b-vol">Items sent a week</label><select id="b-vol"><option>1 to 5</option><option>5 to 20</option><option>20 or more</option></select></div>
      ${contactFields("account")}
      <div class="field full"><label for="b-email">Email (optional)</label><input id="b-email" type="email" autocomplete="email"></div>
      <div class="field full"><label for="b-notes">What do you usually send, and where?</label><textarea id="b-notes" placeholder="e.g. Parts from our Ashburton store to Timaru customers, most days"></textarea></div>
    </div>
    <div id="b-err"></div>
    <button class="btn go" type="submit">Register interest</button></form></div>
    <div id="b-done"></div>
  </section>`;
}

// ---------- BOARD ----------
function board() {
  setTimeout(loadBoard, 0);
  return `<section><h2>On the road this week</h2><p class="sub">Approved posts only. Addresses and contact details are never shown.</p>
    <div class="label">Needs moving</div><div id="bj" class="empty">Loading…</div>
    <div class="label">Drivers heading out</div><div id="bt" class="empty">Loading…</div></section>`;
}
const plate = (f, t) => `<div class="plate"><div class="towns">${esc(f)} → ${esc(t)}</div><div class="km">${(f in KM && t in KM) ? dist(f, t) + " km" : ""}</div></div>`;
async function loadBoard() {
  if (!db) { $("#bj").textContent = $("#bt").textContent = "Not connected yet."; return; }
  const [j, t] = await Promise.all([
    db.from("board_jobs").select("*").order("job_date").limit(50),
    db.from("board_trips").select("*").order("trip_date").limit(50),
  ]);
  const bj = $("#bj"), bt = $("#bt"); if (!bj) return;
  if (j.error || t.error) { bj.textContent = bt.textContent = "Couldn't load the board. Try again shortly."; return; }
  bj.className = bt.className = "";
  bj.innerHTML = j.data.length ? j.data.map(r => `<div class="card" style="margin-bottom:8px"><div class="row"><div>${r.kind === "pickup" ? `<span class="tag">Pick-up-only buy</span> ` : ""}<span class="item">${esc(r.item)}</span></div>${r.price_estimate ? `<span class="chip g num">$${Math.round(r.price_estimate)}</span>` : ""}</div>${plate(r.from_town, r.to_town)}<div class="meta"><span>${fmtDate(r.job_date)}${r.deadline_time ? ", by " + fmtTime(r.deadline_time) : ""}</span><span class="chip">${esc(SIZE_LABEL[r.size]?.split(" (")[0] || r.size)}</span>${r.status === "matched" ? `<span class="chip y">Driver found</span>` : ""}</div></div>`).join("")
    : `<div class="empty">Nothing yet. Be the first: post a job.</div>`;
  bt.innerHTML = t.data.length ? t.data.map(r => `<div class="card" style="margin-bottom:8px">${plate(r.from_town, r.to_town)}<div class="meta"><span>${fmtDate(r.trip_date)}${r.depart_time ? ", leaving " + fmtTime(r.depart_time) : ""}</span><span class="chip">${esc(SPACE_LABEL[r.space] || r.space)}</span></div></div>`).join("")
    : `<div class="empty">No trips posted yet. Driving this week? Post your trip.</div>`;
}

// ---------- MY POSTS ----------
function mine() {
  setTimeout(loadMine, 0);
  return `<section><h2>My posts</h2><p class="sub">Posts made from this phone or computer.</p><div id="mine" class="empty">Loading…</div></section>`;
}
const STATUS = { new: ["Waiting for our text", ""], open: ["Live on the board", "g"], matched: ["Driver found", "y"], delivered: ["Delivered", "g"], full: ["Full", ""], done: ["Done", "g"], cancelled: ["Cancelled", ""] };
async function loadMine() {
  const box = $("#mine");
  if (!db) { box.textContent = "Not connected yet."; return; }
  const { data } = await db.auth.getSession();
  if (!data.session) { box.innerHTML = `<div class="empty">You haven't posted anything from this device yet.</div>`; return; }
  const [j, t] = await Promise.all([db.from("jobs").select("*").order("created_at", { ascending: false }), db.from("trips").select("*").order("created_at", { ascending: false })]);
  const items = [...(j.data || []).map(r => ({ ...r, _t: "jobs" })), ...(t.data || []).map(r => ({ ...r, _t: "trips" }))].sort((a, b) => b.created_at.localeCompare(a.created_at));
  box.className = "";
  box.innerHTML = items.length ? items.map(r => { const [s, c] = STATUS[r.status] || [r.status, ""]; const canCancel = !["cancelled", "delivered", "done"].includes(r.status);
    return `<div class="card" style="margin-bottom:8px"><div class="row"><span class="item">${r._t === "jobs" ? esc(r.item) : "Trip"}</span><span class="chip ${c}">${s}</span></div>${plate(r.from_town, r.to_town)}
      <div class="meta"><span>${fmtDate(r.job_date || r.trip_date)}</span>${r.price_estimate ? `<span class="num">est. $${Math.round(r.price_estimate)}</span>` : ""}${canCancel ? `<button class="btn small" data-cancel="${r._t}:${r.id}" style="margin-left:auto">Cancel</button>` : ""}</div></div>`; }).join("")
    : `<div class="empty">You haven't posted anything from this device yet.</div>`;
}

// ---------- HOW IT WORKS ----------
function info() {
  const sec = (t, b) => `<div class="card"><h3>${t}</h3>${b}</div>`;
  return `<section><h2>How it works</h2>
    ${sec("In four steps", `<ol class="steps"><li><b>Drivers post trips</b> they're already making.</li><li><b>You post what needs moving:</b> a pick-up-only buy or a parcel.</li><li><b>We text you both</b> to confirm the match and the price.</li><li><b>It's delivered.</b> Photos at pickup and drop-off; you pay on delivery.</li></ol>`)}
    ${sec("Pricing", `<p class="sub">One all-in price. It includes our cut, and the driver always gets their full rate.</p><div class="rates">
      <div><span class="num">5–15c/km</span><span>along the driver's route, depending on size.</span></div>
      <div><span class="num">80c/km</span><span>for the detour to your door and back.</span></div>
      <div><span class="num">$23.95/h</span><span>for the driver's extra time, at the NZ minimum wage.</span></div>
      <div><span class="num">+25%</span><span>on km if you need a set arrival time (min $3). If it's late, you pay the normal rate.</span></div>
      <div><span class="num">$0</span><span>detour if you meet the driver on the route.</span></div>
      <div><span class="num">Trial</span><span>items aren't insured yet, so please only send things worth less than $500. Cover is coming before we open to everyone.</span></div></div>`)}
    ${sec("Pick-up-only buys", `<p class="sub">Pay the seller as usual. The driver collects it, photographs it so you can check it matches the listing, and brings it to you.</p>`)}
    ${sec("For businesses", `<p class="sub">Post jobs first thing. If no driver takes it by your cut-off, we text you to book your usual courier. <button class="linkbtn" data-tab-link="business" type="button">Register interest</button></p>`)}
    ${sec("Staying safe", `<ul class="plainlist"><li>We text every poster before anything goes live</li><li>Drivers' licences and vehicles checked before their first job</li><li>Addresses only shared with your driver</li><li>Photos at pickup and drop-off</li><li>Pay on delivery</li></ul>`)}
  </section>`;
}

// ---------- rendering & events ----------
const views = { send, drive, board, info, mine, business };
function render() {
  $("#view").innerHTML = views[cur]();
  document.querySelectorAll(".tabs button").forEach(b => b.setAttribute("aria-selected", b.dataset.tab === cur));
  updPrice();
}
function go(tab) { cur = tab; render(); window.scrollTo(0, 0); }

function showErr(box, msg) { $(box).innerHTML = msg ? `<div class="err">${msg}</div>` : ""; }
function checkContact(errBox) {
  const name = $("#c-name").value.trim(), phone = $("#c-phone").value.trim();
  $("#c-phone").setAttribute("aria-invalid", String(!validPhone(phone)));
  if (!name) return showErr(errBox, "Please add your name."), false;
  if (!validPhone(phone)) return showErr(errBox, "Please enter a NZ mobile number, like 021 123 4567."), false;
  memo.set({ name, phone });
  return true;
}
async function save(table, row, errBox, btn) {
  if (!db) return showErr(errBox, "The site isn't connected yet, so this can't be saved."), false;
  btn.disabled = true; const label = btn.textContent; btn.textContent = "Sending…";
  try {
    await ensureSession();
    const { error } = await db.from(table).insert(row);
    if (error) throw error;
    return true;
  } catch (e) {
    console.error(e);
    showErr(errBox, "That didn't go through. Check your connection and try again." + (e?.message ? ` <span style="display:block;font-size:12px;opacity:.8;margin-top:4px">Details: ${esc(e.message)}</span>` : ""));
    return false;
  } finally { btn.disabled = false; btn.textContent = label; }
}
const done = (title, body) => `<div class="ok"><h3>${title}</h3><p class="sub">${body}</p><button class="linkbtn" type="button" data-tab-link="mine" style="align-self:flex-start">See my posts</button></div>`;

document.addEventListener("click", async e => {
  const tab = e.target.closest(".tabs [data-tab]"); if (tab) return go(tab.dataset.tab);
  const link = e.target.closest("[data-tab-link]"); if (link) return go(link.dataset.tabLink);
  if (e.target.closest("#mineBtn")) return go("mine");
  const md = e.target.closest("[data-mode]"); if (md) { sendMode = md.dataset.mode; return render(); }
  const cx = e.target.closest("[data-cancel]");
  if (cx) {
    if (cx.dataset.confirm !== "1") { cx.dataset.confirm = "1"; cx.textContent = "Tap again to cancel"; return; }
    const [t, id] = cx.dataset.cancel.split(":");
    cx.disabled = true;
    const { error } = await db.from(t).update({ status: "cancelled" }).eq("id", id);
    if (error) { cx.textContent = "Couldn't cancel"; return; }
    loadMine();
  }
});
document.addEventListener("input", e => { if (e.target.closest("#jobForm")) updPrice(); });
document.addEventListener("change", e => { if (e.target.closest("#jobForm")) updPrice(); });

document.addEventListener("submit", async e => {
  e.preventDefault();
  const f = e.target, btn = f.querySelector("button[type=submit]");
  if (f.id === "jobForm") {
    const j = jobValues();
    if (!j.item) return showErr("#j-err", "Please say what it is.");
    if (j.from_town === j.to_town) return showErr("#j-err", "Pick two different towns.");
    if (!j.job_date || j.job_date < todayISO()) return showErr("#j-err", "Pick today or a later day.");
    if (!checkContact("#j-err")) return;
    if (!$("#c-ok").checked) return showErr("#j-err", "Please tick the box to confirm the item is under $500 and not a banned item.");
    showErr("#j-err", "");
    const est = estimate({ from: j.from_town, to: j.to_town, size: j.size, handover: j.handover, deadline: j.deadline_time, cover: j.cover });
    const row = { ...j, price_estimate: est?.total ?? null };
    if (await save("jobs", row, "#j-err", btn)) {
      f.closest(".card").hidden = true;
      $("#j-done").innerHTML = done("Got it. We'll text you shortly.", `We'll text ${esc(j.sender_name)} on ${esc(j.sender_phone)} to confirm the details and price, then find a driver going from ${esc(j.from_town)} to ${esc(j.to_town)}.`);
    }
  }
  if (f.id === "tripForm") {
    const v = id => ($("#" + id)?.value || "").trim();
    const row = { from_town: v("t-from"), to_town: v("t-to"), trip_date: v("t-date"), depart_time: v("t-time") || null, space: v("t-space"), max_detour_km: +v("t-det"),
      vehicle: v("t-veh") || null, space_note: v("t-note") || null, regular: $("#t-reg").checked, driver_name: v("c-name"), driver_phone: v("c-phone") };
    if (row.from_town === row.to_town) return showErr("#t-err", "Pick two different towns.");
    if (!row.trip_date || row.trip_date < todayISO()) return showErr("#t-err", "Pick today or a later day.");
    if (!checkContact("#t-err")) return;
    showErr("#t-err", "");
    if (await save("trips", row, "#t-err", btn)) {
      f.closest(".card").hidden = true;
      $("#t-done").innerHTML = done("Trip posted. Thanks!", `We'll text ${esc(row.driver_name)} to say hello, check your licence and vehicle, and send you any jobs on your route.`);
    }
  }
  if (f.id === "bizForm") {
    const v = id => ($("#" + id)?.value || "").trim();
    if (!v("b-name")) return showErr("#b-err", "Please add your business name.");
    if (!checkContact("#b-err")) return;
    showErr("#b-err", "");
    const row = { business_name: v("b-name"), town: v("b-town"), sends_per_week: v("b-vol"), contact_name: v("c-name"), contact_phone: v("c-phone"), contact_email: v("b-email") || null, notes: v("b-notes") || null };
    if (await save("business_interest", row, "#b-err", btn)) {
      f.closest(".card").hidden = true;
      $("#b-done").innerHTML = done("Thanks. We'll be in touch.", `We'll call or text ${esc(row.contact_name)} about setting up ${esc(row.business_name)}.`);
    }
  }
});

render();
