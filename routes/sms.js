const express = require("express");
const router = express.Router();

const OpenAI = require("openai");

const { sendHumanMessage } = require("../services/messaging");
const { getDeals } = require("../services/deals");
const { getSession } = require("../utils/memory");

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// 🧠 FORMAT DEALS (CONTROLLED — NOT AI)
function formatDeals(deals) {
  return deals.map(d => {
    return `${d.make} ${d.model}
$${d.monthly}/mo
${d.term} mo / ${d.miles}
${d.due} due`;
  }).join("\n\n\n");
}

// 🧠 EXTRACT BUDGET
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

// 🧠 MEMORY
function updateMemory(session, user, bot) {
  if (!session.history) session.history = [];

  session.history.push({ user, bot });

  if (session.history.length > 3) {
    session.history.shift();
  }
}

// 🧠 AI (ONLY GUIDANCE — NO DEAL DATA)
async function aiReply(message, context, history) {
  const convo = history?.map(h => `User: ${h.user}\nBroker: ${h.bot}`).join("\n\n") || "";

  const prompt = `
You are a high-end car broker texting a client.

Rules:
- 1-2 lines max
- no emojis
- no fluff
- do NOT list cars or pricing
- guide the customer naturally

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

  const from = req.body.number || req.body.from;
  const msg = (req.body.content || req.body.text || "").toLowerCase().trim();

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

    // 🧠 GET DEALS
    let deals = await getDeals();

    // ✅ FIXED BUDGET FILTER
    if (session.min !== undefined && session.max !== undefined) {
      deals = deals.filter(d =>
        d.monthly >= session.min &&
        d.monthly <= session.max
      );
    } else if (session.max) {
      deals = deals.filter(d =>
        d.monthly <= session.max
      );
    }

    // ✅ TYPE FILTER
    if (session.type === "suv") {
      deals = deals.filter(isSUV);
    }

    if (session.type === "truck") {
      deals = deals.filter(isTruck);
    }

    // 🧠 DEAL RESPONSE
    if (session.min !== undefined || session.max !== undefined || /deal|options|suv|truck/.test(msg)) {

      if (!deals.length) {
        const reply = "nothing clean in that range — let me check a few angles and follow up with better options";
        await sendHumanMessage(from, reply);
        return;
      }

      const best = deals.slice(0, 3); // top 3 only

      const list = formatDeals(best);

      const ai = await aiReply(msg, "recommend one of these deals", session.history);

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