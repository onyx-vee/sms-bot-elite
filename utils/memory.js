
const sessions = {};

function getSession(user) {
  if (!sessions[user]) sessions[user] = {};
  return sessions[user];
}

module.exports = { getSession };
