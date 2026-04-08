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
  const brands = ["bmw","mercedes","audi","lexus","toyota","honda"];
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

// ===== ROUTE =====
router.post("/", async (req, res) => {
  res.sendStatus(200);

  const from = req.body.number || req.body.from;
  const msg = (req.body.content || req.body.text || "").toLowerCase().trim();

  const session = getSession(from);

  try {

    // RESET
    if (/start over/.test(msg)) {
      Object.keys(session).forEach(k=>delete session[k]);
      await sendHumanMessage(from,"starting fresh — what are you trying to get into?");
      return;
    }

    // HELLO
    if (/^hi|hello|hey$/.test(msg)) {
      await sendHumanMessage(from,"what are you trying to get into?");
      return;
    }

    // ===== HANDLE "CHEAP" PROPERLY =====
    if (/cheap|low|budget/.test(msg) && !session.budget) {
      await sendHumanMessage(from,"got you — where do you want to be monthly? like 300, 400, 500?");
      return;
    }

    // ===== BUDGET =====
    const budget = extractBudget(msg);
    if (budget) {
      session.min = budget.min;
      session.max = budget.max;
    }

    // ===== TYPE =====
    const type = detectType(msg);
    if (type) session.type = type;

    // ===== BRAND =====
    const brand = detectBrand(msg);
    if (brand) session.brand = brand;

    let deals = await getDeals();

    // ===== APPLY FILTERS =====
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

    // ===== IF NO BUDGET YET =====
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

    // ===== GUIDE NEXT STEP =====
    if (session.shown && !session.nextStep) {
      session.nextStep = true;
      await sendHumanMessage(from,"want me to lock something in or tweak it a bit?");
      return;
    }

    // ===== CLOSE =====
    if (/yes|lock|do it/.test(msg)) {
      await sendHumanMessage(from, `perfect — fill this out and i’ll lock it in:\n${APPLICATION_LINK}`);
      return;
    }

    // ===== DEFAULT =====
    await sendHumanMessage(from,"what direction do you want to go — suv, sedan, or something specific?");

  } catch (e) {
    console.log("ERROR:", e);
  }
});

module.exports = router;