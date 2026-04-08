const express = require("express");
const router = express.Router();

const OpenAI = require("openai");

const { sendHumanMessage } = require("../services/messaging");
const { getDeals } = require("../services/deals");
const { getSession } = require("../utils/memory");

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// ===== HELPERS =====

function formatDeal(d) {
  return `${d.make} ${d.model}

$${d.monthly}/mo
${d.term} mo / ${d.miles}

$${d.due} due`;
}

function extractBudget(msg) {
  const nums = msg.match(/\d{3,4}/g);
  if (!nums) return null;

  if (nums.length >= 2) {
    return { min: Number(nums[0]), max: Number(nums[1]) };
  }

  return { min: 0, max: Number(nums[0]) };
}

function detectType(msg) {
  if (/suv|crossover/.test(msg)) return "suv";
  if (/truck|pickup/.test(msg)) return "truck";
  return null;
}

function detectTier(msg) {
  if (/luxury|premium|nice|higher end/.test(msg)) return "luxury";
  return null;
}

function detectBrand(msg) {
  const brands = ["bmw","mercedes","benz","audi","lexus"];
  return brands.find(b => msg.includes(b)) || null;
}

function isLuxury(d) {
  return ["bmw","mercedes","audi","lexus","porsche","range rover","genesis"]
    .some(b => `${d.make}`.toLowerCase().includes(b));
}

function isSUV(d) {
  return /cx|rav4|crv|x|gl|rx|qx|ux|mdx|rdx|pilot|tiguan|highlander/.test(
    `${d.make} ${d.model}`.toLowerCase()
  );
}

function isTruck(d) {
  return /tacoma|tundra|f150|ram|silverado|frontier/.test(
    `${d.model}`.toLowerCase()
  );
}

function extractDown(msg) {
  const m = msg.match(/(\d+)k|(\d{3,5})/);
  if (!m) return null;
  return m[1] ? Number(m[1]) * 1000 : Number(m[2]);
}

function adjustPayment(deal, newDue) {
  const map = {13:77,18:56,24:42,36:28,39:26,48:21};
  const factor = map[Number(deal.term)] || 30;

  const currentDue = Number((deal.due || "").replace(/[^0-9]/g,"")) || 0;
  const diff = (currentDue - newDue) / 1000;

  return Math.round(deal.monthly + (diff * factor));
}

function findMentionedDeal(msg, deals) {
  return deals.find(d =>
    msg.includes(d.make.toLowerCase()) ||
    msg.includes(d.model.toLowerCase())
  );
}

function updateMemory(session, user, bot) {
  if (!session.history) session.history = [];
  session.history.push({ user, bot });
  if (session.history.length > 3) session.history.shift();
}

// ===== AI (BROKER TONE) =====

async function aiReply(message, context, history) {
  const convo = history?.map(h => `User: ${h.user}\nMe: ${h.bot}`).join("\n\n") || "";

  const prompt = `
You are a high-end car broker in Beverly Hills texting clients.

Tone:
- confident
- minimal
- smooth
- no emojis
- no salesy phrases
- no "would you like"
- no over explaining

Style:
- short
- natural
- feels like a real person
- guide, don't ask too many questions

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

// ===== RANKING =====

function rankDeals(deals, session) {
  function score(d) {
    let s = 0;

    s += (1000 - d.monthly);

    const due = Number((d.due || "").replace(/[^0-9]/g,"")) || 0;
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
      await sendHumanMessage(from, "starting fresh — what are you thinking");
      return;
    }

    // GREETING (AI ONLY)
    if (/^hi|hello|hey$/.test(msg)) {
      const ai = await aiReply(msg,"greet naturally",session.history);
      await sendHumanMessage(from, ai);
      updateMemory(session,msg,ai);
      return;
    }

    const budget = extractBudget(msg);
    const type = detectType(msg);
    const tier = detectTier(msg);
    const brand = detectBrand(msg);

    if (budget){ session.min=budget.min; session.max=budget.max; session.lastShown=false;}
    if (type){ session.type=type; session.lastShown=false;}
    if (tier){ session.tier=tier; session.lastShown=false;}
    if (brand){ session.brand=brand; session.lastShown=false;}

    let deals = await getDeals();

    if (session.min!==undefined && session.max!==undefined){
      deals = deals.filter(d=>d.monthly>=session.min && d.monthly<=session.max);
    }

    if (session.type==="suv") deals = deals.filter(isSUV);
    if (session.type==="truck") deals = deals.filter(isTruck);
    if (session.tier==="luxury") deals = deals.filter(isLuxury);

    // SPECIFIC CAR FOLLOW-UP
    const mentioned = findMentionedDeal(msg, deals);

    if (mentioned) {
      session.activeDeal = mentioned;

      const ai = await aiReply(
        msg,
        `talk about ${mentioned.make} ${mentioned.model} only`,
        session.history
      );

      await sendHumanMessage(from, ai);
      updateMemory(session,msg,ai);
      return;
    }

    // NEGOTIATION
    if (/down|due|put/.test(msg) && session.activeDeal) {
      const down = extractDown(msg);

      if (down) {
        const newMonthly = adjustPayment(session.activeDeal, down);

        const reply = `${session.activeDeal.make} ${session.activeDeal.model}

$${newMonthly}/mo with $${down.toLocaleString()} due

(${session.activeDeal.term} mo / ${session.activeDeal.miles})`;

        await sendHumanMessage(from, reply);
        updateMemory(session,msg,reply);
        return;
      }
    }

    // SEARCH TRIGGER (FIXED)
    const isSearch = /what.*have|show|options|deals|available|inventory/.test(msg);

    if ((isSearch || budget) && !session.lastShown) {

      if (!deals.length) {
        await sendHumanMessage(from,"nothing clean there — let me rework it and follow up");
        return;
      }

      const {bestValue,cheapest,premium} = rankDeals(deals,session);

      session.activeDeal = bestValue;

      const sections = [
        `Best value:\n${formatDeal(bestValue)}`,
        cheapest && cheapest !== bestValue ? `Cheapest:\n${formatDeal(cheapest)}` : null,
        premium && premium !== bestValue ? `Premium:\n${formatDeal(premium)}` : null
      ].filter(Boolean).join("\n\n");

      const ai = await aiReply(msg,"guide toward best deal",session.history);

      const reply = sections + "\n\n" + ai;

      session.lastShown = true;

      await sendHumanMessage(from, reply);
      updateMemory(session,msg,reply);
      return;
    }

    // DEFAULT
    const ai = await aiReply(msg,"continue conversation",session.history);
    await sendHumanMessage(from, ai);
    updateMemory(session,msg,ai);

  } catch (e) {
    console.log("ERROR:", e);
  }
});

module.exports = router;