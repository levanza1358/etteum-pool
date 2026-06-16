import { Database } from "bun:sqlite";
const db = new Database("./data/poolprox3.db");
const tables = db.query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
console.log("Existing tables:", tables);
