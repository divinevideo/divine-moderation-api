# Repository Guidelines

## Project Structure & Module Organization
- Worker source and tests live in `src/`.
- Project metadata and scripts live in `package.json`; deployment config lives in `wrangler.toml`.
- Keep request handling, auth, queueing, and response shaping separated where practical instead of growing a single large Worker module.

## Build, Test, and Development Commands
- `npm install`: install dependencies.
- `npm run dev`: start the Worker locally with Wrangler.
- `npm test`: run the Vitest suite.
- `npm run deploy`: deploy the Worker through Wrangler.

## Coding Style & Naming Conventions
- Use modern JavaScript modules and keep request/response shapes explicit.
- Prefer focused helpers and endpoint-specific tests over broad shared utility buckets.
- Keep PRs tightly scoped. Do not mix unrelated cleanup, formatting churn, or speculative refactors into the same change.
- Temporary or transitional code must include `TODO(#issue):` with the tracking issue for removal.

## Pull Request Guardrails
- PR titles must use Conventional Commit format: `type(scope): summary` or `type: summary`.
- Set the correct PR title when opening the PR. Do not rely on fixing it afterward.
- If a PR title changes after opening, verify that the semantic PR title check reruns successfully.
- PR descriptions must include a short summary, motivation, linked issue, and manual test plan.
- Changes to public endpoints, auth behavior, or moderation payloads should include representative request or response examples when helpful.

## Security & Sensitive Information
- Do not commit secrets, bearer tokens, private moderation payloads, or sensitive customer data.
- Public issues, PRs, branch names, screenshots, and descriptions must not mention corporate partners, customers, brands, campaign names, or other sensitive external identities unless a maintainer explicitly approves it. Use generic descriptors instead.
