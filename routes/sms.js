
const express = require("express");
const router = express.Router();

const { sendHumanMessage } = require("../services/messaging");
const { getDeals } = require("../services/deals");
const { buildEliteResponse } = require("../services/closer");
const { getSession } = require("../utils/memory");
const { extractBudget, detectBrand, isGreeting, isReset, isShoppingIntent } = require("../utils/detectors");

router.post("/", async (req, res) => {
  const msg = req.body.content.toLowerCase();
  const from = req.body.number;

  const session = getSession(from);

  if (isReset(msg)) {
    return sendHumanMessage(from, "starting fresh, what are you looking at?");
  }

  if (isGreeting(msg) && !session.started) {
    session.started = true;
    return sendHumanMessage(from, "hey, what are you looking at right now?");
  }

  const budget = extractBudget(msg);
  const brand = detectBrand(msg);

  if (budget) session.budget = budget;
  if (brand) session.brand = brand;

  const deals = await getDeals(session);

  if (isShoppingIntent(msg) && deals.length) {
    return sendHumanMessage(from, buildEliteResponse(deals));
  }

  if (/yes|yeah|works/.test(msg)) {
    return sendHumanMessage(from, "perfect, want me to send the app?");
  }

  if (/app|apply|link/.test(msg)) {
    return sendHumanMessage(from, "https://onyxautocollection.com/1745-2/");
  }

  return sendHumanMessage(from, "got you, what kind of car are you thinking?");
});

module.exports = router;
