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
  const from = req.body.number;

  // 🧠 HANDLE MULTI-MESSAGE INPUT (CRITICAL FIX)
  let raw = req.body.content || "";

  const parts = raw
    .split("\n")
    .map(p => p.trim())
    .filter(Boolean);

  const msg = parts.length
    ? parts[parts.length - 1].toLowerCase()
    : "";

  const session = getSession(from);

  try {
    // 🔥 RESET OVERRIDE (ALWAYS WINS)
    if (/start over|reset|restart/.test(raw.toLowerCase())) {
      Object.keys(session).forEach(k => delete session[k]);

      await sendHumanMessage(from, "starting fresh, what are you looking at?");
      return res.sendStatus(200);
    }

    // 🔥 GREETING
    if (isGreeting(msg) && !session.started) {
      session.started = true;

      await sendHumanMessage(from, "hey, what are you looking at right now?");
      return res.sendStatus(200);
    }

    // 🧠 STORE FILTERS
    const budget = extractBudget(msg);
    const brand = detectBrand(msg);

    if (budget) session.budget = budget;
    if (brand) session.brand = brand;

    // 📊 GET DEALS
    const deals = await getDeals(session);

    // 🧠 STORE DEALS
    if (deals.length) {
      session.lastDeals = deals;
    }

    // 🧠 DETECT SPECIFIC CAR
    const mentionedDeal = findMentionedDeal(msg, session.lastDeals);

    if (mentionedDeal) {
      session.activeDeal = mentionedDeal;
    }

    // 🧠 HANDLE DUE AT SIGNING
    if (/due|due at signing|down/.test(msg) && session.activeDeal) {
      await sendHumanMessage(
        from,
        `${session.activeDeal.make} ${session.activeDeal.model}

due at signing is ${session.activeDeal.due}`
      );
      return res.sendStatus(200);
    }

    // 🧠 HANDLE ZERO DOWN
    if (/0 down|zero down/.test(msg) && (session.activeDeal || deals.length)) {
      const deal = session.activeDeal || deals[0];

      const currentDown = Number(
        deal.due.toString().replace(/[^0-9]/g, "")
      );

      const rates = {
        "13": 77,
        "18": 56,
        "24": 42,
        "36": 28,
        "39": 26,
        "48": 21
      };

      const rate = rates[deal.term] || 30;

      const diff = 0 - currentDown;
      const monthlyChange = (diff / 1000) * rate;

      const newPayment = Math.round(deal.monthly - monthlyChange);

      await sendHumanMessage(
        from,
        `${deal.make} ${deal.model}

zero down puts you around $${newPayment}/mo (${deal.term} mo)`
      );
      return res.sendStatus(200);
    }

    // 🧠 ELITE DEAL RESPONSE
    if (isShoppingIntent(msg) && deals.length) {
      const reply = buildEliteResponse(deals, session);

      await sendHumanMessage(from, reply);
      return res.sendStatus(200);
    }

    // 🧠 SOFT CLOSE
    if (/yes|yeah|that works|sounds good/.test(msg) && session.lastDeals?.length) {
      await sendHumanMessage(
        from,
        "perfect, i can lock this in for you\n\nwant me to send over the app?"
      );
      return res.sendStatus(200);
    }

    // 🧠 HARD CLOSE
    if (/app|apply|link/.test(msg)) {
      await sendHumanMessage(
        from,
        "here you go\n\nhttps://onyxautocollection.com/1745-2/"
      );
      return res.sendStatus(200);
    }

    // 🧠 FALLBACK
    await sendHumanMessage(
      from,
      "got you, what kind of car are you thinking about?"
    );

    return res.sendStatus(200);

  } catch (err) {
    console.error("❌ SMS ERROR:", err);
    return res.sendStatus(200);
  }
});

module.exports = router;