/**
 * Password policy.
 *
 * **One number, shared.** The server and the sign-up form each had their own before this: the API
 * required 12 characters and the form validated at 8, so an eight-character password passed
 * client-side validation, was submitted, and came back rejected. The form was enforcing a rule that
 * did not exist while telling the user the wrong requirement.
 *
 * Anything the API and the web app must agree on lives in shared, and a validation threshold is the
 * clearest possible case of that.
 */

/**
 * Twelve, not eight.
 *
 * Long enough to matter for an app holding a household's finances, and the length is stated up front
 * on the form rather than discovered by being refused.
 */
export const MIN_PASSWORD_LENGTH = 12

/** Better Auth's own ceiling; stated here so the form can stop typing rather than fail on submit. */
export const MAX_PASSWORD_LENGTH = 256
