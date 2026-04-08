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

// ===== CLASSIFICATION =====
function isSUV(d) {
  return /x|gl|rx|nx|qx|cx|rav4|crv|pilot|tiguan|gle|glc|gla|glb/.test(
    `${d.make} ${d.model}`.toLowerCase()
  );
}

function isTruck(d) {
  return /tacoma|f150|ram|silverado|frontier/.test(d.model.toLowerCase());
}

function isSedan(d) {
  return !isSUV(d) && !isTruck(d);
}

// ===== INTENT ENGINE =====
function updateIntent(msg, session) {
  if (!session.intent) session.intent = {};

  const intent = session.intent;

  // ===== HARD RESET CONDITIONS =====
  if (msg.includes("start over")) {
    session.intent = {};
    return;
  }

  // ===== BRAND (overwrites old)
  const brands = ["bmw","mercedes","audi","lexus","toyota","honda"];
  brands.forEach(b => {
    if (msg.includes(b)) {
      intent.brand = b;
    }
  });

  // ===== TYPE (overwrites old)
  if (msg.includes("suv")) {
    intent.type = "suv";
    delete intent.model;
  }

  if (msg.includes("sedan")) {
    intent.type = "sedan";
  }

  if (msg.includes("truck")) {
    intent.type = "truck";
  }

  // ===== BUDGET
  const nums = msg.match(/\d{3,4}/);
  if (nums) intent.budget = parseInt(nums[0]);
}

// ===== FILTER ENGINE =====
function filterDeals(deals, intent) {

  if (!intent) return deals;

  if (intent.brand) {
    deals = deals.filter(d =>
      d.make.toLowerCase().includes(intent.brand)
    );
  }

  if (intent.type === "suv") {
    deals = deals.filter(isSUV);
  }

  if (intent.type === "sedan") {
    deals = deals.filter(isSedan);
  }

  if (intent.type === "truck") {
    deals = deals.filter(isTruck);
  }

  if (intent.budget) {
    deals = deals.filter(d => d.monthly <= intent.budget);
  }

  return deals;
}

// ===== HUMAN TONE =====
function getGreeting() {
  const hour = new Date().getHours();

  if (hour < 12) return "morning — what are you looking at?";
  if (hour < 18) return "what are you thinking about right now?";
  return "what are you looking to get into tonight?";
}

// ===== ROUTE =====
router.post("/", async (req, res) => {
  res.sendStatus(200);

  const from = req.body.number || req.body.from;
  const msg = (req.body.content || req.body.text || "").toLowerCase().trim();

  const session = getSession(from);

  try {

    // ===== GREETING =====
    if (/^hi|hello|hey$/.test(msg)) {
      await sendHumanMessage(from, getGreeting());
      return;
    }

    // ===== UPDATE INTENT =====
    updateIntent(msg, session);

    let deals = await getDeals();
    deals = filterDeals(deals, session.intent);

    deals.sort((a,b)=>a.monthly-b.monthly);

    // ===== NO MATCH =====
    if (!deals.length) {
      await sendHumanMessage(from,"nothing clean on that exact setup — want me to open it up a bit?");
      return;
    }

    // ===== SHOW DEALS =====
    const top = deals.slice(0,3);

    let reply = top.map(formatDeal).join("\n\n");

    reply += `\n\nthis first one is the cleanest setup right now`;

    session.activeDeal = top[0];

    await sendHumanMessage(from, reply);

  } catch (e) {
    console.log("ERROR:", e);
  }
});

module.exports = router;