const express = require("express");
const router = express.Router();

const { sendHumanMessage } = require("../services/messaging");
const { getDeals } = require("../services/deals");
const { getSession } = require("../utils/memory");

const OpenAI = require("openai");
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/* =========================
   BASIC FILTER (LIGHT ONLY)
========================= */
function basicFilter(deals, msg) {
  msg = msg.toLowerCase();

  if (msg.includes("bmw")) {
    deals = deals.filter(d => d.make.toLowerCase().includes("bmw"));
  }

  if (msg.includes("mercedes")) {
    deals = deals.filter(d => d.make.toLowerCase().includes("mercedes"));
  }

  if (msg.includes("audi")) {
    deals = deals.filter(d => d.make.toLowerCase().includes("audi"));
  }

  if (msg.includes("lexus")) {
    deals = deals.filter(d => d.make.toLowerCase().includes("lexus"));
  }

  if (msg.includes("suv")) {
    deals = deals.filter(d =>
      /x1|x3|x5|x7|gla|glb|glc|gle|rx|nx|qx|cx|rav4|crv|tiguan|highlander/i.test(
        `${d.make} ${d.model}`
      )
    );
  }

  if (msg.includes("ev") || msg.includes("electric")) {
    deals = deals.filter(d =>
      /ev|electric|ioniq|tesla|bolt|leaf/i.test(
        `${d.make} ${d.model}`
      )
    );
  }

  const nums = msg.match(/\d{3,4}/);
  if (nums) {
    const budget = parseInt(nums[0]);
    deals = deals.filter(d => d.monthly <= budget);
  }

  return deals.slice(0, 12);
}

/* =========================
   ATTACH IDS (FOR SELECTION)
========================= */
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

/* =========================
   ROUTE
========================= */
router.post("/", async (req, res) => {
  res.sendStatus(200);

  const from = req.body.number || req.body.from;
  const msg = (req.body.content || req.body.text || "").trim().toLowerCase();

  const session = getSession(from);

  try {
    const allDeals = await getDeals();
    let filtered = basicFilter(allDeals, msg);
    const dealsWithIds = attachIds(filtered);

    /* =========================
       HANDLE "I LIKE 8"
    ========================= */
    const numMatch = msg.match(/\b\d+\b/);
    if (numMatch) {
      const selected = dealsWithIds.find(
        d => d.id === parseInt(numMatch[0])
      );

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

    /* =========================
       AI RESPONSE
    ========================= */
    const ai = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `
You are a high-end auto broker texting clients.

You are NOT a chatbot. You text like a real person.

------------------------
FORMAT RULES (STRICT)
------------------------

When showing deals, ALWAYS format EXACTLY like this:

BMW X3 xDrive30

$533/mo  
39 mo / 7,500  
$3,000 due

(blank line)

BMW X5 xDrive40i

$866/mo  
39 mo / 7,500  
$3,000 due

------------------------

NO:
- no paragraphs
- no explanations
- no bullet points
- no numbering
- no bold text

ONLY clean stacked deal format

After listing deals, add ONE short line like:
"this is probably the move"
or
"first one is the cleanest setup"

------------------------
BEHAVIOR
------------------------

- Keep responses SHORT
- If user asks for deals → show deals ONLY
- If user asks a question → answer directly

- NEVER reset conversation
- NEVER ask "what are you looking for" again

- If user selects a car → stick to it

------------------------
NEGOTIATION
------------------------

Use:

36 mo → $28 per $1000  
39 mo → $26 per $1000  

If user changes down payment:
adjust monthly accordingly

------------------------
DATA RULES
------------------------

- ONLY use provided deals
- NEVER invent pricing
- If car not found → say you'll source it

------------------------
DEALS
------------------------
${JSON.stringify(dealsWithIds, null, 2)}

ACTIVE DEAL:
${JSON.stringify(session.activeDeal || null)}

------------------------
GOAL
------------------------

Be sharp. Clean. Human.
Close the deal naturally.
`
        },
        {
          role: "user",
          content: msg
        }
      ]
    });

    const reply = ai.choices[0].message.content;

    /* =========================
       AUTO SAVE ACTIVE DEAL
    ========================= */
    const match = dealsWithIds.find(d =>
      reply.toLowerCase().includes(d.model.toLowerCase())
    );

    if (match) {
      session.activeDeal = match;
    }

    await sendHumanMessage(from, reply);

  } catch (err) {
    console.log("SMS ERROR:", err);
  }
});

module.exports = router;