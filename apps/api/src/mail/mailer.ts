import { createTransport } from 'nodemailer'
import { Resend } from 'resend'
import type { Config, MailTransport } from '../config.js'

/**
 * Outbound mail.
 *
 * Three real implementations, so this is not a single-implementation abstraction: Resend, SMTP,
 * and disabled. The last one is the important one — a self-hosted install may have no mail at all,
 * and Beans must stay fully usable there. **Household invites always work as copy-paste links**,
 * so onboarding never depends on any of this.
 */

export type MailMessage = {
  to: string
  subject: string
  text: string
  html?: string
}

export interface Mailer {
  /** False when no transport is configured. Callers branch on this rather than catching failures. */
  readonly enabled: boolean
  send(message: MailMessage): Promise<void>
}

/**
 * The no-op transport.
 *
 * Deliberately succeeds rather than throwing. A missing mailer is a supported configuration, not
 * an error state — but callers must check `enabled` and tell the user when something would have
 * been emailed, instead of silently doing nothing and implying it was sent.
 */
class DisabledMailer implements Mailer {
  readonly enabled = false

  async send(): Promise<void> {
    // Intentionally empty.
  }
}

class ResendMailer implements Mailer {
  readonly enabled = true
  readonly #client: Resend
  readonly #from: string

  constructor(apiKey: string, from: string) {
    this.#client = new Resend(apiKey)
    this.#from = from
  }

  async send(message: MailMessage): Promise<void> {
    const { error } = await this.#client.emails.send({
      from: this.#from,
      to: message.to,
      subject: message.subject,
      text: message.text,
      ...(message.html === undefined ? {} : { html: message.html }),
    })

    if (error !== null) {
      // The message body is deliberately not included — it may carry an invite link or a reset
      // token, and this string ends up in logs.
      throw new Error(`Resend rejected the message: ${error.message}`)
    }
  }
}

class SmtpMailer implements Mailer {
  readonly enabled = true
  readonly #transport: ReturnType<typeof createTransport>
  readonly #from: string

  constructor(url: string, from: string) {
    this.#transport = createTransport(url)
    this.#from = from
  }

  async send(message: MailMessage): Promise<void> {
    await this.#transport.sendMail({
      from: this.#from,
      to: message.to,
      subject: message.subject,
      text: message.text,
      ...(message.html === undefined ? {} : { html: message.html }),
    })
  }
}

export function createMailer(config: Config): Mailer {
  return createMailerFor(config.mail)
}

export function createMailerFor(transport: MailTransport): Mailer {
  switch (transport.kind) {
    case 'resend':
      return new ResendMailer(transport.apiKey, transport.from)
    case 'smtp':
      return new SmtpMailer(transport.url, transport.from)
    case 'disabled':
      return new DisabledMailer()
  }
}
