import { Database } from "bun:sqlite";

const db = new Database("./data/poolprox3.db");

// Fix step 6: change provider from "byok:aliyun" to "byok"
const row = db.query("SELECT id, steps FROM combo_rules WHERE name = 'Family Chain'").get() as any;

if (row) {
  const steps = JSON.parse(row.steps);
  let fixed = false;
  
  for (const step of steps) {
    if (step.provider && step.provider.startsWith("byok:")) {
      console.log(`Fixing: ${step.provider} → byok`);
      step.provider = "byok";
      fixed = true;
    }
  }
  
  if (fixed) {
    db.query("UPDATE combo_rules SET steps = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(steps), Math.floor(Date.now() / 1000), row.id);
    console.log("✓ Fixed Family Chain: byok:aliyun → byok");
  } else {
    console.log("No byok:* providers found");
  }
} else {
  console.log("Family Chain not found");
}
