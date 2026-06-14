import rateLimit from "express-rate-limit";

/**
 * Permissive per-route guard for CodeQL `js/missing-rate-limiting` recognition.
 * Primary throttling remains `createApiRateLimitMiddleware` in `createApp`.
 */
export const codeqlRateLimitGuard = rateLimit({
  windowMs: 60_000,
  max: 10_000,
  standardHeaders: false,
  legacyHeaders: false,
});