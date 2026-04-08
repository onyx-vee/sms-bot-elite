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

// 🧠 FIND DEAL
function findDeal(msg, deals) {
  if (!deals) return null;

  msg = msg.toLowerCase();

  return deals.find(d => {
    const name = `${d.make} ${d.model}`.toLowerCase();
    return name.includes(msg) || msg.includes(d.model.toLowerCase());
  });
}

// 🧠 FORMAT DEAL (CLEAN LINE)
function formatDeal(d) {
  return `${d.make} ${d.model} - $${d.monthly}/mo (${d.term}mo / ${d.miles})`;
}

// 🧠 PICK BEST
function pickBest(deals) {
  return [...deals].sort((a, b) => a.monthly - b.monthly).slice(0, 2);
}

router.post("/", async (req, res) => {
  res.sendStatus(200);

  const from = req.body.number;
  const raw = req.body.content || "";

  const msg = raw.split("\n").pop().trim().toLowerCase();

  const session = getSession(from);

  try {
    // 🔥 RESET
    if (/start over|reset/.test(raw.toLowerCase())) {
      Object.keys(session).forEach(k => delete session[k]);

      await sendHumanMessage(from,
        "hey, just so i point you the right way—what are you thinking about?"
      );
      return;
    }

    // 🔥 GREETING (HUMAN)
    if (isGreeting(msg) && !session.started) {
      session.started = true;

      await sendHumanMessage(from,
        "hey, what are you thinking about getting into?"
      );
      return;
    }

    // 🧠 STORE FILTERS
    const budget = extractBudget(msg);
    const brand = detectBrand(msg);

    if (budget) session.budget = budget;
    if (brand) session.brand = brand;

    // 🧠 GET DEALS
    const deals = await getDeals(session);

    if (deals.length) session.lastDeals = deals;

    // 🧠 BRAND REQUEST (BMW, etc)
    if (brand && deals.length) {
      const best = pickBest(deals);

      const list = best.map(formatDeal).join("\n");

      await sendHumanMessage(from,
        `${list}

these are the cleanest ${brand.toUpperCase()} deals right now

want me to dial one in for you?`
      );
      return;
    }

    // 🧠 SPECIFIC CAR
    const selected = findDeal(msg, session.lastDeals);

    if (selected) {
      session.activeDeal = selected;

      await sendHumanMessage(from,
        `${selected.make} ${selected.model}

want the full breakdown on this one?`
      );
      return;
    }

    // 🧠 TERMS / MILES / DUE
    if (/term|months|miles|due|down/.test(msg)) {

      if (!session.activeDeal) {
        await sendHumanMessage(from,
          "which one are you looking at?"
        );
        return;
      }

      const d = session.activeDeal;

      await sendHumanMessage(from,
        `${d.make} ${d.model}
${d.term} months
${d.miles} miles/year
${d.due} due at signing`
      );
      return;
    }

    // 🧠 REFINEMENT (LUXURY)
    if (/luxury|nicer|better|upgrade/.test(msg)) {

      session.budget = Math.max(session.budget || 0, 600);

      const newDeals = await getDeals(session);
      const best = pickBest(newDeals);

      const list = best.map(formatDeal).join("\n");

      await sendHumanMessage(from,
        `${list}

these will feel a lot more premium

i’d lean toward the ${best[0].make} ${best[0].model}

want me to structure it clean?`
      );
      return;
    }

    // 🧠 MAIN SEARCH
    if (isShoppingIntent(msg) && deals.length) {

      const best = pickBest(deals);
      const list = best.map(formatDeal).join("\n");

      await sendHumanMessage(from,
        `${list}

this is what actually makes the most sense right now

i’d go with the ${best[0].make} ${best[0].model}

want me to lock something in or tweak it?`
      );
      return;
    }

    // 🧠 SHOW MORE
    if (/more|all|list/.test(msg)) {

      const chunk = session.lastDeals?.slice(0, 10) || [];
      const list = chunk.map(formatDeal).join("\n");

      await sendHumanMessage(from, list);
      return;
    }

    // 🧠 CLOSE
    if (/yes|ok|do it/.test(msg)) {
      await sendHumanMessage(from,
        "perfect, i’ll get this going\n\nhttps://onyxautocollection.com/1745-2/"
      );
      return;
    }

    // 🧠 FALLBACK (NO LOOPING)
    await sendHumanMessage(from,
      "got you—what kind of car are you leaning toward?"
    );

  } catch (err) {
    console.error("❌ ERROR:", err);
  }
});

module.exports = router;