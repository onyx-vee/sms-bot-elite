const express = require("express");
const router = express.Router();

const { sendHumanMessage } = require("../services/messaging");
const { getDeals } = require("../services/deals");
const { getSession } = require("../utils/memory");

const APPLICATION_LINK = "https://onyxautocollection.com/1745-2/";

// ===== FORMAT =====
function formatDeal(d) {
  return `${d.make} ${d.model}
$${d.monthly}/mo
${d.term} mo / ${d.miles}
$${d.due} due`;
}

// ===== DETECT =====
function extractBudget(msg) {
  const nums = msg.match(/\d{3,4}/g);
  if (!nums) return null;
  if (nums.length >= 2) return { min: +nums[0], max: +nums[1] };
  return { min: 0, max: +nums[0] };
}

function detectType(msg) {
  if (/suv/.test(msg)) return "suv";
  if (/truck/.test(msg)) return "truck";
  if (/sedan/.test(msg)) return "sedan";
  return null;
}

function detectBrand(msg) {
  const brands = ["bmw","mercedes","audi","lexus","toyota","honda","nissan","mazda"];
  return brands.find(b => msg.includes(b));
}

// ===== FILTERS =====
function isSUV(d) {
  return /x|gl|rx|nx|qx|cx|rav4|crv|pilot|tiguan/.test(
    `${d.make} ${d.model}`.toLowerCase()
  );
}

function isTruck(d) {
  return /tacoma|f150|ram|silverado|frontier/.test(d.model.toLowerCase());
}

function isSedan(d) {
  return !isSUV(d) && !isTruck(d);
}

// ===== NEGOTIATION =====
function extractDown(msg) {
  if (msg.includes("0")) return 0;

  const m = msg.match(/(\d+)/);
  if (!m) return null;

  let val = parseInt(m[1]);
  if (val < 100) val = val * 1000;

  return val;
}

function adjustPayment(deal, newDown) {
  const map = {13:77,18:56,24:42,36:28,39:26,48:21};

  const term = Number(deal.term);
  const factor = map[term] || 30;

  const currentDue = parseInt(
    (deal.due || "").replace(/[^0-9]/g,"")
  ) || 0;

  const diff = (currentDue - newDown) / 1000;

  return Math.round(deal.monthly + diff * factor);
}

// ===== ROUTE =====
router.post("/", async (req, res) => {
  res.sendStatus(200);

  const from = req.body.number || req.body.from;
  const msg = (req.body.content || req.body.text || "").toLowerCase().trim();

  const session = getSession(from);

  try {

    // ===== RESET =====
    if (/start over/.test(msg)) {
      Object.keys(session).forEach(k=>delete session[k]);
      await sendHumanMessage(from,"starting fresh — what are you trying to get into?");
      return;
    }

    // ===== GREETING =====
    if (/^hi|hello|hey$/.test(msg)) {
      await sendHumanMessage(from,"what are you trying to get into?");
      return;
    }

    // ===== HANDLE "CHEAP" =====
    if (/cheap|low|budget/.test(msg) && !session.max) {
      await sendHumanMessage(from,"got you — where do you want to be monthly? like 300, 400, 500?");
      return;
    }

    // ===== NEGOTIATION (FIXED) =====
    if (/down/.test(msg) && session.activeDeal) {

      const newDown = extractDown(msg);

      if (newDown !== null) {
        const newMonthly = adjustPayment(session.activeDeal, newDown);

        await sendHumanMessage(from,
`${session.activeDeal.make} ${session.activeDeal.model}
$${newMonthly}/mo with $${newDown} due
(${session.activeDeal.term} mo / ${session.activeDeal.miles})`
        );

        return;
      }
    }

    // ===== INTENT =====
    const budget = extractBudget(msg);
    if (budget) {
      session.min = budget.min;
      session.max = budget.max;
      session.shown = false;
    }

    const type = detectType(msg);
    if (type) {
      session.type = type;
      session.shown = false;
    }

    const brand = detectBrand(msg);
    if (brand) {
      session.brand = brand;
      session.shown = false;
    }

    let deals = await getDeals();

    // ===== FILTER =====
    if (session.min !== undefined && session.max !== undefined) {
      deals = deals.filter(d => d.monthly >= session.min && d.monthly <= session.max);
    }

    if (session.brand) {
      deals = deals.filter(d => d.make.toLowerCase().includes(session.brand));
    }

    if (session.type === "suv") deals = deals.filter(isSUV);
    if (session.type === "truck") deals = deals.filter(isTruck);
    if (session.type === "sedan") deals = deals.filter(isSedan);

    deals.sort((a,b)=>a.monthly-b.monthly);

    // ===== NEED BUDGET =====
    if (!session.max) {
      await sendHumanMessage(from,"what monthly are you trying to stay around?");
      return;
    }

    // ===== SHOW DEALS =====
    if (!session.shown) {

      if (!deals.length) {
        await sendHumanMessage(from,"nothing clean there — let me adjust it for you");
        return;
      }

      const top = deals.slice(0,3);

      let reply = top.map(formatDeal).join("\n\n");

      reply += `\n\nfirst one is what i’d go with`;

      session.activeDeal = top[0];
      session.shown = true;

      await sendHumanMessage(from, reply);
      return;
    }

    // ===== POST-DEAL GUIDANCE =====
    if (session.shown && !session.prompted) {
      session.prompted = true;
      await sendHumanMessage(from,"want me to lock it in or adjust numbers a bit?");
      return;
    }

    // ===== CLOSE =====
    if (/yes|lock|do it|apply/.test(msg)) {
      await sendHumanMessage(from,
`perfect — fill this out and i’ll lock it in:
${APPLICATION_LINK}`);
      return;
    }

    // ===== DEFAULT =====
    await sendHumanMessage(from,"what do you want to adjust — price, car, or payment?");

  } catch (e) {
    console.log("ERROR:", e);
  }
});

module.exports = router;