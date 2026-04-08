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
    return msg.includes(d.model.toLowerCase()) || msg.includes(full);
  });
}

// 🧠 DETECT BUYER TYPE
function detectBuyerType(msg, session) {
  const luxuryBrands = ["bmw", "mercedes", "audi", "lexus", "porsche"];

  if (luxuryBrands.some(b => msg.includes(b))) return "luxury";

  if (session.budget && session.budget <= 400) return "budget";
  if (session.budget && session.budget >= 700) return "luxury";

  return "standard";
}

// 🧠 DETECT PERSONALITY
function detectStyle(msg) {
  if (msg.length < 15) return "short";
  if (msg.includes("?") && msg.length > 25) return "curious";
  if (msg.length > 40) return "detailed";
  return "normal";
}

// 🧠 BUILD RESPONSE BASED ON STYLE
function buildResponse({ primary, secondary, buyerType, style }) {

  const short = style === "short";

  let res = "";

  // DEALS
  if (short) {
    res += `${primary.make} ${primary.model} $${primary.monthly}`;
    if (secondary) {
      res += `\n${secondary.make} ${secondary.model} $${secondary.monthly}`;
    }
  } else {
    res += `${primary.make} ${primary.model} - $${primary.monthly}/mo`;
    if (secondary) {
      res += `\n${secondary.make} ${secondary.model} - $${secondary.monthly}/mo`;
    }
  }

  // TONE
  if (buyerType === "luxury") {
    res += short
      ? `\nbest option rn`
      : `\n\nthese are the cleanest options right now\nif it were me i'd go with the ${primary.make} ${primary.model}`;
  }

  else if (buyerType === "budget") {
    res += short
      ? `\nbest value`
      : `\n\nthese are the strongest value deals right now\n${primary.make} ${primary.model} is the best bang for your money`;
  }

  else {
    res += short
      ? `\nthis is the move`
      : `\n\nthis is what actually makes the most sense\nif it were me i'd go with the ${primary.make} ${primary.model}`;
  }

  // CLOSE
  res += short
    ? `\nwant it?`
    : `\n\ndoes that feel right or want something different?`;

  return res;
}

router.post("/", async (req, res) => {
  res.sendStatus(200); // 🔥 instant webhook response

  const from = req.body.number;

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
    // 🔥 RESET
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

    // 🧠 NEW SEARCH RESET
    if (/under|budget|monthly|deal|options/.test(msg)) {
      delete session.activeDeal;
    }

    // 🧠 STORE FILTERS
    const budget = extractBudget(msg);
    const brand = detectBrand(msg);

    if (budget) {
      session.budget = budget;
      delete session.lastDeals;
      delete session.activeDeal;
    }

    if (brand) session.brand = brand;

    // 📊 GET DEALS
    const deals = await getDeals(session);

    if (deals.length) session.lastDeals = deals;

    // 🧠 STYLE + BUYER TYPE
    const style = detectStyle(msg);
    const buyerType = detectBuyerType(msg, session);

    // 🧠 CAR MATCH
    const mentionedDeal = findMentionedDeal(msg, session.lastDeals);

    if (mentionedDeal) {
      session.activeDeal = mentionedDeal;

      const reply = style === "short"
        ? `${mentionedDeal.make} ${mentionedDeal.model}\nwant numbers?`
        : `got it, you're looking at the ${mentionedDeal.make} ${mentionedDeal.model}\n\nwant me to break down numbers on it?`;

      await sendHumanMessage(from, reply);
      return;
    }

    // 🧠 DUE QUESTION
    if (/due|down/.test(msg)) {
      if (!session.activeDeal) {
        await sendHumanMessage(from,
          style === "short"
            ? "which one?"
            : "which one are you looking at? i’ll break it down for you"
        );
        return;
      }

      await sendHumanMessage(
        from,
        `${session.activeDeal.make} ${session.activeDeal.model}\ndue is ${session.activeDeal.due}`
      );
      return;
    }

    // 🧠 ZERO DOWN
    if (/0 down|zero down/.test(msg)) {
      const deal = session.activeDeal || session.lastDeals?.[0];
      if (!deal) return;

      const down = Number(deal.due.replace(/[^0-9]/g, ""));
      const newPayment = deal.monthly + Math.round(down / 36);

      await sendHumanMessage(
        from,
        `${deal.make} ${deal.model}\n0 down ~ $${newPayment}/mo`
      );
      return;
    }

    // 🧠 DEAL RESPONSE (ELITE + ADAPTIVE)
    if (isShoppingIntent(msg) && deals.length) {
      const sorted = [...deals].sort((a, b) => a.monthly - b.monthly);
      const primary = sorted[0];
      const secondary = sorted[1];

      const reply = buildResponse({
        primary,
        secondary,
        buyerType,
        style
      });

      await sendHumanMessage(from, reply);
      return;
    }

    // 🧠 SHOW MORE
    if (/full list|all|more/.test(msg)) {
      const chunk = session.lastDeals?.slice(0, 10) || [];

      const list = chunk.map(d =>
        `${d.make} ${d.model} $${d.monthly}`
      ).join("\n");

      await sendHumanMessage(from, list);
      return;
    }

    // 🧠 CLOSE
    if (/yes|yeah|ok/.test(msg)) {
      await sendHumanMessage(
        from,
        "perfect, i’ll lock it in\n\nwant the app?"
      );
      return;
    }

    if (/app|apply/.test(msg)) {
      await sendHumanMessage(
        from,
        "https://onyxautocollection.com/1745-2/"
      );
      return;
    }

    // 🧠 FALLBACK
    await sendHumanMessage(
      from,
      style === "short"
        ? "what are you thinking?"
        : "what kind of car are you looking for?"
    );

  } catch (err) {
    console.error("❌ SMS ERROR:", err);
  }
});

module.exports = router;