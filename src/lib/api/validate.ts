/**
 * Input validation at the server boundary.
 *
 * Every request body and query string must pass through one of these helpers.
 * They turn zod failures into a 422 `validation_failed` with flattened issues,
 * and transport-level problems (wrong content type, unparseable JSON, oversized
 * payload) into a 400 `bad_request`.
 */
import { z } from "zod";
import { BadRequestError, ValidationError } from "./errors";

/**
 * Hard cap on a JSON request body. Nothing this API accepts is anywhere near
 * this size; the limit exists so a hostile client cannot make us buffer
 * megabytes of text before validation runs.
 */
export const MAX_JSON_BODY_BYTES = 1024 * 1024; // 1 MiB

/** Shape of the `details` we attach to a `ValidationError`. */
export interface ValidationDetails {
  formErrors: string[];
  fieldErrors: Record<string, string[] | undefined>;
}

/**
 * Flattens a zod error into `{ formErrors, fieldErrors }`.
 *
 * zod 4 moved this off the error instance: `error.flatten()` is deprecated in
 * favour of the free function `z.flattenError()` (`z.treeifyError()` gives the
 * nested variant if a future endpoint needs it).
 */
function toValidationDetails(error: z.ZodError): ValidationDetails {
  return z.flattenError(error) as ValidationDetails;
}

/** Raises a 422 carrying the flattened issues. */
function validationFailed(error: z.ZodError): never {
  throw new ValidationError(
    "The submitted data is invalid.",
    toValidationDetails(error),
  );
}

/** True for `application/json` and its `+json` structured-suffix relatives. */
function isJsonContentType(header: string | null): boolean {
  if (!header) {
    return false;
  }
  const mediaType = header.split(";", 1)[0].trim().toLowerCase();
  return mediaType === "application/json" || mediaType.endsWith("+json");
}

/**
 * Drains a request body while counting bytes, aborting the moment the cap is
 * crossed so an oversized (or chunked, or lying-about-`Content-Length`) body
 * is never fully buffered.
 *
 * @throws {BadRequestError} oversized or unreadable body.
 */
async function readBodyWithCap(
  request: Request,
  maxBytes: number,
): Promise<string> {
  if (!request.body) {
    return "";
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      received += value.byteLength;
      if (received > maxBytes) {
        await reader.cancel();
        throw new BadRequestError("Request body is too large.");
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof BadRequestError) {
      throw error;
    }
    throw new BadRequestError("Request body could not be read.");
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/**
 * Reads, size-checks and validates a JSON request body.
 *
 * The size cap is enforced twice: optimistically from `Content-Length` (so an
 * honest client is refused before any bytes are read) and for real while the
 * body streams in, because `Content-Length` is absent on chunked requests and
 * is not trustworthy.
 *
 * @throws {BadRequestError} wrong content type, oversized body, or invalid JSON.
 * @throws {ValidationError} the JSON did not match `schema`.
 */
export async function parseJsonBody<T>(
  request: Request,
  schema: z.ZodType<T>,
): Promise<T> {
  if (!isJsonContentType(request.headers.get("content-type"))) {
    throw new BadRequestError("Expected a JSON request body.");
  }

  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_JSON_BODY_BYTES) {
    throw new BadRequestError("Request body is too large.");
  }

  const text = await readBodyWithCap(request, MAX_JSON_BODY_BYTES);

  if (text.trim() === "") {
    throw new BadRequestError("Request body is empty.");
  }

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new BadRequestError("Request body is not valid JSON.");
  }

  const result = schema.safeParse(json);
  if (!result.success) {
    validationFailed(result.error);
  }
  return result.data;
}

/**
 * Validates query parameters against a schema.
 *
 * Repeated keys collapse to an array so `?tag=a&tag=b` can be modelled as
 * `z.array(z.string())`; single values stay strings. Use `z.coerce` (or
 * `z.stringbool()`) in the schema for numbers and booleans.
 *
 * @throws {ValidationError} when the parameters do not match `schema`.
 */
export function parseSearchParams<T>(
  url: URLSearchParams | { searchParams: URLSearchParams },
  schema: z.ZodType<T>,
): T {
  // Duck-typed on purpose: `request.nextUrl` is a `NextURL`, which exposes
  // `searchParams` but is not an `instanceof URL`.
  const params = "searchParams" in url ? url.searchParams : url;
  const raw: Record<string, string | string[]> = {};
  for (const key of new Set(params.keys())) {
    const values = params.getAll(key);
    raw[key] = values.length > 1 ? values : values[0];
  }

  const result = schema.safeParse(raw);
  if (!result.success) {
    validationFailed(result.error);
  }
  return result.data;
}
