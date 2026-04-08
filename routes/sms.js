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

// 🧠 DETECT STYLE
function detectStyle(msg) {
  if (msg.length < 15) return "short";
  if (msg.length > 40) return "detailed";
  return "normal";
}

// 🧠 PICK BEST DEALS
function pickBestDeals(deals) {
  return [...deals].sort((a, b) => a.monthly - b.monthly).slice(0, 2);
}

router.post("/", async (req, res) => {
  res.sendStatus(200); // 🔥 instant response (prevents duplicates)

  const from = req.body.number;

  // 🧠 HANDLE MULTI MESSAGE
  let raw = req.body.content || "";

  const parts = raw.split("\n").map(p => p.trim()).filter(Boolean);
  const msg = parts.length ? parts[parts.length - 1].toLowerCase() : "";

  const session = getSession(from);

  try {
    // 🔥 RESET
    if (/start over|reset|restart/.test(raw.toLowerCase())) {
      Object.keys(session).forEach(k => delete session[k]);

      await sendHumanMessage(from, "starting fresh, what are you looking at?");
      return;
    }

    // 🔥 GREETING (only first time)
    if (isGreeting(msg) && !session.started && !session.lastDeals) {
      session.started = true;

      await sendHumanMessage(from, "hey, what are you looking to get into?");
      return;
    }

    // 🧠 STYLE
    const style = detectStyle(msg);

    // 🧠 REFINEMENT (🔥 THIS FIXES YOUR MAIN ISSUE)
    if (/different|something else|more luxury|luxury|nicer|upgrade|better/.test(msg)) {

      session.luxury = true;

      // bump budget if too low
      if (!session.budget || session.budget < 500) {
        session.budget = 700;
      }

      const deals = await getDeals(session);

      if (!deals.length) {
        await sendHumanMessage(from, "nothing solid there, want me to stretch it a bit?");
        return;
      }

      const [primary, secondary] = pickBestDeals(deals);

      await sendHumanMessage(
        from,
        `${primary.make} ${primary.model} - $${primary.monthly}/mo
${secondary ? `${secondary.make} ${secondary.model} - $${secondary.monthly}/mo\n` : ""}

these are going to feel a lot more premium

if it were me i'd go with the ${primary.make} ${primary.model}

want me to dial this in or get aggressive on pricing?`
      );

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

    // 🧠 DEAL SELECTION
    const mentionedDeal = findMentionedDeal(msg, session.lastDeals);

    if (mentionedDeal) {
      session.activeDeal = mentionedDeal;

      await sendHumanMessage(
        from,
        style === "short"
          ? `${mentionedDeal.make} ${mentionedDeal.model}\nwant numbers?`
          : `got it, ${mentionedDeal.make} ${mentionedDeal.model}\n\nwant me to break it down?`
      );
      return;
    }

    // 🧠 DUE QUESTION
    if (/due|down/.test(msg)) {
      if (!session.activeDeal) {
        await sendHumanMessage(
          from,
          "which one are you looking at?"
        );
        return;
      }

      await sendHumanMessage(
        from,
        `${session.activeDeal.make} ${session.activeDeal.model}\ndue is ${session.activeDeal.due}`
      );
      return;
    }

    // 🧠 DEAL RESPONSE (CORE SELLING LOGIC)
    if (isShoppingIntent(msg) && deals.length) {

      const [primary, secondary] = pickBestDeals(deals);

      let response = "";

      if (style === "short") {
        response = `${primary.make} ${primary.model} $${primary.monthly}`;
        if (secondary) response += `\n${secondary.make} ${secondary.model} $${secondary.monthly}`;
        response += `\nthis is the move\nwant it?`;
      } else {
        response = `${primary.make} ${primary.model} - $${primary.monthly}/mo`;
        if (secondary) response += `\n${secondary.make} ${secondary.model} - $${secondary.monthly}/mo`;

        response += `\n\nthis is what actually makes the most sense`;
        response += `\n\nif it were me i'd go with the ${primary.make} ${primary.model}`;
        response += `\n\nwant me to lock something in or tweak it?`;
      }

      await sendHumanMessage(from, response);
      return;
    }

    // 🧠 SHOW MORE
    if (/more|full list|all/.test(msg)) {
      const chunk = session.lastDeals?.slice(0, 10) || [];

      const list = chunk.map(d =>
        `${d.make} ${d.model} $${d.monthly}`
      ).join("\n");

      await sendHumanMessage(from, list);
      return;
    }

    // 🧠 CLOSE
    if (/yes|yeah|ok|do it/.test(msg)) {
      await sendHumanMessage(
        from,
        "perfect, i'll lock it in\n\nwant the app?"
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