
function extractBudget(msg) {
  const m = msg.match(/\d{3,4}/);
  return m ? Number(m[0]) : null;
}

function detectBrand(msg) {
  const brands = ["toyota","bmw","audi","mercedes","lexus"];
  return brands.find(b => msg.includes(b));
}

function isGreeting(msg) {
  return /hi|hello|hey/.test(msg);
}

function isReset(msg) {
  return /reset|start over/.test(msg);
}

function isShoppingIntent(msg) {
  return /under|deal|price|payment|available|options/.test(msg);
}

module.exports = {
  extractBudget,
  detectBrand,
  isGreeting,
  isReset,
  isShoppingIntent
};
