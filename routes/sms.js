const express = require("express");
const router = express.Router();

const OpenAI = require("openai");

const { sendHumanMessage } = require("../services/messaging");
const { getDeals } = require("../services/deals");
const { getSession } = require("../utils/memory");

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// 🧠 FORMAT DEALS
function formatDeals(deals) {
  return deals.map(d => {
    return `${d.make} ${d.model}
$${d.monthly}/mo
${d.term} mo / ${d.miles}
${d.due} due`;
  }).join("\n\n\n");
}

// 🧠 BUDGET
function extractBudget(msg) {
  const nums = msg.match(/\d{3,4}/g);
  if (!nums) return null;

  if (nums.length >= 2) {
    return { min: Number(nums[0]), max: Number(nums[1]) };
  }

  return { min: 0, max: Number(nums[0]) };
}

// 🧠 TYPE
function detectType(msg) {
  if (/suv|crossover/.test(msg)) return "suv";
  if (/truck|pickup/.test(msg)) return "truck";
  return null;
}

// 🧠 LUXURY
function detectTier(msg) {
  if (/luxury|premium|nice|higher end/.test(msg)) return "luxury";
  return null;
}

function isLuxury(d) {
  const str = `${d.make} ${d.model}`.toLowerCase();
  return [
    "bmw","mercedes","benz","audi","lexus",
    "infiniti","acura","genesis","porsche"
  ].some(k => str.includes(k));
}

// 🧠 TYPE FILTERS
function isSUV(d) {
  const str = `${d.make} ${d.model}`.toLowerCase();
  return [
    "cx","rav4","crv","pilot","tiguan",
    "x1","x3","x5","x7",
    "glc","gle","rx","nx","qx","ux",
    "mdx","rdx","highlander","explorer"
  ].some(k => str.includes(k));
}

function isTruck(d) {
  const str = `${d.make} ${d.model}`.toLowerCase();
  return [
    "tacoma","tundra","frontier",
    "silverado","ram","f150"
  ].some(k => str.includes(k));
}

// 🧠 BRAND
function detectBrand(msg) {
  const brands = ["bmw","mercedes","benz","audi","lexus"];
  return brands.find(b => msg.includes(b)) || null;
}

// 🧠 MEMORY
function updateMemory(session, user, bot) {
  if (!session.history) session.history = [];
  session.history.push({ user, bot });
  if (session.history.length > 3) session.history.shift();
}

// 🧠 AI
async function aiReply(message, context, history) {
  const convo = history?.map(h => `User: ${h.user}\nBroker: ${h.bot}`).join("\n\n") || "";

  const prompt = `
You are a high-end car broker texting.

Rules:
- 1-2 lines max
- no emojis
- no listing cars
- guide naturally

${convo}

Context: ${context}

User: ${message}
`;

  const res = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }]
  });

  return res.choices[0].message.content.trim();
}

// 🧠 RANKING
function rankDeals(deals, session) {
  function score(d) {
    let s = 0;

    s += (1000 - d.monthly);

    const due = Number((d.due || "").toString().replace(/[^0-9]/g, "")) || 0;
    s += (5000 - due) / 10;

    if (Number(d.term) === 36) s += 200;

    if (session.tier === "luxury" && isLuxury(d)) s += 300;

    if (session.brand && d.make.toLowerCase().includes(session.brand)) s += 400;

    return s;
  }

  const sorted = [...deals].sort((a,b)=>score(b)-score(a));

  return {
    bestValue: sorted[0],
    cheapest: [...deals].sort((a,b)=>a.monthly-b.monthly)[0],
    premium: [...deals].sort((a,b)=>b.monthly-a.monthly)[0]
  };
}

// 🧠 NEGOTIATION
function adjustPayment(deal, newDue) {
  const term = Number(deal.term);

  const map = {
    13:77,18:56,24:42,36:28,39:26,48:21
  };

  const factor = map[term] || 30;

  const currentDue = Number((deal.due || "").replace(/[^0-9]/g,"")) || 0;
  const diff = (newDue - currentDue) / 1000;

  return Math.round(deal.monthly - (diff * factor));
}

function extractDown(msg) {
  const m = msg.match(/(\d+)k|(\d{3,5})/);
  if (!m) return null;
  return m[1] ? Number(m[1]) * 1000 : Number(m[2]);
}

router.post("/", async (req, res) => {
  res.sendStatus(200);

  const from = req.body.number || req.body.from;
  const msg = (req.body.content || req.body.text || "").toLowerCase();

  const session = getSession(from);

  try {

    // RESET
    if (/start over/.test(msg)) {
      Object.keys(session).forEach(k=>delete session[k]);
      await sendHumanMessage(from, "starting fresh — what are you looking for?");
      return;
    }

    // GREETING
    if (/^hi|hello|hey$/.test(msg)) {
      const ai = await aiReply(msg,"greet naturally",session.history);
      await sendHumanMessage(from, ai);
      updateMemory(session,msg,ai);
      return;
    }

    // INTENT
    const budget = extractBudget(msg);
    const type = detectType(msg);
    const tier = detectTier(msg);
    const brand = detectBrand(msg);

    if (budget){ session.min=budget.min; session.max=budget.max; session.lastShown=false;}
    if (type){ session.type=type; session.lastShown=false;}
    if (tier){ session.tier=tier; session.lastShown=false;}
    if (brand){ session.brand=brand; session.lastShown=false;}

    let deals = await getDeals();

    // FILTERS
    if (session.min!==undefined && session.max!==undefined){
      deals = deals.filter(d=>d.monthly>=session.min && d.monthly<=session.max);
    }

    if (session.type==="suv") deals = deals.filter(isSUV);
    if (session.type==="truck") deals = deals.filter(isTruck);
    if (session.tier==="luxury") deals = deals.filter(isLuxury);

    // NEGOTIATION
    if (/down|due|put/.test(msg) && session.activeDeal){
      const down = extractDown(msg);
      if (down){
        const newMonthly = adjustPayment(session.activeDeal, down);
        const reply = `${session.activeDeal.make} ${session.activeDeal.model}

$${newMonthly}/mo with $${down} due

(${session.activeDeal.term} mo / ${session.activeDeal.miles})`;

        await sendHumanMessage(from, reply);
        updateMemory(session,msg,reply);
        return;
      }
    }

    // DEAL SEARCH
    const isSearch = /deal|options|what do you have|available/.test(msg);

    if ((isSearch || budget || type || tier || brand) && !session.lastShown){

      if (!deals.length){
        await sendHumanMessage(from,"nothing clean there — i’ll follow up with better options");
        return;
      }

      const {bestValue,cheapest,premium} = rankDeals(deals,session);

      session.activeDeal = bestValue;

      const sections = [
        `Best value:\n${formatDeals([bestValue])}`,
        `Cheapest:\n${formatDeals([cheapest])}`,
        `Premium:\n${formatDeals([premium])}`
      ].join("\n\n");

      const ai = await aiReply(msg,"guide toward best deal",session.history);

      const reply = sections + "\n\n" + ai;

      session.lastShown=true;

      await sendHumanMessage(from, reply);
      updateMemory(session,msg,reply);
      return;
    }

    // DEFAULT
    const ai = await aiReply(msg,"continue conversation",session.history);
    await sendHumanMessage(from, ai);
    updateMemory(session,msg,ai);

  } catch(e){
    console.log("ERROR:",e);
  }
});

module.exports = router;