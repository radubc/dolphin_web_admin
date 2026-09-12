/**
 * Query schemas for the Cost center routes.
 *
 * Shape and size only. There is nothing to normalise and nothing to refuse on
 * business grounds — both endpoints are reads of cached rows — so the one job
 * here is to stop `?days=100000` from asking the database for a scan of
 * everything it has.
 *
 * Plain zod, no server imports: safe to import from anywhere.
 */
import { z } from "zod";
import { COST_DAYS_DEFAULT, COST_DAYS_MAX } from "./types";

/**
 * `GET /api/v1/admin/costs/daily?days=35`.
 *
 * Capped at {@link COST_DAYS_MAX} because that is roughly the 14 months Cost
 * Explorer itself keeps; a larger window could only return rows that were
 * never fetched.
 */
export const costDailyQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(COST_DAYS_MAX).default(COST_DAYS_DEFAULT),
});

export type ResolvedCostDailyQuery = z.infer<typeof costDailyQuerySchema>;
