const express = require("express");
const router = express.Router();

const OpenAI = require("openai");
const { sendHumanMessage } = require("../services/messaging");
const { getDeals } = require("../services/deals");
const { getSession } = require("../utils/memory");

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// ===== CONFIG =====
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
  if (/sedan/.test(msg)) return "sedan";
  if (/suv/.test(msg)) return "suv";
  if (/truck/.test(msg)) return "truck";
  return null;
}

function detectTier(msg) {
  if (/luxury|premium/.test(msg)) return "luxury";
  return null;
}

function extractDown(msg) {
  const m = msg.match(/(\d+)k|(\d{3,5})/);
  if (!m) return null;
  return m[1] ? +m[1]*1000 : +m[2];
}

// ===== FILTERS =====
function isSUV(d) {
  return /x|gl|rx|nx|qx|cx|rav4|crv|pilot|tiguan|highlander/.test(
    `${d.make} ${d.model}`.toLowerCase()
  );
}

function isTruck(d) {
  return /tacoma|tundra|f150|ram|silverado|frontier/.test(
    d.model.toLowerCase()
  );
}

function isSedan(d) {
  return !isSUV(d) && !isTruck(d);
}

function isLuxury(d) {
  return ["bmw","mercedes","audi","lexus","genesis","porsche"]
    .includes(d.make.toLowerCase());
}

// ===== RANKING =====
function scoreDeal(d) {
  let score = 0;

  score += (1000 - d.monthly);

  const due = Number((d.due || "").replace(/[^0-9]/g,"")) || 0;
  score += (5000 - due) / 10;

  if (Number(d.term) === 36) score += 200;

  return score;
}

function rankDeals(deals) {
  const sortedScore = [...deals].sort((a,b)=>scoreDeal(b)-scoreDeal(a));

  return {
    best: sortedScore[0],
    cheapest: deals[0],
    premium: deals[deals.length - 1]
  };
}

// ===== NEGOTIATION =====
function adjustPayment(deal, newDue) {
  const map = {13:77,18:56,24:42,36:28,39:26,48:21};
  const factor = map[+deal.term] || 30;

  const currentDue = +((deal.due || "").replace(/[^0-9]/g,"")) || 0;
  const diff = (currentDue - newDue)/1000;

  return Math.round(deal.monthly + diff*factor);
}

// ===== AI (STRICT) =====
async function aiReply(message, context) {
  const prompt = `
You are a high-end car broker.

Rules:
- 1 sentence
- no emojis
- no car names
- no pricing

User: ${message}
Context: ${context}
`;

  const res = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }]
  });

  return res.choices[0].message.content.trim();
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
      await sendHumanMessage(from,"starting fresh what are you thinking");
      return;
    }

    // GREETING
    if (/^hi|hello|hey$/.test(msg)) {
      const ai = await aiReply(msg,"greet");
      await sendHumanMessage(from, ai);
      return;
    }

    // ===== LEAD CAPTURE =====
    if (!session.name && msg.length < 25 && /^[a-z\s]+$/.test(msg)) {
      session.name = msg;
      await sendHumanMessage(from, "got it — what zip are you in?");
      return;
    }

    if (!session.zip && /\d{5}/.test(msg)) {
      session.zip = msg.match(/\d{5}/)[0];
    }

    // ===== INTENT =====
    const budget = extractBudget(msg);
    const type = detectType(msg);
    const tier = detectTier(msg);

    if (budget) {
      session.min = budget.min;
      session.max = budget.max;
      session.lastShown = false;
    }

    if (type) {
      session.type = type;
      session.lastShown = false;
    }

    if (tier) {
      session.tier = tier;
      session.lastShown = false;
    }

    let deals = await getDeals();

    // FILTER
    if (session.min !== undefined && session.max !== undefined) {
      deals = deals.filter(d => d.monthly >= session.min && d.monthly <= session.max);
    }

    if (session.type === "suv") deals = deals.filter(isSUV);
    if (session.type === "truck") deals = deals.filter(isTruck);
    if (session.type === "sedan") deals = deals.filter(isSedan);

    if (session.tier === "luxury") deals = deals.filter(isLuxury);

    deals.sort((a,b)=>a.monthly-b.monthly);

    // ===== NEGOTIATION =====
    if (/down|put/.test(msg) && session.activeDeal) {
      const down = extractDown(msg);

      if (down) {
        const newMonthly = adjustPayment(session.activeDeal, down);

        const reply = `${session.activeDeal.make} ${session.activeDeal.model}

$${newMonthly}/mo with $${down} due

(${session.activeDeal.term} mo / ${session.activeDeal.miles})`;

        await sendHumanMessage(from, reply);
        return;
      }
    }

    // ===== SEARCH =====
    const isSearch = /what|show|options|deals/.test(msg);

    if ((isSearch || budget) && !session.lastShown) {

      if (!deals.length) {
        await sendHumanMessage(from,"nothing clean in that lane i’ll rework it");
        return;
      }

      const { best, cheapest, premium } = rankDeals(deals);

      let reply = "";

      reply += `Best value:\n${formatDeal(best)}\n\n`;

      if (cheapest !== best) {
        reply += `Cheapest:\n${formatDeal(cheapest)}\n\n`;
      }

      if (premium !== best) {
        reply += `Premium:\n${formatDeal(premium)}`;
      }

      reply += `\n\nthis first one is what i’d lean toward`;

      session.activeDeal = best;
      session.lastShown = true;

      await sendHumanMessage(from, reply);
      return;
    }

    // ===== CLOSE =====
    if (/ready|lets do it|lock|apply/.test(msg)) {
      await sendHumanMessage(from, `perfect — fill this out and i’ll take it from there:\n${APPLICATION_LINK}`);
      return;
    }

    // DEFAULT
    const ai = await aiReply(msg,"conversation");
    await sendHumanMessage(from, ai);

  } catch (e) {
    console.log("ERROR:", e);
  }
});

module.exports = router;