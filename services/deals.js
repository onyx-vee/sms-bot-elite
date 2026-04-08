const { getPricingRows } = require("./sheets");

function cleanNumber(val) {
  if (!val) return null;
  return Number(val.toString().replace(/[^0-9.]/g, ""));
}

async function getDeals() {
  const rows = await getPricingRows();

  return rows.map(row => ({
    make: row[0],
    model: row[1],
    monthly: cleanNumber(row[2]),
    due: row[3],
    term: row[4],
    miles: row[5]
  })).filter(d => d.monthly);
}

module.exports = { getDeals };