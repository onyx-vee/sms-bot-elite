const express = require("express");
const router = express.Router();

const OpenAI = require("openai");

const { sendHumanMessage } = require("../services/messaging");
const { getDeals } = require("../services/deals");
const { getSession } = require("../utils/memory");

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// 🧠 FORMAT DEAL (ALWAYS CLEAN)
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

// 🧠 BUDGET RANGE
function extractBudgetRange(msg) {
  const rangeMatch = msg.match(/(\d{3,4})\s?[-to]+\s?(\d{3,4})/);

  if (rangeMatch) {
    return {
      min: Number(rangeMatch[1]),
      max: Number(rangeMatch[2])
    };
  }

  const singleMatch = msg.match(/\d{3,4}/);

  if (singleMatch) {
    return {
      min: 0,
      max: Number(singleMatch[0])
    };
  }

  return null;
}

// 🧠 AI RESPONSE (CLARITY + HUMAN)
async function aiReply({ message, context }) {
  const prompt = `
You are a high-end car broker texting a client.

Tone:
- confident
- smooth
- not robotic
- not salesy
- short (1–3 sentences max)

Goal:
- guide the deal forward
- clarify confusion naturally

Context:
${context}

Customer:
${message}

Respond like a real human broker texting.
`;

  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }]
  });

  return response.choices[0].message.content;
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

    // GREETING (HUMAN)
    if (/^hi|hello|hey$/.test(msg) && !session.started) {
      session.started = true;

      await sendHumanMessage(from,
        "hey—what are you looking at right now?"
      );
      return;
    }

    // 🧠 BUDGET
    const range = extractBudgetRange(msg);
    if (range) {
      session.minBudget = range.min;
      session.maxBudget = range.max;
    }

    // 🧠 GET DEALS
    const deals = await getDeals(session);
    if (deals.length) session.lastDeals = deals;

    // 🧠 FILTER
    let filtered = deals;

    if (session.maxBudget) {
      filtered = deals.filter(d =>
        d.monthly >= (session.minBudget || 0) &&
        d.monthly <= session.maxBudget
      );
    }

    // 🧠 DEAL SELECTION
    const selected = findDeal(msg, session.lastDeals);

    if (selected) {
      session.activeDeal = selected;

      await sendHumanMessage(from,
        `${selected.make} ${selected.model}

clean deal—want me to structure numbers on it or compare it to something else?`
      );
      return;
    }

    // 🧠 MAIN SEARCH
    if (range || /under|budget|month|deal/.test(msg)) {

      if (!filtered.length) {
        await sendHumanMessage(from,
          "nothing strong there—want me to stretch it a bit or keep it tight?"
        );
        return;
      }

      const best = pickBest(filtered);

      await sendHumanMessage(from,
        best.map(formatDeal).join("\n\n")
      );

      return;
    }

    // 🧠 FOLLOW UPS (TERMS / DUE)
    if (/term|miles|due|down/.test(msg)) {

      if (!session.activeDeal) {
        const ai = await aiReply({
          message: msg,
          context: "User asked about terms but no car selected"
        });

        await sendHumanMessage(from, ai);
        return;
      }

      const d = session.activeDeal;

      await sendHumanMessage(from,
        `${d.make} ${d.model}
${d.term} mo
${d.miles} miles
${d.due} due`
      );

      return;
    }

    // 🧠 UNKNOWN → AI CLARIFY
    const ai = await aiReply({
      message: msg,
      context: JSON.stringify(session)
    });

    await sendHumanMessage(from, ai);

  } catch (err) {
    console.error("❌ ERROR:", err);
  }
});

module.exports = router;