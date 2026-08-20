# Dashboard API Contract Design

## Goal

Prevent structural drift between the dashboard HTTP server and browser client while preserving current routes, authentication, status codes, and runtime validation.

## Current Problem

`packages/contracts` owns domain schemas, but `apps/web/src/api.ts` defines many endpoint response schemas inline while `apps/control-plane/src/http` independently parses request bodies and constructs responses. TypeScript sees JSON timestamps as plain `string`, so database timestamp representations can pass static checks and fail runtime ISO datetime validation.

## Design

### Shared endpoint schemas

Add a dashboard API contract module under `packages/contracts` containing request and response Zod schemas for dashboard endpoints. Export inferred TypeScript types from each schema. The module owns wire-format shapes, not database row shapes.

The initial migration covers worker configuration, worker queries, pools, settings, repositories, runs, onboarding, and mutation responses. Existing domain schemas are reused rather than duplicated.

### Typed client and server usage

`apps/web/src/api.ts` imports response and request schemas from the shared module. Inline endpoint schemas are removed where an equivalent shared schema exists.

Control-plane handlers use the same schemas for request parsing and response validation at the HTTP boundary. Endpoint URLs, methods, authentication, status codes, and error payloads remain unchanged.

A lightweight endpoint metadata type records method, path parameters, request schema, and response schema for migrated endpoints. It is used for compile-time `satisfies` checks and typed client helpers, without introducing generated code or a generic router abstraction.

### Boundary timestamp normalization

Database and protocol adapters normalize `Date | string` values to ISO-8601 strings before applying shared wire schemas. Invalid values remain invalid and are rejected by runtime schema parsing. Domain and wire timestamps remain strings at the JSON boundary because TypeScript cannot validate external data at compile time.

### Error behavior

Existing API error codes and status codes are preserved. Schema failures continue to produce the existing `invalid_request` or `invalid_response` behavior. No retry or fallback behavior is added.

## Testing

- Compile-time `satisfies` assertions verify representative endpoint definitions use the intended schemas.
- Runtime tests verify server parsing and response shapes against shared schemas.
- Browser API tests verify representative requests consume the shared response schemas.
- Timestamp tests cover PostgreSQL-style timestamps, JavaScript `Date` values, ISO strings, and invalid values.
- Existing control-plane and web suites remain unchanged except for contract coverage additions.

## Non-goals

- No route renaming or versioning.
- No OpenAPI or code-generation pipeline.
- No migration of worker socket protocol messages into the dashboard endpoint map.
- No redesign of authentication or error handling.
- No database schema changes.
