const express = require("express");
const router = express.Router();

const OpenAI = require("openai");

const { sendHumanMessage } = require("../services/messaging");
const { getDeals } = require("../services/deals");
const { getSession } = require("../utils/memory");

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// 🧠 FORMAT DEAL
function formatDeal(d) {
  return [
    `${d.make} ${d.model}`,
    `$${d.monthly}/mo`,
    `${d.term} mo / ${d.miles}`,
    `${d.due} due`
  ].join("\n");
}

// 🧠 PICK BEST
function pickBest(deals) {
  return [...deals].sort((a, b) => a.monthly - b.monthly).slice(0, 2);
}

// 🧠 FIND DEAL (STRONG MATCH)
function findDeal(msg, deals) {
  msg = msg.toLowerCase();

  return deals.find(d => {
    const full = `${d.make} ${d.model}`.toLowerCase();
    return msg.includes(d.model.toLowerCase()) || msg.includes(full);
  });
}

// 🧠 TYPE
function detectType(msg) {
  if (/suv|crossover/.test(msg)) return "suv";
  if (/truck|pickup/.test(msg)) return "truck";
  return null;
}

// 🧠 SUV FILTER
function isSUV(d) {
  const str = `${d.make} ${d.model}`.toLowerCase();

  return [
    "cx","rav4","crv","pilot","tiguan",
    "x1","x3","x5","x7",
    "glc","gle","rx","nx","qx","ux",
    "mdx","rdx","highlander","explorer"
  ].some(k => str.includes(k));
}

// 🧠 TRUCK FILTER
function isTruck(d) {
  const str = `${d.make} ${d.model}`.toLowerCase();

  return [
    "tacoma","tundra","frontier",
    "silverado","ram","f150"
  ].some(k => str.includes(k));
}

// 🧠 BUDGET
function extractBudget(msg) {
  const match = msg.match(/\d{3,4}/);
  return match ? Number(match[0]) : null;
}

// 🧠 MEMORY
function updateMemory(session, user, bot) {
  if (!session.history) session.history = [];

  session.history.push({ user, bot });

  if (session.history.length > 3) {
    session.history.shift();
  }
}

// 🧠 AI
async function aiReply(message, context, history) {
  const convo = history?.map(h => `User: ${h.user}\nBot: ${h.bot}`).join("\n\n") || "";

  const prompt = `
You are a high-end car broker texting.

Rules:
- 1-2 lines max
- no emojis
- no fluff
- no repeating
- guide the deal forward

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

router.post("/", async (req, res) => {
  res.sendStatus(200);

  const from = req.body.number;
  const msg = (req.body.content || "").toLowerCase().trim();

  const session = getSession(from);

  try {

    // 🔥 RESET
    if (/start over|reset/.test(msg)) {
      Object.keys(session).forEach(k => delete session[k]);
      await sendHumanMessage(from, "starting fresh — what are you looking for?");
      return;
    }

    // 🔥 GREETING
    if (/^hi|hello|hey$/.test(msg)) {
      const ai = await aiReply(msg, "greet naturally", session.history);
      await sendHumanMessage(from, ai);
      updateMemory(session, msg, ai);
      return;
    }

    // 🧠 GET DEALS
    const deals = await getDeals(session);
    session.lastDeals = deals;

    // 🧠 PRIORITY 1: EXACT CAR MATCH
    const selected = findDeal(msg, deals);

    if (selected) {
      session.activeDeal = selected;

      const reply = formatDeal(selected);
      await sendHumanMessage(from, reply);
      updateMemory(session, msg, reply);
      return;
    }

    // 🧠 PRIORITY 2: FOLLOW-UP ON ACTIVE DEAL
    if (/tell me more|details|spec|features|engine|hp|that one/.test(msg)) {

      if (session.activeDeal) {
        const ai = await aiReply(msg, "explain this car and guide deal", session.history);

        await sendHumanMessage(from, ai);
        updateMemory(session, msg, ai);
        return;
      }
    }

    // 🧠 TYPE + BUDGET
    const type = detectType(msg);
    if (type) session.type = type;

    const budget = extractBudget(msg);
    if (budget) session.maxBudget = budget;

    let filtered = deals;

    if (session.maxBudget) {
      filtered = filtered.filter(d => d.monthly <= session.maxBudget);
    }

    if (session.type === "suv") {
      filtered = filtered.filter(isSUV);
    }

    if (session.type === "truck") {
      filtered = filtered.filter(isTruck);
    }

    // 🧠 PRIORITY 3: DEAL SEARCH
    if (/suv|truck|deal|options|budget|under/.test(msg) || budget) {

      if (!filtered.length) {
        await sendHumanMessage(from, "nothing strong there — want me to open it up?");
        return;
      }

      const best = pickBest(filtered);
      const list = best.map(formatDeal).join("\n\n\n");

      const ai = await aiReply(msg, "recommend best option", session.history);

      const reply = list + "\n\n" + ai;

      await sendHumanMessage(from, reply);
      updateMemory(session, msg, reply);
      return;
    }

    // 🧠 DEFAULT
    const ai = await aiReply(msg, "continue conversation", session.history);

    await sendHumanMessage(from, ai);
    updateMemory(session, msg, ai);

  } catch (err) {
    console.error("ERROR:", err);
  }
});

module.exports = router;