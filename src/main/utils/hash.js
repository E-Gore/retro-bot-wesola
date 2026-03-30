const crypto = require("node:crypto");

function sha256(value, salt = "") {
  return crypto.createHash("sha256").update(String(salt)).update(String(value)).digest("hex");
}

module.exports = { sha256 };
