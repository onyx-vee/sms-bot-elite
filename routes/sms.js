const express = require("express");
const router = express.Router();

const { sendHumanMessage } = require("../services/messaging");
const { getDeals } = require("../services/deals");
const { getSession } = require("../utils/memory");

const OpenAI = require("openai");
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ===== BASIC FILTER ONLY =====
function basicFilter(deals, msg) {
  msg = msg.toLowerCase();

  if (msg.includes("bmw")) {
    deals = deals.filter(d => d.make.toLowerCase().includes("bmw"));
  }

  if (msg.includes("mercedes")) {
    deals = deals.filter(d => d.make.toLowerCase().includes("mercedes"));
  }

  if (msg.includes("suv")) {
    deals = deals.filter(d =>
      /x|gl|rx|nx|qx|cx|rav4|crv|tiguan|gle|glc/.test(
        `${d.make} ${d.model}`.toLowerCase()
      )
    );
  }

  const nums = msg.match(/\d{3,4}/);
  if (nums) {
    const budget = parseInt(nums[0]);
    deals = deals.filter(d => d.monthly <= budget);
  }

  return deals.slice(0, 10); // give AI options, not everything
}

// ===== ROUTE =====
router.post("/", async (req, res) => {
  res.sendStatus(200);

  const from = req.body.number || req.body.from;
  const msg = (req.body.content || "").trim();

  const session = getSession(from);

  try {
    const allDeals = await getDeals();
    const filteredDeals = basicFilter(allDeals, msg);

    const ai = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `
You are a high-end auto broker texting clients.

STYLE:
- Sound natural, confident, not robotic
- Short, clean texts
- No long paragraphs
- No repeating yourself
- No "how can I assist"
- No corporate tone

BEHAVIOR:
- Guide the deal
- Recommend 1-2 strong options (not all)
- If user asks "all", explain briefly then still guide
- If user asks follow-up, answer directly (DO NOT reset convo)
- If info missing, ask naturally

IMPORTANT:
- Only use real deals provided
- NEVER invent pricing
- If no match, say you'll check and follow up

DEALS:
${JSON.stringify(filteredDeals, null, 2)}
          `
        },
        {
          role: "user",
          content: msg
        }
      ]
    });

    const reply = ai.choices[0].message.content;

    await sendHumanMessage(from, reply);

  } catch (err) {
    console.log(err);
  }
});

module.exports = router;