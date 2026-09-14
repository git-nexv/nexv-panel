'use strict';
/*
 * Persian for the panel.
 *
 * Every string a person reads is set through one of three helpers - el()'s
 * `text` and `html`, a field's label, or a dialog's title - so the translation
 * hooks in there rather than at four hundred call sites. A string with no entry
 * comes back exactly as it was written, which means an untranslated corner is
 * English rather than blank, and adding a line here is all it takes to fix one.
 *
 * Sentences that carry a number or a name are handled by PATTERNS: the English
 * is matched by shape and rebuilt in Persian with the pieces in the right
 * order, because Persian does not put them where English does.
 */

/* a classic script shares one global scope with app.js, so everything in here
   stays inside the closure and only NEXV_I18N comes out */
(function () {

const LANGS = [
  { code: 'en', label: 'English', dir: 'ltr' },
  { code: 'fa', label: 'فارسی', dir: 'rtl' }
];

const FA = {
  /* ---------------------------- navigation ---------------------------- */
  'Dashboard': 'داشبورد',
  'Inbounds': 'اینباندها',
  'Clients': 'کلاینت‌ها',
  'Outbounds': 'اوت‌باندها',
  'Routing': 'مسیریابی',
  'Bot': 'ربات',
  'Settings': 'تنظیمات',
  'Account': 'حساب کاربری',
  'Logs': 'رویدادها',
  'More': 'بیشتر',
  'Sign out': 'خروج',
  'Light or dark': 'روشن یا تیره',
  'Language': 'زبان',

  /* ----------------------------- dashboard ---------------------------- */
  'CPU': 'پردازنده',
  'Memory': 'حافظه',
  'Disk': 'دیسک',
  'Network': 'شبکه',
  'Active clients': 'کلاینت‌های فعال',
  'Total traffic': 'ترافیک کل',
  'Uptime': 'مدت روشن بودن',
  'Xray-core': 'هسته Xray',
  'Server': 'سرور',
  'Restart': 'راه‌اندازی دوباره',
  'Stop': 'توقف',
  'Start': 'شروع',
  'Running': 'در حال اجرا',
  'Stopped': 'متوقف',
  'version unknown': 'نسخه نامشخص',
  'Xray up': 'Xray روشن',
  'Xray down': 'Xray خاموش',

  /* ------------------------------ common ------------------------------ */
  'Save': 'ذخیره',
  'Save settings': 'ذخیره تنظیمات',
  'Save account': 'ذخیره حساب',
  'Delete': 'حذف',
  'Edit': 'ویرایش',
  'Close': 'بستن',
  'Cancel': 'انصراف',
  'Apply': 'اعمال',
  'Generate': 'ساختن',
  'Import': 'ورودی',
  'Remove': 'حذف',
  'Discard': 'دور انداختن',
  'Reload': 'بارگذاری دوباره',
  'Please confirm': 'تایید کنید',
  'Yes, continue': 'بله، ادامه بده',
  'Dismiss': 'بستن',
  'Preview': 'پیش‌نمایش',
  'Copy': 'کپی',
  'Copied': 'کپی شد',
  'Never': 'هیچ‌وقت',
  'Unlimited': 'نامحدود',
  'None': 'هیچ‌کدام',
  'Any': 'همه',
  'Auto': 'خودکار',
  'Enable / disable': 'روشن / خاموش',
  'On / off': 'روشن / خاموش',
  'Nothing logged yet.': 'هنوز رویدادی ثبت نشده.',
  'Time': 'زمان',
  'Type': 'نوع',
  'Event': 'رویداد',
  'days left': 'روز مانده',
  'past due': 'گذشته',
  'not attached': 'بدون اینباند',
  'offline': 'آفلاین',
  'idle': 'بیکار',

  /* ------------------------------ inbounds ---------------------------- */
  'Each inbound is one port and one protocol that clients connect to.':
    'هر اینباند یک پورت و یک پروتکل است که کلاینت‌ها به آن وصل می‌شوند.',
  'New inbound': 'اینباند جدید',
  'Inbound actions': 'کارهای اینباند',
  'Import an inbound': 'ورود اینباند',
  'Export inbound': 'خروجی گرفتن از اینباند',
  'Export all URLs': 'خروجی همه لینک‌ها',
  'Export all URLs — subscription': 'خروجی همه لینک‌ها — سابسکریپشن',
  'Reset traffic': 'صفر کردن مصرف',
  'Reset traffic for all inbounds': 'صفر کردن مصرف همه اینباندها',
  'Attach clients…': 'اتصال کلاینت‌ها…',
  'Name': 'نام',
  'Protocol': 'پروتکل',
  'Port': 'پورت',
  'Transport': 'انتقال',
  'Traffic': 'مصرف',
  'Status': 'وضعیت',
  'Enabled': 'فعال',
  'Disabled': 'غیرفعال',
  'No inbounds yet. Create one to start accepting connections.':
    'هنوز اینباندی نیست. یکی بسازید تا اتصال‌ها را بپذیرد.',
  'From this panel or from 3x-ui.': 'از همین پنل یا از 3x-ui.',
  'Paste the inbound JSON here, clients and all': 'JSON اینباند را اینجا بچسبانید، همراه کلاینت‌ها',
  'Take over clients whose names already exist': 'کلاینت‌هایی که نامشان تکراری است جایگزین شوند',

  /* ------------------------------ clients ----------------------------- */
  'Clients of each inbound, with their quota and expiry.':
    'کلاینت‌های هر اینباند، با حجم و تاریخ انقضایشان.',
  'New client': 'کلاینت جدید',
  'Client actions': 'کارهای کلاینت',
  'Client': 'کلاینت',
  'Inbound': 'اینباند',
  'Now': 'الان',
  'Used': 'مصرف‌شده',
  'Quota': 'حجم',
  'Expires': 'انقضا',
  'Total': 'همه',
  'Active': 'فعال',
  'Expired': 'منقضی',
  'Out of quota': 'حجم تمام',
  'Too many IPs': 'آی‌پی بیش از حد',
  'Search clients by name…': 'جست‌وجوی کلاینت با نام…',
  'No client matches that.': 'کلاینتی با این نام پیدا نشد.',
  'No clients yet.': 'هنوز کلاینتی نیست.',
  'Create an inbound first, then add clients to it.': 'اول یک اینباند بسازید، بعد کلاینت اضافه کنید.',
  'Delete expired clients': 'حذف کلاینت‌های منقضی',
  'Delete clients out of quota': 'حذف کلاینت‌هایی که حجمشان تمام شده',
  'Delete expired and out of quota': 'حذف منقضی‌ها و کسانی که حجمشان تمام شده',
  'Delete disabled clients': 'حذف کلاینت‌های غیرفعال',
  'Delete every client': 'حذف همه کلاینت‌ها',
  'QR code and links': 'کد QR و لینک‌ها',
  'Copy config link': 'کپی لینک کانفیگ',
  'Where its traffic goes': 'ترافیکش کجا می‌رود',
  'Client name': 'نام کلاینت',
  'UUID': 'شناسه UUID',
  'Password / key': 'رمز / کلید',
  'Quota (GB)': 'حجم (گیگابایت)',
  'Valid for (days)': 'اعتبار (روز)',
  'Concurrent IP limit': 'حداکثر آی‌پی هم‌زمان',
  'Note': 'یادداشت',
  'generated when you save': 'هنگام ذخیره ساخته می‌شود',
  '0 means no expiry': '۰ یعنی بدون انقضا',
  'How much traffic this client may use in total. 0 means unlimited.':
    'مجموع ترافیکی که این کلاینت می‌تواند مصرف کند. ۰ یعنی نامحدود.',
  'Start the clock': 'شروع شمارش',
  'Only after the first use': 'فقط بعد از اولین استفاده',
  'The days begin the first time this config carries traffic, not now.':
    'روزها از اولین باری که این کانفیگ ترافیک رد کند شروع می‌شوند، نه از حالا.',
  'The days begin as soon as you save.': 'روزها به‌محض ذخیره شروع می‌شوند.',
  'Not started': 'شروع نشده',
  'Copy the subscription link': 'کپی لینک سابسکریپشن',
  'Copied to clipboard': 'کپی شد',

  /* ------------------------- reseller panels --------------------------- */
  'Admins': 'نمایندگان',
  'Sign out of this panel?': 'از این پنل خارج می‌شوید؟',
  'Balance': 'موجودی',
  'My clients': 'کلاینت‌های من',
  'Sold': 'فروخته‌شده',
  'Activation code': 'کد فعال‌سازی',
  'Paid for a top-up? Type the code you were given here.':
    'شارژ خریده‌اید؟ کدی که گرفته‌اید را اینجا وارد کنید.',
  'Add to my balance': 'افزودن به موجودی',
  'Balance history': 'تاریخچه موجودی',
  'New panel': 'پنل جدید',
  'Gift code': 'کد هدیه',
  'Panel name': 'نام پنل',
  'Their inbound': 'اینباند آن‌ها',
  'Price per GB': 'قیمت هر گیگ',
  'Opening balance': 'موجودی اولیه',
  'Sign-in address': 'آدرس ورود',
  'Copy their sign-in address': 'کپی آدرس ورود آن‌ها',
  'Your bot': 'ربات شما',
  'Your own bot settings': 'تنظیمات ربات خودتان',
  'Panels you have sold. Each one signs in at its own address and spends a balance you credit.':
    'پنل‌هایی که فروخته‌اید. هرکدام از آدرس خودش وارد می‌شود و از موجودی‌ای که شارژ می‌کنید خرج می‌کند.',
  'New reseller panel': 'پنل نمایندگی جدید',
  'Create the panel': 'ساخت پنل',
  'A panel gets an address of its own. Hand that over; whoever opens it first makes the account.':
    'هر پنل آدرس مخصوص خودش را می‌گیرد. آن را تحویل بدهید؛ هرکس اول بازش کند حساب را می‌سازد.',
  'Every client they make goes on this inbound. They never see the choice.':
    'هر کلاینتی که می‌سازند روی همین اینباند می‌نشیند. خودشان این انتخاب را نمی‌بینند.',
  'What a gigabyte costs them, in your currency.': 'هر گیگ برایشان چقدر آب می‌خورد، به پول خودتان.',
  'No reseller panels yet. Create one and hand over its address.':
    'هنوز پنل نمایندگی‌ای نساخته‌اید. یکی بسازید و آدرسش را تحویل بدهید.',
  'Panel': 'پنل',
  'Last seen': 'آخرین بازدید',
  'Open': 'باز کردن',
  'Suspend / re-open': 'تعلیق / بازگشایی',
  'Suspended': 'معلق',
  'Re-opened': 'بازگشایی شد',
  'Panel deleted': 'پنل حذف شد',
  'Codes': 'کدها',
  'Worth': 'ارزش',
  'For': 'برای',
  'not yet': 'هنوز نه',
  'anyone (gift)': 'هرکسی (هدیه)',
  'Spent so far': 'خرج‌شده تا اینجا',
  'Their bot': 'ربات آن‌ها',
  'Last signed in': 'آخرین ورود',
  'never': 'هرگز',
  'set up': 'تنظیم شده',
  'not set up': 'تنظیم نشده',
  'Their clients': 'کلاینت‌های آن‌ها',
  'They have not sold anything yet.': 'هنوز چیزی نفروخته‌اند.',
  'Adjust the balance': 'اصلاح موجودی',
  'Make a code for them': 'یک کد برایشان بساز',
  'A positive number adds, a negative one takes back.':
    'عدد مثبت اضافه می‌کند، عدد منفی پس می‌گیرد.',
  'Amount': 'مبلغ',
  'why': 'دلیل',
  'who this is': 'این شخص کیست',
  'History': 'تاریخچه',
  'When': 'چه زمانی',
  'Change': 'تغییر',
  'Why': 'چرا',
  'A gift code': 'کد هدیه',
  'Only this panel can use it, and only once.': 'فقط همین پنل می‌تواند استفاده کند، و فقط یک بار.',
  'Anybody with the code can use it, once. Good for handing out a trial.':
    'هرکسی که کد را داشته باشد یک بار می‌تواند استفاده کند. برای دادن یک تست خوب است.',
  'Send them this address. Whoever opens it first chooses the username and password.':
    'این آدرس را برایشان بفرستید. هرکس اول بازش کند نام کاربری و گذرواژه را انتخاب می‌کند.',
  'It is the only way in, and it is the only secret protecting it — send it to the right person.':
    'تنها راه ورود همین است و تنها چیزی که از آن محافظت می‌کند همین — برای آدم درست بفرستیدش.',
  'Copy the address': 'کپی آدرس',
  'Pick one': 'یکی را انتخاب کنید',
  'Save changes': 'ذخیره تغییرات',
  'Sign-in': 'ورود',
  'Their username': 'نام کاربری آن‌ها',
  'Signs in as': 'ورود با نام',
  'Username and password': 'نام کاربری و گذرواژه',
  'They sign in at': 'آدرس ورود آن‌ها',
  'Address': 'آدرس',
  'Make the account': 'ساخت حساب',
  'Save the sign-in': 'ذخیره اطلاعات ورود',
  'Change it': 'تغییرش بده',
  'Remove the account': 'حذف حساب',
  'Account removed': 'حساب حذف شد',
  'Copy all three': 'کپی هر سه',
  'Think of one': 'یکی بساز',
  'no account yet': 'هنوز حسابی ندارد',
  'at least eight characters': 'حداقل هشت کاراکتر',
  'Fill these in to make the account yourself, or leave both blank and whoever opens the address chooses them.':
    'این‌ها را پر کنید تا خودتان حساب را بسازید، یا هر دو را خالی بگذارید تا هرکس اول آدرس را باز کرد خودش انتخاب کند.',
  'Kept scrambled once saved — nobody can read it back, so copy it now if you need it.':
    'پس از ذخیره رمزنگاری می‌شود و دیگر قابل خواندن نیست — اگر لازمش دارید همین حالا کپی کنید.',
  'Leave the password blank to keep the one they have. Setting a new one signs them out everywhere.':
    'گذرواژه را خالی بگذارید تا همان قبلی بماند. اگر گذرواژه تازه بگذارید، از همه‌جا خارج می‌شود.',
  'Changing this does not sign them out.': 'تغییر این مورد باعث خروج آن‌ها نمی‌شود.',
  'Fill this in and hand it over, instead of letting them choose it themselves.':
    'این را پر کنید و تحویلشان بدهید، به‌جای اینکه خودشان انتخاب کنند.',
  'This is the only time the password is readable. Send all three.':
    'این تنها باری است که گذرواژه خوانده می‌شود. هر سه را بفرستید.',
  'Not set up': 'تنظیم نشده',
  'Set up': 'تنظیم شده',

  /* ---------------------------- outbounds ----------------------------- */
  'Chain to another server': 'اتصال به سرور دیگر',
  'New outbound': 'اوت‌باند جدید',
  'Test this outbound': 'تست این اوت‌باند',
  'Add a server to chain to': 'افزودن سروری برای اتصال زنجیره‌ای',
  'Read it': 'بخوانش',
  'Server address': 'آدرس سرور',
  'Server port': 'پورت سرور',
  'Security': 'امنیت',
  'Fingerprint': 'اثر انگشت',
  'REALITY public key': 'کلید عمومی REALITY',
  'REALITY short id': 'شناسه کوتاه REALITY',
  'The name to ask the far server for': 'نامی که از سرور مقابل خواسته می‌شود',
  'Only from these inbounds': 'فقط از این اینباندها',
  'Send me a test order': 'یک سفارش آزمایشی برایم بفرست',
  'Sent — check Telegram': 'ارسال شد — تلگرام را ببینید',

  /* ----------------------------- activity ----------------------------- */
  'Sites': 'سایت‌ها',
  'Addresses': 'آی‌پی‌ها',
  'App or site': 'اپ یا سایت',
  'Kind': 'دسته',
  'Connections': 'اتصال‌ها',
  'Share': 'سهم',
  'Host': 'هاست',
  'App': 'اپ',
  'Clear this history': 'پاک کردن این تاریخچه',
  'Forget these addresses': 'فراموش کردن این آی‌پی‌ها',
  'Nothing recorded yet.': 'هنوز چیزی ثبت نشده.',
  'No connection in the last five minutes.': 'در پنج دقیقه اخیر اتصالی نبوده.',
  'Video': 'ویدیو',
  'Social': 'شبکه اجتماعی',
  'Messaging & calls': 'پیام‌رسان و تماس',
  'AI': 'هوش مصنوعی',
  'Games': 'بازی',
  'Downloads & torrents': 'دانلود و تورنت',
  'Ads & trackers': 'تبلیغات و ردیاب',
  'Cloud & updates': 'کلود و آپدیت',
  'Web & search': 'وب و جست‌وجو',
  'Something else': 'چیز دیگر',
  'Plain addresses': 'آی‌پی خام',

  /* ----------------------------- settings ----------------------------- */
  'General': 'عمومی',
  'Config names': 'نام کانفیگ‌ها',
  'TLS': 'TLS',
  'Backup': 'پشتیبان',
  'Panel domain': 'دامنه پنل',
  'Secret web path': 'مسیر مخفی پنل',
  'Panel port': 'پورت پنل',
  'Subscription port': 'پورت سابسکریپشن',
  'Subscription path': 'مسیر سابسکریپشن',
  'Subscription title': 'عنوان سابسکریپشن',
  'Xray log level': 'سطح لاگ Xray',
  'BitTorrent': 'تورنت',
  'Block torrent traffic': 'مسدود کردن ترافیک تورنت',
  'Client addresses': 'آی‌پی کلاینت‌ها',
  'Record which IPs each client connects from': 'ثبت آی‌پی‌هایی که هر کلاینت با آن وصل می‌شود',
  'Redirect port 80': 'هدایت پورت ۸۰',
  'Answer on port 80 and redirect here': 'پاسخ روی پورت ۸۰ و هدایت به اینجا',
  'Name template': 'قالب نام',
  'Available pieces': 'اجزای در دسترس',
  'Click one to drop it in where the cursor is.': 'روی هرکدام بزنید تا همان‌جا که مکان‌نما هست اضافه شود.',
  'Username': 'نام کاربری',
  'Password': 'رمز عبور',
  'Current password': 'رمز فعلی',
  'New password': 'رمز جدید',
  'Leave empty to keep the current password': 'خالی بگذارید تا رمز فعلی نگه داشته شود',
  'Show backup as text': 'نمایش پشتیبان به‌صورت متن',
  'Restore from text': 'بازیابی از متن',
  'Download as a file': 'دانلود به‌صورت فایل',
  'Restore from a file': 'بازیابی از فایل',
  'View config.json': 'دیدن config.json',
  'Restore the panel': 'بازیابی پنل',
  'Restore': 'بازیابی',
  'Paste a panel backup here': 'پشتیبان پنل را اینجا بچسبانید',

  /* ------------------------------- bot -------------------------------- */
  'Setup': 'راه‌اندازی',
  'Screens': 'صفحه‌ها',
  'Plans': 'پلن‌ها',
  'Payment': 'پرداخت',
  'Channel': 'کانال',
  'Orders': 'سفارش‌ها',
  'Connection': 'اتصال',

  /* ------------------------------ update ------------------------------ */
  'Update': 'به‌روزرسانی',
  'Check again': 'بررسی دوباره'
};

/*
 * Sentences built around a value. Each entry is a regular expression over the
 * English, and a function that puts the captured pieces back in Persian order.
 */
const PATTERNS = [
  [/^(\d+) cores?$/, (m) => `${m[1]} هسته`],
  [/^of (\d+) total$/, (m) => `از ${m[1]}`],
  [/^(.+) of (.+)$/, (m) => `${m[1]} از ${m[2]}`],
  [/^(\d+) days? left$/, (m) => `${m[1]} روز مانده`],
  [/^Delete client "(.+)"\?$/, (m) => `کلاینت «${m[1]}» حذف شود؟`],
  [/^Delete inbound "(.+)"\?$/, (m) => `اینباند «${m[1]}» حذف شود؟`],
  [/^Delete its (\d+) client\(s\) as well$/, (m) => `${m[1]} کلاینتش هم حذف شوند`],
  [/^Delete (\d+) (.+)\?$/, (m) => `${m[1]} مورد حذف شود؟`],
  [/^Deleted (\d+) client\(s\)$/, (m) => `${m[1]} کلاینت حذف شد`],
  [/^Client deleted$/, () => 'کلاینت حذف شد'],
  [/^Inbound deleted$/, () => 'اینباند حذف شد'],
  [/^Settings saved$/, () => 'تنظیمات ذخیره شد'],
  [/^Bot saved$/, () => 'ربات ذخیره شد'],
  [/^What (.+) is doing$/, (m) => `${m[1]} مشغول چه کاری است`],
  [/^Addresses for (.+)$/, (m) => `آی‌پی‌های ${m[1]}`],
  [/^Show all (\d+) hostnames$/, (m) => `نمایش هر ${m[1]} هاست`],
  [/^Hide hostnames$/, () => 'پنهان کردن هاست‌ها'],
  [/^(\d+) hosts$/, (m) => `${m[1]} هاست`],
  [/^Show everyone$/, () => 'نمایش همه'],
  [/^Show only the (.+) ones$/, () => 'فقط همین‌ها را نشان بده'],
  [/^Edit (.+)$/, (m) => `ویرایش ${m[1]}`],
  [/^(.+) is ready$/, (m) => `${m[1]} آماده است`],
  [/^about (\d+) GB$/, (m) => `حدود ${m[1]} گیگ`],
  [/^A code for (.+)$/, (m) => `یک کد برای ${m[1]}`],
  [/^Delete the panel "(.+)"\? Their sign-in stops working\. The clients they sold are kept\.$/,
    (m) => `پنل «${m[1]}» حذف شود؟ ورودشان از کار می‌افتد. کلاینت‌هایی که فروخته‌اند می‌مانند.`],
  [/^Balance is now (.+)$/, (m) => `موجودی حالا ${m[1]} است`],
  [/^signs in as (.+)$/, (m) => `ورود با نام ${m[1]}`],
  [/^Sign-in for (.+)$/, (m) => `اطلاعات ورود ${m[1]}`],
  [/^(.+) can sign in now$/, (m) => `${m[1]} حالا می‌تواند وارد شود`],
  [/^Remove the account "(.+)"\? They are signed out, and the next person to open their address chooses a new username and password\. Their clients and balance are kept\.$/,
    (m) => `حساب «${m[1]}» حذف شود؟ از پنل خارج می‌شود و هرکس بعداً آدرسش را باز کند نام کاربری و گذرواژه تازه انتخاب می‌کند. کلاینت‌ها و موجودی‌اش می‌ماند.`]
];

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

window.NEXV_I18N = { t, setLang, lang, stored, LANGS };

}());
