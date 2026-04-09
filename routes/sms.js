const express = require("express");
const router = express.Router();

const { sendHumanMessage } = require("../services/messaging");
const { getDeals } = require("../services/deals");
const { getSession } = require("../utils/memory");

const OpenAI = require("openai");
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

function basicFilter(deals, msg) {
  msg = msg.toLowerCase();

  if (msg.includes("bmw")) {
    deals = deals.filter(d => d.make.toLowerCase().includes("bmw"));
  }

  if (msg.includes("suv")) {
    deals = deals.filter(d =>
      /x1|x3|x5|x7|gla|glb|glc|gle|rx|nx|qx|cx|rav4|crv|tiguan/i.test(
        `${d.make} ${d.model}`
      )
    );
  }

  return deals.slice(0, 12);
}

function attachIds(deals) {
  return deals.map((d, i) => ({
    id: i + 1,
    make: d.make,
    model: d.model,
    monthly: d.monthly,
    due: d.due,
    term: d.term,
    miles: d.miles
  }));
}

router.post("/", async (req, res) => {
  res.sendStatus(200);

  const from = req.body.number || req.body.from;
  const msg = (req.body.content || "").toLowerCase().trim();

  const session = getSession(from);

  try {
    const allDeals = await getDeals();
    let filtered = basicFilter(allDeals, msg);

    const dealsWithIds = attachIds(filtered);

    // ===== HANDLE "I like 8" =====
    const numMatch = msg.match(/\b\d+\b/);
    if (numMatch) {
      const selected = dealsWithIds.find(d => d.id === parseInt(numMatch[0]));
      if (selected) {
        session.activeDeal = selected;

        await sendHumanMessage(
          from,
          `${selected.make} ${selected.model}

$${selected.monthly}/mo
${selected.term} mo / ${selected.miles}
$${selected.due} due

want me to adjust the numbers or lock it in?`
        );
        return;
      }
    }

    const ai = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `
You are a high-end auto broker texting.

STRICT RULES:

- No bullet points
- No numbered lists
- No bold text
- Text like a human

- NEVER say "I'll check" or "I'll get back to you"
- If deal exists → answer directly

- If user selects a number → that is the deal
- NEVER switch cars incorrectly

- ONLY reference cars from this list
- NEVER say a car doesn't exist if it's listed

- Recommend 1-2 options max unless user asks for all

- Keep it short and clean

DEALS:
${JSON.stringify(dealsWithIds, null, 2)}

ACTIVE DEAL:
${JSON.stringify(session.activeDeal || null)}
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