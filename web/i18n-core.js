'use strict';
/*
 * The translation engine, plus the words the sign-in page shows.
 *
 * All of this used to live in i18n.js, which is thirty-eight kilobytes
 * compressed: the whole panel's vocabulary, every dialog and every table
 * heading. The sign-in page was loading all of it to translate eight labels,
 * and on a filtered link that was most of the wait before the form appeared.
 * So the engine and the sign-in words are here - a kilobyte and a half - and
 * i18n.js carries the rest of the dictionary, handing it to add() when the
 * panel itself loads.
 *
 * Each string still lives in exactly one place; nothing is written twice.
 */

/* a classic script shares one global scope with app.js, so everything in here
   stays inside the closure and only NEXV_I18N comes out */
(function () {

const LANGS = [
  { code: 'en', label: 'English', dir: 'ltr' },
  { code: 'fa', label: 'فارسی', dir: 'rtl' }
];

/* the sign-in page, and the two controls that sit in its corner */
const FA = {
  'Welcome back': 'خوش آمدید',
  'Sign in to manage your server': 'برای مدیریت سرورتان وارد شوید',
  'Xray-core management': 'مدیریت هسته Xray',
  'Sign in': 'ورود',
  'Signing in…': 'در حال ورود…',
  'Wrong username or password.': 'نام کاربری یا گذرواژه اشتباه است.',
  'that username is taken': 'این نام کاربری گرفته شده است',
  'this panel already has an account - sign in instead': 'این پنل از قبل حساب دارد — وارد شوید',
  'this address is not open': 'این آدرس باز نیست',
  'username and password are required': 'نام کاربری و گذرواژه لازم است',
  'invalid credentials': 'اطلاعات ورود نادرست است',
  'Sign-in failed.': 'ورود ناموفق بود.',
  'Could not reach the server.': 'نتوانست به سرور برسد.',
  'The server did not respond. Try again.': 'سرور جواب نداد. دوباره تلاش کنید.',
  'Opening panel…': 'در حال باز کردن پنل…',
  'Signed in, but the panel page did not load. Check "nexv logs" on the server.':
    'وارد شدید، ولی صفحه پنل بالا نیامد. روی سرور «nexv logs» را ببینید.',
  'Set up your panel': 'پنل خود را بسازید',
  'Choose a username and password. This happens once.':
    'یک نام کاربری و گذرواژه انتخاب کنید. این کار فقط یک بار انجام می‌شود.',
  'Create my account': 'ساخت حساب',

  'Light or dark': 'روشن یا تیره',
  'Language': 'زبان',
  'Username': 'نام کاربری',
  'Password': 'رمز عبور',
};

/* i18n.js fills these in; the sign-in page needs none of them */
let PATTERNS = [];

let current = 'en';

function lang() { return current; }

function setLang(code) {
  current = LANGS.some((l) => l.code === code) ? code : 'en';
  const meta = LANGS.find((l) => l.code === current);
  document.documentElement.lang = current;
  document.documentElement.dir = meta.dir;
  document.body.dir = meta.dir;
  try { localStorage.setItem('nexv-lang', current); } catch (_) { /* private window */ }
  return current;
}

function stored() {
  try { return localStorage.getItem('nexv-lang') || ''; } catch (_) { return ''; }
}

/** English in, the current language out - unchanged when there is no entry. */
function t(value) {
  if (current === 'en' || typeof value !== 'string' || !value) return value;
  const key = value.trim();
  if (Object.prototype.hasOwnProperty.call(FA, key)) {
    // keep whatever spacing the caller had around it
    return value.replace(key, FA[key]);
  }
  for (const [re, build] of PATTERNS) {
    const m = re.exec(key);
    if (m) return build(m);
  }
  return value;
}

/**
 * i18n.js hands the rest of the panel's dictionary in through here, once it
 * has loaded. Anything already translated before that - the sign-in page, and
 * the first paint of the panel's own shell - comes out of FA above.
 */
function add(words, patterns) {
  if (words) Object.assign(FA, words);
  if (patterns) PATTERNS = PATTERNS.concat(patterns);
}

window.NEXV_I18N = { t, setLang, lang, stored, add, LANGS };

}());
