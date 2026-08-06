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

- [ ] `secure` cookies actually set and returned through the Cloudflare tunnel
- [ ] Sign-in rate limiting keys on the real client address: two browsers on different networks get
      separate buckets, and a request carrying a forged `CF-Connecting-IP` does not get a fresh one.
      The forged half only holds while the app publishes no port — so this also tests that.
- [ ] Session survives a full browser round trip on the real domain
- [ ] CSRF origin validation accepts the real origin and rejects others

### Container and deployment

Most of this section is gone because it happened: the image builds and publishes, migrations apply
on startup, and the master key loads — the app would not boot otherwise, and it has, repeatedly.

- [ ] `/health` reachable **through the tunnel** and reporting `database: ok`. The container's own
      healthcheck hits `127.0.0.1`, so it proves the app answers, not that the tunnel reaches it.
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
- [ ] Navigation order persisting across devices. The write path is now covered by integration
      tests against real Postgres — it had never worked at all, because a JavaScript array was being
      handed to a `jsonb` column — so what is unproven is only the cross-device half: reorder on a
      phone, open a laptop, find it there.
- [ ] **Mapping real SimpleFIN errors onto recommendations.** `assessConnection` currently infers
      what to recommend from status, consecutive failure count and age, because that is all the
      schema records. SimpleFIN's `errlist` carries structured reasons, and some of them are
      distinguishable — "needs re-authentication" versus "institution temporarily unavailable" —
      which would let the banner stop guessing. Needs a real connection that has actually failed to
      see what the Bridge returns in practice.
- [ ] **Whether mashing "Sync now" can exhaust the day's budget.** Reconnect and Sync now are wired
      now — the claim flow and `POST /api/connections/:id/sync` both exist — so what is left is the
      quota question against a real Bridge: `canSync` reserves part of the 24-per-day ceiling for
      the schedule, and that reservation has never been tested by somebody actually pressing the
      button repeatedly.
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
- [ ] **The client's cascade on account deletion.** The server logs one tombstone for the account and
      `applyDelta` deletes its balances and transactions by index on the client. The server half is
      covered; the IndexedDB half has been exercised by hand but has no automated test, because
      `apps/web` has no DOM test environment. If it were wrong the symptom would be a net worth that
      silently keeps a deleted account's history.
- [x] ~~The container image has never been built.~~ Built and pushed by CI for both amd64 and
      arm64: `ghcr.io/nerdspar/beans:latest`. It took two attempts — `pnpm install --prod` aborts
      with `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY` unless `CI=true` is set, because switching an
      existing install to production-only changes the shape of `node_modules` and pnpm will not purge
      it unattended. The symlinked-`node_modules`-across-stages worry turned out to be unfounded.
- [ ] **The image has never been run.** It builds, but nothing has started a container from it. The
      production bundle was exercised directly with `node` on the development machine, which covers
      the application but not the image: the entrypoint, the non-root user, the mounted master key,
      and whether migrations apply on first boot against the real database are all unproven.
- [ ] **There is no re-wrap job, so the master key cannot actually be rotated.** `households.key_version`
      exists, `LocalMasterKeyProvider` accepts several keys at once, and the "no master key for
      version N" error tells the operator to complete a re-wrap — but nothing implements one.
      ARCHITECTURE §5 claims rotation without downtime and that is currently untrue. It matters in
      practice: the first deployment necessarily reuses whatever key encrypted the existing data, so
      a development key becomes the production key with no supported way off it. The job needs to
      unwrap each household's DEK with its current version and re-wrap it with the new one, in a
      transaction, leaving both keys present until every row has moved.
- [ ] **Categories cannot be renamed, added or deleted from the UI.** The default set installs and is
      usable, and rules reference slugs rather than labels so renaming is safe to add later, but
      there is no screen for it. A household wanting a category Beans does not ship has no way to
      create one.
- [ ] **Rules cannot be reordered or edited.** They can be created, listed in application order, and
      deleted. Since the first match wins, order decides outcomes — and the only way to change it
      today is deleting a rule and creating it again.
- [ ] **Import against a real export.** The flow was exercised with a three-row CSV: mapped, staged,
      previewed, committed and reversed. What that does not cover is a real Empower or Mint file —
      thousands of rows, a debit/credit pair rather than one signed column, dates in an ambiguous
      format, and the seam logic that decides where imported history stops and synced history starts.
- [ ] **Invites have never been accepted.** Creating and revoking work, and the link is shown because
      mail is unconfigured. Nobody has followed one, so joining a household, the second member's view
      of shared accounts, and `is_shared` on a private account are all unproven.

