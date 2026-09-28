// Shared by the public site and the admin page: towns, pricing, helpers, database client.

// South Island corridor, approximate road km from Hanmer Springs along the main route.
// Launch corridor is Christchurch - Ashburton - Timaru; the rest is here so the maths works either side.
const TOWNS = [
  ["Hanmer Springs", 0], ["Culverden", 38], ["Amberley", 88], ["Rangiora", 108],
  ["Christchurch Airport", 125], ["Christchurch", 135], ["Rolleston", 158], ["Rakaia", 192],
  ["Ashburton", 220], ["Geraldine", 272], ["Temuka", 280], ["Timaru", 296],
  ["Oamaru", 380], ["Dunedin", 495],
];
const KM = Object.fromEntries(TOWNS);
const dist = (a, b) => Math.abs(KM[b] - KM[a]);

// Pricing: cheap for km the driver drives anyway, a proper rate for the detour,
// minimum wage for the driver's extra time, +25% on km for a set arrival time.
const RATE = {
  onRoute: { small: 0.05, medium: 0.08, large: 0.15 }, // $ per km along the driver's route
  detourKm: 0.80,       // $ per extra km (out and back)
  wage: 23.95,          // NZ adult minimum wage from 1 April 2026, per hour of extra time
  minsPerKm: 1,         // detour driving time
  minsPerStop: 5,
  typicalDetourKm: 4,   // estimate per door stop until a driver accepts
  deadlinePct: 0.25, deadlineMin: 3,
  feePct: 0.15, feeMin: 3,
};
const COVER_FEE = { 500: 0, 1000: 5, 2000: 10 };
const SIZE_LABEL = { small: "Small (fits on a seat)", medium: "Medium (boot or box)", large: "Large (needs a ute tray)" };
const SPACE_LABEL = { boot: "Car boot", ute: "Ute tray", trailer: "Trailer", van: "Van" };

// Estimate what the sender pays, all in. The driver's pay is never reduced by our fee.
function estimate({ from, to, size, handover, deadline, cover }) {
  if (!(from in KM) || !(to in KM) || from === to) return null;
  const onRoute = dist(from, to);
  const detour = handover === "route" ? 0 : 2 * RATE.typicalDetourKm * 2; // two stops, out and back
  const mins = detour * RATE.minsPerKm + 2 * RATE.minsPerStop;
  const a = RATE.onRoute[size] * onRoute, b = RATE.detourKm * detour, c = (RATE.wage / 60) * mins;
  const prem = deadline ? Math.max(RATE.deadlineMin, (a + b) * RATE.deadlinePct) : 0;
  const driver = a + b + c + prem;
  const fee = Math.max(RATE.feeMin, driver * RATE.feePct);
  const total = Math.round(driver + fee + (COVER_FEE[cover] || 0));
  const normal = deadline ? Math.round(a + b + c + Math.max(RATE.feeMin, (a + b + c) * RATE.feePct) + (COVER_FEE[cover] || 0)) : total;
  return { onRoute, detour, driver: Math.round(driver), total, normal, prem: Math.round(prem) };
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
