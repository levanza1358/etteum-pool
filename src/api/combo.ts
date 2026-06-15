import { Hono } from "hono";
import {
  getAllComboRules,
  getComboRule,
  createComboRule,
  updateComboRule,
  deleteComboRule,
  isComboEnabled,
  invalidateComboCache,
  type NewComboRule,
} from "../proxy/combo";
import { db } from "../db/index";
import { settings } from "../db/schema";
import { eq } from "drizzle-orm";
import { getAllModels } from "../proxy/router";

export const comboRouter = new Hono();

/**
 * GET /api/combo - List all combo rules
 */
comboRouter.get("/", async (c) => {
  const rules = await getAllComboRules();
  return c.json({
    data: rules,
    enabled: isComboEnabled(),
  });
});

/**
 * GET /api/combo/models - List all available provider+model pairs for combo steps
 */
comboRouter.get("/models", async (c) => {
  const models = getAllModels();
  // Group by provider (owned_by)
  const grouped: Record<string, { id: string; name: string }[]> = {};
  for (const m of models) {
    const provider = m.owned_by || "unknown";
    if (!grouped[provider]) grouped[provider] = [];
    grouped[provider].push({ id: m.id, name: m.id });
  }
  return c.json({ data: grouped });
});

/**
 * GET /api/combo/:id - Get a single combo rule
 */
comboRouter.get("/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);

  const rule = await getComboRule(id);
  if (!rule) return c.json({ error: "Combo rule not found" }, 404);

  return c.json({ data: rule });
});

/**
 * POST /api/combo - Create a new combo rule
 */
comboRouter.post("/", async (c) => {
  const body = await c.req.json<Partial<NewComboRule>>();

  if (!body.triggerModel) {
    return c.json({ error: "triggerModel is required" }, 400);
  }
  if (!body.steps || !Array.isArray(body.steps) || body.steps.length === 0) {
    return c.json({ error: "steps array is required and must not be empty" }, 400);
  }

  // Validate each step has provider + model
  for (const step of body.steps) {
    if (!step.provider || !step.model) {
      return c.json({ error: "Each step must have provider and model" }, 400);
    }
  }

  const rule = await createComboRule({
    name: body.name || "",
    modelId: body.modelId || "",
    triggerModel: body.triggerModel,
    matchType: body.matchType || "contains",
    steps: body.steps,
    maxRetries: body.maxRetries ?? 3,
    retryOn: body.retryOn || ["quota_exhausted", "rate_limit", "error", "timeout"],
    enabled: body.enabled ?? true,
    priority: body.priority ?? 0,
  });

  return c.json({ data: rule }, 201);
});

/**
 * PUT /api/combo/:id - Update a combo rule
 */
comboRouter.put("/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);

  const body = await c.req.json<Partial<NewComboRule>>();

  // Validate steps if provided
  if (body.steps) {
    if (!Array.isArray(body.steps) || body.steps.length === 0) {
      return c.json({ error: "steps must be a non-empty array" }, 400);
    }
    for (const step of body.steps) {
      if (!step.provider || !step.model) {
        return c.json({ error: "Each step must have provider and model" }, 400);
      }
    }
  }

  const updated = await updateComboRule(id, body);
  if (!updated) return c.json({ error: "Combo rule not found" }, 404);

  return c.json({ data: updated });
});

/**
 * DELETE /api/combo/:id - Delete a combo rule
 */
comboRouter.delete("/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);

  const deleted = await deleteComboRule(id);
  if (!deleted) return c.json({ error: "Combo rule not found" }, 404);

  return c.json({ success: true });
});

/**
 * PUT /api/combo/toggle - Enable/disable combo globally
 */
comboRouter.put("/toggle", async (c) => {
  const body = await c.req.json<{ enabled: boolean }>();

  const existing = await db
    .select()
    .from(settings)
    .where(eq(settings.key, "combo_enabled"));

  const value = body.enabled ? "true" : "false";

  if (existing.length > 0) {
    await db
      .update(settings)
      .set({ value, updatedAt: new Date() })
      .where(eq(settings.key, "combo_enabled"));
  } else {
    await db.insert(settings).values({ key: "combo_enabled", value });
  }

  invalidateComboCache();
  return c.json({ enabled: body.enabled });
});
