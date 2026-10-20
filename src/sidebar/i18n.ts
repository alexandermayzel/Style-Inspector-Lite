import english from '../../_locales/en/messages.json';

export const language = browser.i18n.getUILanguage().toLowerCase().startsWith('de') ? 'de' : 'en';
type Message = { message: string; placeholders?: Record<string, { content: string }> };
const fallback = english as Record<string, Message>;

export function t(key: string, ...values: Array<string | number>): string {
  const translated = browser.i18n.getMessage(key, values.map(String));
  if (translated) return translated;
  const entry = fallback[key];
  if (!entry) return fallback.error_generic!.message;
  return entry.message.replace(/\$([a-z\d]+)\$/gi, (_, name: string) => {
    const index = Number(entry.placeholders?.[name]?.content.slice(1)) - 1;
    return String(values[index] ?? '');
  });
}

const numberFormats = new Map<number, Intl.NumberFormat>();
const dateFormat = new Intl.DateTimeFormat(language, { dateStyle: 'medium', timeStyle: 'short' });
export const number = (value: number, digits = 2) => {
  let formatter = numberFormats.get(digits);
  if (!formatter) { formatter = new Intl.NumberFormat(language, { maximumFractionDigits: digits }); numberFormats.set(digits, formatter); }
  return formatter.format(value);
};
export const date = (value: string) => dateFormat.format(new Date(value));
export function reason(code?: string): string {
  if (!code) return t('reason_unknown');
  const key = `reason_${code.replace(/[^a-zA-Z0-9_]/g, '_')}`;
  return fallback[key] ? t(key) : t('reason_unknown');
}
