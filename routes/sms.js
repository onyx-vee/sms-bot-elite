const express = require("express");
const router = express.Router();

const { sendHumanMessage } = require("../services/messaging");
const { getDeals } = require("../services/deals");
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
  // 🔥 respond immediately (prevents webhook retries)
  res.sendStatus(200);

  const from = req.body.number;

  // 🧠 MULTI-MESSAGE FIX
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
    // 🔥 RESET (always wins)
    if (/start over|reset|restart/.test(raw.toLowerCase())) {
      Object.keys(session).forEach(k => delete session[k]);

      await sendHumanMessage(from, "starting fresh, what are you looking at?");
      return;
    }

    // 🔥 GREETING
    if (isGreeting(msg) && !session.started) {
      session.started = true;

      await sendHumanMessage(from, "hey, what are you looking to get into?");
      return;
    }

    // 🧠 DETECT NEW SEARCH → reset context
    if (/under|budget|monthly|deal|options/.test(msg)) {
      delete session.activeDeal;
    }

    // 🧠 STORE FILTERS
    const budget = extractBudget(msg);
    const brand = detectBrand(msg);

    if (budget) {
      session.budget = budget;

      // 🔥 force fresh results
      delete session.lastDeals;
      delete session.activeDeal;
    }

    if (brand) {
      session.brand = brand;
    }

    // 📊 GET DEALS
    const deals = await getDeals(session);

    if (deals.length) {
      session.lastDeals = deals;
    }

    // 🧠 DETECT SPECIFIC CAR
    const mentionedDeal = findMentionedDeal(msg, session.lastDeals);

    if (mentionedDeal) {
      session.activeDeal = mentionedDeal;

      await sendHumanMessage(
        from,
        `got it, you're looking at the ${mentionedDeal.make} ${mentionedDeal.model}

want me to break down numbers on that?`
      );
      return;
    }

    // 🧠 HANDLE DUE QUESTION
    if (/due|due at signing|down/.test(msg)) {

      if (!session.activeDeal) {
        await sendHumanMessage(
          from,
          "which one are you looking at? i’ll break down the exact numbers for you"
        );
        return;
      }

      await sendHumanMessage(
        from,
        `${session.activeDeal.make} ${session.activeDeal.model}

due at signing is ${session.activeDeal.due}`
      );
      return;
    }

    // 🧠 HANDLE ZERO DOWN
    if (/0 down|zero down/.test(msg)) {
      const deal = session.activeDeal || session.lastDeals?.[0];

      if (!deal) {
        await sendHumanMessage(from, "what car are you looking at?");
        return;
      }

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
      return;
    }

    // 🧠 DEAL SEARCH RESPONSE
    if (isShoppingIntent(msg) && deals.length) {

      const topDeals = deals.slice(0, 5);

      const list = topDeals.map(d =>
        `${d.make} ${d.model} - $${d.monthly}/mo`
      ).join("\n");

      await sendHumanMessage(
        from,
        `${list}

there are ${deals.length} total options in that range

want me to narrow it down or show you something specific?`
      );

      return;
    }

    // 🧠 SOFT CLOSE
    if (/yes|yeah|that works|sounds good/.test(msg)) {
      await sendHumanMessage(
        from,
        "perfect, i can line something up for you\n\nwant me to send over the app?"
      );
      return;
    }

    // 🧠 HARD CLOSE
    if (/app|apply|link/.test(msg)) {
      await sendHumanMessage(
        from,
        "here you go\n\nhttps://onyxautocollection.com/1745-2/"
      );
      return;
    }

    // 🧠 FALLBACK
    await sendHumanMessage(
      from,
      "got you, what kind of car are you thinking about?"
    );

  } catch (err) {
    console.error("❌ SMS ERROR:", err);
  }
});

module.exports = router;