import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createTransport, Transporter } from 'nodemailer';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * Platform emails (verification, password reset, invitations) over SMTP.
 * Without MAIL_HOST (development only — production refuses to start) the
 * message is logged instead of sent so local flows remain usable.
 */
@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private readonly transporter: Transporter | null;
  private readonly from: string;

  constructor(config: ConfigService) {
    const mail = config.getOrThrow<{
      host: string;
      port: number;
      secure: boolean;
      auth: { user: string; pass: string };
      from: string;
    }>('mail');
    this.from = mail.from;
    this.transporter = mail.host
      ? createTransport({
          host: mail.host,
          port: mail.port,
          secure: mail.secure,
          auth: mail.auth.user ? mail.auth : undefined,
        })
      : null;
  }

  async send(message: MailMessage): Promise<void> {
    if (!this.transporter) {
      this.logger.warn(
        `MAIL_HOST not configured — email NOT sent (dev only). To: ${message.to} | ${message.subject}\n${message.text}`,
      );
      return;
    }
    await this.transporter.sendMail({ from: this.from, ...message });
  }

  sendEmailVerification(to: string, name: string, link: string) {
    return this.send(
      this.compose(
        to,
        'Verify your email address',
        name,
        [
          'Please confirm your email address to finish setting up your account.',
        ],
        'Verify email',
        link,
        'This link expires in 24 hours.',
      ),
    );
  }

  sendPasswordReset(to: string, name: string, link: string) {
    return this.send(
      this.compose(
        to,
        'Reset your password',
        name,
        [
          'We received a request to reset your password.',
          'If you did not request this, you can ignore this email.',
        ],
        'Reset password',
        link,
        'This link expires in 1 hour.',
      ),
    );
  }

  sendInvitation(
    to: string,
    inviterName: string,
    tenantName: string,
    roleName: string,
    link: string,
  ) {
    return this.send(
      this.compose(
        to,
        `You're invited to join ${tenantName}`,
        null,
        [
          `${inviterName} invited you to join the workspace "${tenantName}" as ${roleName}.`,
        ],
        'Accept invitation',
        link,
        'This invitation expires in 7 days.',
      ),
    );
  }

  private compose(
    to: string,
    subject: string,
    name: string | null,
    paragraphs: string[],
    cta: string,
    link: string,
    footnote: string,
  ): MailMessage {
    const greeting = name ? `Hi ${name},` : 'Hi,';
    const text = [
      greeting,
      '',
      ...paragraphs,
      '',
      `${cta}: ${link}`,
      '',
      footnote,
    ].join('\n');
    const html = [
      `<p>${escapeHtml(greeting)}</p>`,
      ...paragraphs.map((p) => `<p>${escapeHtml(p)}</p>`),
      `<p><a href="${escapeHtml(link)}">${escapeHtml(cta)}</a></p>`,
      `<p style="color:#6b7280;font-size:13px">${escapeHtml(footnote)}</p>`,
    ].join('\n');
    return { to, subject, text, html };
  }
}
