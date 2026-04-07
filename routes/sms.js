const express = require("express");
const router = express.Router();

const { sendHumanMessage } = require("../services/messaging");
const { getDeals } = require("../services/deals");
const { buildEliteResponse } = require("../services/closer");
const { getSession } = require("../utils/memory");
const {
  extractBudget,
  detectBrand,
  isGreeting,
  isReset,
  isShoppingIntent
} = require("../utils/detectors");

// 🧠 FIND DEAL FROM MESSAGE
function findMentionedDeal(msg, deals) {
  if (!deals) return null;

  msg = msg.toLowerCase();

  return deals.find(d => {
    const full = `${d.make} ${d.model}`.toLowerCase();
    return (
      msg.includes(d.model.toLowerCase()) ||
      msg.includes(full)
    );
  });
}

router.post("/", async (req, res) => {
  const msg = req.body.content.toLowerCase();
  const from = req.body.number;

  const session = getSession(from);

  // RESET
  if (isReset(msg)) {
    Object.keys(session).forEach(k => delete session[k]);
    return sendHumanMessage(from, "starting fresh, what are you looking at?");
  }

  // GREETING
  if (isGreeting(msg) && !session.started) {
    session.started = true;
    return sendHumanMessage(from, "hey, what are you looking at right now?");
  }

  // STORE FILTERS
  const budget = extractBudget(msg);
  const brand = detectBrand(msg);

  if (budget) session.budget = budget;
  if (brand) session.brand = brand;

  // GET DEALS
  const deals = await getDeals(session);

  // STORE DEALS IN MEMORY
  if (deals.length) {
    session.lastDeals = deals;
  }

  // 🧠 DETECT IF USER REFERENCED A SPECIFIC CAR
  const mentionedDeal = findMentionedDeal(msg, session.lastDeals);

  if (mentionedDeal) {
    session.activeDeal = mentionedDeal;
  }

  // 🧠 HANDLE "DUE AT SIGNING"
  if (/due|due at signing|down/.test(msg) && session.activeDeal) {
    return sendHumanMessage(
      from,
      `${session.activeDeal.make} ${session.activeDeal.model}

due at signing is ${session.activeDeal.due}`
    );
  }

  // 🧠 HANDLE ZERO DOWN / NEGOTIATION
  if (/0 down|zero down/.test(msg) && (session.activeDeal || deals.length)) {
    const deal = session.activeDeal || deals[0];

    const currentDown = Number(
      deal.due.toString().replace(/[^0-9]/g, "")
    );

    const term = deal.term;

    const rates = {
      "13": 77,
      "18": 56,
      "24": 42,
      "36": 28,
      "39": 26,
      "48": 21
    };

    const rate = rates[term] || 30;

    const diff = 0 - currentDown;
    const monthlyChange = (diff / 1000) * rate;

    const newPayment = Math.round(deal.monthly - monthlyChange);

    return sendHumanMessage(
      from,
      `${deal.make} ${deal.model}

zero down puts you around $${newPayment}/mo (${deal.term} mo)`
    );
  }

  // 🧠 ELITE DEAL RESPONSE
  if (isShoppingIntent(msg) && deals.length) {
    const reply = buildEliteResponse(deals, session);
    return sendHumanMessage(from, reply);
  }

  // 🧠 SOFT CLOSE
  if (/yes|yeah|that works|sounds good/.test(msg) && session.lastDeals?.length) {
    return sendHumanMessage(
      from,
      "perfect, i can lock this in for you\n\nwant me to send over the app?"
    );
  }

  // 🧠 HARD CLOSE
  if (/app|apply|link/.test(msg)) {
    return sendHumanMessage(
      from,
      "here you go\n\nhttps://onyxautocollection.com/1745-2/"
    );
  }

  // 🧠 FALLBACK
  return sendHumanMessage(
    from,
    "got you, what kind of car are you thinking about?"
  );
});

module.exports = router;