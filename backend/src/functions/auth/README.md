# auth

- `postConfirmation` — Cognito Post Confirmation trigger (wired via `template.yaml`'s `ApohcoUserPool.LambdaConfig`). Fires once a user set up via AdminCreateUser confirms their account; upserts a matching `Users` row (and a `GroupUsers` row for practice-level roles) so every UserId referenced elsewhere in the schema is always valid.

JWT verification itself is shared middleware, not a standalone function — see `../../shared/verifyToken.js` (`requireAuth`), used by every API-facing Lambda except `qboOAuthCallback` (a public redirect target — see its own comments) and this trigger (invoked directly by Cognito, not through API Gateway).
