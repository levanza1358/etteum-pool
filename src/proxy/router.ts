import type { ChatCompletionRequest, ProviderResult } from "./providers/base";
import { providers, getAllModels, type ProviderName } from "./providers/registry";
import { isNonAccountRequestError, isTransientError } from "./errors";
import { applyPudidilFilters } from "./filters";
import { pool } from "./pool";
import type { Account } from "../db/schema";
import {
  compressRequest,
  getCompressionConfig,
  type CompressionStats,
} from "./compression";
import {
  findComboForModel,
  shouldComboRetry,
  isComboModel,
  isStepCooledDown,
  recordStepFailure,
  recordStepSuccess,
} from "./combo";
import { tryAutoRecoverProvider, isAutoRecoverProvider } from "../auth/warmup-runner";

export interface RouteResult {
  result: ProviderResult;
  account: Account;
  provider: ProviderName;
  durationMs: number;
  compressionStats?: CompressionStats;
  /** When a combo fallback was used, records which step succeeded. */
  comboInfo?: {
    ruleName: string;
    originalModel: string;
    usedStep: number;
    usedProvider: string;
    usedModel: string;
    attemptedSteps: string[];
  };
}

/** Check if a request contains image content blocks */
function requestHasImages(request: ChatCompletionRequest): boolean {
  return request.messages.some((msg) => {
    if (!Array.isArray(msg.content)) return false;
    return (msg.content as any[]).some(
      (block) => block?.type === "image_url" || block?.type === "image"
    );
  });
}

/**
 * Sanitize request by applying pudidil filters to all text content.
 */
function sanitizeRequest(request: ChatCompletionRequest): ChatCompletionRequest {
  const sanitized = { ...request };

  sanitized.messages = request.messages.map((msg) => {
    if (typeof msg.content === "string") {
      return { ...msg, content: applyPudidilFilters(msg.content) };
    }
    if (Array.isArray(msg.content)) {
      return {
        ...msg,
        content: (msg.content as any[]).map((block) => {
          if (block?.type === "text" && typeof block.text === "string") {
            return { ...block, text: applyPudidilFilters(block.text) };
          }
          if (block?.type === "tool_result") {
            if (typeof block.content === "string") {
              return { ...block, content: applyPudidilFilters(block.content) };
            }
            if (Array.isArray(block.content)) {
              return {
                ...block,
                content: block.content.map((inner: any) =>
                  inner?.type === "text" && typeof inner.text === "string"
                    ? { ...inner, text: applyPudidilFilters(inner.text) }
                    : inner
                ),
              };
            }
          }
          return block;
        }),
      };
    }
    return msg;
  });

  if (sanitized.tools) {
    sanitized.tools = request.tools!.map((tool: any) => {
      if (tool?.function?.description) {
        return {
          ...tool,
          function: {
            ...tool.function,
            description: applyPudidilFilters(tool.function.description),
          },
        };
      }
      return tool;
    });
  }

  return sanitized;
}

// ---------------------------------------------------------------------------
// tryProvider — attempt a request against a single provider+model
// ---------------------------------------------------------------------------

async function tryProvider(
  sanitizedRequest: ChatCompletionRequest,
  targetModel: string,
  providerName: ProviderName,
  stream: boolean,
): Promise<RouteResult> {
  const hasImages = requestHasImages(sanitizedRequest);
  const modelRequest = { ...sanitizedRequest, model: targetModel };

  let compressedRequest = modelRequest;
  let compressionStats: CompressionStats | undefined;
  try {
    const cfg = await getCompressionConfig();
    const out = compressRequest(modelRequest, cfg, providerName);
    compressedRequest = out.request;
    compressionStats = out.stats;
  } catch (err) {
    console.error("[Compression] Failed, passing request through unchanged:", err);
  }

  const provider = providers[providerName];
  if (!provider) {
    throw new Error(`Provider not configured: ${providerName}`);
  }

  if (hasImages) {
    const modelInfo = provider.getModelInfo(targetModel);
    if (modelInfo && !modelInfo.vision) {
      throw new Error(
        `Model "${targetModel}" does not support image/vision inputs. Use a vision-capable model instead.`
      );
    }
  }

  const maxRetries = 3;
  let lastError = "";

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    let account = providerName === "byok"
      ? (await pool.getAccountForModel(compressedRequest.model))?.account ?? null
      : await pool.getNextAccount(providerName);

    // Auto-recover: kalau pool kosong dan provider mendukung (mis. codex),
    // coba "warmup" akun exhausted/error sebentar lalu coba sekali lagi.
    if (!account && providerName !== "byok" && isAutoRecoverProvider(providerName) && attempt === 0) {
      const recovered = await tryAutoRecoverProvider(providerName);
      if (recovered > 0) {
        account = await pool.getNextAccount(providerName);
      }
    }

    if (!account) {
      throw new Error(
        `No active accounts available for provider: ${providerName}`
      );
    }

    const startTime = Date.now();
    let tracked = false;

    try {
      pool.trackRequestStart(account.id);
      tracked = true;
      const result = stream
        ? await provider.chatCompletionStream(account, compressedRequest)
        : await provider.chatCompletion(account, compressedRequest);

      const durationMs = Date.now() - startTime;

      if (result.success) {
        if (result.tokens) {
          await pool.updateTokens(account.id, result.tokens);
        }
        await pool.markUsed(account.id);
        return { result, account, provider: providerName, durationMs, compressionStats };
      }

      pool.trackRequestEnd(account.id);
      tracked = false;

      if (isNonAccountRequestError(result.error)) {
        throw new Error(result.error || `Invalid model: ${compressedRequest.model}`);
      }

      if (result.rateLimited) {
        lastError = result.error || "Rate limited";
        continue;
      }

      if (result.quotaExhausted) {
        // Recheck quota in real-time before marking exhausted — avoids false positives
        // from transient 429s or stale local quota data.
        try {
          const quotaCheck = await provider.fetchQuota(account);
          if (quotaCheck.success && quotaCheck.quota && quotaCheck.quota.remaining > 0) {
            // Quota still available — this was a transient rate limit, not real exhaustion
            console.log(
              `[Router] ${account.email}: quotaExhausted signal but real quota is ${quotaCheck.quota.remaining}/${quotaCheck.quota.limit}. Treating as transient.`
            );
            await pool.updateQuotaSnapshot(account.id, quotaCheck.quota, {
              status: "active",
              errorMessage: null,
            });
            lastError = result.error || "Transient rate limit";
            continue;
          }
          if (quotaCheck.success && quotaCheck.quota) {
            await pool.updateQuotaSnapshot(account.id, quotaCheck.quota, {
              status: "exhausted",
              errorMessage: result.error || "Quota exhausted",
            });
          }
        } catch {
          // Quota check failed — proceed with marking exhausted
        }
        await pool.markExhausted(account.id);
        lastError = result.error || "Quota exhausted";
        continue;
      }

      if (
        result.error?.includes("expired") ||
        result.error?.includes("401")
      ) {
        const refreshResult = await provider.refreshToken(account);
        if (refreshResult.success && refreshResult.tokens) {
          let parsedTokens: unknown;
          try {
            parsedTokens = JSON.parse(refreshResult.tokens);
          } catch {
            parsedTokens = refreshResult.tokens;
          }
          await pool.updateTokens(account.id, parsedTokens);
          pool.trackRequestStart(account.id);
          tracked = true;
          const retryResult = stream
            ? await provider.chatCompletionStream(account, compressedRequest)
            : await provider.chatCompletion(account, compressedRequest);

          if (retryResult.success) {
            await pool.markUsed(account.id);
            return {
              result: retryResult,
              account,
              provider: providerName,
              durationMs: Date.now() - startTime,
              compressionStats,
            };
          }
          pool.trackRequestEnd(account.id);
          tracked = false;
        }
        await pool.markTransientFailure(account.id, result.error || "Auth failed");
        lastError = result.error || "Auth failed";
        continue;
      }

      if (isTransientError(result.error || "")) {
        await pool.markTransientFailure(account.id, result.error || "Transient error");
      } else {
        await pool.markError(account.id, result.error || "Unknown error");
      }
      lastError = result.error || "Unknown error";
    } catch (error) {
      const errMsg =
        error instanceof Error ? error.message : String(error);
      if (tracked) {
        pool.trackRequestEnd(account.id);
        tracked = false;
      }
      if (isNonAccountRequestError(errMsg)) {
        throw error;
      }
      if (errMsg.includes("expired") || errMsg.includes("401")) {
        await pool.markTransientFailure(account.id, errMsg);
      } else if (isTransientError(errMsg)) {
        await pool.markTransientFailure(account.id, errMsg);
      } else {
        await pool.markError(account.id, errMsg);
      }
      lastError = errMsg;
    }
  }

  throw new Error(
    `All accounts failed for ${providerName}. Last error: ${lastError}`
  );
}

// ---------------------------------------------------------------------------
// routeRequest — main entry point with combo fallback
// ---------------------------------------------------------------------------

/**
 * Route a chat completion request to the appropriate provider/account.
 * Implements retry logic with fallback to next account, and combo
 * (multi-provider+model) fallback when a combo rule matches.
 */
export async function routeRequest(
  request: ChatCompletionRequest,
  stream: boolean
): Promise<RouteResult> {
  const sanitizedRequest = sanitizeRequest(request);

  const originalModel = sanitizedRequest.model;

  // ── Check if this is a combo virtual model (exact match) ──
  // When the client selects a combo model (e.g. "best"), we skip the normal
  // provider lookup and go straight into the combo chain from step 1.
  const directCombo = isComboModel(originalModel);
  if (directCombo) {
    return runComboChain(sanitizedRequest, originalModel, directCombo, stream, []);
  }

  // ── Normal routing: find provider for this model ──
  const providerName = pool.getProviderForModel(originalModel);
  if (!providerName) {
    throw new Error(`No provider found for model: ${originalModel}`);
  }

  // ── First attempt: original provider + model ──
  try {
    return await tryProvider(sanitizedRequest, originalModel, providerName, stream);
  } catch (primaryError) {
    const primaryMsg = primaryError instanceof Error ? primaryError.message : String(primaryError);

    // Content/model errors should not trigger combo fallback
    if (isNonAccountRequestError(primaryMsg)) {
      throw primaryError;
    }

    // ── Combo fallback (pattern match) ──
    const comboRule = findComboForModel(originalModel);
    if (!comboRule || comboRule.steps.length === 0) {
      throw primaryError; // No combo rule — propagate original error
    }

    // maxRetries = max number of fallback steps to ACTUALLY attempt.
    // Skipped steps (duplicate of primary, cooldown, no accounts, unknown provider)
    // do NOT consume this budget — they're not real attempts.
    // 0 = no limit (try all steps in the chain).
    const maxFallbacks = comboRule.maxRetries > 0
      ? comboRule.maxRetries
      : comboRule.steps.length;

    const attemptedSteps: string[] = [`${providerName}/${originalModel}`];
    const skippedSteps: string[] = [];

    console.log(
      `[Combo] Primary provider ${providerName}/${originalModel} failed: ${primaryMsg}. ` +
      `Trying combo "${comboRule.name}" (${comboRule.steps.length} steps total, max ${maxFallbacks} fallback attempts)…`
    );

    let lastComboError = primaryMsg;
    let triedFallbacks = 0;

    for (let i = 0; i < comboRule.steps.length; i++) {
      if (triedFallbacks >= maxFallbacks) {
        console.log(`[Combo] Reached maxRetries cap (${maxFallbacks}); stopping.`);
        break;
      }

      const step = comboRule.steps[i]!;
      const stepLabel = `${step.provider}/${step.model}`;

      // Skip if this step is the same as what we already tried (don't consume budget)
      if (step.provider === providerName && step.model === originalModel) {
        skippedSteps.push(`${stepLabel} (duplicate of primary)`);
        continue;
      }

      const stepProvider = step.provider as ProviderName;
      if (!providers[stepProvider]) {
        console.warn(`[Combo] Unknown provider "${step.provider}" in step ${i + 1}, skipping.`);
        skippedSteps.push(`${stepLabel} (unknown provider)`);
        continue;
      }

      // Cooldown check (don't consume budget)
      if (isStepCooledDown(step.provider, step.model)) {
        console.log(`[Combo] Step ${i + 1} (${stepLabel}) is in cooldown, skipping.`);
        skippedSteps.push(`${stepLabel} (cooldown)`);
        continue;
      }

      // Health-aware skip (don't consume budget)
      const hasAccounts = await pool.hasActiveAccounts(stepProvider, step.model);
      if (!hasAccounts) {
        console.log(`[Combo] Step ${i + 1} (${stepLabel}) has no active accounts, skipping.`);
        skippedSteps.push(`${stepLabel} (no active accounts)`);
        continue;
      }

      // Check if the error type should trigger a retry for this rule
      // (only check on actual attempts, after we've passed all skip conditions)
      if (!shouldComboRetry(comboRule, lastComboError)) {
        console.log(`[Combo] Error type not retryable for rule "${comboRule.name}", stopping.`);
        break;
      }

      attemptedSteps.push(stepLabel);
      triedFallbacks++;
      console.log(`[Combo] Fallback ${triedFallbacks}/${maxFallbacks} (step ${i + 1}/${comboRule.steps.length}): trying ${stepLabel}…`);

      try {
        const result = await withTimeout(
          tryProvider(sanitizedRequest, step.model, stepProvider, stream),
          COMBO_STEP_TIMEOUT_MS,
          stepLabel,
        );

        recordStepSuccess(step.provider, step.model);

        // Success — attach combo metadata
        result.comboInfo = {
          ruleName: comboRule.name,
          originalModel,
          usedStep: i,
          usedProvider: step.provider,
          usedModel: step.model,
          attemptedSteps,
        };

        console.log(
          `[Combo] ✓ Success on step ${i + 1} (${stepLabel}) ` +
          `after ${attemptedSteps.length} attempts.`
        );

        return result;
      } catch (stepError) {
        lastComboError = stepError instanceof Error ? stepError.message : String(stepError);
        console.log(`[Combo] Step ${i + 1} failed: ${lastComboError}`);

        recordStepFailure(step.provider, step.model);

        if (isNonAccountRequestError(lastComboError)) {
          continue; // Model/content error on this step — skip to next
        }
      }
    }

    // All combo steps exhausted (pattern-match fallback)
    const skippedNote = skippedSteps.length > 0
      ? ` Skipped: ${skippedSteps.join(", ")}.`
      : "";
    throw new Error(
      `Combo "${comboRule.name}" exhausted ${triedFallbacks} fallback attempt(s) ` +
      `(out of ${comboRule.steps.length} steps in chain). ` +
      `Tried: ${attemptedSteps.join(" → ")}.${skippedNote} Last error: ${lastComboError}`
    );
  }
}

// ---------------------------------------------------------------------------
// runComboChain — used when the model IS a combo virtual model
// ---------------------------------------------------------------------------

import type { ComboRule } from "./combo";

/** Per-step timeout for combo chain (30 seconds per step). */
const COMBO_STEP_TIMEOUT_MS = 30_000;

/** Wrap a promise with a timeout. */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout after ${ms}ms: ${label}`)), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

async function runComboChain(
  sanitizedRequest: ChatCompletionRequest,
  originalModel: string,
  comboRule: ComboRule,
  stream: boolean,
  priorSteps: string[],
): Promise<RouteResult> {
  // maxRetries = max number of steps to ACTUALLY attempt.
  // Skipped steps (cooldown, no accounts, unknown provider) do NOT consume budget.
  // 0 = no limit.
  const maxAttempts = comboRule.maxRetries > 0
    ? comboRule.maxRetries
    : comboRule.steps.length;

  const attemptedSteps: string[] = [...priorSteps];
  const skippedSteps: string[] = [];
  let lastComboError = "";
  let triedCount = 0;

  console.log(
    `[Combo] Direct combo model "${originalModel}" → running chain "${comboRule.name}" ` +
    `(${comboRule.steps.length} steps total, max ${maxAttempts} attempts)…`
  );

  for (let i = 0; i < comboRule.steps.length; i++) {
    if (triedCount >= maxAttempts) {
      console.log(`[Combo] Reached maxRetries cap (${maxAttempts}); stopping.`);
      break;
    }

    const step = comboRule.steps[i]!;
    const stepProvider = step.provider as ProviderName;
    const stepLabel = `${step.provider}/${step.model}`;

    if (!providers[stepProvider]) {
      console.warn(`[Combo] Unknown provider "${step.provider}" in step ${i + 1}, skipping.`);
      skippedSteps.push(`${stepLabel} (unknown provider)`);
      continue;
    }

    // ── Cooldown check: skip steps that failed too many times recently (no budget) ──
    if (isStepCooledDown(step.provider, step.model)) {
      console.log(`[Combo] Step ${i + 1} (${stepLabel}) is in cooldown, skipping.`);
      skippedSteps.push(`${stepLabel} (cooldown)`);
      continue;
    }

    // ── Health-aware skip: check if provider has any active accounts (no budget) ──
    const hasAccounts = await pool.hasActiveAccounts(stepProvider, step.model);
    if (!hasAccounts) {
      console.log(`[Combo] Step ${i + 1} (${stepLabel}) has no active accounts, skipping.`);
      skippedSteps.push(`${stepLabel} (no active accounts)`);
      continue;
    }

    attemptedSteps.push(stepLabel);
    triedCount++;
    console.log(`[Combo] Attempt ${triedCount}/${maxAttempts} (step ${i + 1}/${comboRule.steps.length}): trying ${stepLabel}…`);

    try {
      // ── Per-step timeout: don't let one slow provider block the whole chain ──
      const result = await withTimeout(
        tryProvider(sanitizedRequest, step.model, stepProvider, stream),
        COMBO_STEP_TIMEOUT_MS,
        stepLabel,
      );

      // Success — reset cooldown and attach combo metadata
      recordStepSuccess(step.provider, step.model);

      result.comboInfo = {
        ruleName: comboRule.name,
        originalModel,
        usedStep: i,
        usedProvider: step.provider,
        usedModel: step.model,
        attemptedSteps,
      };

      console.log(
        `[Combo] ✓ Success on step ${i + 1} (${stepLabel}) ` +
        `after ${attemptedSteps.length} attempts.`
      );

      return result;
    } catch (stepError) {
      lastComboError = stepError instanceof Error ? stepError.message : String(stepError);
      console.log(`[Combo] Step ${i + 1} failed: ${lastComboError}`);

      // Record failure for cooldown tracking
      recordStepFailure(step.provider, step.model);

      // Check retry conditions (skip for first real attempt — always try at least once)
      if (triedCount > 1 && !shouldComboRetry(comboRule, lastComboError)) {
        console.log(`[Combo] Error type not retryable, stopping.`);
        break;
      }

      if (isNonAccountRequestError(lastComboError)) {
        continue; // Model/content error — skip to next step
      }
    }
  }

  const skippedNote = skippedSteps.length > 0
    ? ` Skipped: ${skippedSteps.join(", ")}.`
    : "";
  throw new Error(
    `Combo "${comboRule.name}" exhausted ${triedCount} attempt(s) ` +
    `(out of ${comboRule.steps.length} steps in chain). ` +
    `Tried: ${attemptedSteps.join(" → ")}.${skippedNote} Last error: ${lastComboError}`
  );
}

// Re-exported from the provider registry (single source of truth). Kept as
// named exports here so existing import sites (proxy/index.ts, api/stats.ts,
// auth/runner.ts, api/image-studio.ts, auth/warmup-runner.ts) stay unchanged.
export { providers, getAllModels, type ProviderName };
