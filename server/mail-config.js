import { isIP } from 'node:net';

const DNS_LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const DNS_NAME = new RegExp('^(?:' + DNS_LABEL + '\\.)*' + DNS_LABEL + '$', 'i');
const MAIL_ATOM = "[a-z0-9!#$%&'*+/=?^_`{|}~-]+";
const ADDRESS = new RegExp('^' + MAIL_ATOM + '(?:\\.' + MAIL_ATOM + ')*@(?:' + DNS_LABEL + '\\.)+' + DNS_LABEL + '$', 'i');
const CONTROL = /[\u0000-\u001f\u007f]/;

export const isMailAddress = (value) => typeof value === 'string' && value.length <= 120 && !CONTROL.test(value) && ADDRESS.test(value);
export const isMailHost = (value) => Boolean(value && value.length <= 120 && (isIP(value) || DNS_NAME.test(value.replace(/\.$/, ''))));

export function readMailConfig(get) {
  const rawPort = get('smtpPort', '');
  const rawSecure = get('smtpSecure', '');
  const port = rawPort === '' ? (rawSecure === '1' ? 465 : 587) : Number(rawPort);
  return {
    host: get('smtpHost', '').trim(),
    port,
    secure: rawSecure === '' ? port === 465 : rawSecure === '1' ? true : rawSecure === '0' ? false : null,
    user: get('smtpUser', '').trim(),
    pass: get('smtpPass', ''),
    from: get('smtpFrom', '').trim(),
    fromName: get('smtpFromName', 'Everony').trim() || 'Everony',
  };
}

export function describeMailConfig(cfg) {
  const issues = [];
  const issue = (code, message) => issues.push({ code, message });
  if (!cfg.host) issue('SMTP_HOST_REQUIRED', '请填邮件服务商提供的 SMTP 服务器地址。');
  else if (!isMailHost(cfg.host)) issue('SMTP_HOST_INVALID', 'SMTP 服务器地址只填主机名或 IP，不要加协议、路径或端口。');
  if (!Number.isInteger(cfg.port) || cfg.port < 1 || cfg.port > 65535) issue('SMTP_PORT_INVALID', 'SMTP 端口必须为 1–65535 的整数。');
  if (typeof cfg.secure !== 'boolean') issue('SMTP_MODE_INVALID', '请选择 TLS 直连或 STARTTLS。');
  else if ((cfg.port === 465 && !cfg.secure) || (cfg.port === 587 && cfg.secure)) {
    issue('SMTP_PORT_MODE_MISMATCH', '465 端口请选择 TLS 直连，587 端口请选择 STARTTLS。');
  }
  if (CONTROL.test(cfg.user || '')) issue('SMTP_USER_INVALID', '登录名不能包含换行或控制字符。');
  if (CONTROL.test(cfg.pass || '')) issue('SMTP_AUTHORIZATION_INVALID', '密码或授权码不能包含换行或控制字符。');
  const hasPass = Boolean(cfg.pass?.trim());
  if (cfg.user && !hasPass) issue('SMTP_AUTHORIZATION_REQUIRED', '已填写登录名，请补填服务商提供的 SMTP 授权码或应用专用密码。');
  if (!cfg.user && hasPass) issue('SMTP_USER_REQUIRED', '已保存授权码，请填写登录名；免认证中继不应保存授权码。');
  const from = cfg.from || cfg.user;
  if (cfg.from && !isMailAddress(cfg.from)) issue('SMTP_SENDER_INVALID', '发件人请填写有效的邮箱地址，不要添加姓名或尖括号。');
  else if (!isMailAddress(from)) issue('SMTP_SENDER_REQUIRED', '请填写服务商允许的发件邮箱；仅当登录名本身是邮箱时才可留空。');
  return { ready: issues.length === 0, issues, from };
}
