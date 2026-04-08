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

// ===== INTENT PARSER =====
function parseIntent(msg, session) {
  if (!session.intent) session.intent = {};

  // budget
  const nums = msg.match(/\d{3,4}/);
  if (nums) session.intent.budget = parseInt(nums[0]);

  // brand
  const brands = ["bmw","mercedes","audi","lexus","toyota","honda"];
  brands.forEach(b => {
    if (msg.includes(b)) session.intent.brand = b;
  });

  // model
  if (msg.includes("cle")) session.intent.model = "cle";
  if (msg.includes("3 series")) session.intent.model = "3";

  // type
  if (msg.includes("suv")) session.intent.type = "suv";
  if (msg.includes("truck")) session.intent.type = "truck";
  if (msg.includes("sedan")) session.intent.type = "sedan";
}

// ===== FILTER =====
function filterDeals(deals, intent) {
  if (!intent) return deals;

  if (intent.budget) {
    deals = deals.filter(d => d.monthly <= intent.budget);
  }

  if (intent.brand) {
    deals = deals.filter(d =>
      d.make.toLowerCase().includes(intent.brand)
    );
  }

  if (intent.model) {
    deals = deals.filter(d =>
      d.model.toLowerCase().includes(intent.model)
    );
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

    // RESET
    if (msg.includes("start over")) {
      session.intent = {};
      await sendHumanMessage(from,"starting fresh — what are you looking for?");
      return;
    }

    // GREETING
    if (/^hi|hello|hey$/.test(msg)) {
      await sendHumanMessage(from,"what are you thinking?");
      return;
    }

    // HANDLE CHEAP
    if (/cheap|budget|low/.test(msg) && !session.intent?.budget) {
      await sendHumanMessage(from,"got you — where do you want to be monthly?");
      return;
    }

    // PARSE INTENT
    parseIntent(msg, session);

    let deals = await getDeals();
    deals = filterDeals(deals, session.intent);

    deals.sort((a,b)=>a.monthly-b.monthly);

    // NO RESULTS
    if (!deals.length) {
      await sendHumanMessage(from,"i’ll check inventory and get you options shortly");
      return;
    }

    // SHOW DEALS
    const top = deals.slice(0,3);

    let reply = top.map(formatDeal).join("\n\n");
    reply += `\n\nfirst one is the strongest deal`;

    session.activeDeal = top[0];

    await sendHumanMessage(from, reply);

  } catch (e) {
    console.log("ERROR:", e);
  }
});

module.exports = router;