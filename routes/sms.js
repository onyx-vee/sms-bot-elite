const express = require("express");
const router = express.Router();

const OpenAI = require("openai");

const { sendHumanMessage } = require("../services/messaging");
const { getDeals } = require("../services/deals");
const { getSession } = require("../utils/memory");

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// 🧠 FORMAT DEALS FOR AI
function formatDealsForAI(deals) {
  return deals.map(d => {
    return `${d.make} ${d.model} | $${d.monthly}/mo | ${d.term} mo | ${d.miles} miles | ${d.due} due`;
  }).join("\n");
}

// 🧠 EXTRACT BUDGET RANGE
function extractBudget(msg) {
  const nums = msg.match(/\d{3,4}/g);

  if (!nums) return null;

  if (nums.length >= 2) {
    return {
      min: Number(nums[0]),
      max: Number(nums[1])
    };
  }

  return {
    min: 0,
    max: Number(nums[0])
  };
}

// 🧠 TYPE DETECTION
function detectType(msg) {
  if (/suv/.test(msg)) return "suv";
  if (/truck/.test(msg)) return "truck";
  return null;
}

// 🧠 MEMORY
function updateMemory(session, user, bot) {
  if (!session.history) session.history = [];
  session.history.push({ user, bot });

  if (session.history.length > 3) {
    session.history.shift();
  }
}

// 🧠 AI RESPONSE (MASTER)
async function aiReply({ message, deals, context, history }) {

  const convo = history?.map(h =>
    `User: ${h.user}\nBroker: ${h.bot}`
  ).join("\n\n") || "";

  const dealData = deals.length
    ? formatDealsForAI(deals)
    : "NO DEALS FOUND";

  const prompt = `
You are a high-end car broker texting a client.

IMPORTANT RULES:
- ONLY use the deals provided below
- NEVER make up pricing or cars
- If no deals match, say you'll follow up with options
- Keep responses clean and natural
- Format deals clearly line by line
- 2-4 lines max

Conversation:
${convo}

Deals:
${dealData}

Context:
${context}

User:
${message}

Respond like a real broker texting.
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

    // 🧠 EXTRACT INTENT
    const budget = extractBudget(msg);
    const type = detectType(msg);

    if (budget) {
      session.min = budget.min;
      session.max = budget.max;
    }

    if (type) {
      session.type = type;
    }

    // 🧠 GET DEALS FROM SHEET
    let deals = await getDeals();

    // 🧠 FILTER
    if (session.max) {
      deals = deals.filter(d => d.monthly <= session.max);
    }

    if (session.type === "suv") {
      deals = deals.filter(d =>
        /cx|rav4|crv|x|glc|gle|rx|qx/i.test(`${d.make} ${d.model}`)
      );
    }

    if (session.type === "truck") {
      deals = deals.filter(d =>
        /tacoma|tundra|f150|ram|silverado/i.test(d.model)
      );
    }

    // 🧠 LIMIT (important for AI quality)
    const topDeals = deals.slice(0, 5);

    // 🧠 AI RESPONSE (ALWAYS)
    const ai = await aiReply({
      message: msg,
      deals: topDeals,
      context: "User shopping for lease",
      history: session.history
    });

    await sendHumanMessage(from, ai);
    updateMemory(session, msg, ai);

  } catch (err) {
    console.error("ERROR:", err);
  }
});

module.exports = router;