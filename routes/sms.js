const express = require("express");
const router = express.Router();

const { sendHumanMessage } = require("../services/messaging");
const { getDeals } = require("../services/deals");
const { getSession } = require("../utils/memory");

// 🧠 PAYMENT RULES
const leaseAdjust = {
  13: 77,
  18: 56,
  24: 42,
  36: 28,
  39: 26,
  48: 21
};

// 🧠 FORMAT DEAL
function formatDeal(d) {
  return `${d.make} ${d.model}
$${d.monthly}/mo
${d.term} mo / ${d.miles}
${d.due} due`;
}

// 🧠 PICK BEST
function pickBest(deals) {
  return [...deals].sort((a, b) => a.monthly - b.monthly).slice(0, 2);
}

// 🧠 FIND DEAL
function findDeal(msg, deals) {
  if (!deals) return null;

  msg = msg.toLowerCase();

  return deals.find(d =>
    msg.includes(d.model.toLowerCase()) ||
    msg.includes(`${d.make} ${d.model}`.toLowerCase())
  );
}

// 🧠 PARSE MONEY
function extractMoney(msg) {
  const match = msg.match(/\$?(\d{3,5})/);
  return match ? Number(match[1]) : null;
}

// 🧠 CALCULATE PAYMENT
function adjustPayment(deal, newDown) {
  const currentDown = Number(deal.due.replace(/[^0-9]/g, ""));
  const diff = newDown - currentDown;

  const factor = leaseAdjust[deal.term] || 30;

  const delta = Math.round((diff / 1000) * factor);

  return deal.monthly - delta;
}

router.post("/", async (req, res) => {
  res.sendStatus(200);

  const from = req.body.number;
  const raw = req.body.content || "";
  const msg = raw.split("\n").pop().trim().toLowerCase();

  const session = getSession(from);

  try {
    // RESET
    if (/start over|reset/.test(msg)) {
      Object.keys(session).forEach(k => delete session[k]);

      await sendHumanMessage(from,
        "let’s reset—what are you thinking about getting into?"
      );
      return;
    }

    // GREETING
    if (/^hi|hello|hey$/.test(msg) && !session.started) {
      session.started = true;

      await sendHumanMessage(from,
        "hey—what are you looking to get into?"
      );
      return;
    }

    // BUDGET
    const budget = extractMoney(msg);
    if (budget && msg.includes("month")) {
      session.budget = budget;
    }

    // GET DEALS
    const deals = await getDeals(session);
    if (deals.length) session.lastDeals = deals;

    // SELECT CAR
    const selected = findDeal(msg, session.lastDeals);
    if (selected) {
      session.activeDeal = selected;

      await sendHumanMessage(from,
        `${selected.make} ${selected.model}

clean deal—want numbers broken down?`
      );
      return;
    }

    // NEGOTIATION (DOWN PAYMENT)
    if (/down|due/.test(msg)) {

      if (!session.activeDeal) {
        await sendHumanMessage(from, "which car?");
        return;
      }

      const newDown = extractMoney(msg);

      if (!newDown && /0/.test(msg)) {
        const newPayment = adjustPayment(session.activeDeal, 0);

        await sendHumanMessage(from,
          `${session.activeDeal.make} ${session.activeDeal.model}

0 down lands around $${newPayment}/mo`
        );
        return;
      }

      if (newDown) {
        const newPayment = adjustPayment(session.activeDeal, newDown);

        await sendHumanMessage(from,
          `${session.activeDeal.make} ${session.activeDeal.model}

with $${newDown} down you're around $${newPayment}/mo`
        );
        return;
      }

      // default info
      const d = session.activeDeal;

      await sendHumanMessage(from,
        `${d.make} ${d.model}
${d.term} mo
${d.miles} miles
${d.due} due`
      );

      return;
    }

    // LOWER PAYMENT INTENT
    if (/lower|cheaper/.test(msg)) {

      if (!session.activeDeal) return;

      const d = session.activeDeal;

      const newPayment = adjustPayment(d, 4000);

      await sendHumanMessage(from,
        `we can get that down to about $${newPayment}/mo with around $4k down

want me to structure it clean?`
      );

      return;
    }

    // MAIN SEARCH
    if (/under|month|deal|options/.test(msg)) {

      const best = pickBest(deals);

      await sendHumanMessage(from,
        best.map(formatDeal).join("\n\n")
      );

      return;
    }

    // SHOW MORE
    if (/more|all/.test(msg)) {
      const chunk = session.lastDeals?.slice(0, 8) || [];

      await sendHumanMessage(from,
        chunk.map(formatDeal).join("\n\n")
      );

      return;
    }

    // CLOSE
    if (/yes|ok|do it/.test(msg)) {
      await sendHumanMessage(from,
        "perfect—i’ll get this going\n\nhttps://onyxautocollection.com/1745-2/"
      );
      return;
    }

    // DEFAULT
    await sendHumanMessage(from,
      "what kind of car are you leaning toward?"
    );

  } catch (err) {
    console.error("❌ ERROR:", err);
  }
});

module.exports = router;