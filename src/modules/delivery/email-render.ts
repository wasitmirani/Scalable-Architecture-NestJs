/**
 * Server-side email rendering. `blocksToHtml`, `composeEmail`, `htmlToText` and
 * `emailText` are ports of frontend-react/src/utils/helpers/{email-html,template}.ts,
 * so a sent email matches the editor preview. Keep them in sync.
 */

export interface EmailBlock {
  id: string;
  type: 'heading' | 'text' | 'button' | 'image' | 'divider' | 'spacer' | 'social' | 'footer' | 'html';
  content: string;
  href?: string;
  align?: 'left' | 'center' | 'right';
  level?: 1 | 2 | 3;
  size?: number;
  color?: string;
  textColor?: string;
  fullWidth?: boolean;
  width?: number;
  alt?: string;
  height?: number;
  links?: Partial<Record<string, string>>;
  padding?: 'none' | 'sm' | 'md' | 'lg';
  bg?: string;
}

export interface EmailDesign {
  accent: string;
  background: string;
  paper: string;
  text: string;
  font: string;
  radius: number;
}

export const DEFAULT_DESIGN: EmailDesign = { accent: '#4f46e5', background: '#f1f5f9', paper: '#ffffff', text: '#1f2937', font: 'Inter', radius: 8 };
const PADDING_PX = { none: '0', sm: '6px 24px', md: '14px 24px', lg: '24px 32px' } as const;
const SOCIAL_NETWORKS = [
  { key: 'facebook', label: 'Facebook' },
  { key: 'instagram', label: 'Instagram' },
  { key: 'linkedin', label: 'LinkedIn' },
  { key: 'x', label: 'X' },
  { key: 'youtube', label: 'YouTube' },
];
const HEADING = { 1: 26, 2: 21, 3: 17 } as const;

export const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const nl = (s: string) => escapeHtml(s).replace(/\n/g, '<br />');

function cell(b: EmailBlock, d: EmailDesign): string {
  switch (b.type) {
    case 'heading':
      return `<h${b.level ?? 1} style="margin:0;font-size:${HEADING[b.level ?? 1]}px;line-height:1.25;font-weight:700;color:${b.color ?? d.text}">${nl(b.content)}</h${b.level ?? 1}>`;
    case 'text':
      return `<p style="margin:0;font-size:${b.size ?? 15}px;line-height:1.6;color:${b.color ?? d.text}">${nl(b.content)}</p>`;
    case 'button':
      return `<a href="${escapeHtml(b.href ?? '#')}" style="display:${b.fullWidth ? 'block' : 'inline-block'};padding:12px 24px;background:${b.color ?? d.accent};color:${b.textColor ?? '#ffffff'};border-radius:${Math.min(d.radius, 24)}px;text-decoration:none;font-weight:600">${escapeHtml(b.content)}</a>`;
    case 'image': {
      const img = `<img src="${escapeHtml(b.content)}" alt="${escapeHtml(b.alt ?? '')}" width="${Math.round((600 * (b.width ?? 100)) / 100)}" style="max-width:100%;height:auto;border:0;display:inline-block" />`;
      return b.href ? `<a href="${escapeHtml(b.href)}">${img}</a>` : img;
    }
    case 'divider':
      return '<hr style="border:0;border-top:1px solid #e5e7eb;margin:4px 0" />';
    case 'spacer':
      return `<div style="height:${b.height ?? 24}px;line-height:${b.height ?? 24}px">&nbsp;</div>`;
    case 'social':
      return SOCIAL_NETWORKS.filter((n) => b.links?.[n.key])
        .map((n) => `<a href="${escapeHtml(b.links![n.key]!)}" style="color:${b.color ?? '#6b7280'};text-decoration:none;margin:0 6px">${n.label}</a>`)
        .join(' ');
    case 'footer':
      return `<p style="margin:0;font-size:12px;line-height:1.5;color:${b.color ?? '#6b7280'}">${nl(b.content).replace(/\{\{\s*unsubscribe_url\s*\}\}/g, '<a href="{{unsubscribe_url}}" style="color:inherit">Unsubscribe</a>')}</p>`;
    case 'html':
      return b.content;
    default:
      return '';
  }
}

/** Table-based, inline-styled HTML that renders the same in Outlook, Gmail and Apple Mail. */
export function blocksToHtml(blocks: EmailBlock[], design: Partial<EmailDesign> = {}, subject = '', previewText = ''): string {
  const d = { ...DEFAULT_DESIGN, ...design };
  const rows = blocks
    .map((b) => `            <tr><td align="${b.align ?? 'left'}" style="padding:${PADDING_PX[b.padding ?? (b.type === 'spacer' || b.type === 'divider' ? 'sm' : 'md')]};${b.bg ? `background:${b.bg};` : ''}text-align:${b.align ?? 'left'}">${cell(b, d)}</td></tr>`)
    .join('\n');
  const preheader = previewText
    ? `\n    <div style="display:none;max-height:0;overflow:hidden;mso-hide:all">${escapeHtml(previewText)}</div>`
    : '';
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(subject)}</title>
  </head>
  <body style="margin:0;background:${d.background};font-family:${d.font}, Arial, sans-serif;color:${d.text}">${preheader}
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
      <tr>
        <td align="center" style="padding:24px">
          <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:${d.paper};border-radius:${d.radius}px">
${rows}
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>
`;
}

/** Brand header + template content + brand footer (blocks mode). */
export function composeEmail(
  t: { blocks?: EmailBlock[]; brandHeader?: boolean; brandFooter?: boolean },
  kit: { header?: EmailBlock[]; footer?: EmailBlock[] } | null | undefined,
): EmailBlock[] {
  const blocks = t.blocks ?? [];
  if (!kit) return blocks;
  return [
    ...(t.brandHeader ? (kit.header ?? []) : []),
    ...blocks,
    ...(t.brandFooter ? (kit.footer ?? []) : []),
  ];
}

/** Readable text of an HTML email, for the plain-text part. */
export const htmlToText = (html: string) =>
  html
    .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>|<\/(p|div|tr|h\d|li)>/gi, '\n')
    .replace(/<a [^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, '$2 ($1)')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n\s*\n+/g, '\n\n')
    .trim();

/** Plain-text part generated from blocks. */
export const emailText = (blocks: EmailBlock[]) =>
  blocks
    .filter((b) => ['heading', 'text', 'button', 'footer'].includes(b.type))
    .map((b) => (b.type === 'button' ? `${b.content}: ${b.href ?? ''}` : b.content))
    .join('\n\n');

/** Plain text (campaign body) → simple HTML paragraphs. */
export const textToHtml = (text: string, subject = '') =>
  blocksToHtml(
    text.split(/\n{2,}/).filter((p) => p.trim()).map((p, i) => ({ id: `p${i}`, type: 'text', content: p.trim() })),
    {},
    subject,
  );

/**
 * Replaces `{{key}}` placeholders. `escape` is on for HTML so contact data cannot
 * inject markup. Unknown keys become empty strings.
 */
export function personalize(source: string, values: Record<string, string>, escape: boolean): string {
  return source.replace(/{{\s*([\w.]+)\s*}}/g, (_, key: string) => {
    const v = values[key] ?? '';
    return escape ? escapeHtml(v) : v;
  });
}

/** Placeholder values for one recipient: contact fields, attributes, then run data. */
export function recipientValues(
  contact: Record<string, unknown> | null,
  extra: Record<string, string> = {},
): Record<string, string> {
  const c = contact ?? {};
  const s = (v: unknown) => (v === null || v === undefined ? '' : String(v));
  const attributes = (c.attributes ?? {}) as Record<string, unknown>;
  const values: Record<string, string> = {
    first_name: s(c.firstName),
    last_name: s(c.lastName),
    full_name: `${s(c.firstName)} ${s(c.lastName)}`.trim(),
    email: s(c.email),
    phone: s(c.phone),
    company: s(c.companyName),
    job_title: s(c.jobTitle),
    city: s(c.city),
    country: s(c.country),
  };
  for (const [k, v] of Object.entries(attributes)) {
    values[k] ??= s(v);
    values[`attributes.${k}`] = s(v);
  }
  for (const [k, v] of Object.entries(values)) values[`contact.${k}`] = v;
  return { ...values, ...extra };
}
