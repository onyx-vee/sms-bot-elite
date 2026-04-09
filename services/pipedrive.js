const axios = require("axios");

const PD_TOKEN = process.env.PIPEDRIVE_API_TOKEN;
const PD_BASE  = "https://api.pipedrive.com/v1";

// Cache pipeline/stage IDs after first lookup so we don't hammer the API
let cachedStageId = null;

/* ─── Helpers ─────────────────────────────────────────────────── */
function pd(path) {
  return `${PD_BASE}${path}?api_token=${PD_TOKEN}`;
}

async function get(path) {
  const res = await axios.get(pd(path));
  return res.data;
}

async function post(path, body) {
  const res = await axios.post(pd(path), body);
  return res.data;
}

/* ─── Resolve "Quote" stage in "Sales" pipeline ──────────────── */
async function getQuoteStageId() {
  if (cachedStageId) return cachedStageId;

  const { data: pipelines } = await get("/pipelines");
  const salesPipeline = pipelines.find(p =>
    p.name.toLowerCase().includes("sales")
  );

  if (!salesPipeline) {
    throw new Error('Pipedrive: could not find a pipeline named "Sales"');
  }

  const { data: stages } = await get(`/stages?pipeline_id=${salesPipeline.id}`);
  const quoteStage = stages.find(s =>
    s.name.toLowerCase().includes("quote")
  );

  if (!quoteStage) {
    throw new Error('Pipedrive: could not find a "Quote" stage in the Sales pipeline');
  }

  cachedStageId = quoteStage.id;
  console.log(`✅ Pipedrive stage resolved: "${quoteStage.name}" (id ${cachedStageId})`);
  return cachedStageId;
}

/* ─── Find or create a Person (contact) ─────────────────────── */
async function findOrCreateContact(name, phone) {
  // Search by phone first to avoid duplicates
  const search = await get(`/persons/search?term=${encodeURIComponent(phone)}&fields=phone`);
  const existing = search.data?.items?.[0]?.item;

  if (existing) {
    console.log(`👤 Existing Pipedrive contact found: ${existing.name} (id ${existing.id})`);
    return existing.id;
  }

  // Create new contact
  const created = await post("/persons", {
    name: name || phone,   // fall back to phone if name unknown
    phone: [{ value: phone, primary: true }]
  });

  if (!created.success) {
    throw new Error(`Pipedrive: failed to create contact — ${JSON.stringify(created)}`);
  }

  console.log(`👤 New Pipedrive contact created: ${created.data.name} (id ${created.data.id})`);
  return created.data.id;
}

/* ─── Create a Deal ──────────────────────────────────────────── */
async function createDeal(personId, session, phone) {
  const stageId = await getQuoteStageId();

  const vehicle = session.activeDeal
    ? `${session.activeDeal.year ? session.activeDeal.year + " " : ""}${session.activeDeal.make} ${session.activeDeal.model}`
    : "Vehicle TBD";

  const monthly = session.activeDeal?.monthly
    ? `$${session.activeDeal.monthly}/mo`
    : "";

  const dealTitle = `${session.clientName || phone} — ${vehicle}`;

  const body = {
    title:     dealTitle,
    person_id: personId,
    stage_id:  stageId,
    // Pipedrive "value" field = deal value. Use monthly payment * term as a rough estimate.
    value: session.activeDeal?.monthly && session.activeDeal?.term
      ? session.activeDeal.monthly * session.activeDeal.term
      : 0,
    currency: "USD",
    // Store key details in the note visible on the deal card
  };

  const created = await post("/deals", body);

  if (!created.success) {
    throw new Error(`Pipedrive: failed to create deal — ${JSON.stringify(created)}`);
  }

  const dealId = created.data.id;
  console.log(`💼 Pipedrive deal created: "${dealTitle}" (id ${dealId})`);

  // Attach a note with all the details so the sales team sees everything
  const noteLines = [
    `📱 Phone: ${phone}`,
    `🚗 Vehicle: ${vehicle}${monthly ? " @ " + monthly : ""}`,
    session.activeDeal?.due     ? `💵 Due at signing: $${session.activeDeal.due}` : null,
    session.activeDeal?.term    ? `📅 Term: ${session.activeDeal.term} months` : null,
    session.activeDeal?.miles   ? `🛣️ Miles: ${session.activeDeal.miles}` : null,
    session.budget              ? `💰 Budget: ${session.budget}` : null,
    session.zip                 ? `📍 Zip: ${session.zip}` : null,
    `⏰ Created: ${new Date().toLocaleString("en-US", { timeZone: "America/Los_Angeles" })}`,
  ].filter(Boolean).join("\n");

  await post("/notes", {
    content:  noteLines,
    deal_id:  dealId,
    pinned_to_deal_flag: 1
  });

  console.log(`📝 Note pinned to deal ${dealId}`);
  return dealId;
}

/* ─── Main export ────────────────────────────────────────────── */
async function saveLead(session, phone) {
  if (!PD_TOKEN) throw new Error("PIPEDRIVE_API_TOKEN is not set in .env");

  const personId = await findOrCreateContact(session.clientName, phone);
  const dealId   = await createDeal(personId, session, phone);

  return dealId;
}

module.exports = { saveLead };
