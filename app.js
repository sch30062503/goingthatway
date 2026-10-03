// Going That Way: public site.
// Senders post and pay ahead; the job goes live once the admin sees the payment.
// Drivers decide on the day: post a trip, see paid jobs on their route, take one, collect, deliver.

const db = makeClient();
const cfg = window.GTW_CONFIG || {};
let cur = /^#(account|mine)$/.test(location.hash) ? "account" : "send", sendMode = "pickup";
// Arrived from a "reset your password" email link
let recovery = /type=recovery/.test(location.hash);

// ---------- remembered details (this device only) ----------
const memo = {
  get() { try { return JSON.parse(localStorage.getItem("gtw-contact") || "{}"); } catch { return {}; } },
  set(v) { try { localStorage.setItem("gtw-contact", JSON.stringify({ ...memo.get(), ...v })); } catch {} },
};
// Signed-in member and their profile (verification status etc.)
const me = { user: null, profile: null };
async function loadMe() {
  if (!db) return;
  const { data } = await db.auth.getSession();
  const u = data.session?.user;
  me.user = u && !u.is_anonymous ? u : null;
  me.profile = null;
  if (me.user) { const { data: p } = await db.from("profiles").select("*").eq("id", me.user.id).single(); me.profile = p || null; }
  const b = $("#mineBtn"); if (b) b.textContent = me.user ? "My account" : "Sign in";
}
async function ensureSession() { if (!me.user) throw new Error("Please sign in first"); return me.user; }
async function myId() { return me.user?.id || null; }
const idOk = () => ["pending", "verified"].includes(me.profile?.id_status);
const driverOk = () => ["pending", "verified"].includes(me.profile?.driver_status);
const STATUS_CHIP = { none: ["Not started", ""], pending: ["Being checked", "y"], verified: ["Verified", "g"], rejected: ["Needs another go", ""] };
const chip = st => { const [t, c] = STATUS_CHIP[st || "none"]; return `<span class="chip ${c}">${t}</span>`; };
function gate(title, body, btnLabel, target) {
  return `<div class="card" style="border:2px solid var(--sign)"><h3>${title}</h3><p class="sub">${body}</p><button class="btn go" type="button" data-tab-link="${target}">${btnLabel}</button></div>`;
}
const postingAs = () => `<p class="fine" style="grid-column:1/-1">Posting as <b>${esc(me.profile?.name || me.user?.email || "")}</b> · ${esc(me.profile?.phone || "")}. Change these under My account. Your details are never shown publicly.</p>`;

// ---------- "I'm human" check (Cloudflare Turnstile), on only once a site key is in config.js ----------
const TS = { ids: {}, tries: 0 };
const tsBox = name => cfg.TURNSTILE_SITE_KEY ? `<div class="ts" id="ts-${name}"></div>` : "";
function tsMount() {
  if (!cfg.TURNSTILE_SITE_KEY || !document.querySelector(".ts:empty")) return;
  if (!window.turnstile) { if (TS.tries++ < 40) setTimeout(tsMount, 250); return; }
  document.querySelectorAll(".ts:empty").forEach(el => { TS.ids[el.id.slice(3)] = window.turnstile.render(el, { sitekey: cfg.TURNSTILE_SITE_KEY, theme: "auto", size: "flexible" }); });
}
function tsToken(name) {
  if (!cfg.TURNSTILE_SITE_KEY) return undefined;
  const id = TS.ids[name], t = id !== undefined && window.turnstile ? window.turnstile.getResponse(id) : "";
  if (!t) throw new Error("Please complete the \"I'm human\" check first. If you can't see it, refresh the page.");
  return t;
}
function tsReset(name) { try { if (window.turnstile && TS.ids[name] !== undefined) window.turnstile.reset(TS.ids[name]); } catch (e) {} }

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

const copyBtn = (text, label = "Copy") => `<button class="btn small" type="button" data-copy="${esc(text)}">${label}</button>`;
function payPanel(j) {
  const amount = Math.round(j.price_estimate || 0), ref = jobRef(j);
  const line = (k, val, copy) => `<div class="payline"><span class="k">${k}</span><span class="num v">${val}</span>${copyBtn(copy)}</div>`;
  return `<div class="card" style="border:2px solid var(--sign)"><h3>Pay $${amount} to make it live</h3>
    ${bankSet() ? `<div class="paylines">
      ${line("Amount", `$${amount}`, String(amount))}
      ${line("Account", `${esc(cfg.BANK_ACCOUNT)}<span class="fine" style="display:block">${esc(cfg.BANK_NAME || "Going That Way")}</span>`, cfg.BANK_ACCOUNT)}
      ${line("Reference", `<b>${ref}</b>`, ref)}</div>
      <p class="fine">Tap Copy, then paste into your banking app. Please use the reference exactly, so we can match your payment.</p>`
      : `<p class="sub">We'll text you the bank details with your reference <b class="num">${ref}</b>.</p>`}
    <p class="fine">Your job goes on the board as soon as we see the payment, usually within a few hours. We hold your money and only pay the driver once it's delivered. If no driver takes it by ${fmtDate(j.window_end || j.job_date)}, you get a full refund.</p></div>`;
}

// A message the buyer sends the seller, so they know a driver is coming
function sellerMsg(j) {
  const site = cfg.SITE_NAME || "goingthatway.co.nz";
  return `Hi${j.seller_name ? " " + j.seller_name.split(" ")[0] : ""}, it's ${(j.sender_name || "").split(" ")[0] || "the buyer"}, the buyer of the ${j.item}. I've arranged for a Going That Way driver to collect it for me between ${fmtDate(j.job_date)} and ${fmtDate(j.window_end || j.job_date)}. They'll text you first to arrange a time${j.check_first ? ", and take a few photos for me before loading" : ""}. Could you help them load it? Thanks! (Ref ${jobRef(j)}, ${site})`;
}
function sellerPanel(j) {
  if (j.kind !== "pickup") return "";
  const msg = sellerMsg(j);
  return `<div class="card"><h3>Let the seller know</h3>
    <p class="sub">Send this to the seller through Trade Me, Marketplace or a text, so they're expecting the driver.</p>
    <div class="quote">${esc(msg)}</div>
    <div style="display:flex;gap:6px;flex-wrap:wrap">${copyBtn(msg, "Copy message")}${j.seller_phone ? `<a class="btn small" href="${smsLink(j.seller_phone, msg)}">Text it to ${esc((j.seller_name || "the seller").split(" ")[0])}</a>` : ""}</div></div>`;
}

// Example prices, worked out live from the same pricing as the real form
const EXAMPLES = [
  ["3-seater couch", "Christchurch", "Timaru", "xl"],
  ["Washing machine", "Christchurch", "Ashburton", "large"],
  ["Kids' bike", "Oamaru", "Dunedin", "large"],
  ["Dining set", "Christchurch", "Dunedin", "xl"],
  ["Box of tractor parts", "Christchurch", "Timaru", "medium"],
];
function examplePrices() {
  const rows = EXAMPLES.map(([item, f, t, size]) => { const e = estimate({ from: f, to: t, size, handover: "door", cover: 500 });
    return `<div class="ex"><div><b>${item}</b><span>${f} → ${t}</span></div><b class="num">$${e.total}</b></div>`; }).join("");
  const c = estimate({ from: "Christchurch", to: "Timaru", size: "xl", handover: "door", cover: 500 }), cc = estimate({ from: "Christchurch", to: "Timaru", size: "xl", handover: "door", cover: 500, check: true });
  return `<div class="card examples"><div class="label">Example prices, door to door</div>${rows}
    <p class="fine">Delivered within the week, all in. Add <b>$${cc.total - c.total}</b> to have the driver check it and send you photos before collecting. Collecting it yourself from Christchurch means a ${2 * dist("Christchurch", "Timaru")} km round trip from Timaru, about 4 hours of driving.</p></div>`;
}

// "Report a problem" form, on the sender's and the driver's view of a job
function reportForm(id, role) {
  const kinds = role === "driver" ? ["not_turned_up", "not_as_described", "wrong_item", "damaged", "late", "payment", "safety", "other"] : ["damaged", "late", "not_turned_up", "wrong_item", "not_as_described", "payment", "safety", "other"];
  return `<details class="more report"><summary>Report a problem</summary><div class="reportf" data-reportbox="${id}">
    <div class="field"><label for="rk-${id}">What's wrong?</label><select id="rk-${id}">${kinds.map(k => `<option value="${k}">${REPORT_KINDS[k]}</option>`).join("")}</select></div>
    <div class="field"><label for="rd-${id}">Tell us what happened</label><textarea id="rd-${id}" maxlength="2000" placeholder="What happened, and what would put it right?"></textarea></div>
    <div class="field"><label for="rp-${id}">Photo <span class="hint">(optional)</span></label><input id="rp-${id}" type="file" accept="image/*"></div>
    <button class="btn go" type="button" data-report="${id}">Send to Going That Way</button>
    <p class="fine">Only the Going That Way admin sees this, and we'll get back to you. If anyone's in danger, call 111 first.</p></div></details>`;
}
const REPORT_STATUS = r => r.status === "resolved" ? `Sorted${r.admin_note ? ": " + esc(r.admin_note) : ""}` : "We're looking into it";

// =====================================================================
// SEND
// =====================================================================
function send() {
  const pickup = sendMode === "pickup", collect = sendMode === "collect", buy = pickup || collect;
  const g = !db ? "" : !me.user ? gate("Create a free account to send", "It takes a minute. Everyone on Going That Way is ID-checked once, so drivers and senders know who they're dealing with.", "Sign up or sign in", "account")
    : !idOk() ? gate("Verify your ID first", "Upload a photo of your ID and a selfie. We check it once, then delete the photos. It takes about 2 minutes.", "Verify my ID", "account") : "";
  const head = pickup ? `<h2>Bought it online, but it's pick-up only?</h2><p class="sub">Furniture, whiteware, bikes, parts. Someone already driving that way collects it and brings it to your door. The seller doesn't pack or post a thing.</p>`
    : collect ? `<h2>Ordered from a store in another town?</h2><p class="sub">Click and collect from a store anywhere between Christchurch and Dunedin. Someone already heading your way picks it up from the counter and brings it to your door.</p>`
    : `<h2>Send something with someone going that way</h2><p class="sub">Bulky, awkward or urgent things couriers won't take, carried by people already making the trip.</p>`;
  const steps = `<ol class="steps only-desk"><li><b>Post it and pay.</b> We hold your money until it's delivered.</li>${collect ? `<li><b>Someone already heading your way takes it</b> and collects it from the store counter with your order number.</li>` : `<li><b>Someone already heading your way takes it</b> and arranges pickup with the seller.</li><li><b>Want it checked first?</b> The driver sends photos before loading.</li>`}<li><b>Delivered to your door,</b> with photos at both ends.</li></ol>`;
  if (g) return `<section class="split"><div class="col-a">${head}${buy ? examplePrices() : ""}${steps}</div><div class="col-b">${g}</div></section>`;
  const fold = buy && me.profile?.id_status === "verified";
  return `<section class="split"><div class="col-a">
    ${head}
    ${!buy ? "" : fold ? `<div class="only-desk">${examplePrices()}</div><details class="more only-mob"><summary>Example prices</summary>${examplePrices()}</details>` : examplePrices()}
    ${steps}
    </div><div class="col-b">
    <div class="seg seg3" role="tablist">
      <button type="button" role="tab" data-mode="pickup" aria-selected="${pickup}">Pick-up-only buy</button>
      <button type="button" role="tab" data-mode="collect" aria-selected="${collect}">Click and collect</button>
      <button type="button" role="tab" data-mode="parcel" aria-selected="${!buy}">Send something</button>
    </div>
    ${notConnected()}
    <div class="card"><form id="jobForm" novalidate>
      <div class="fields">
        ${pickup ? `<div class="field full"><label for="j-link">Listing link <span class="hint">(Trade Me, Marketplace)</span></label><input id="j-link" type="url" inputmode="url" placeholder="Paste the link"></div>` : ""}
        <div class="field full"><label for="j-item">${pickup ? "What did you buy?" : collect ? "What did you order?" : "What is it?"}</label><input id="j-item" required placeholder="${pickup ? "e.g. Kids' bike, rimu table" : collect ? "e.g. Flat-pack wardrobe, 20 lengths of 90×45 timber" : "e.g. Box of parts, trailer tyre"}"></div>
        <div class="field"><label for="j-from">${pickup ? "Seller's town" : collect ? "Store's town" : "From"}</label><select id="j-from">${townOptions("Christchurch")}</select></div>
        <div class="field"><label for="j-to">${buy ? "Your town" : "To"}</label><select id="j-to">${townOptions("Timaru")}</select></div>
        ${collect ? `<div class="field full"><label for="j-store">Store</label><input id="j-store" required placeholder="e.g. Bunnings Tower Junction"></div>` : ""}
        <div class="field full"><label for="j-pa">${pickup ? "Seller's address" : collect ? "Store address" : "Pickup address"}</label><input id="j-pa" required autocomplete="off" placeholder="${collect ? "Street and suburb of the store" : "Street and suburb. Only your driver sees it."}"></div>
        ${collect ? `<div class="field"><label for="j-on">Order number</label><input id="j-on" required autocomplete="off" placeholder="From your order email"></div>
        <div class="field"><label for="j-onm">Name the order is under</label><input id="j-onm" required value="${esc(me.profile?.name || "")}"></div>
        <div class="note" style="grid-column:1/-1">Most stores let someone else collect with the order number and the name it's under. Some also ask you to add the collector's name. Once a driver takes your job, you'll see their full name under My account, so you can add them if your store needs it. Only post it once the store says it's ready to collect.</div>` : ""}
        ${pickup ? `<div class="field"><label for="j-sn">Seller's name</label><input id="j-sn" required></div>
        <div class="field"><label for="j-sp">Seller's mobile</label><input id="j-sp" type="tel" inputmode="tel" required placeholder="So the driver can arrange pickup"></div>` : ""}
        <div class="field full"><label for="j-da">Deliver to</label><input id="j-da" required autocomplete="street-address" placeholder="Street and suburb. Only your driver sees it.">${me.profile?.address ? `<button class="linkbtn" type="button" id="useHome" style="align-self:flex-start;font-size:13px">Use my address: ${esc(me.profile.address)}</button>` : ""}</div>
        <div class="field full"><label for="j-type">What kind of thing is it?</label><select id="j-type">${Object.entries(ITEM_TYPES).map(([k, [lab]]) => `<option value="${k}"${k === (pickup ? "big_furniture" : collect ? "furniture" : "parts") ? " selected" : ""}>${lab}</option>`).join("")}</select></div>
        <div class="field"><label for="j-size">Space it needs</label><select id="j-size">${Object.entries(SIZE_LABEL).map(([k, lab]) => `<option value="${k}"${k === (pickup ? "xl" : collect ? "large" : "medium") ? " selected" : ""}>${lab}</option>`).join("")}</select></div>
        <div class="field"><label for="j-by">Deliver by</label><input id="j-by" type="date" min="${todayISO()}" value="${todayISO(6)}" required></div>
        <p class="fine" style="grid-column:1/-1" id="j-by-hint">The more days you allow, the more drivers can take it. Today only is express (+25%).</p>
        <div class="field full urgentf"><label for="j-when">How soon?</label><select id="j-when"><option value="standard">By my deliver-by day</option><option value="urgent">Urgent: it has to get there today</option></select>
          <div id="j-urg" hidden><label for="j-bonus" style="margin-top:8px;display:block">Urgency bonus, all of it to the driver</label><select id="j-bonus">${URGENT_BONUSES.map(b => `<option value="${b}"${b === 30 ? " selected" : ""}>+$${b}</option>`).join("")}</select>
          <p class="fine" style="margin-top:6px">A bigger bonus gets drivers to take a longer detour or leave sooner. We'll also personally ring around drivers heading your way today. Pay straight away so we can put it live fast. We're alerted the moment you post.</p></div></div>
        <div class="field full heavyf"><label class="check"><input type="checkbox" id="j-heavy"${pickup ? " checked" : ""}> <span><b>It's a two-person lift</b><br>Too heavy or awkward for one person to carry safely.</span></label>
          <label class="check" id="j-help-f" style="margin-top:8px"><input type="checkbox" id="j-help"> <span>${pickup ? "The seller will help the driver load it, and someone will be at my place to help unload." : collect ? "Store staff will help the driver load it, and someone will be at my place to help unload." : "Someone will help the driver load it, and someone will help unload at the other end."}</span></label></div>
        ${collect ? `<input type="hidden" id="j-pm" value="business">` : `<div class="field full"><label for="j-pm">How can the driver collect it?</label><select id="j-pm">${Object.entries(PICKUP_LABEL).map(([k, lab]) => `<option value="${k}">${lab}</option>`).join("")}</select></div>`}
        <div class="field full" id="pm-hours-f"><label for="j-ph" id="pm-hours-l">When is someone there?</label><input id="j-ph" placeholder="e.g. weekdays 8 am to 5 pm, or any time"></div>
        <div class="field full" id="pm-notes-f" hidden><label for="j-pn" id="pm-notes-l">Where is it left?</label><input id="j-pn" placeholder="e.g. under the carport. Only your driver sees this."></div>
        ${pickup ? `<div class="field full checkfirst"><label class="check"><input type="checkbox" id="j-check"> <span><b>Check it before I commit</b> <span id="j-check-amt"></span><br>At the seller's, the driver sends you photos before loading it. You say yes and it's collected, or no and it's left there. If you say no, the driver is still paid for their trip and we refund the rest.</span></label></div>` : ""}
        ${postingAs()}
        ${me.profile?.id_status === "pending" ? `<div class="note" style="grid-column:1/-1">Your ID is being checked. You can post now; your job goes live once your ID is verified and it's paid.</div>` : ""}
      </div>
      <details class="more"><summary>More options</summary><div class="fields">
        <div class="field"><label for="j-from-d">Earliest pickup</label><input id="j-from-d" type="date" min="${todayISO()}" value="${todayISO()}"></div>
        <div class="field"><label for="j-dl">Arrival on the last day</label><select id="j-dl"><option value="">Any time</option><option value="by">By a set time (+25%)</option></select></div>
        <div class="field"><label for="j-dlt">Arrive by</label><input id="j-dlt" type="time" value="13:00"></div>
        <div class="field full"><label for="j-desc">Anything the driver should know?</label><textarea id="j-desc" placeholder="e.g. Seller will help load. Keep upright."></textarea></div>
      </div></details>
      <div id="j-price"></div>
      <label class="check"><input type="checkbox" id="c-ok" required> <span>It's worth less than $500 and isn't dangerous goods, cash, drugs, weapons or a live animal. Someone at each end will help the driver load and unload anything heavy. I understand items aren't insured during the trial and are carried at owner's risk, and that if the driver arrives when I said and it isn't available, a no-show fee covering their trip is kept from my payment. <a href="terms.html" target="_blank">Full terms</a></span></label>
      <div id="j-err"></div>
      <button class="btn go" type="submit">Post and pay</button>
    </form></div>
    <div id="j-done"></div>
  </div></section>`;
}
function jobValues() {
  const pm = v("j-pm") || "home";
  const urgent = v("j-when") === "urgent";
  const jobDate = urgent ? todayISO() : (v("j-from-d") || todayISO()), windowEnd = urgent ? todayISO() : v("j-by");
  return {
    kind: sendMode, item: v("j-item"), item_type: v("j-type") || null, heavy: !!$("#j-heavy")?.checked,
    urgent, urgent_bonus: urgent ? +v("j-bonus") : 0, check_first: sendMode === "pickup" && !!$("#j-check")?.checked, listing_url: v("j-link") || null, from_town: v("j-from"), to_town: v("j-to"),
    store_name: v("j-store") || null, order_ref: v("j-on") || null, order_name: v("j-onm") || null,
    pickup_address: v("j-pa") || null, drop_address: v("j-da") || null, seller_name: v("j-sn") || null, seller_phone: v("j-sp") || null,
    size: v("j-size"), job_date: jobDate, window_end: windowEnd,
    deadline_time: v("j-dl") === "by" ? (v("j-dlt") || null) : null,
    pickup_mode: pm, handover: pm === "meet" ? "route" : "door",
    pickup_hours: pm === "left_out" ? "any time" : (v("j-ph") || null), pickup_notes: v("j-pn") || null,
    description: v("j-desc") || null, cover: 500, sender_name: me.profile?.name || "", sender_phone: me.profile?.phone || "",
  };
}
function jobPrice(j) {
  const express = isExpress(j.job_date, j.window_end);
  return estimate({ from: j.from_town, to: j.to_town, size: j.size, handover: j.handover, deadline: j.deadline_time || (express ? "express" : null), cover: 500, check: j.check_first, bonus: j.urgent_bonus });
}
function updPickupMode() {
  const pm = v("j-pm"); if (!pm) return;
  const hoursF = $("#pm-hours-f"), notesF = $("#pm-notes-f");
  hoursF.hidden = pm === "left_out"; notesF.hidden = !(pm === "left_out" || pm === "meet");
  $("#pm-hours-l").textContent = { home: "When is someone there?", business: "Opening hours", meet: "When can you meet?" }[pm] || "";
  $("#pm-notes-l").textContent = pm === "meet" ? "Where on the route? (e.g. Rakaia BP)" : "Where is it left?";
}
function updUrgent() {
  const u = v("j-when") === "urgent", box = $("#j-urg"), by = $("#j-by"), fd = $("#j-from-d"); if (!box) return;
  box.hidden = !u; by.disabled = u; if (fd) fd.disabled = u;
  $("#j-by-hint").textContent = u ? "Urgent jobs are delivered today, so the deliver-by day is today." : "The more days you allow, the more drivers can take it. Today only is express (+25%).";
}
function updHeavy() { const h = $("#j-heavy"), f = $("#j-help-f"); if (h && f) f.hidden = !h.checked; }
function updPrice() {
  const box = $("#j-price"); if (!box) return;
  const j = jobValues(), e = jobPrice(j);
  if (!e) { box.innerHTML = `<p class="fine">Pick two different towns to see a price.</p>`; return; }
  const express = isExpress(j.job_date, j.window_end);
  const amt = $("#j-check-amt"); if (amt) { const off = jobPrice({ ...j, check_first: false }), on = jobPrice({ ...j, check_first: true }); amt.textContent = off && on ? `(+$${on.total - off.total})` : ""; }
  const P = e.parts, r = x => "$" + Math.round(x);
  box.innerHTML = `<div class="allin"><span>Price, all in</span><b class="num">$${e.total}</b></div>
    <p class="fine" style="margin-top:6px">${e.onRoute} km${j.handover === "route" ? ", meeting on the route" : ", door to door"}. You pay when you post, and we hold it until it's delivered. Full refund if no driver takes it by ${fmtDate(j.window_end)}.</p>
    <details class="why"><summary>How this price is worked out</summary><div class="rates" style="margin-top:6px">
      <div><span class="num">${r(P.route)}</span><span>${e.onRoute} km along the driver's route</span></div>
      ${P.detour ? `<div><span class="num">${r(P.detour)}</span><span>the detour to both doors, and the driver's time</span></div>` : ""}
      ${P.handling ? `<div><span class="num">${r(P.handling)}</span><span>loading, strapping down and unloading a bulky item</span></div>` : ""}
      ${P.check ? `<div><span class="num">${r(P.check)}</span><span>checking it for you before collecting</span></div>` : ""}
      ${P.prem ? `<div><span class="num">${r(P.prem)}</span><span>${express ? "same-day express" : "set arrival time"}</span></div>` : ""}
      ${P.bonus ? `<div><span class="num">${r(P.bonus)}</span><span>urgency bonus, all of it to the driver</span></div>` : ""}
      <div><span class="num">${r(P.fee)}</span><span>Going That Way's 15%. Everything else goes to the driver.</span></div></div></details>
    ${e.prem ? `<div class="note" style="margin-top:6px">Includes a $${e.prem} ${express ? "same-day express" : "set-time"} premium, paid to the driver. Delays like road closures, crashes or weather can still happen. If it arrives late, you only pay the normal rate ($${e.normal}).</div>` : ""}
    <div class="note" style="margin-top:6px"><b>Trial service: items aren't insured yet.</b> Please don't send anything worth more than $500.</div>`;
}

// =====================================================================
// DRIVE
// =====================================================================
function drive() {
  const g = !db ? "" : !me.user ? gate("Create a free account to drive", "Sign up, then apply to drive with your licence and vehicle details. We check them once.", "Sign up or sign in", "account")
    : !driverOk() ? gate("Apply to drive", "Add your driver licence, a selfie and your vehicle's number plate. We check your licence, WoF and rego once, then you can take jobs.", "Apply to drive", "account") : "";
  const dhead = `<h2>Heading somewhere between Christchurch and Dunedin today?</h2>
    <p class="sub">Post your trip and see paid jobs on your route straight away. Take the ones that suit you.</p>`;
  const dsteps = `<ol class="steps only-desk"><li><b>Post your trip,</b> often the morning you're going.</li><li><b>See paid jobs on your route</b> and exactly what each pays you.</li><li><b>Take the ones that suit you,</b> text to confirm, collect and deliver with a photo at each end.</li><li><b>Get paid weekly</b> by bank transfer.</li></ol>`;
  if (g) return `<section class="split"><div class="col-a">${dhead}${dsteps}</div><div class="col-b">${g}</div></section>`;
  return `<section class="split"><div class="col-a">
    ${dhead}
    ${dsteps}
    </div><div class="col-b">
    ${notConnected()}
    <div id="t-again"></div>
    <div class="card"><form id="tripForm" novalidate>
      <div class="fields">
        <div class="field"><label for="t-from">From</label><select id="t-from">${townOptions(memo.get().tfrom || "Christchurch")}</select></div>
        <div class="field"><label for="t-to">To</label><select id="t-to">${townOptions(memo.get().tto || "Timaru")}</select></div>
        <div class="field full"><label for="t-fa">Leaving from</label><input id="t-fa" required placeholder="Street, suburb, or e.g. Christchurch CBD" value="${esc(memo.get().tfa || "")}"></div>
        <div class="field full"><label for="t-ta">Arriving at</label><input id="t-ta" required placeholder="Street, suburb, or e.g. Timaru CBD" value="${esc(memo.get().tta || "")}"></div>
        <div class="field"><label for="t-date">Day</label><input id="t-date" type="date" min="${todayISO()}" value="${todayISO()}" required></div>
        <div class="field"><label for="t-time">Leaving about</label><input id="t-time" type="time" value="08:00"></div>
        <div class="field"><label for="t-space">Space</label><select id="t-space">${Object.entries(SPACE_LABEL).map(([k, lab]) => `<option value="${k}"${k === (memo.get().tspace || me.profile?.vehicle_space || "ute") ? " selected" : ""}>${lab}</option>`).join("")}</select></div>
        <div class="field"><label for="t-det">Max detour</label><select id="t-det">${[5, 10, 20, 30].map(k => `<option value="${k}"${k === (+memo.get().tdet || 20) ? " selected" : ""}>${k} km</option>`).join("")}</select></div>
        ${postingAs()}
        ${me.profile?.driver_status === "pending" ? `<div class="note" style="grid-column:1/-1">We're checking your licence and vehicle. You can post trips now; they go live once you're approved.</div>` : ""}
      </div>
      <details class="more"><summary>More options</summary><div class="fields">
        <div class="field full"><label for="t-veh">Your vehicle</label><input id="t-veh" placeholder="e.g. Toyota Hilux double cab" value="${esc(memo.get().tveh || me.profile?.vehicle_make || "")}"></div>
        <div class="field full"><label for="t-note">Space available</label><input id="t-note" placeholder="e.g. Open tray 1.5 × 1.5 m, straps"></div>
        <div class="field full"><label class="check"><input type="checkbox" id="t-reg"> <span>I do this run most weeks</span></label></div>
      </div></details>
      <div id="t-err"></div>
      <button class="btn go" type="submit">Post my trip and see jobs</button>
    </form></div>
    <div id="t-done"></div>
  </div></section>`;
}

// "Going today?" One tap reposts the driver's last trip for today
const nextQuarter = () => { const d = new Date(Date.now() + 15 * 60000); d.setMinutes(Math.ceil(d.getMinutes() / 15) * 15, 0, 0); return d.toTimeString().slice(0, 5); };
let againTrip = null;
async function loadAgain() {
  const box = $("#t-again"); if (!box || !db || !me.user) return;
  const { data } = await db.from("trips").select("*").eq("user_id", me.user.id).order("created_at", { ascending: false }).limit(1);
  const t = data?.[0]; againTrip = t || null; if (!t || !$("#t-again")) return;
  const already = t.trip_date === todayISO() && ["new", "open"].includes(t.status);
  box.innerHTML = already ? `<div class="card again"><div class="row"><h3>You're going today</h3><span class="chip g">Posted</span></div>${plate(t.from_town, t.to_town)}<button class="btn" type="button" data-showtrip="${t.id}">See jobs on my route</button></div>`
    : `<div class="card again"><h3>Going again today?</h3>${plate(t.from_town, t.to_town)}
      <p class="fine">${esc(t.from_suburb || t.from_town)} to ${esc(t.to_suburb || t.to_town)} · ${esc(SPACE_LABEL[t.space] || "")} · up to ${t.max_detour_km} km detour</p>
      <div style="display:flex;gap:6px;flex-wrap:wrap"><button class="btn go" type="button" data-again="now">Post it for today, leaving now</button><button class="btn" type="button" data-again="edit">Change details</button></div><div id="again-err"></div></div>`;
}
async function postAgain(mode) {
  const t = againTrip; if (!t) return;
  if (mode === "edit") {
    $("#t-from").value = t.from_town; $("#t-to").value = t.to_town; $("#t-fa").value = t.from_suburb || ""; $("#t-ta").value = t.to_suburb || "";
    $("#t-space").value = t.space; $("#t-det").value = String(t.max_detour_km); $("#t-time").value = nextQuarter(); if (t.vehicle) $("#t-veh").value = t.vehicle;
    $("#t-again").innerHTML = ""; $("#tripForm").scrollIntoView({ behavior: "smooth" }); return;
  }
  const row = { from_town: t.from_town, to_town: t.to_town, from_suburb: t.from_suburb, to_suburb: t.to_suburb, trip_date: todayISO(), depart_time: nextQuarter(),
    space: t.space, max_detour_km: t.max_detour_km, vehicle: t.vehicle, space_note: t.space_note, regular: t.regular, driver_name: me.profile?.name || t.driver_name, driver_phone: me.profile?.phone || t.driver_phone };
  const btn = document.querySelector('[data-again="now"]');
  const saved = await save("trips", row, "#again-err", btn);
  if (saved) { $("#t-again").innerHTML = ""; $("#tripForm").closest(".card").hidden = true; await refreshTripPanel(saved.id); }
}

// Jobs on a trip's route: taken jobs (full details) and available ones (take it)
async function tripJobsPanel(t, verified) {
  const [taken, board] = await Promise.all([
    db.from("jobs").select("*").eq("matched_trip", t.id),
    db.from("board_jobs").select("*").eq("status", "open"),
  ]);
  const mine = (taken.data || []).filter(j => ["matched", "collected", "delivered", "declined"].includes(j.status));
  const avail = (board.data || []).filter(j => jobFitsTrip(j, t)).sort((a, b) => (b.urgent ? 1 : 0) - (a.urgent ? 1 : 0));
  const takenHtml = mine.map(j => takenJobCard(j, t)).join("");
  const availHtml = avail.map(j => `<div class="card${j.urgent ? " urgent" : ""}">
      ${j.urgent ? `<div class="urgentbar">Urgent: needed today · +$${(j.urgent_bonus || 0) + (j.admin_bonus || 0)} bonus included</div>` : ""}
      <div class="row"><div>${j.kind === "pickup" ? `<span class="tag">Pick-up-only buy</span> ` : j.kind === "collect" ? `<span class="tag">Click and collect${j.store_name ? ": " + esc(j.store_name) : ""}</span> ` : ""}<span class="item">${esc(j.item)}</span></div><span class="chip g num">You get $${driverPay(j)}</span></div>
      <div class="meta"><span>${esc(j.from_town)} → ${esc(j.to_town)}</span>${j.item_type ? `<span class="chip">${esc(itemTypeShort(j.item_type))}</span>` : ""}<span class="chip">${esc(SIZE_SHORT[j.size] || j.size)}</span>${j.heavy ? `<span class="chip y">2-person lift</span>` : ""}${j.check_first ? `<span class="chip y">Check first: photos for the buyer</span>` : ""}<span class="chip">${esc(PICKUP_LABEL[j.pickup_mode] || "")}${j.pickup_hours ? ": " + esc(j.pickup_hours) : ""}</span><span>by ${fmtDate(j.window_end)}${j.deadline_time ? ", " + fmtTime(j.deadline_time) : ""}</span></div>
      ${t.status === "open" && verified ? `<button class="btn go" data-claim="${j.id}:${t.id}">Take it</button>` : ""}
    </div>`).join("");
  return `${takenHtml ? `<div class="label">Jobs you've taken</div>${takenHtml}` : ""}
    <div class="label">Paid jobs on your route${t.trip_date === todayISO() ? " today" : " on " + fmtDate(t.trip_date)}</div>
    ${!verified || t.status !== "open" ? `<div class="note">We'll check your licence and vehicle once (we'll text you). Then you can take jobs, and future trips go live instantly.</div>` : ""}
    ${availHtml || `<div class="empty">No paid jobs on your route ${t.trip_date === todayISO() ? "today" : "that day"} yet. New ones can appear any time; check back before you leave.</div>`}`;
}
function takenJobCard(j, t) {
  const who = j.kind === "pickup" && j.seller_phone ? { name: j.seller_name || "the seller", phone: j.seller_phone } : { name: j.sender_name, phone: j.sender_phone };
  const confirmMsg = j.kind === "collect"
    ? `Hi ${who.name}, it's ${t.driver_name} from Going That Way. I'm collecting your ${j.item} from ${j.store_name} ${t.trip_date === todayISO() ? "today" : "on " + fmtDate(t.trip_date)}, around ${fmtTime(t.depart_time) || "(time)"}. If the store needs you to name who's collecting, please add ${t.driver_name}. Is it ready to collect? Thanks!`
    : `Hi ${who.name}, it's ${t.driver_name} from Going That Way. I'm collecting the ${j.item} ${t.trip_date === todayISO() ? "today" : "on " + fmtDate(t.trip_date)}, around ${fmtTime(t.depart_time) || "(time)"}.${j.check_first ? " I'll take a few photos of it for the buyer before loading." : ""}${j.heavy ? " It's a two-person lift, so could you give me a hand loading it?" : ""} Can you confirm it'll be ready? Thanks!`;
  const buyer = (j.sender_name || "the buyer").split(" ")[0];
  const askMsg = `Hi ${buyer}, it's ${t.driver_name} from Going That Way. I'm at the seller's with your ${j.item}. I've sent you photos: open Going That Way, then My account, and tap yes or no. I'll wait a few minutes.`;
  const camera = (kind, label, cls = "btn go") => `<label class="${cls} camera">${label}<input type="file" accept="image/*" capture="environment" data-photo="${j.id}:${kind}"></label>`;
  const noShow = camera("no_show", "Nobody there? Photo the door", "btn small");
  let step;
  if (j.status === "matched" && j.check_first && j.check_status !== "approved") {
    step = j.check_status === "waiting"
      ? `<div class="note" data-poll><b>Waiting for ${esc(buyer)} to say yes or no.</b> Don't load it yet.${j.check_note ? ` Your note: "${esc(j.check_note)}"` : ""}</div>
        <div style="display:flex;gap:6px;flex-wrap:wrap"><a class="btn small go" href="${smsLink(j.sender_phone, askMsg)}">Text ${esc(buyer)} to look</a><button class="btn small" type="button" data-recheck="${t.id}">Check for an answer</button>${camera("check", "Add another photo", "btn small")}</div>`
      : `<div class="checkstep"><b>1. Check it for the buyer before loading.</b> Take a few photos (the whole item, any marks or damage, and that it works if you can), then send them.
        <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:6px">${camera("check", "Take a check photo")}</div>
        <div class="field" style="margin-top:6px"><label for="cn-${j.id}">Anything the buyer should know?</label><input id="cn-${j.id}" placeholder="e.g. Small scratch on the left arm, otherwise as listed"></div>
        <button class="btn go" type="button" data-checksend="${j.id}" style="margin-top:6px">Send photos to ${esc(buyer)}</button></div>
        <div style="display:flex;gap:6px;flex-wrap:wrap">${j.check_status ? "" : `<button class="btn small" data-release="${j.id}">Give it back</button>`}${noShow}</div>`;
  } else if (j.status === "matched") {
    step = `${j.check_first ? `<div class="note"><b>${esc(buyer)} said yes.</b> Load it up.</div>` : ""}<div style="display:flex;gap:6px;flex-wrap:wrap">${camera("pickup", "Collected: take pickup photo")}${j.check_first ? "" : `<button class="btn small" data-release="${j.id}">Give it back</button>`}${noShow}</div>`;
  } else if (j.status === "collected") step = camera("dropoff", "Delivered: take drop-off photo");
  else if (j.status === "declined") step = `<div class="note"><b>${esc(buyer)} said no, so leave it with the seller.</b> Let the seller know politely. You're still paid for this trip in the weekly payout.</div>`;
  else step = `<span class="chip g">Delivered. Thanks! Paid in the weekly payout.</span>`;
  return `<div class="card" style="border:2px solid var(--mark)">
    <div class="row"><span class="item">${esc(j.item)}</span><span class="chip g num">You get $${driverPay(j)}</span></div>
    ${j.item_type || j.check_first || j.heavy ? `<div class="meta">${j.item_type ? `<span class="chip">${esc(itemTypeShort(j.item_type))}</span>` : ""}<span class="chip">${esc(SIZE_SHORT[j.size] || "")}</span>${j.heavy ? `<span class="chip y">2-person lift</span>` : ""}${j.check_first ? `<span class="chip y">Check first</span>` : ""}</div>` : ""}
    <dl style="display:grid;grid-template-columns:92px 1fr;gap:3px 10px;font-size:13.5px;margin:0">
      <dt style="color:var(--ink3)">Collect</dt><dd style="margin:0">${j.kind === "collect" ? `<b>${esc(j.store_name || "")}</b>, ` : ""}${esc(j.pickup_address)}, ${esc(j.from_town)}</dd>
      ${j.kind === "collect" ? `<dt style="color:var(--ink3)">Order</dt><dd style="margin:0"><b class="num">${esc(j.order_ref || "")}</b> under <b>${esc(j.order_name || "")}</b>. Give these at the click and collect counter.</dd>` : ""}
      <dt style="color:var(--ink3)">How</dt><dd style="margin:0">${esc(PICKUP_LABEL[j.pickup_mode] || "")}${j.pickup_hours ? " · " + esc(j.pickup_hours) : ""}${j.pickup_notes ? " · " + esc(j.pickup_notes) : ""}</dd>
      <dt style="color:var(--ink3)">Deliver</dt><dd style="margin:0">${esc(j.drop_address)}, ${esc(j.to_town)} · by ${fmtDate(j.window_end)}${j.deadline_time ? ", " + fmtTime(j.deadline_time) : ""}</dd>
      <dt style="color:var(--ink3)">Contact</dt><dd style="margin:0">${esc(who.name)} · <a href="${telLink(who.phone)}">${esc(who.phone)}</a>${j.kind === "pickup" ? ` · buyer ${esc(j.sender_name)} <a href="${telLink(j.sender_phone)}">${esc(j.sender_phone)}</a>` : ""}</dd>
      ${j.description ? `<dt style="color:var(--ink3)">Notes</dt><dd style="margin:0">${esc(j.description)}</dd>` : ""}
      <dt style="color:var(--ink3)">Job ref</dt><dd class="num" style="margin:0">${jobRef(j)}</dd>
    </dl>
    <div style="display:flex;gap:6px;flex-wrap:wrap">
      ${j.status === "matched" && !j.check_status ? `<a class="btn small go" href="${smsLink(who.phone, confirmMsg)}">Text ${esc(who.name.split(" ")[0])} to confirm pickup</a>` : ""}
      <a class="btn small" href="${mapWithJob(j, t)}" target="_blank" rel="noopener">Route with this job</a>
    </div>
    <p class="fine">Don't set off for the pickup until they've confirmed, unless it's left out. The photos confirm collection and delivery, and protect you if anything's questioned.</p>
    <div data-photos="${j.id}"></div>
    ${step}
    ${reportForm(j.id, "driver")}
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
      <div class="field full"><label for="b-notes">What do you usually send, and where?</label><textarea id="b-notes" placeholder="e.g. Parts from our Ashburton store to customers in Timaru and Oamaru, most days"></textarea></div>
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
    <div class="board-cols"><div><div class="label">Paid jobs</div><div id="bj" class="empty">Loading…</div></div>
    <div><div class="label">Drivers heading out</div><div id="bt" class="empty">Loading…</div></div></div></section>`;
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
  bj.innerHTML = j.data.length ? j.data.map(r => `<div class="card" style="margin-bottom:8px"><div class="row"><div>${r.kind === "pickup" ? `<span class="tag">Pick-up-only buy</span> ` : r.kind === "collect" ? `<span class="tag">Click and collect</span> ` : ""}<span class="item">${esc(r.item)}</span></div><span class="chip g num">$${Math.round(r.price_estimate || 0)}</span></div>${plate(r.from_town, r.to_town)}<div class="meta"><span>by ${fmtDate(r.window_end)}</span>${r.item_type ? `<span class="chip">${esc(itemTypeShort(r.item_type))}</span>` : ""}<span class="chip">${esc(SIZE_SHORT[r.size] || r.size)}</span>${r.heavy ? `<span class="chip y">2-person lift</span>` : ""}<span class="chip">${esc(PICKUP_LABEL[r.pickup_mode] || "")}</span>${r.urgent ? `<span class="chip warn">Urgent today</span>` : ""}${r.status !== "open" ? `<span class="chip y">Driver found</span>` : ""}</div></div>`).join("")
    : `<div class="empty">No paid jobs right now. Be the first: post a job.</div>`;
  bt.innerHTML = t.data.length ? t.data.map(r => `<div class="card" style="margin-bottom:8px">${plate(r.from_town, r.to_town)}<div class="meta"><span>${fmtDate(r.trip_date)}${r.depart_time ? ", leaving " + fmtTime(r.depart_time) : ""}</span><span class="chip">${esc(SPACE_LABEL[r.space] || r.space)}</span></div></div>`).join("")
    : `<div class="empty">No trips posted yet. Driving this week? Post your trip.</div>`;
}

// =====================================================================
// MY POSTS
// =====================================================================
function mine() { return account(); }
const ID_LABEL = { driver_licence: "NZ driver licence", passport: "Passport", kiwi_access: "Kiwi Access card", other: "Other government photo ID" };
const fileField = (id, label, hint, capture) => `<div class="field full"><label for="${id}">${label}</label><input id="${id}" type="file" accept="image/*"${capture ? ` capture="${capture}"` : ""} required>${hint ? `<span class="hint">${hint}</span>` : ""}</div>`;
function account() {
  if (!db) return `<section><h2>My account</h2>${notConnected()}</section>`;
  if (recovery) return `<section><h2>Choose a new password</h2>
    <div class="card"><form id="npForm" novalidate><div class="fields">
      <div class="field full"><label for="np-pass">New password</label><input id="np-pass" type="password" autocomplete="new-password" minlength="8" required><span class="hint">At least 8 characters</span></div>
    </div><div id="np-err"></div><button class="btn go" type="submit">Save new password</button></form></div></section>`;
  if (!me.user) return `<section>
    <h2>Sign in or create an account</h2>
    <div class="card"><h3>Sign in</h3><form id="siForm" novalidate><div class="fields">
      <div class="field full"><label for="si-email">Email</label><input id="si-email" type="email" autocomplete="username" required></div>
      <div class="field full"><label for="si-pass">Password</label><input id="si-pass" type="password" autocomplete="current-password" required></div>
    </div>${tsBox("si")}<div id="si-err"></div><button class="btn go" type="submit">Sign in</button>
    <button class="linkbtn" type="button" id="forgotBtn" style="align-self:flex-start;font-size:13.5px">Forgotten your password?</button>
    <div id="forgotBox" hidden><div class="field"><label for="fp-email">Your email</label><input id="fp-email" type="email" autocomplete="email"></div>
      ${tsBox("fp")}<button class="btn" type="button" id="forgotSend" style="margin-top:8px">Email me a reset link</button><div id="fp-msg"></div></div></form></div>
    <div class="card"><h3>New here? Create a free account</h3><form id="suForm" novalidate><div class="fields">
      <div class="field full"><label for="su-name">Full name</label><input id="su-name" autocomplete="name" required></div>
      <div class="field full"><label for="su-email">Email</label><input id="su-email" type="email" autocomplete="email" required></div>
      <div class="field full"><label for="su-pass">Password</label><input id="su-pass" type="password" autocomplete="new-password" minlength="8" required><span class="hint">At least 8 characters</span></div>
      <div class="field"><label for="su-phone">Mobile</label><input id="su-phone" type="tel" inputmode="tel" autocomplete="tel" required placeholder="021 123 4567"></div>
      <div class="field"><label for="su-addr">Home address</label><input id="su-addr" autocomplete="street-address" required></div>
    </div>
    <label class="check"><input type="checkbox" id="su-ok" required> <span>I'm 18 or over and I agree to the <a href="terms.html" target="_blank">terms</a> and <a href="privacy.html" target="_blank">privacy policy</a>. I understand Going That Way checks everyone's ID once: my ID photo and selfie are only seen by the Going That Way admin, used only to confirm who I am, and deleted once checked.</span></label>
    ${tsBox("su")}<div id="su-err"></div><button class="btn go" type="submit">Create account</button></form></div>
  </section>`;
  const P = me.profile || {}, idDone = ["pending", "verified"].includes(P.id_status), needLicence = !(P.id_type === "driver_licence" && idDone);
  setTimeout(loadMine, 0);
  return `<section>
    <div class="row"><h2>My account</h2><button class="btn small" id="signOut" type="button">Sign out</button></div>
    <div id="checkAlert"></div>

    <div class="card"><div class="row"><h3>1. Your ID check</h3>${chip(P.id_status)}</div>
      ${P.id_status === "verified" ? `<p class="sub">Verified. Your photos have been deleted. You can send anything on the site.</p>`
      : P.id_status === "pending" ? `<p class="sub">Thanks, we're checking your ${esc(ID_LABEL[P.id_type] || "ID")}. You can post jobs now; they go live once you're verified.</p>`
      : `${P.id_status === "rejected" ? `<div class="err">We couldn't verify that one${P.review_note ? `: ${esc(P.review_note)}` : ""}. Please try again.</div>` : ""}
        <p class="sub">Everyone is ID-checked once. Only the Going That Way admin sees your photos, and they're deleted once checked.</p>
        <form id="idForm" novalidate><div class="fields">
          <div class="field full"><label for="id-type">Type of ID</label><select id="id-type">${Object.entries(ID_LABEL).map(([k, l]) => `<option value="${k}">${l}</option>`).join("")}</select><span class="hint">To drive, it must be your driver licence.</span></div>
          ${fileField("id-photo", "Photo of your ID", "The side with your photo. Make sure it's sharp and nothing's covered.", "environment")}
          ${fileField("id-selfie", "A selfie", "Just your face, clearly lit, so we can match it to the ID.", "user")}
        </div><div id="id-err"></div><button class="btn go" type="submit">Send for checking</button></form>`}
    </div>

    <div class="card"><div class="row"><h3>2. Driving</h3>${chip(P.driver_status)}</div>
      ${P.driver_status === "verified" ? `<p class="sub">Approved to drive: ${esc(P.vehicle_make || "")} ${esc(P.vehicle_plate || "")} (${esc(SPACE_LABEL[P.vehicle_space] || "")}). WoF to ${fmtDate(P.wof_expiry)}, rego to ${fmtDate(P.rego_expiry)}.</p><button class="btn go" type="button" data-tab-link="drive">Post a trip</button>`
      : P.driver_status === "pending" ? `<p class="sub">Thanks, we're checking your licence and your vehicle's WoF and rego. You can post trips now; they go live once you're approved.</p>`
      : `${P.driver_status === "rejected" ? `<div class="err">We couldn't approve that${P.review_note ? `: ${esc(P.review_note)}` : ""}. Please try again.</div>` : ""}
        <p class="sub">Earn from trips you're already making. We need your licence and vehicle details once.</p>
        <form id="drForm" novalidate><div class="fields">
          <div class="field"><label for="dr-class">Licence</label><select id="dr-class"><option value="full">Full</option><option value="restricted">Restricted</option></select></div>
          <div class="field"><label for="dr-space">Space you usually have</label><select id="dr-space">${Object.entries(SPACE_LABEL).map(([k, l]) => `<option value="${k}"${k === "ute" ? " selected" : ""}>${l}</option>`).join("")}</select></div>
          <div class="field"><label for="dr-plate">Number plate</label><input id="dr-plate" required autocapitalize="characters" placeholder="ABC123"></div>
          <div class="field"><label for="dr-make">Make and model</label><input id="dr-make" required placeholder="e.g. Toyota Hilux"></div>
          ${needLicence ? fileField("dr-lic", "Photo of your driver licence", "The side with your photo.", "environment") + fileField("dr-selfie", "A selfie", "So we can match it to your licence.", "user") : `<p class="fine" style="grid-column:1/-1">We'll use the licence you sent for your ID check.</p>`}
        </div><p class="fine">Learner licences can't drive for Going That Way. We check your vehicle's WoF and rego from the plate.</p><div id="dr-err"></div><button class="btn go" type="submit">Apply to drive</button></form>`}
    </div>

    ${["verified", "pending"].includes(P.driver_status) ? `<div class="card"><div class="row"><h3>Your earnings</h3><span class="chip">Paid weekly</span></div>
      <div id="earn" class="fine">Loading…</div>
      <form id="bkForm" novalidate><div class="fields">
        <div class="field"><label for="bk-acc">Bank account for payouts</label><input id="bk-acc" inputmode="numeric" autocomplete="off" placeholder="12-3456-7890123-00" value="${esc(P.bank_account || "")}"></div>
        <div class="field"><label for="bk-name">Account name</label><input id="bk-name" autocomplete="off" value="${esc(P.bank_account_name || P.name || "")}"></div>
      </div><p class="fine">Only you and the Going That Way admin can see this. We pay what you've earned each week by bank transfer.</p><div id="bk-err"></div><button class="btn" type="submit">Save bank details</button></form></div>` : ""}
    <div class="card"><h3>3. Your details</h3><form id="pfForm" novalidate><div class="fields">
      <div class="field full"><label for="pf-name">Full name</label><input id="pf-name" value="${esc(P.name || "")}" required></div>
      <div class="field full"><label>Email</label><input value="${esc(me.user.email || "")}" disabled></div>
      <div class="field"><label for="pf-phone">Mobile</label><input id="pf-phone" type="tel" value="${esc(P.phone || "")}" required></div>
      <div class="field"><label for="pf-addr">Home address</label><input id="pf-addr" value="${esc(P.address || "")}" required></div>
    </div><div id="pf-err"></div><button class="btn" type="submit">Save details</button></form></div>

    <h2 style="margin-top:8px">My posts</h2><div id="mine" class="empty">Loading…</div>
  </section>`;
}
async function uploadIdDoc(kind, file) {
  const blob = await shrinkImage(file, 1800, 0.8);
  const path = `${me.user.id}/${kind}-${Date.now()}.jpg`;
  const { error } = await db.storage.from("id-docs").upload(path, blob, { contentType: "image/jpeg", upsert: false });
  if (error) throw error;
}
const JOB_STATUS = { new: ["Waiting for payment", "y"], open: ["Paid · waiting for a driver", "g"], matched: ["Driver on the way", "g"], collected: ["Collected · on its way", "g"], delivered: ["Delivered", "g"], cancelled: ["Cancelled", ""], no_show: ["No-show", ""], declined: ["Not collected: you said no", ""] };
// Progress bar: posted → paid → driver found → (checked) → collected → delivered
function progress(j) {
  if (!["new", "open", "matched", "collected", "delivered"].includes(j.status)) return "";
  const steps = [["Paid", j.status !== "new"], ["Driver found", ["matched", "collected", "delivered"].includes(j.status)]];
  if (j.check_first) steps.push(["Checked", j.check_status === "approved" || ["collected", "delivered"].includes(j.status)]);
  steps.push(["Collected", ["collected", "delivered"].includes(j.status)], ["Delivered", j.status === "delivered"]);
  const next = steps.findIndex(([, d]) => !d);
  return `<ol class="progress" aria-label="Progress">${steps.map(([l, d], i) => `<li class="${d ? "done" : i === next ? "now" : ""}">${l}</li>`).join("")}</ol>`;
}
// The buyer's yes/no on the driver's check photos
function checkPanel(r) {
  if (!r.check_first || r.status !== "matched") return "";
  if (r.check_status === "waiting") return `<div class="card checkask"><h3>Your driver is at the seller's. Is it what you expected?</h3>
    ${r.check_note ? `<p class="sub">Driver's note: "${esc(r.check_note)}"</p>` : ""}
    <p class="fine">Tap a photo to see it bigger. Say yes and they'll load it up. Say no and it stays with the seller; the driver is still paid for the trip and we refund the rest.</p>
    <div style="display:flex;gap:6px;flex-wrap:wrap"><button class="btn go" type="button" data-checkans="${r.id}:yes">Yes, collect it</button><button class="btn" type="button" data-checkans="${r.id}:no">No, leave it</button></div></div>`;
  if (r.check_status === "approved") return `<p class="fine">You said yes to the check photos.</p>`;
  return `<p class="fine">Your driver will send you photos from the seller's before loading it. Keep your phone handy on the day.</p>`;
}
const TRIP_STATUS = { new: ["Waiting for licence check", "y"], open: ["Live", "g"], full: ["Full", ""], done: ["Done", "g"], cancelled: ["Cancelled", ""] };
// A driver's money: owed (done, not yet paid) and paid, from the jobs they've taken
async function loadEarnings(tripIds) {
  const box = $("#earn"); if (!box) return;
  if (!tripIds.length) { box.textContent = "Take a job on one of your trips and your earnings show here."; return; }
  const { data } = await db.from("jobs").select("*").in("matched_trip", tripIds);
  const done = (data || []).filter(j => ["delivered", "no_show", "declined"].includes(j.status));
  const owed = done.filter(j => !j.driver_paid), paid = done.filter(j => j.driver_paid);
  const sum = a => a.reduce((n, j) => n + driverPay(j), 0);
  const going = (data || []).filter(j => ["matched", "collected"].includes(j.status));
  box.className = "";
  box.innerHTML = `<div class="earn">
      <div><span class="label">To be paid</span><b class="num">$${sum(owed)}</b><span class="fine">${owed.length} job${owed.length === 1 ? "" : "s"}, in the next weekly payout</span></div>
      <div><span class="label">Paid so far</span><b class="num">$${sum(paid)}</b><span class="fine">${paid.length} job${paid.length === 1 ? "" : "s"}</span></div>
      ${going.length ? `<div><span class="label">On the go</span><b class="num">$${sum(going)}</b><span class="fine">once delivered</span></div>` : ""}
    </div>
    ${done.length ? `<details class="more"><summary>Job by job</summary><ul class="plainlist" style="margin-top:6px">${[...done].sort((a, b) => String(b.delivered_at || b.created_at).localeCompare(String(a.delivered_at || a.created_at))).map(j => `<li><span class="num">$${driverPay(j)}</span> · ${esc(j.item)} (${jobRef(j)}) · ${j.driver_paid ? `paid ${j.driver_paid_at ? new Date(j.driver_paid_at).toLocaleDateString("en-NZ") : ""}` : "to be paid"}</li>`).join("")}</ul></details>` : ""}
    ${!me.profile?.bank_account && done.length ? `<div class="note">Add your bank account below so we can pay you.</div>` : ""}`;
}
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
  loadEarnings((t.data || []).map(x => x.id));
  const parts = [];
  for (const r of (t.data || [])) {
    const [s, c] = TRIP_STATUS[r.status] || [r.status, ""];
    const live = ["new", "open"].includes(r.status) && r.trip_date >= todayISO();
    parts.push(`<div class="card" style="margin-bottom:8px"><div class="row"><span class="item">Your trip</span><span class="chip ${c}">${s}</span></div>${plate(r.from_town, r.to_town)}
      <div class="meta"><span>${fmtDate(r.trip_date)}${r.depart_time ? ", leaving " + fmtTime(r.depart_time) : ""}</span>${live ? `<button class="btn small" data-cancel="trips:${r.id}" style="margin-left:auto">Cancel trip</button>` : ""}</div>
      ${live ? `<div data-trippanel="${r.id}" class="empty">Loading jobs on your route…</div>` : ""}</div>`);
  }
  const ids = (j.data || []).map(r => r.id), reps = {};
  if (ids.length) { const { data: rr } = await db.from("job_reports").select("*").in("job_id", ids).order("created_at"); (rr || []).forEach(x => (reps[x.job_id] ||= []).push(x)); }
  const jobsSorted = [...(j.data || [])].sort((a, b) => (b.check_status === "waiting" && b.status === "matched") - (a.check_status === "waiting" && a.status === "matched"));
  for (const r of jobsSorted) {
    const [s, c] = JOB_STATUS[r.status] || [r.status, ""];
    const canCancel = ["new", "open"].includes(r.status);
    const pollMe = r.check_first && r.status === "matched" && !r.check_status ? " data-poll" : "";
    parts.push(`<div class="card" id="job-${r.id}"${pollMe} style="margin-bottom:8px"><div class="row"><span class="item">${esc(r.item)}</span><span class="chip ${c}">${s}</span></div>${plate(r.from_town, r.to_town)}
      <div class="meta"><span>by ${fmtDate(r.window_end || r.job_date)}</span><span class="num">$${Math.round(r.price_estimate || 0)} · ${jobRef(r)}</span>${canCancel ? `<button class="btn small" data-cancel="jobs:${r.id}" style="margin-left:auto">Cancel</button>` : ""}</div>
      ${progress(r)}
      ${["matched", "collected", "delivered", "declined"].includes(r.status) ? `<div data-driverfor="${r.id}" class="fine">Finding driver details…</div><div data-photos="${r.id}"></div>` : ""}
      ${checkPanel(r)}
      ${r.status === "declined" ? `<p class="fine">It wasn't collected. We'll refund you everything except the driver's trip, usually within 2 working days.</p>` : ""}
      ${r.status === "new" && r.payment === "unpaid" ? payPanel(r) : ""}
      ${["new", "open"].includes(r.status) && r.kind === "pickup" ? `<details class="more"><summary>Message for the seller</summary>${sellerPanel(r)}</details>` : ""}
      ${(reps[r.id] || []).map(x => `<div class="note">You reported: <b>${esc(REPORT_KINDS[x.kind] || x.kind)}</b> on ${new Date(x.created_at).toLocaleDateString("en-NZ")}. ${REPORT_STATUS(x)}</div>`).join("")}
      ${r.status !== "cancelled" ? reportForm(r.id, "sender") : ""}</div>`);
  }
  box.className = "";
  box.innerHTML = parts.join("") || `<div class="empty">You haven't posted anything yet.</div>`;
  const waiting = (j.data || []).filter(r => r.check_status === "waiting" && r.status === "matched");
  const al = $("#checkAlert"); if (al) al.innerHTML = waiting.map(r => `<a class="alert" href="#job-${r.id}"><b>Your driver has sent photos of the ${esc(r.item)}.</b> Tap to see them and say yes or no.</a>`).join("");
  for (const r of (t.data || [])) { const el = document.querySelector(`[data-trippanel="${r.id}"]`); if (el) { el.className = ""; el.innerHTML = await tripJobsPanel(r, verified); } }
  showPhotos(db);
  for (const r of (j.data || [])) {
    const el = document.querySelector(`[data-driverfor="${r.id}"]`); if (!el) continue;
    const { data } = await db.rpc("my_job_driver", { p_job: r.id });
    const d = data?.[0];
    const coll = r.kind === "collect" && r.status === "matched" && d ? `<div class="note" style="margin-top:6px">If ${esc(r.store_name || "the store")} needs you to name who's collecting order <b class="num">${esc(r.order_ref || "")}</b>, add <b>${esc(d.driver_name)}</b>.</div>` : "";
    el.innerHTML = d ? coll + `Driver: <b>${esc(d.driver_name)}</b> · <a href="${telLink(d.driver_phone)}">${esc(d.driver_phone)}</a> · ${fmtDate(d.trip_date)}${d.depart_time ? ", leaving " + fmtTime(d.depart_time) : ""}.${r.status === "matched" ? " They'll text before pickup." : ""}` : "";
  }
}

// =====================================================================
// HOW IT WORKS
// =====================================================================
function info() {
  const sec = (t, b) => `<div class="card"><h3>${t}</h3>${b}</div>`;
  return `<section class="info-grid"><h2>How it works</h2>
    ${sec("Bought something pick-up only?", `<ol class="steps"><li><b>Post it and pay.</b> Paste the listing, add the seller's details and a deliver-by day. We hold your money.</li><li><b>Let the seller know.</b> We give you a message to send them. They don't pack or post anything.</li><li><b>A driver already heading your way takes it</b> and texts the seller to arrange pickup.</li><li><b>Want it checked first?</b> The driver sends you photos from the seller's, and you say yes or no before it's loaded.</li><li><b>It's delivered to your door.</b> Photos at pickup and drop-off, then the driver is paid. Full refund if nobody takes it in time.</li></ol>`)}
    ${sec("Ordered from a store in another town?", `<p class="sub">Use <b>Click and collect</b>. Give us the store, your order number and the name it's under. A driver already heading your way collects it from the counter and brings it to your door. If the store needs you to name who's collecting, add your driver's name once they take the job.</p>`)}
    ${sec("For drivers", `<ol class="steps"><li><b>Heading somewhere today?</b> Post your trip.</li><li><b>See paid jobs on your route</b> and what each one pays you.</li><li><b>Take the ones that suit you,</b> text the sender to confirm, collect and deliver.</li><li><b>Get paid weekly</b> by bank transfer.</li></ol>`)}
    ${examplePrices()}
    ${sec("Pricing", `<p class="sub">One all-in price, shown before you post. Our cut is 15% (minimum $3), and the driver always gets the rest.</p><div class="rates">
      <div><span class="num">5–30c/km</span><span>along the route, depending on the space it needs (car seat, boot, ute tray, or trailer or van).</span></div>
      <div><span class="num">$10–20</span><span>for loading and unloading a bulky item.</span></div>
      <div><span class="num">$10</span><span>to the driver if you ask them to check it before collecting.</span></div>
      <div><span class="num">80c/km</span><span>for the detour to the door and back.</span></div>
      <div><span class="num">$23.95/h</span><span>for the driver's extra time, at the NZ minimum wage.</span></div>
      <div><span class="num">+25%</span><span>on km for same-day express or a set arrival time. If it's late, you pay the normal rate.</span></div>
      <div><span class="num">$0</span><span>detour if you meet the driver on the route.</span></div></div>`)}
    ${sec("Collection and no-shows", `<p class="sub">Say how it can be collected: someone's home (and when), left out, at a business, or meet on the route. Drivers text you before they set off. If they arrive when you said and it isn't available, a no-show fee covering their trip is kept from your payment, and the rest refunded.</p>`)}
    ${sec("For businesses", `<p class="sub">Post jobs first thing. If no driver takes it by your cut-off, we text you to book your usual courier. <button class="linkbtn" data-tab-link="business" type="button">Register interest</button></p>`)}
    ${sec("Put it on your home screen", `<p class="sub">Open it like an app, in one tap.</p><ul class="plainlist"><li><b>iPhone:</b> in Safari, tap the Share button, then <b>Add to Home Screen</b>.</li><li><b>Android:</b> in Chrome, tap the ⋮ menu, then <b>Add to Home screen</b> or <b>Install app</b>.</li></ul>`)}
    ${sec("Trial service", `<ul class="plainlist"><li>Items aren't insured yet, so please only send things worth less than $500</li><li>Everyone is ID-checked once with a photo ID and selfie; the photos are deleted once checked</li><li>Drivers' licences, WoF and rego are checked before their first job</li><li>Drivers can check an item before accepting it, and refuse anything sealed or suspicious</li><li>Drivers usually travel alone, so for a two-person lift someone at each end helps load and unload</li><li>Addresses are only shared with your driver</li><li>Your payment is held until delivery is confirmed</li></ul>`)}
  </section>`;
}

// =====================================================================
// rendering & events
// =====================================================================
const views = { send, drive, board, info, mine, business, account };
function render() {
  $("#view").innerHTML = views[cur]();
  document.querySelectorAll(".tabs button").forEach(b => b.setAttribute("aria-selected", b.dataset.tab === cur));
  updPickupMode(); updHeavy(); updUrgent(); updPrice(); TS.tries = 0; tsMount();
  if (cur === "drive") loadAgain();
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
const niceError = e => { const m = e?.message || ""; return e?.code === "P0001" || /someone else|outside|licence|isn't live|yours to update|give back|buyer|already been answered|photo/i.test(m) ? esc(m) : "That didn't go through. Check your connection and try again." + (m ? ` <span style="display:block;font-size:12px;opacity:.8;margin-top:4px">Details: ${esc(m)}</span>` : ""); };
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
  if (e.target.closest("#mineBtn")) return go("account");
  if (e.target.closest("#forgotBtn")) { $("#forgotBox").hidden = false; $("#fp-email").value = v("si-email"); $("#fp-email").focus(); tsMount(); return; }
  const fs = e.target.closest("#forgotSend");
  if (fs) {
    const email = v("fp-email"), msg = $("#fp-msg");
    if (!/^\S+@\S+\.\S+$/.test(email)) { msg.innerHTML = `<div class="err">Please enter the email you signed up with.</div>`; return; }
    let captchaToken; try { captchaToken = tsToken("fp"); } catch (err) { msg.innerHTML = `<div class="err">${esc(err.message)}</div>`; return; }
    fs.disabled = true; fs.textContent = "Sending…";
    const { error } = await db.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname, captchaToken });
    tsReset("fp");
    fs.disabled = false; fs.textContent = "Email me a reset link";
    msg.innerHTML = error ? `<div class="err">${niceError(error)}</div>` : `<div class="ok"><p class="sub">If there's an account for ${esc(email)}, a reset link is on its way from hello@goingthatway.co.nz. If it's not in your inbox within a few minutes, check your junk folder.</p></div>`;
    return;
  }
  if (e.target.closest("#signOut")) { await db.auth.signOut(); await loadMe(); return go("account"); }
  const md = e.target.closest("[data-mode]"); if (md) { sendMode = md.dataset.mode; return render(); }
  const cx = e.target.closest("[data-cancel]");
  if (cx) {
    if (cx.dataset.confirm !== "1") { cx.dataset.confirm = "1"; cx.textContent = "Tap again to cancel"; return; }
    const [t, id] = cx.dataset.cancel.split(":"); cx.disabled = true;
    const { error } = await db.from(t).update({ status: "cancelled" }).eq("id", id);
    if (error) { cx.textContent = "Couldn't cancel. Use Report a problem on the job instead."; return; }
    return loadMine();
  }
  const cp = e.target.closest("[data-copy]"); if (cp) return copyText(cp.dataset.copy, cp);
  const rp = e.target.closest("[data-report]");
  if (rp) {
    const id = rp.dataset.report, box = rp.closest("[data-reportbox]"), details = ($("#rd-" + id)?.value || "").trim(), file = $("#rp-" + id)?.files?.[0];
    box.querySelectorAll(".err").forEach(x => x.remove());
    if (!details) return rp.insertAdjacentHTML("afterend", `<div class="err">Please tell us what happened.</div>`);
    rp.disabled = true; rp.textContent = "Sending…";
    try {
      if (file) await uploadJobPhoto(db, id, "report", file);
      const { error } = await db.from("job_reports").insert({ job_id: id, kind: $("#rk-" + id).value, details });
      if (error) throw error;
      box.innerHTML = `<div class="ok"><h3>Thanks, we've got it</h3><p class="sub">The Going That Way admin will look at it and get back to you, usually the same day.</p></div>`;
    } catch (err) { console.error(err); rp.disabled = false; rp.textContent = "Send to Going That Way"; rp.insertAdjacentHTML("afterend", `<div class="err">${niceError(err)}</div>`); }
    return;
  }
  if (e.target.closest("#useHome")) { $("#j-da").value = me.profile?.address || ""; return; }
  const ag = e.target.closest("[data-again]"); if (ag) return postAgain(ag.dataset.again);
  const sw = e.target.closest("[data-showtrip]"); if (sw) { $("#tripForm").closest(".card").hidden = true; $("#t-again").innerHTML = ""; return refreshTripPanel(sw.dataset.showtrip); }
  const rc = e.target.closest("[data-recheck]"); if (rc) { rc.textContent = "Checking…"; return cur === "account" ? loadMine() : refreshTripPanel(rc.dataset.recheck); }
  const cs = e.target.closest("[data-checksend]");
  if (cs) {
    const id = cs.dataset.checksend; cs.disabled = true; cs.textContent = "Sending…";
    const { error } = await db.rpc("job_check_send", { p_job: id, p_note: $("#cn-" + id)?.value || null });
    if (error) { cs.disabled = false; cs.textContent = "Send photos to the buyer"; cs.insertAdjacentHTML("afterend", `<div class="err">${niceError(error)}</div>`); return; }
    return cur === "account" ? loadMine() : refreshTripPanel(lastTrip?.id);
  }
  const ca = e.target.closest("[data-checkans]");
  if (ca) {
    const [id, ans] = ca.dataset.checkans.split(":");
    if (ca.dataset.confirm !== "1") { ca.dataset.confirm = "1"; ca.textContent = ans === "yes" ? "Tap again: yes, collect it" : "Tap again: no, leave it"; return; }
    ca.disabled = true;
    const { error } = await db.rpc("job_check_answer", { p_job: id, p_ok: ans === "yes" });
    if (error) { ca.outerHTML = `<div class="err">${niceError(error)}</div>`; return; }
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
    if (kind === "check") {
      btn.firstChild.textContent = "Photo added. Take another?"; inp.disabled = false; inp.value = "";
      btn.closest(".card")?.querySelectorAll(".err").forEach(x => x.remove());
      return showPhotos(db);
    }
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
document.addEventListener("change", e => {
  if (e.target.id === "j-type") { const t = ITEM_TYPES[e.target.value]; if (t) { $("#j-size").value = t[1]; $("#j-heavy").checked = t[2]; } }
  if (e.target.closest("#jobForm")) { updHeavy(); updUrgent(); }
  if (e.target.closest("#jobForm")) { updPickupMode(); updPrice(); }
});
// While someone's waiting on a check (driver for an answer, buyer for photos), look for news every 20 seconds
setInterval(() => {
  if (document.hidden || !document.querySelector("[data-poll]")) return;
  if (cur === "account") loadMine(); else if (lastTrip && $("#t-done")) refreshTripPanel(lastTrip.id);
}, 20000);

document.addEventListener("submit", async e => {
  e.preventDefault();
  const f = e.target, btn = f.querySelector("button[type=submit]");
  const busy = async (box, fn) => { btn.disabled = true; const l = btn.textContent; btn.textContent = "Please wait…"; try { await fn(); } catch (err) { console.error(err); showErr(box, esc(err.message || String(err))); } finally { btn.disabled = false; btn.textContent = l; } };
  if (f.id === "siForm") return busy("#si-err", async () => {
    const captchaToken = tsToken("si");
    const { error } = await db.auth.signInWithPassword({ email: v("si-email"), password: $("#si-pass").value, options: { captchaToken } });
    tsReset("si");
    if (error) throw new Error(/invalid/i.test(error.message) ? "That email and password don't match." : error.message);
    await loadMe(); go(me.profile && !idOk() ? "account" : cur === "account" ? "send" : cur);
  });
  if (f.id === "suForm") return busy("#su-err", async () => {
    const name = v("su-name"), email = v("su-email"), pass = $("#su-pass").value, phone = v("su-phone"), address = v("su-addr");
    if (!name || !email || !address) throw new Error("Please fill in every field.");
    if (pass.length < 8) throw new Error("Please use a password of at least 8 characters.");
    if (!validPhone(phone)) throw new Error("Please enter a NZ mobile number, like 021 123 4567.");
    if (!$("#su-ok").checked) throw new Error("Please tick the box to continue.");
    const captchaToken = tsToken("su");
    const { data, error } = await db.auth.signUp({ email, password: pass, options: { data: { name, phone, address }, captchaToken } });
    tsReset("su");
    if (error) throw new Error(/registered|exists/i.test(error.message) ? "There's already an account with that email. Sign in instead." : error.message);
    if (!data.session) { f.closest(".card").innerHTML = `<div class="ok"><h3>Check your email</h3><p class="sub">We've sent a link to ${esc(email)} to confirm your account.</p></div>`; return; }
    await loadMe(); go("account");
  });
  if (f.id === "npForm") return busy("#np-err", async () => {
    const pass = $("#np-pass").value;
    if (pass.length < 8) throw new Error("Please use a password of at least 8 characters.");
    const { error } = await db.auth.updateUser({ password: pass }); if (error) throw error;
    recovery = false; history.replaceState(null, "", location.pathname);
    await loadMe(); go("account");
    $("#view").insertAdjacentHTML("afterbegin", `<div class="ok" style="margin-bottom:10px"><h3>Password changed</h3><p class="sub">You're signed in with your new password.</p></div>`);
  });
  if (f.id === "bkForm") return busy("#bk-err", async () => {
    let acc = v("bk-acc").replace(/[\s]/g, "");
    const digits = acc.replace(/-/g, "");
    if (!acc.includes("-") && /^\d{15,16}$/.test(digits)) acc = `${digits.slice(0, 2)}-${digits.slice(2, 6)}-${digits.slice(6, 13)}-${digits.slice(13)}`;
    if (!/^\d{2}-\d{4}-\d{7}-\d{2,3}$/.test(acc)) throw new Error("Please enter a NZ bank account number like 12-3456-7890123-00.");
    const name = v("bk-name"); if (!name) throw new Error("Please add the name on the account.");
    const { error } = await db.from("profiles").update({ bank_account: acc, bank_account_name: name }).eq("id", me.user.id); if (error) throw error;
    await loadMe(); $("#bk-acc").value = acc; showErr("#bk-err", ""); btn.textContent = "Saved";
  });
  if (f.id === "pfForm") return busy("#pf-err", async () => {
    const row = { name: v("pf-name"), phone: v("pf-phone"), address: v("pf-addr") };
    if (!row.name || !row.address) throw new Error("Please fill in your name and address.");
    if (!validPhone(row.phone)) throw new Error("Please enter a NZ mobile number, like 021 123 4567.");
    const { error } = await db.from("profiles").update(row).eq("id", me.user.id); if (error) throw error;
    await loadMe(); showErr("#pf-err", ""); btn.textContent = "Saved";
  });
  if (f.id === "idForm") return busy("#id-err", async () => {
    const idf = $("#id-photo").files?.[0], sf = $("#id-selfie").files?.[0];
    if (!idf || !sf) throw new Error("Please add both a photo of your ID and a selfie.");
    await uploadIdDoc("id", idf); await uploadIdDoc("selfie", sf);
    const { error } = await db.rpc("submit_id", { p_type: v("id-type") }); if (error) throw error;
    await loadMe(); go("account");
  });
  if (f.id === "drForm") return busy("#dr-err", async () => {
    const plate = v("dr-plate"), make = v("dr-make");
    if (!plate || !make) throw new Error("Please add your number plate and vehicle.");
    const lic = $("#dr-lic"), sel = $("#dr-selfie");
    if (lic) { if (!lic.files?.[0] || !sel.files?.[0]) throw new Error("Please add a photo of your licence and a selfie."); await uploadIdDoc("licence", lic.files[0]); await uploadIdDoc("selfie", sel.files[0]); }
    const { error } = await db.rpc("apply_driver", { p_licence_class: v("dr-class"), p_plate: plate, p_make: make, p_space: v("dr-space") }); if (error) throw error;
    await loadMe(); go("account");
  });
  if (f.id === "jobForm") {
    const j = jobValues();
    if (!j.item) return showErr("#j-err", "Please say what it is.");
    if (j.from_town === j.to_town) return showErr("#j-err", "Pick two different towns.");
    if (!j.pickup_address || !j.drop_address) return showErr("#j-err", "Please add the pickup and delivery addresses, so your driver knows where to go. Only your driver sees them.");
    if (j.kind === "pickup" && (!j.seller_name || !validPhone(j.seller_phone || ""))) return showErr("#j-err", "Please add the seller's name and mobile, so the driver can arrange pickup.");
    if (j.kind === "collect" && (!j.store_name || !j.order_ref || !j.order_name)) return showErr("#j-err", "Please add the store, your order number and the name the order is under, so the driver can collect it.");
    if (j.heavy && !$("#j-help")?.checked) return showErr("#j-err", "For a two-person lift, please confirm someone will help the driver at each end. Drivers usually travel alone.");
    if (j.pickup_mode === "left_out" && !j.pickup_notes) return showErr("#j-err", "Please say where it's left, so the driver can find it.");
    if (!j.window_end || j.window_end < todayISO()) return showErr("#j-err", "Pick a deliver-by day, today or later.");
    if (j.job_date > j.window_end) return showErr("#j-err", "The earliest pickup day is after the deliver-by day.");
    if (!j.sender_name || !validPhone(j.sender_phone)) return showErr("#j-err", "Please add your name and mobile under My account first.");
    if (!$("#c-ok").checked) return showErr("#j-err", "Please tick the box to agree to the trial terms.");
    showErr("#j-err", "");
    const row = { ...j, price_estimate: jobPrice(j)?.total ?? null };
    const saved = await save("jobs", row, "#j-err", btn);
    if (saved) {
      f.closest(".card").hidden = true;
      $("#j-done").innerHTML = `<div class="ok"><h3>Posted. One step left.</h3><p class="sub">Your ${esc(j.item)} (${esc(j.from_town)} → ${esc(j.to_town)}, by ${fmtDate(j.window_end)}) goes on the board once it's paid. We've emailed you the details too. If you can't see it, check your junk folder and mark it "not junk".</p></div>` + payPanel(saved)
        + sellerPanel(saved) + `<button class="linkbtn" type="button" data-tab-link="mine">See my posts</button>`;
    }
  }
  if (f.id === "tripForm") {
    const row = { from_town: v("t-from"), to_town: v("t-to"), from_suburb: v("t-fa") || null, to_suburb: v("t-ta") || null, trip_date: v("t-date"), depart_time: v("t-time") || null,
      space: v("t-space"), max_detour_km: +v("t-det"), vehicle: v("t-veh") || null, space_note: v("t-note") || null, regular: $("#t-reg").checked, driver_name: me.profile?.name || "", driver_phone: me.profile?.phone || "" };
    if (row.from_town === row.to_town) return showErr("#t-err", "Pick two different towns.");
    if (!row.from_suburb || !row.to_suburb) return showErr("#t-err", "Please say roughly where you're leaving from and arriving at. A suburb or \"CBD\" is fine.");
    if (!row.trip_date || row.trip_date < todayISO()) return showErr("#t-err", "Pick today or a later day.");
    if (!row.driver_name || !validPhone(row.driver_phone)) return showErr("#t-err", "Please add your name and mobile under My account first.");
    showErr("#t-err", "");
    memo.set({ tfrom: row.from_town, tto: row.to_town, tfa: row.from_suburb, tta: row.to_suburb, tspace: row.space, tdet: row.max_detour_km, tveh: row.vehicle || "" });
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

$("#view").innerHTML = `<div class="empty">Loading…</div>`;
// Contact email in the footer, if set
if (cfg.CONTACT_EMAIL) { const f = document.querySelector(".foot p"); if (f) f.insertAdjacentHTML("beforeend", ` · <a href="mailto:${esc(cfg.CONTACT_EMAIL)}">${esc(cfg.CONTACT_EMAIL)}</a>`); }
if (recovery) cur = "account";
loadMe().then(render);
if (db) db.auth.onAuthStateChange(ev => {
  if (ev === "SIGNED_OUT") loadMe().then(render);
  if (ev === "PASSWORD_RECOVERY") { recovery = true; cur = "account"; loadMe().then(render); }
});
