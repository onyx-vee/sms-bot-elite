const axios = require("axios");

// Read token lazily so it's always picked up after dotenv loads
const PD_BASE  = "https://api.pipedrive.com/v1";
function getToken() {
  const t = process.env.PIPEDRIVE_API_TOKEN;
  if (!t) throw new Error("PIPEDRIVE_API_TOKEN is not set in .env");
  return t;
}

let cachedStageId = null;

/* ─── Helpers ────────────────────────────────────────────────── */
function pd(path) {
  return `${PD_BASE}${path}?api_token=${getToken()}`;
}

async function get(path) {
  try {
    const res = await axios.get(pd(path));
    if (!res.data) throw new Error(`Empty response from GET ${path}`);
    return res.data;
  } catch (err) {
    const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    throw new Error(`Pipedrive GET ${path} failed: ${detail}`);
  }
}

async function post(path, body) {
  try {
    const res = await axios.post(pd(path), body);
    if (!res.data) throw new Error(`Empty response from POST ${path}`);
    return res.data;
  } catch (err) {
    const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    throw new Error(`Pipedrive POST ${path} failed: ${detail}`);
  }
}

/* ─── Resolve "Quote" stage in "Sales" pipeline ──────────────── */
async function getQuoteStageId() {
  if (cachedStageId) return cachedStageId;

  console.log("🔍 Pipedrive: looking up Sales pipeline...");
  const pipelinesRes = await get("/pipelines");
  const pipelines = pipelinesRes.data;

  if (!pipelines || !pipelines.length) {
    throw new Error("Pipedrive: no pipelines found — check API token");
  }

  console.log("📋 Pipelines found:", pipelines.map(p => p.name).join(", "));

  const salesPipeline = pipelines.find(p =>
    p.name.toLowerCase().includes("sales")
  );

  const pipeline = salesPipeline || pipelines[0];
  if (!salesPipeline) console.log(`⚠️ No 'Sales' pipeline, using: "${pipeline.name}"`);
  console.log(`✅ Pipeline: "${pipeline.name}" (id ${pipeline.id})`);

  const stagesRes = await get(`/stages?pipeline_id=${pipeline.id}`);
  const stages = stagesRes.data;

  if (!stages || !stages.length) {
    throw new Error(`Pipedrive: no stages in pipeline "${pipeline.name}"`);
  }

  console.log("📋 Stages found:", stages.map(s => s.name).join(", "));

  const quoteStage = stages.find(s => s.name.toLowerCase().includes("quote"));
  const stage = quoteStage || stages[0];
  if (!quoteStage) console.log(`⚠️ No 'Quote' stage, using: "${stage.name}"`);

  cachedStageId = stage.id;
  console.log(`✅ Stage: "${stage.name}" (id ${cachedStageId})`);
  return cachedStageId;
}

/* ─── Find or create a Person ────────────────────────────────── */
async function findOrCreateContact(name, phone) {
  console.log(`👤 Searching for contact: ${phone}`);
  const searchRes = await get(`/persons/search?term=${encodeURIComponent(phone)}&fields=phone`);
  const existing  = searchRes.data?.items?.[0]?.item;

  if (existing) {
    console.log(`👤 Found existing: ${existing.name} (id ${existing.id})`);
    return existing.id;
  }

  console.log(`👤 Creating new contact: ${name || phone}`);
  const created = await post("/persons", {
    name:  name || phone,
    phone: [{ value: phone, primary: true, label: "mobile" }]
  });

  if (!created.success) {
    throw new Error(`Failed to create contact: ${JSON.stringify(created)}`);
  }

  console.log(`👤 Created: ${created.data.name} (id ${created.data.id})`);
  return created.data.id;
}

/* ─── Create Deal + Note ─────────────────────────────────────── */
async function createDeal(personId, session, phone) {
  const stageId = await getQuoteStageId();
  const deal    = session.activeDeal;

  const vehicle = deal
    ? `${deal.year ? deal.year + " " : ""}${deal.make} ${deal.model}`.trim()
    : "Vehicle TBD";

  const monthly   = deal?.monthly ? `$${deal.monthly}/mo` : "";
  const dealTitle = `${session.clientName || phone} — ${vehicle}`;
  const rawMonthly = deal?.monthly
    ? parseFloat(String(deal.monthly).replace(/[^0-9.]/g, ""))
    : 0;
  const dealValue = (rawMonthly && deal?.term)
    ? Math.round(rawMonthly * parseInt(deal.term))
    : 0;

  console.log(`💼 Creating deal: "${dealTitle}"`);

  const created = await post("/deals", {
    title:     dealTitle,
    person_id: personId,
    stage_id:  stageId,
    value:     dealValue,
    currency:  "USD"
  });

  if (!created.success) {
    throw new Error(`Failed to create deal: ${JSON.stringify(created)}`);
  }

  const dealId = created.data.id;
  console.log(`💼 Deal created (id ${dealId})`);

  const noteLines = [
    `📱 Phone: ${phone}`,
    `🚗 Vehicle: ${vehicle}${monthly ? " @ " + monthly : ""}`,
    deal?.due   ? `💵 Due at signing: $${deal.due}`  : null,
    deal?.term  ? `📅 Term: ${deal.term} months`      : null,
    deal?.miles ? `🛣️  Miles/yr: ${deal.miles}`       : null,
    session.budget ? `💰 Budget: ${session.budget}`   : null,
    session.zip    ? `📍 Zip: ${session.zip}`         : null,
    `⏰ ${new Date().toLocaleString("en-US", { timeZone: "America/Los_Angeles" })}`
  ].filter(Boolean).join("\n");

  await post("/notes", {
    content:             noteLines,
    deal_id:             dealId,
    pinned_to_deal_flag: 1
  });

  console.log(`📝 Note pinned to deal ${dealId}`);
  return dealId;
}

/* ─── Main export ────────────────────────────────────────────── */
async function saveLead(session, phone) {
  const token = process.env.PIPEDRIVE_API_TOKEN;
  console.log(`🔑 PIPEDRIVE_API_TOKEN present: ${!!token}, length: ${token?.length}, first 6: ${token?.slice(0,6)}`);
  getToken(); // validates token is present before doing any work
  console.log(`🚀 Saving Pipedrive lead for ${phone}...`);
  const personId = await findOrCreateContact(session.clientName, phone);
  const dealId   = await createDeal(personId, session, phone);
  console.log(`✅ Pipedrive complete — deal id ${dealId}`);
  return dealId;
}

module.exports = { saveLead };