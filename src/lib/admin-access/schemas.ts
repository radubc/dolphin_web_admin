/**
 * Request-body schemas for the admin-access routes. Shape and size only: the
 * repository owns the business rules (uniqueness, unknown keys, lockouts), so
 * a client that skips these still cannot break an invariant.
 */
import { z } from "zod";

const roleKeys = z.array(z.string().min(1).max(64)).max(50);
const actionKeys = z.array(z.string().min(1).max(64)).max(200);

export const createAdminUserSchema = z.object({
  email: z.string().trim().min(3).max(320),
  displayName: z.string().trim().max(120).nullable().optional(),
  roleKeys: roleKeys.default([]),
  isSuperAdmin: z.boolean().default(false),
});

export const updateAdminUserSchema = z
  .object({
    displayName: z.string().trim().max(120).nullable().optional(),
    roleKeys: roleKeys.optional(),
    isSuperAdmin: z.boolean().optional(),
    disabled: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: "Nothing to update.",
  });

export const createRoleSchema = z.object({
  key: z.string().trim().min(1).max(64),
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).nullable().optional(),
  actionKeys: actionKeys.default([]),
});

export const updateRoleSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    description: z.string().trim().max(500).nullable().optional(),
    actionKeys: actionKeys.optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: "Nothing to update.",
  });

const ruleActionKeys = z.array(z.string().min(1).max(64)).max(100);

export const upsertPageRuleSchema = z.object({
  actionKeys: ruleActionKeys.optional(),
  requireSuperAdmin: z.boolean().optional(),
  isEnabled: z.boolean().optional(),
  navOrder: z.number().int().min(0).max(10_000).optional(),
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().trim().max(500).nullable().optional(),
});

export const upsertEndpointRuleSchema = z.object({
  actionKeys: ruleActionKeys.optional(),
  requireSuperAdmin: z.boolean().optional(),
  isEnabled: z.boolean().optional(),
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().trim().max(1000).nullable().optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
});
