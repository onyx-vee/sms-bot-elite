const express = require("express");
const router = express.Router();

const { sendHumanMessage } = require("../services/messaging");
const { getDeals } = require("../services/deals");
const { getSession } = require("../utils/memory");

// ===== FORMAT =====
function formatDeal(d) {
  return `${d.make} ${d.model}
$${d.monthly}/mo
${d.term} mo / ${d.miles}
$${d.due} due`;
}

// ===== REAL SUV DETECTION (FIXED) =====
function isSUV(d) {
  const text = `${d.make} ${d.model}`.toLowerCase();

  const suvKeywords = [
    "x1","x3","x5","x7",
    "gl","gla","glb","glc","gle",
    "rx","nx","qx",
    "cx","rav4","crv","pilot","tiguan","highlander",
    "ux","gx","lx"
  ];

  return suvKeywords.some(k => text.includes(k));
}

function isTruck(d) {
  return /tacoma|f150|ram|silverado|frontier/.test(d.model.toLowerCase());
}

function isSedan(d) {
  return !isSUV(d) && !isTruck(d);
}

// ===== RESPONSE VARIATION (HUGE UPGRADE) =====
function getCloserLine() {
  const options = [
    "this one makes the most sense overall",
    "this is probably the move right now",
    "this is the strongest deal in the group",
    "this one is where i’d lean",
    "this is the cleanest setup i’m seeing"
  ];

  return options[Math.floor(Math.random() * options.length)];
}

// ===== GREETING =====
function getGreeting() {
  const options = [
    "hey — what are you looking at right now?",
    "what are you thinking about getting into?",
    "what kind of car are you in the market for?",
    "what are you trying to switch into?"
  ];

  return options[Math.floor(Math.random() * options.length)];
}

// ===== INTENT ENGINE =====
function updateIntent(msg, session) {
  if (!session.intent) session.intent = {};
  const intent = session.intent;

  // HARD RESET
  if (msg.includes("start over")) {
    session.intent = {};
    return;
  }

  // BRAND (overwrite)
  const brands = ["bmw","mercedes","audi","lexus","toyota","honda"];
  brands.forEach(b => {
    if (msg.includes(b)) {
      intent.brand = b;
    }
  });

  // TYPE (overwrite + reset model)
  if (msg.includes("suv")) {
    intent.type = "suv";
    delete intent.model;
  }

  if (msg.includes("sedan")) intent.type = "sedan";
  if (msg.includes("truck")) intent.type = "truck";

  // BUDGET
  const nums = msg.match(/\d{3,4}/);
  if (nums) intent.budget = parseInt(nums[0]);
}

// ===== FILTER =====
function filterDeals(deals, intent) {

  if (!intent) return deals;

  if (intent.brand) {
    deals = deals.filter(d =>
      d.make.toLowerCase().includes(intent.brand)
    );
  }

  if (intent.type === "suv") deals = deals.filter(isSUV);
  if (intent.type === "sedan") deals = deals.filter(isSedan);
  if (intent.type === "truck") deals = deals.filter(isTruck);

  if (intent.budget) {
    deals = deals.filter(d => d.monthly <= intent.budget);
  }

  return deals;
}

// ===== ROUTE =====
router.post("/", async (req, res) => {
  res.sendStatus(200);

  const from = req.body.number || req.body.from;
  const msg = (req.body.content || req.body.text || "").toLowerCase().trim();

  const session = getSession(from);

  try {

    // GREETING
    if (/^hi|hello|hey$/.test(msg)) {
      await sendHumanMessage(from, getGreeting());
      return;
    }

    // UPDATE INTENT
    updateIntent(msg, session);

    let deals = await getDeals();
    deals = filterDeals(deals, session.intent);

    deals.sort((a,b)=>a.monthly-b.monthly);

    // NO RESULTS
    if (!deals.length) {
      await sendHumanMessage(from,"nothing clean exactly like that — want me to open it up a bit?");
      return;
    }

    // SHOW DEALS
    const top = deals.slice(0,3);

    let reply = top.map(formatDeal).join("\n\n");

    reply += `\n\n${getCloserLine()}`;

    session.activeDeal = top[0];

    await sendHumanMessage(from, reply);

  } catch (e) {
    console.log("ERROR:", e);
  }
});

module.exports = router;