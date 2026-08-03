# Manual testing backlog

Things that cannot be verified from the development machine and are deferred until the production
container is deployed at `https://beans.nerdspar.com`.

Everything here is **written and typechecked but not exercised against the real thing**. That
distinction matters: the code paths exist and compile, and in several cases the surrounding logic is
covered by tests, but the integration with the external service has never actually run.

Keep this list current. When an item is verified, delete it rather than ticking it — the point is to
know what is still unproven, not to keep a trophy case.

---

## Blocked on deployment

### Google OAuth (milestone 2)

Cannot be tested locally: Google rejects OAuth redirect URIs on bare IPs and `.local` names, so it
needs the real hostname with a valid certificate.

- [ ] Register redirect URI `https://beans.nerdspar.com/api/auth/callback/google` in Google Cloud
      Console
- [ ] Set `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`; confirm `/api/capabilities` flips
      `googleSignIn` to `true`
- [ ] Sign in with Google end to end, confirm a row lands in `auth_account` with
      `provider_id = 'google'`
- [ ] Confirm `accessType: 'offline'` actually yields a refresh token
- [ ] Confirm a Google sign-in and an email/password sign-in for the **same address** link to one
      `auth_user` rather than creating two
- [ ] Confirm the Google button is hidden when the env vars are absent

### Email delivery (milestone 2)

The mailer has three implementations and the disabled path is the only one exercised so far.

- [ ] Resend: verify the sending domain, set `RESEND_API_KEY`, confirm `/api/capabilities` flips
      `emailDelivery` to `true`
- [ ] Password reset end to end — request, receive, follow link, set new password, confirm old
      sessions are revoked (`revokeSessionsOnPasswordReset: true`)
- [ ] Invite email actually arrives, and the link in it works
- [ ] Confirm an invite still succeeds when mail delivery **fails** — the link must be returned
      regardless, since email is a convenience and the link is the mechanism
- [ ] SMTP fallback path with `SMTP_URL` set and `RESEND_API_KEY` empty

### Cookies and sessions behind the reverse proxy

Local development runs plain HTTP on `localhost`, which is exempt from several browser rules that
production is not.

- [ ] `secure` cookies actually set and returned through Nginx Proxy Manager
- [ ] `trustProxy` resolves the real client IP, so auth rate limiting is per-user rather than
      per-proxy
- [ ] Session survives a full browser round trip on the real domain
- [ ] CSRF origin validation accepts the real origin and rejects others

### Container and deployment

- [ ] Dockerfile builds. `apps/web/dist` now exists (milestone 6), but the **API still has no build
      script** — it runs via tsx in development and nothing bundles it for production. That is the
      remaining blocker.
- [ ] Migrations run on container startup, idempotently, against the existing database
- [ ] `/health` reachable through the proxy and reports `database: ok`
- [ ] Master key mounted correctly and readable by the container user
- [ ] Graceful shutdown on `SIGTERM` closes the pool without dropping in-flight requests

---

## Blocked on external accounts

### SimpleFIN (milestone 3)

The test suite runs against recorded fixtures so it never touches the network or burns quota. Live
behavior is a separate question.

- [ ] Claim a real setup token — single-use, so this is genuinely one-shot per token
- [ ] Real `/accounts` response shape matches our parser across several institutions
- [ ] **Credit card sign convention per institution.** The highest-risk item in the app: get it
      backwards and net worth is off by twice the card balance, in a plausible direction, with no
      error raised. Check every card institution individually.
- [ ] Pending transactions: confirm whether ids stay stable when they post, per institution
- [ ] **Whether any institution inverts transaction amounts as well as the balance.** We apply
      `provider_sign_inverted` to the balance only, reasoning that the protocol _does_ specify a
      transaction sign (positive = money in) and institutions generally follow a spec where one
      exists, while saying nothing about balances — which is why balances vary. If some institution
      inverts both, that account's derived history will **drift steadily rather than fail loudly**,
      because backward reconstruction subtracts transactions from the current balance and needs both
      in the same sign space. The milestone 4 reconstruction check should catch it; verify against
      real data for every card institution.
- [ ] `errlist` surfaces to the UI rather than being swallowed
- [ ] Reconnect preserves history and creates no duplicate accounts
- [ ] Confirm the daily request budget is not exceeded under the real schedule

---

## Not blocked, just not done yet

- [ ] Route-level tests for the household and invite endpoints. The HTTP layer was verified by hand
      (create household, invite, join, token reuse rejected, non-owner rejected, unauthenticated
      rejected) but has no automated coverage. The repository layer beneath it does.
- [ ] Route-level tests for the connection endpoints. Verified by hand only as far as auth gating
      (401 without a session); the full claim → discover → confirm → sync flow is covered at the
      repository layer but not over HTTP.
- [ ] **A scheduled sync actually firing.** The worker starts, registers its cron, and its handler
      is covered by the sync-service tests — but no scheduled tick has ever fired end to end, since
      that needs a live token and a wait. Verify the first real one lands, and that the jitter
      offset does not push it outside its window.
- [ ] Email verification flow (`requireEmailVerification`) — off by default, never exercised.
- [ ] **PWA install on a real device.** The manifest and service worker are generated and the
      iOS meta tags are set, but nothing has been added to a home screen. Verify standalone display,
      the icon, safe-area insets against a real notch, and that the app does not get stuck on a
      stale build after a deploy.
- [ ] Tab reordering persisting across devices. The optimistic update and the endpoint both exist,
      but the round trip has only been exercised signed-out (401), so the persisted path is
      unproven.
- [ ] **Mapping real SimpleFIN errors onto recommendations.** `assessConnection` currently infers
      what to recommend from status, consecutive failure count and age, because that is all the
      schema records. SimpleFIN's `errlist` carries structured reasons, and some of them are
      distinguishable — "needs re-authentication" versus "institution temporarily unavailable" —
      which would let the banner stop guessing. Needs a real connection that has actually failed to
      see what the Bridge returns in practice.
- [ ] **The banner's actions do nothing yet.** Reconnect, Sync now and Try now render and are
      reachable, but none is wired — reconnect needs the claim flow, and the two sync buttons need
      an endpoint that triggers a run on demand and reports back. Verify against the Bridge's
      24-requests-per-day ceiling that a user mashing "Sync now" cannot exhaust the day's budget.
- [ ] Whether carrying a balance flat is the right default for **investment** accounts specifically.
      Backward reconstruction is already wrong for them (§4), and a flat line through a month of
      market movement is visibly false in a different way than it is for a credit card. May want to
      stop the series at the last observation rather than carry it.
- [ ] **Google sign-in has never run.** The button is rendered only when the server reports
      `googleSignIn`, which needs real OAuth credentials and a public HTTPS origin — Google rejects
      redirect URIs on bare IPs and `.local` names. Verify the round trip, and that a Google account
      matching an existing email links rather than creating a second user.
- [ ] Session expiry clearing the working set. The code path exists and is exercised by a 401 from
      the working-set endpoint, but only ever seen by signing out — never by an actually expired
      session, which needs waiting out the real TTL.
- [ ] Delta sync against data that changes *while a client is connected* — a sync landing mid-session,
      an account being removed in another tab. Covered at the repository layer with explicit cursors;
      never observed live.
- [ ] **A real SimpleFIN setup token has never been claimed.** The whole connect flow was verified
      against a mock Bridge served over HTTPS on localhost — claim, discovery, the sign-confirmation
      screen, confirm, first sync, and the resulting net worth. What that cannot tell us is how *your*
      institutions actually report their balances: which ones send a card as a positive amount owed,
      whether the type guesses land, and whether any of them return something the parser has not
      seen. Expect to sit with the confirmation screen the first time.
- [ ] **Transport failures reaching the Bridge surface as a bare 500.** `claimSetupToken` lets a
      fetch rejection propagate, so a DNS failure or a TLS problem reaches the user as "Internal
      Server Error" with nothing actionable. Seen while pointing the API at a mock with an untrusted
      certificate. Wrap the transport in `SimplefinError` so the message says the Bridge could not be
      reached.
- [ ] Whether the request-budget refusal (429 with `retryAfter`) reads sensibly in the UI. The route
      returns it and the screen shows the message, but the ceiling has never actually been hit.

