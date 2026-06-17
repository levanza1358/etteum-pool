import { Database } from "bun:sqlite";

const db = new Database("./data/poolprox3.db");

// Update Fast Best retry_on to include server_error
const newRetryOn = JSON.stringify([
  "quota_exhausted",
  "rate_limit",
  "server_error",
  "overloaded",
  "timeout",
  "error"
]);

db.query("UPDATE combo_rules SET retry_on = ?, updated_at = ? WHERE id = 2")
  .run(newRetryOn, Math.floor(Date.now() / 1000));

console.log("✓ Updated Fast Best retry conditions to include server_error & overloaded");

const row = db.query("SELECT id, name, retry_on FROM combo_rules WHERE id = 2").get();
console.log(JSON.stringify(row, null, 2));
