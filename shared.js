// Shared by the public site and the admin page: towns, pricing, helpers, database client.

// South Island corridor along State Highway 1, approximate road km from Hanmer Springs.
// Service area: Christchurch to Dunedin and the towns in between (towns a few km off SH1,
// like Geraldine and Waimate, are counted at their turn-off; the door-stop detour covers the rest).
const TOWNS = [
  ["Hanmer Springs", 0], ["Culverden", 38], ["Amberley", 88], ["Rangiora", 108],
  ["Christchurch Airport", 125], ["Christchurch", 135], ["Rolleston", 158], ["Dunsandel", 176], ["Rakaia", 192],
  ["Ashburton", 220], ["Hinds", 242], ["Geraldine", 268], ["Winchester", 271], ["Temuka", 280], ["Timaru", 296],
  ["Pareora", 313], ["St Andrews", 320], ["Makikihi", 329], ["Waimate", 340], ["Glenavy", 357],
  ["Oamaru", 380], ["Hampden", 416], ["Moeraki", 420], ["Palmerston", 435], ["Waikouaiti", 454], ["Dunedin", 495],
];
const KM = Object.fromEntries(TOWNS);
const dist = (a, b) => Math.abs(KM[b] - KM[a]);

// Pricing: cheap for km the driver drives anyway, a proper rate for the detour,
// minimum wage for the driver's extra time, +25% on km for a set arrival time.
// Bulky items pay more per km (they need a ute or trailer) plus a loading allowance.
const RATE = {
  onRoute: { small: 0.05, medium: 0.08, large: 0.20, xl: 0.30 }, // $ per km along the driver's route (xl: towing a trailer or a van)
  handling: { small: 0, medium: 0, large: 10, xl: 20 },           // loading, strapping down, unloading a bulky item
  check: 10,            // "check it before you buy": photos from the seller's, buyer says yes or no
  detourKm: 0.80,       // $ per extra km (out and back)
  wage: 23.95,          // NZ adult minimum wage from 1 April 2026, per hour of extra time
  minsPerKm: 1,         // detour driving time
  minsPerStop: 5,
  typicalDetourKm: 4,   // estimate per door stop until a driver accepts
  deadlinePct: 0.25, deadlineMin: 3,
  feePct: 0.15, feeMin: 3,
};
const COVER_FEE = { 500: 0, 1000: 5, 2000: 10 };
const SIZE_LABEL = { small: "Fits on a car seat", medium: "Fits in a car boot", large: "Ute tray", xl: "Trailer or van only" };
const SIZE_SHORT = { small: "Small", medium: "Boot-size", large: "Ute-size", xl: "Trailer or van" };
// What people buy pick-up only: the space each usually needs, and whether it's a two-person lift
const ITEM_TYPES = {
  big_furniture: ["Big furniture (couch, bed, wardrobe, dining set)", "xl", true],
  furniture: ["Smaller furniture (armchair, drawers, desk, small table)", "large", false],
  whiteware: ["Whiteware (fridge, washer, dryer)", "large", true],
  bike: ["Bike, e-bike or scooter", "large", false],
  outdoor: ["Outdoor and garden (mower, BBQ, outdoor set)", "large", false],
  building: ["Building materials (timber, doors, windows)", "large", false],
  parts: ["Car, farm or machinery parts", "medium", false],
  tools: ["Tools and equipment", "medium", false],
  boxed: ["Boxes and smaller items", "small", false],
  other: ["Something else", "medium", false],
};
const itemTypeShort = k => (ITEM_TYPES[k]?.[0] || "").split(" (")[0];
const SPACE_LABEL = { boot: "Car boot", ute: "Ute tray", trailer: "Trailer", van: "Van" };

// Estimate what the sender pays, all in. The driver's pay is never reduced by our fee.
function estimate({ from, to, size, handover, deadline, cover, check }) {
  if (!(from in KM) || !(to in KM) || from === to) return null;
  const onRoute = dist(from, to);
  const detour = handover === "route" ? 0 : 2 * RATE.typicalDetourKm * 2; // two stops, out and back
  const mins = detour * RATE.minsPerKm + 2 * RATE.minsPerStop;
  const a = RATE.onRoute[size] * onRoute, b = RATE.detourKm * detour, c = (RATE.wage / 60) * mins;
  const h = RATE.handling[size] || 0, k = check ? RATE.check : 0;
  const prem = deadline ? Math.max(RATE.deadlineMin, (a + b) * RATE.deadlinePct) : 0;
  const base = a + b + c + h + k, driver = base + prem;
  const fee = Math.max(RATE.feeMin, driver * RATE.feePct);
  const total = Math.round(driver + fee + (COVER_FEE[cover] || 0));
  const normal = deadline ? Math.round(base + Math.max(RATE.feeMin, base * RATE.feePct) + (COVER_FEE[cover] || 0)) : total;
  return { onRoute, detour, driver: Math.round(driver), total, normal, prem: Math.round(prem), handling: h, check: k,
    parts: { route: a, detour: b + c, handling: h, check: k, prem, fee } };
}

const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const $ = s => document.querySelector(s);
const fmtDate = d => d ? new Date(d + "T00:00:00").toLocaleDateString("en-NZ", { weekday: "short", day: "numeric", month: "short" }) : "";
const fmtTime = t => { if (!t) return ""; const [h, m] = t.split(":").map(Number); return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${h >= 12 ? "pm" : "am"}`; };
const todayISO = (plus = 0) => { const d = new Date(); d.setDate(d.getDate() + plus); return d.toLocaleDateString("en-CA"); };
const townOptions = sel => TOWNS.map(([n]) => `<option${n === sel ? " selected" : ""}>${n}</option>`).join("");
// NZ mobile: 02x followed by 7-9 digits (spaces allowed)
const validPhone = p => /^(\+?64|0)2\d{7,9}$/.test(String(p).replace(/[\s-]/g, ""));

function makeClient() {
  const c = window.GTW_CONFIG || {};
  if (!window.supabase || !c.SUPABASE_URL || c.SUPABASE_URL.includes("YOUR-PROJECT")) return null;
  return window.supabase.createClient(c.SUPABASE_URL, c.SUPABASE_ANON_KEY);
}

// What the driver is paid from an all-in price (price = driver + 15% fee, fee at least $3)
const driverFromPrice = p => { p = Number(p) || 0; return Math.round(p / (1 + RATE.feePct) >= RATE.feeMin / RATE.feePct ? p / (1 + RATE.feePct) : p - RATE.feeMin); };

// Same-day jobs are express (+25%), like a set arrival time
const isExpress = (jobDate, windowEnd) => jobDate && jobDate === windowEnd && windowEnd === todayISO();

// Does a job fit a trip? Same direction, both ends inside the trip, room for it, and the trip day is inside the job's window
const SPACE_FITS = { boot: ["small", "medium"], ute: ["small", "medium", "large"], trailer: ["small", "medium", "large", "xl"], van: ["small", "medium", "large", "xl"] };
function jobFitsTrip(j, t) {
  if (![t.from_town, t.to_town, j.from_town, j.to_town].every(x => x in KM)) return false;
  const a = KM[t.from_town], b = KM[t.to_town], p = KM[j.from_town], d = KM[j.to_town], lo = Math.min(a, b), hi = Math.max(a, b);
  const onRoute = (b - a) * (d - p) > 0 && p >= lo && p <= hi && d >= lo && d <= hi;
  const inWindow = t.trip_date >= j.job_date && t.trip_date <= (j.window_end || j.job_date);
  return onRoute && inWindow && (SPACE_FITS[t.space] || []).includes(j.size);
}

// Google Maps links for a driver: their normal route, and with the job added
const place = (addr, town) => encodeURIComponent([addr, town, "New Zealand"].filter(Boolean).join(", "));
const mapNormal = t => `https://www.google.com/maps/dir/?api=1&travelmode=driving&origin=${place(t.from_suburb, t.from_town)}&destination=${place(t.to_suburb, t.to_town)}`;
const mapWithJob = (j, t) => `${mapNormal(t)}&waypoints=${place(j.pickup_address, j.from_town)}%7C${place(j.drop_address, j.to_town)}`;
const jobRef = j => "GTW-" + String(j.id).replace(/-/g, "").slice(0, 6).toUpperCase();
const PICKUP_LABEL = { home: "Someone's home", left_out: "Left out for collection", business: "At a business", meet: "Meet on the route" };
// Copy text to the clipboard; falls back to selecting it in a box
async function copyText(text, btn) {
  const lab = btn.dataset.label || btn.textContent; btn.dataset.label = lab;
  try { await navigator.clipboard.writeText(text); btn.textContent = "Copied"; }
  catch { const ta = document.createElement("textarea"); ta.value = text; ta.className = "tmpl"; btn.after(ta); ta.select(); btn.textContent = "Select and copy"; }
  setTimeout(() => (btn.textContent = lab), 1800);
}
const bankSet = () => { const c = window.GTW_CONFIG || {}; return c.BANK_ACCOUNT && !c.BANK_ACCOUNT.startsWith("00-0000"); };

// ---------- Photos ----------
// Shrink a phone photo to max 1600px JPEG before uploading (fast on rural reception, small storage)
async function shrinkImage(file, max = 1600, quality = 0.72) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
    const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement("canvas"); c.width = Math.round(img.naturalWidth * scale); c.height = Math.round(img.naturalHeight * scale);
    c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
    return await new Promise(res => c.toBlob(res, "image/jpeg", quality));
  } finally { URL.revokeObjectURL(url); }
}
const PHOTO_LABEL = { pickup: "Pickup", dropoff: "Drop-off", no_show: "Nobody there", check: "Check" };
// Fill every [data-photos="<job id>"] element with that job's photos (signed links last an hour)
async function showPhotos(db, root = document) {
  const els = [...root.querySelectorAll("[data-photos]")]; if (!els.length || !db) return;
  const ids = [...new Set(els.map(e => e.dataset.photos))];
  const { data: rows } = await db.from("job_photos").select("*").in("job_id", ids).order("created_at");
  if (!rows?.length) return;
  const { data: signed } = await db.storage.from("job-photos").createSignedUrls(rows.map(r => r.path), 3600);
  const urlFor = p => signed?.find(s => s.path === p)?.signedUrl;
  for (const el of els) {
    const mine = rows.filter(r => r.job_id === el.dataset.photos);
    el.innerHTML = mine.length ? `<div class="photos">${mine.map(r => { const u = urlFor(r.path); return u ? `<a href="${esc(u)}" target="_blank" rel="noopener"><img src="${esc(u)}" alt="${PHOTO_LABEL[r.kind]} photo"><span>${PHOTO_LABEL[r.kind]} · ${new Date(r.created_at).toLocaleTimeString("en-NZ", { hour: "numeric", minute: "2-digit" })}</span></a>` : ""; }).join("")}</div>` : "";
  }
}
async function uploadJobPhoto(db, jobId, kind, file) {
  const blob = await shrinkImage(file);
  const path = `${jobId}/${kind}-${Date.now()}.jpg`;
  const up = await db.storage.from("job-photos").upload(path, blob, { contentType: "image/jpeg", upsert: false });
  if (up.error) throw up.error;
  const { error } = await db.from("job_photos").insert({ job_id: jobId, kind, path });
  if (error) throw error;
}
