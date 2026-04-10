const axios = require("axios");
const { PRICING_SHEET } = require("../config/constants");

const SHEETS_BASE = "https://sheets.googleapis.com/v4/spreadsheets";

function getApiKey() {
  const key = process.env.GOOGLE_API_KEY;
  if (!key) throw new Error("GOOGLE_API_KEY is not set in .env");
  return key;
}

async function getPricingRows() {
  const spreadsheetId = process.env.GOOGLE_SHEET_ID || PRICING_SHEET;
  const range = encodeURIComponent("Sheet1!A2:G");
  const url = `${SHEETS_BASE}/${spreadsheetId}/values/${range}?key=${getApiKey()}`;

  try {
    const res = await axios.get(url);
    const rows = res.data.values || [];
    console.log(`📊 Loaded ${rows.length} rows from pricing sheet`);
    return rows;
  } catch (err) {
    const detail = err.response?.data?.error?.message || err.message;
    console.error("❌ Failed to fetch pricing sheet:", detail);
    return [];
  }
}

module.exports = { getPricingRows };