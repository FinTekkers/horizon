// The owner's "new active customer" email (HZ-634), so they can book the
// setup call. Sent through the contact form's Gmail account (config.js's
// ownerMailConfig). The mailer is anything with sendMail(msg) → Promise:
// production gets gmailMailer(), tests pass a stub through buildApp({ mailer }).

import nodemailer from 'nodemailer'
import { ownerMailConfig } from './config.js'

let transport = null
let transportKey = null

// Production's mailer, built lazily and rebuilt if the account changes. Null
// while GMAIL_USER or GMAIL_APP_PASSWORD is unset.
export function gmailMailer() {
  const { user, pass } = ownerMailConfig()
  if (!user || !pass) return null
  const key = `${user}\n${pass}`
  if (!transport || transportKey !== key) {
    transport = nodemailer.createTransport({ service: 'gmail', auth: { user, pass } })
    transportKey = key
  }
  return transport
}

// Header values come from a sign-up form: keep them on one line.
const oneLine = (value) => String(value ?? '').replace(/[\r\n]+/g, ' ').trim()

export function activationEmail({ name, email, company }, { from, to }) {
  return {
    from,
    to,
    subject: `Horizon: new active customer — ${oneLine(name)}`,
    text: [
      'A customer has paid for Horizon and is now active. Book their setup call.',
      '',
      `name: ${oneLine(name)}`,
      `email: ${oneLine(email)}`,
      `company: ${oneLine(company) || '(not given)'}`,
      '',
    ].join('\n'),
  }
}

// Sends the email. False, without sending, when there is no mailer or no
// recipient; a failed send rejects.
export async function sendActivationEmail(mailer, customer) {
  const { user, to } = ownerMailConfig()
  if (!mailer || !to) return false
  await mailer.sendMail(activationEmail(customer, { from: user ?? to, to }))
  return true
}
