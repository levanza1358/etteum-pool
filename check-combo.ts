import { Database } from "bun:sqlite";

const db = new Database("./data/poolprox3.db");
const row = db.query("SELECT * FROM combo_rules WHERE name LIKE '%Family%'").get();
console.log(JSON.stringify(row, null, 2));
