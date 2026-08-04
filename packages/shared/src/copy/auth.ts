import { MIN_PASSWORD_LENGTH } from '../auth/password.js'

/**
 * Copy for signing in, signing up, and creating a household.
 *
 * This is the first screen anybody sees, and for a self-hosted finance app it is also the moment
 * they are deciding whether to trust it. So the voice here is warm but the claims are literal —
 * nothing says "secure" or "private" as an adjective. `signInBlurb` states where the data actually
 * lives, which is a fact about this deployment rather than a promise.
 */

export const AUTH_COPY = {
  appName: 'Beans',

  signInTitle: 'Welcome back',
  signInBlurb: 'Your accounts and balances live on your server, not ours.',
  signUpTitle: 'Set up Beans',
  signUpBlurb: 'One account for you, and a household to put your money in.',

  email: 'Email',
  password: 'Password',
  name: 'Your name',

  signIn: 'Sign in',
  signUp: 'Create account',
  signOut: 'Sign out',
  google: 'Continue with Google',
  or: 'or',

  toSignUp: 'No account yet? Create one',
  toSignIn: 'Already have an account? Sign in',

  working: 'One moment',

  /*
   * Errors say what to do, and never guess at a cause. "Wrong password" would be a claim the server
   * did not make — Better Auth deliberately does not distinguish an unknown email from a bad
   * password, because doing so tells an attacker which emails have accounts.
   *
   * `signUpFailed` used to add "the email may already be in use", which broke that rule and was
   * wrong in the case people actually hit: a rate-limited request reported as a duplicate account.
   * When the server explains itself, its message is shown instead of either of these.
   */
  signInFailed: 'That email and password did not match. Try again.',
  signUpFailed: 'Could not create the account.',
  /*
   * Derived from the shared constant rather than typed as a literal. The previous version hard-coded
   * eight while the server required twelve, so the form told the user a requirement that was not the
   * one being enforced.
   */
  passwordTooShort: `Passwords need at least ${MIN_PASSWORD_LENGTH} characters.`,
  /** Shown before submitting, so the rule is not something you discover by being refused. */
  passwordHint: `At least ${MIN_PASSWORD_LENGTH} characters.`,
  offline: 'Could not reach Beans. Check that the server is running.',

  /**
   * Rate limiting, stated as a wait rather than a failure.
   *
   * This is the one that matters most to get right: on sign-in the previous code reported a
   * throttled request as a password mismatch, which sends somebody to reset a password that was
   * never wrong. Sign-up allows three attempts per five minutes, which a household setting up two
   * accounts can reach without doing anything unusual.
   */
  rateLimited: (seconds: number): string => {
    if (seconds <= 0) return 'Too many attempts just now. Try again in a moment.'
    const minutes = Math.ceil(seconds / 60)
    return seconds < 60
      ? `Too many attempts just now. Try again in ${seconds} seconds.`
      : `Too many attempts just now. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`
  },

  householdTitle: 'Name your household',
  /** The field label. Distinct from the heading, which already says "name your household". */
  householdNameLabel: 'Household name',
  householdBlurb:
    'Everything you connect belongs to a household, and it is what you share with anyone you invite. You can rename it later.',
  householdPlaceholder: 'The Smiths',
  createHousehold: 'Create household',
  householdFailed: 'Could not create the household. Try again.',

  /** The automatic household step. Neither is a place the user does anything. */
  settingUp: 'Setting things up…',
  retry: 'Try again',
} as const
