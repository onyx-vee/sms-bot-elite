const { getPricingRows } = require("./sheets");

function cleanNumber(val) {
  if (!val) return null;
  return Number(val.toString().replace(/[^0-9.]/g, ""));
}

async function getDeals() {
  const rows = await getPricingRows();

  let deals = [];

  for (let row of rows) {
    const monthly = cleanNumber(row[2]);

    if (!monthly) continue;

    deals.push({
      make: row[0],
      model: row[1],
      monthly,
      due: row[3],
      term: row[4],
      miles: row[5]
    });
  }

  // sort cheapest first
  deals.sort((a, b) => a.monthly - b.monthly);

  return deals;
}

module.exports = { getDeals };