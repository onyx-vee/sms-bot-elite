const express = require("express");
const router = express.Router();

const OpenAI = require("openai");
const { sendHumanMessage } = require("../services/messaging");
const { getDeals } = require("../services/deals");
const { getSession } = require("../utils/memory");

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

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

function detectBrand(msg) {
  const brands = ["bmw","mercedes","audi","lexus","toyota","honda","nissan","mazda"];
  return brands.find(b => msg.includes(b));
}

function detectType(msg) {
  if (/sedan/.test(msg)) return "sedan";
  if (/suv/.test(msg)) return "suv";
  if (/truck/.test(msg)) return "truck";
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

// ===== NEGOTIATION =====
function adjustPayment(deal, newDue) {
  const map = {13:77,18:56,24:42,36:28,39:26,48:21};
  const factor = map[+deal.term] || 30;

  const currentDue = +((deal.due || "").replace(/[^0-9]/g,"")) || 0;
  const diff = (currentDue - newDue)/1000;

  return Math.round(deal.monthly + diff*factor);
}

// ===== AI =====
async function aiReply(message, context) {
  const prompt = `
You are a high-end car broker in Los Angeles.

Tone:
- smooth
- confident
- efficient
- never robotic
- never dismissive

Rules:
- 1 short sentence
- no emojis
- no pricing
- guide the deal forward

Behavior:
- If user says cheap/budget → convert to monthly
- Keep control of conversation
- Always move toward a deal

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
      await sendHumanMessage(from,"starting fresh — what are you thinking?");
      return;
    }

    let deals = await getDeals();

    // ===== BRAND PRIORITY =====
    const brand = detectBrand(msg);

    if (brand) {
      deals = deals.filter(d => d.make.toLowerCase().includes(brand));

      if (!deals.length) {
        await sendHumanMessage(from,"i’ll check what i can source for that and circle back");
        return;
      }

      deals.sort((a,b)=>a.monthly-b.monthly);

      const top = deals.slice(0,3);

      let reply = top.map(formatDeal).join("\n\n");

      await sendHumanMessage(from, reply);

      session.activeDeal = top[0];
      return;
    }

    // ===== BUDGET =====
    const budget = extractBudget(msg);

    if (budget) {
      session.min = budget.min;
      session.max = budget.max;
      session.lastShown = false;
    }

    // ===== TYPE =====
    const type = detectType(msg);
    if (type) {
      session.type = type;
      session.lastShown = false;
    }

    // ===== FILTER =====
    if (session.min !== undefined && session.max !== undefined) {
      deals = deals.filter(d => d.monthly >= session.min && d.monthly <= session.max);
    }

    if (session.type === "suv") deals = deals.filter(isSUV);
    if (session.type === "truck") deals = deals.filter(isTruck);
    if (session.type === "sedan") deals = deals.filter(isSedan);

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
        await sendHumanMessage(from,"nothing clean there — let me tighten it up for you");
        return;
      }

      const top = deals.slice(0,3);

      let reply = top.map(formatDeal).join("\n\n");

      reply += `\n\nfirst one is the strongest value`;

      session.activeDeal = top[0];
      session.lastShown = true;

      await sendHumanMessage(from, reply);
      return;
    }

    // ===== CLOSE =====
    if (/ready|lock|apply/.test(msg)) {
      await sendHumanMessage(from, `perfect — fill this out and i’ll lock it in:\n${APPLICATION_LINK}`);
      return;
    }

    // ===== DEFAULT =====
    const ai = await aiReply(msg,"conversation");
    await sendHumanMessage(from, ai);

  } catch (e) {
    console.log("ERROR:", e);
  }
});

module.exports = router;