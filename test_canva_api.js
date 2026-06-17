import { CanvaProvider } from "./src/proxy/providers/canva.js";

const canva = new CanvaProvider();

// Mock account with dummy CAZ token
const mockAccount = {
  id: 1,
  email: "test@example.com",
  tokens: JSON.stringify({ caz: "fake-token" })
};

async function test() {
  console.log("Testing Canva Provider...");
  const result = await canva.fetchQuota(mockAccount);
  console.log(result);
  console.log("Health check:", await canva.healthCheck(mockAccount));
}

test().catch(err => console.error(err));