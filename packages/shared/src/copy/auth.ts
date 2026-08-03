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
   */
  signInFailed: 'That email and password did not match. Try again.',
  signUpFailed: 'Could not create the account. The email may already be in use.',
  passwordTooShort: 'Passwords need at least 8 characters.',
  offline: 'Could not reach Beans. Check that the server is running.',

  householdTitle: 'Name your household',
  /** The field label. Distinct from the heading, which already says "name your household". */
  householdNameLabel: 'Household name',
  householdBlurb:
    'Everything you connect belongs to a household, and it is what you share with anyone you invite. You can rename it later.',
  householdPlaceholder: 'The Smiths',
  createHousehold: 'Create household',
  householdFailed: 'Could not create the household. Try again.',
} as const
