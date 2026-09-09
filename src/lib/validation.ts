import { z } from 'zod';

import { REPORT_STATUSES, ROLES, SEVERITIES, THREAT_TYPES } from '@/constants/threats';
import { ApiError } from '@/api/errors';

/**
 * One schema set, used twice.
 *
 * Forms validate against these for immediate feedback, and every mock endpoint
 * re-validates the same schema before touching data. That double-check is the
 * point: client validation is a courtesy to the user, server validation is the
 * actual guarantee, and keeping them in one file stops them drifting apart.
 */

// --- Primitives -------------------------------------------------------------

export const emailSchema = z
  .string()
  .trim()
  .min(1, 'Email is required')
  .max(254, 'That email is too long')
  .email('Enter a valid email address')
  .transform((v) => v.toLowerCase());

/** Kenyan mobile numbers, accepted in any of the forms people actually type. */
export const phoneSchema = z
  .string()
  .trim()
  .regex(/^(\+?254|0)?7\d{8}$|^(\+?254|0)?1\d{8}$/, 'Enter a valid Kenyan mobile number');

export const passwordSchema = z
  .string()
  .min(10, 'Use at least 10 characters')
  .max(128, 'That password is too long')
  .regex(/[a-z]/, 'Include a lowercase letter')
  .regex(/[A-Z]/, 'Include an uppercase letter')
  .regex(/\d/, 'Include a number');

export const otpSchema = z
  .string()
  .trim()
  .regex(/^\d{6}$/, 'Enter the 6-digit code');

export const latLngSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});

// --- Auth -------------------------------------------------------------------

export const signInSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, 'Password is required'),
  rememberDevice: z.boolean().optional(),
});
export type SignInInput = z.infer<typeof signInSchema>;

export const signUpSchema = z
  .object({
    fullName: z
      .string()
      .trim()
      .min(2, 'Enter your full name')
      .max(80, 'That name is too long')
      .regex(/^[\p{L}\p{M}'\-.\s]+$/u, 'Use letters only'),
    email: emailSchema,
    phone: phoneSchema,
    /** Issued by an admin. Ties the account to an organisation and a role. */
    inviteCode: z
      .string()
      .trim()
      .min(4, 'Enter the invite code from your organisation')
      .max(24)
      .transform((v) => v.toUpperCase()),
    password: passwordSchema,
    confirmPassword: z.string(),
    acceptedTerms: z
      .boolean()
      .refine((v) => v === true, { message: 'You must accept the data handling policy' }),
  })
  .refine((v) => v.password === v.confirmPassword, {
    message: 'Passwords do not match',
    path: ['confirmPassword'],
  })
  .refine(
    (v) => {
      const first = v.fullName.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
      return first.length < 3 || !v.password.toLowerCase().includes(first);
    },
    { message: 'Do not use your name in your password', path: ['password'] },
  );
export type SignUpInput = z.infer<typeof signUpSchema>;

export const forgotPasswordSchema = z.object({ email: emailSchema });

export const verifyCodeSchema = z.object({
  email: emailSchema,
  code: otpSchema,
  purpose: z.enum(['password-reset', 'email-verification', 'sign-in']),
});

export const resetPasswordSchema = z
  .object({
    email: emailSchema,
    resetToken: z.string().min(8),
    password: passwordSchema,
    confirmPassword: z.string(),
  })
  .refine((v) => v.password === v.confirmPassword, {
    message: 'Passwords do not match',
    path: ['confirmPassword'],
  });

export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, 'Enter your current password'),
    password: passwordSchema,
    confirmPassword: z.string(),
  })
  .refine((v) => v.password === v.confirmPassword, {
    message: 'Passwords do not match',
    path: ['confirmPassword'],
  })
  .refine((v) => v.password !== v.currentPassword, {
    message: 'Choose a password you have not used here before',
    path: ['password'],
  });

// --- Profile ----------------------------------------------------------------

export const onboardingSchema = z.object({
  operatingRegions: z
    .array(z.string())
    .min(1, 'Select at least one region you work in')
    .max(8, 'Select no more than 8 regions'),
  jobTitle: z.string().trim().max(80).optional(),
  shareLocation: z.boolean(),
});

export const profileUpdateSchema = z.object({
  fullName: z.string().trim().min(2, 'Enter your full name').max(80).optional(),
  phone: phoneSchema.optional(),
  jobTitle: z.string().trim().max(80).nullable().optional(),
  operatingRegions: z.array(z.string()).max(12).optional(),
  notificationPreferences: z
    .object({
      push: z.boolean(),
      criticalOnly: z.boolean(),
      quietHours: z.object({
        enabled: z.boolean(),
        startHour: z.number().int().min(0).max(23),
        endHour: z.number().int().min(0).max(23),
      }),
    })
    .optional(),
});

// --- Reports ----------------------------------------------------------------

export const reportDraftSchema = z.object({
  description: z
    .string()
    .trim()
    .min(20, 'Describe what happened in at least 20 characters')
    .max(2000, 'Keep the description under 2000 characters'),
  reportedType: z.enum(THREAT_TYPES).nullable(),
  location: latLngSchema,
  locationAccuracyMeters: z.number().nonnegative().nullable(),
  locationSource: z.enum(['gps', 'manual-pin']),
  photoUrl: z.string().nullable(),
  occurredAt: z.string().datetime({ offset: true }).or(z.string().datetime()),
});
export type ReportDraftInput = z.infer<typeof reportDraftSchema>;

export const verifyReportSchema = z.object({
  reportId: z.string().min(1),
  threatType: z.enum(THREAT_TYPES),
  severity: z.enum(SEVERITIES),
  priority: z.number().int().min(1).max(10),
  alertRadiusMeters: z
    .number()
    .int()
    .min(250, 'Alert radius must be at least 250 m')
    .max(60_000, 'Alert radius cannot exceed 60 km'),
  confirmDuplicate: z.boolean(),
  duplicateOf: z.string().nullable(),
  note: z.string().trim().max(500).optional(),
});

export const dismissReportSchema = z.object({
  reportId: z.string().min(1),
  reason: z
    .string()
    .trim()
    .min(10, 'Give a reason of at least 10 characters - this is recorded in the audit log')
    .max(500),
});

// --- Alerts -----------------------------------------------------------------

export const advisorySchema = z.object({
  title: z.string().trim().min(6, 'Give the advisory a clear title').max(90),
  message: z
    .string()
    .trim()
    .min(20, 'Say what people should actually do, in at least 20 characters')
    .max(1200),
  severity: z.enum(SEVERITIES),
  threatType: z.enum(THREAT_TYPES).nullable(),
  regionIds: z.array(z.string()).min(1, 'Select at least one region'),
  location: latLngSchema.nullable(),
  radiusMeters: z.number().int().min(500).max(80_000).nullable(),
  expiresInHours: z.number().int().min(1).max(168),
  shareWithPartners: z.boolean(),
});

// --- SOS --------------------------------------------------------------------

export const sosTriggerSchema = z.object({
  location: latLngSchema,
  accuracyMeters: z.number().nonnegative().nullable(),
  reason: z.string().trim().max(200).nullable(),
});

export const sosResolveSchema = z.object({
  sosId: z.string().min(1),
  note: z.string().trim().min(5, 'Add a short resolution note for the record').max(500),
});

// --- Admin ------------------------------------------------------------------

export const inviteSchema = z.object({
  fullName: z.string().trim().min(2, 'Enter their full name').max(80),
  email: emailSchema,
  role: z.enum(ROLES),
  operatingRegions: z.array(z.string()).max(12),
});

export const organizationUpdateSchema = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  regions: z.array(z.string()).min(1, 'An organisation must operate in at least one region').optional(),
  crossSharePartners: z.array(z.string()).max(20).optional(),
  contactEmail: emailSchema.optional(),
  settings: z
    .object({
      defaultAdvisoryHours: z.number().int().min(1).max(168),
      dualControlForCritical: z.boolean(),
      anonymiseReportersToOfficers: z.boolean(),
    })
    .optional(),
});

// --- Route ------------------------------------------------------------------

export const routeQuerySchema = z.object({
  origin: latLngSchema,
  destination: latLngSchema,
  originLabel: z.string().max(120).optional(),
  destinationLabel: z.string().max(120).optional(),
  bufferMeters: z.number().int().min(500).max(10_000).default(2000),
  windowHours: z.number().int().min(1).max(2160).default(24 * 30),
});

export const reportFilterSchema = z.object({
  status: z.enum(REPORT_STATUSES).optional(),
  severities: z.array(z.enum(SEVERITIES)).optional(),
  types: z.array(z.enum(THREAT_TYPES)).optional(),
  regionIds: z.array(z.string()).optional(),
  windowHours: z.number().int().positive().optional(),
  search: z.string().trim().max(120).optional(),
  limit: z.number().int().min(1).max(200).optional(),
  cursor: z.string().nullable().optional(),
});

// --- Helpers ----------------------------------------------------------------

export type FieldErrors = Record<string, string>;

/** Flatten a ZodError into the `{ field: message }` shape forms consume. */
export function fieldErrorsFrom(error: z.ZodError): FieldErrors {
  const out: FieldErrors = {};
  for (const issue of error.issues) {
    const key = issue.path.join('.') || '_form';
    if (!out[key]) out[key] = issue.message;
  }
  return out;
}

/** Parse or throw a presentable 422. Used by every mock endpoint. */
export function parseOrThrow<T extends z.ZodTypeAny>(schema: T, value: unknown): z.infer<T> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new ApiError({
      kind: 'validation',
      message: 'validation failed',
      fieldErrors: fieldErrorsFrom(result.error),
    });
  }
  return result.data;
}

/** Non-throwing variant for live form feedback. */
export function validate<T extends z.ZodTypeAny>(
  schema: T,
  value: unknown,
): { ok: true; data: z.infer<T> } | { ok: false; errors: FieldErrors } {
  const result = schema.safeParse(value);
  return result.success ? { ok: true, data: result.data } : { ok: false, errors: fieldErrorsFrom(result.error) };
}

/** Password strength for the meter on sign-up and reset. */
export function passwordStrength(password: string): {
  score: 0 | 1 | 2 | 3 | 4;
  label: string;
  checks: { label: string; met: boolean }[];
} {
  const checks = [
    { label: 'At least 10 characters', met: password.length >= 10 },
    { label: 'Upper and lowercase letters', met: /[a-z]/.test(password) && /[A-Z]/.test(password) },
    { label: 'A number', met: /\d/.test(password) },
    { label: 'A symbol', met: /[^A-Za-z0-9]/.test(password) },
    { label: '14+ characters (recommended)', met: password.length >= 14 },
  ];

  const met = checks.filter((c) => c.met).length;
  const weakPattern = /^(password|123456|qwerty|letmein|welcome|admin)/i.test(password);
  const score = (weakPattern ? 0 : Math.min(4, Math.max(0, met - 1))) as 0 | 1 | 2 | 3 | 4;
  const labels = ['Very weak', 'Weak', 'Fair', 'Strong', 'Very strong'];

  return { score, label: labels[score], checks };
}

/**
 * Strip characters that could be used to smuggle markup or control sequences
 * into a rendered report. React Native does not interpret HTML, but this text
 * is also destined for push payloads and the web build.
 */
export function sanitizeText(input: string): string {
  let out = '';
  for (const ch of input) {
    const code = ch.codePointAt(0) ?? 0;
    const isControl = code < 0x20 || (code >= 0x7f && code <= 0x9f);
    const isInvisible =
      (code >= 0x200b && code <= 0x200f) || code === 0x2028 || code === 0x2029 || code === 0xfeff;
    if (isControl && ch !== '\n') continue;
    if (isInvisible) continue;
    out += ch;
  }
  return out
    .replace(/<\/?[a-zA-Z][^>]*>/g, '')
    .replace(/[ \t]{3,}/g, '  ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
