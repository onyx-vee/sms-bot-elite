const express = require("express");
const router = express.Router();

const OpenAI = require("openai");

const { sendHumanMessage } = require("../services/messaging");
const { getDeals } = require("../services/deals");
const { getSession } = require("../utils/memory");

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// ========= STRICT FORMAT =========
function formatDeal(d) {
  return `${d.make} ${d.model}
$${d.monthly}/mo
${d.term} mo / ${d.miles}
$${d.due} due`;
}

// ========= HELPERS =========
function extractBudget(msg) {
  const nums = msg.match(/\d{3,4}/g);
  if (!nums) return null;

  if (nums.length >= 2) return { min: +nums[0], max: +nums[1] };
  return { min: 0, max: +nums[0] };
}

function detectType(msg) {
  if (/suv/.test(msg)) return "suv";
  if (/truck/.test(msg)) return "truck";
  return null;
}

function detectTier(msg) {
  if (/luxury|premium/.test(msg)) return "luxury";
  return null;
}

function isLuxury(d) {
  return ["bmw","mercedes","audi","lexus","porsche","genesis"]
    .some(b => d.make.toLowerCase().includes(b));
}

function isSUV(d) {
  const str = `${d.make} ${d.model}`.toLowerCase();

  return [
    "x1","x3","x5","x7",
    "glc","gle","gls",
    "rx","nx","ux",
    "qx","mdx","rdx",
    "cx","rav4","crv","highlander","pilot","tiguan"
  ].some(k => str.includes(k));
}

function extractDown(msg) {
  const m = msg.match(/(\d+)k|(\d{3,5})/);
  if (!m) return null;
  return m[1] ? +m[1]*1000 : +m[2];
}

// ========= PAYMENT =========
function adjustPayment(deal, newDue) {
  const map = {13:77,18:56,24:42,36:28,39:26,48:21};
  const factor = map[+deal.term] || 30;

  const currentDue = +((deal.due || "").replace(/[^0-9]/g,"")) || 0;
  const diff = (currentDue - newDue)/1000;

  return Math.round(deal.monthly + diff*factor);
}

// ========= RANK =========
function rankDeals(deals) {
  return {
    best: deals[Math.floor(deals.length/2)],
    cheapest: deals[0],
    premium: deals[deals.length-1]
  };
}

// ========= AI (LOCKED DOWN) =========
async function aiReply(message, context) {
  const prompt = `
You are a high-end car broker.

Rules:
- 1 sentence max
- no emojis
- no "would you like"
- do NOT mention specific cars or prices
- guide naturally

User: ${message}
Context: ${context}
`;

  const res = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }]
  });

  return res.choices[0].message.content.trim();
}

// ========= ROUTE =========
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
      const ai = await aiReply(msg,"greeting");
      await sendHumanMessage(from, ai);
      return;
    }

    // INTENT
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
    if (session.tier === "luxury") deals = deals.filter(isLuxury);

    deals.sort((a,b)=>a.monthly-b.monthly);

    // NEGOTIATION
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

    // SEARCH (STRICT)
    const isSearch = /what|show|options|deals/.test(msg);

    if ((isSearch || budget) && !session.lastShown) {

      if (!deals.length) {
        await sendHumanMessage(from,"nothing clean there let me rework it");
        return;
      }

      const { best, cheapest, premium } = rankDeals(deals);

      session.activeDeal = best;

      let reply = "";

      reply += `Best value:\n${formatDeal(best)}\n\n`;

      if (cheapest !== best) {
        reply += `Cheapest:\n${formatDeal(cheapest)}\n\n`;
      }

      if (premium !== best) {
        reply += `Premium:\n${formatDeal(premium)}`;
      }

      const ai = await aiReply(msg,"guide");

      reply += `\n\n${ai}`;

      session.lastShown = true;

      await sendHumanMessage(from, reply);
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