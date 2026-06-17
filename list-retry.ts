import { Database } from "bun:sqlite";

const db = new Database("./data/poolprox3.db");
const rows = db.query("SELECT id, name, retry_on FROM combo_rules ORDER BY id").all();

for (const row of rows) {
  console.log(`\n[${row.id}] ${row.name}`);
  console.log(`retry_on: ${row.retry_on}`);
}
