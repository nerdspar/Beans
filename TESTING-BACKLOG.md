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

- [ ] Dockerfile builds. **It currently cannot** — it copies `apps/web/dist`, which does not exist
      until milestone 6, and the API has no build script yet. Both need doing before any deploy.
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
- [ ] `errlist` surfaces to the UI rather than being swallowed
- [ ] Reconnect preserves history and creates no duplicate accounts
- [ ] Confirm the daily request budget is not exceeded under the real schedule

---

## Not blocked, just not done yet

- [ ] Route-level tests for the household and invite endpoints. The HTTP layer was verified by hand
      (create household, invite, join, token reuse rejected, non-owner rejected, unauthenticated
      rejected) but has no automated coverage. The repository layer beneath it does.
- [ ] Email verification flow (`requireEmailVerification`) — off by default, never exercised.
