# Hard Deep Scan

Hard Deep Scan برای پیمایش طولانی و قابل Resume کل catalog طراحی شده است. پیمایش پیش‌فرض حالا با موتور **block-adaptive** انجام می‌شود: catalog به بلوک‌های ‎/24‎ تقسیم می‌شود و بودجه probe به‌جای پخش یکنواخت روی همه IPها، روی بلوک‌هایی متمرکز می‌شود که شواهد به نفعشان است. موتور قبلی (range round-robin) همچنان در دسترس است؛ در انتهای سند توضیح داده شده است.

## چرا پیمایش بلوکی؟

catalog فعلی 753 رنج، 7,697 بلوک ‎/24‎ و 1,970,432 آدرس دارد. پیمایش ترتیبی — حتی با اجرای موازی — برای هر IP دست‌کم یک probe خرج می‌کند و رسیدن به عمق کافی روی IPهای خوب، در عمل چند روز طول می‌کشد؛ بیشتر آن بودجه هم روی بلوک‌های مرده هدر می‌رود. موتور block-adaptive سقف بودجه را به کسری از پیمایش کامل محدود می‌کند (بخش «بودجه probe») و همان بودجه را با شواهد آماری تخصیص می‌دهد: اول همه بلوک‌ها ارزان غربال می‌شوند، بعد فقط بلوک‌های امیدوارکننده عمق می‌گیرند.

## pipeline موتور block-adaptive

### 1. Primer — غربال ارزان همه بلوک‌ها

برای هر بلوک حداکثر 3 probe (`hard.primerPerBlock`) روی آدرس‌های تصادفیِ درون همان بلوک اجرا می‌شود؛ انتخاب آدرس‌ها با seed ثابت و بدون جایگزینی است، پس traversal قطعی و قابل تکرار است. نتیجه primer فقط triage است: بلوکی با 0 موفقیت از 3 probe حذف نمی‌شود — کران بالای Wilson آن هنوز 0.562 است — فقط در تخصیص بعدی عقب‌تر می‌ایستد.

اعتبار ذخیره‌شده از runهای قبلی می‌تواند primer یک بلوک را سبک یا حذف کند؛ جزئیات در بخش «اعتبار بلوک‌ها» آمده است.

دو safety valve در این مرحله run را زود متوقف می‌کند، چون ادامه دادن بی‌فایده است:

- **hard-error:** اگر حداقل 95٪ از 200 مشاهده اول primer یک کد خطای non-retryable مشترک داشته باشند، run abort می‌شود — مسیر یا کانفیگ خراب است، نه catalog.
- **dead-path:** اگر بعد از 1,000 probe نرخ موفقیت زیر 0.5٪ باشد، run abort می‌شود.

### 2. Split-coverage — عمق تضمین‌شده برای بلوک‌های مشکوک

سیگنال ناهمگنی در شمارنده‌های دو نیمه بلوک زندگی می‌کند، اما شاخص تخصیص فقط مجموع بلوک را می‌بیند؛ بلوک ناهمگنِ متوسط دقیقاً شبیه یک بلوک همگنِ متوسط دیده می‌شود و در تخصیص صرفِ شاخصی گرسنه می‌ماند. برای همین بین primer و expansion یک pass محدود اجرا می‌شود که از یک رزرو بودجه (حداکثر `hard.splitReserveFraction` از headroom باقی‌مانده) خرج می‌کند و برای بلوک‌های مشکوک — primer مخلوط (1 یا 2 موفقیت از 3)، به‌علاوه بلوک‌های 0 موفقیتی که با draw هدفمند به نیمه کمترمشاهده‌شده‌شان ارتقا پیدا می‌کنند — عمق مشاهده لازم برای فعال شدن تست split را در هر دو نیمه تضمین می‌کند. مشکوک‌هایی که در آستانه split نزدیک‌به‌خطا (near-miss) می‌ایستند یک مرحله عمیق‌تر هم می‌گیرند.

### 3. Expansion — موج‌های Wilson-UCB

بودجه باقی‌مانده در موج‌هایی به اندازه `hard.expansionWaveFactor` × concurrency تخصیص می‌یابد؛ در هر pass حداکثر `hard.expansionChunk` (پیش‌فرض 4) probe برای هر بلوک و حداکثر `hard.rangeWaveCapFraction` (پیش‌فرض 25٪) از هر موج برای یک رنج. ترتیب تخصیص با شاخص Wilson-UCB تعیین می‌شود — کران بالای بازه اطمینان Wilson هر بلوک با ضریب اکتشاف `hard.banditExploration` — پس بلوک‌های داغ عمق می‌گیرند و بلوک‌های سرد فقط به اندازه عدم‌قطعیتشان. سقف عمق هر بلوک `hard.maxDepthPerBlock` (پیش‌فرض 32) probe است.

expansion با یکی از این سه شرط تمام می‌شود: بودجه تمام شود؛ همه بلوک‌ها exhausted شوند؛ یا بهترین شاخص باقی‌مانده دو موج پیاپی زیر آستانه ورود به pool نهایی بماند (marginal-gain stop). در عمل معمولاً شرط سوم زودتر از سقف بودجه می‌رسد.

### 4. Split — شکافتن بلوک ناهمگن

اگر دو نیمه یک بلوک به‌طور معناداری متفاوت باشند — تست دقیق Fisher دوطرفه با `p ≤ hard.splitAlpha` (پیش‌فرض 0.05) **و** اختلاف نرخ موفقیت حداقل `hard.splitMinEffect` (پیش‌فرض 0.5)، با حداقل 4 مشاهده در هر نیمه — بلوک به دو نیمه ‎/25‎ شکافته می‌شود و هر نیمه از آن به بعد بلوک مستقل است. حداکثر عمق split برابر `hard.splitMaxDepth` (پیش‌فرض 2) است، یعنی تا ‎/26‎. مشاهدات پدر بین فرزندان تقسیم می‌شود و split هیچ probe اضافه‌ای خرج نمی‌کند.

### 5. Pool نهایی و finalize مشترک

از screening حداکثر `hard.finalTop` (پیش‌فرض 200) finalist وارد pool می‌شود، با سقف تنوع `hard.poolPerBlock` (پیش‌فرض 8 از هر بلوک) تا فهرست نهایی اسیر یک ‎/24‎ نشود. از اینجا به بعد مسیر دقیقاً همان finalize قبلی است و بین هر دو موتور مشترک است:

1. صف delayed retry برای خطاهای soft (سقف `hard.retryLimit`)
2. بازبینی SPRT روی حداکثر `hard.recheckTop` finalist، با سقف `hard.recheckPerBlock` (پیش‌فرض 4 از هر بلوک) و تعداد کامل `Eligibility rounds`
3. تونل واقعی Xray و اندازه‌گیری QoE (browsing، streaming و real load) روی finalistهای انتخابی

سرعت screening بالا رفته است، اما تصمیم نهایی مثل قبل فقط به مشاهده اولیه وابسته نیست.

## بودجه probe

هر سه مرحله primer، split-coverage و expansion از یک بودجه مشترک (`hard.budgetProbes`) خرج می‌کنند:

- Windows/Linux: ‎72,000 probe — حدود 3.7٪ پیمایش کامل
- Android/Termux: ‎40,000 probe — حدود 2.0٪ پیمایش کامل

«پوشش» از این به بعد بر حسب بلوک گزارش می‌شود، نه IP: ادعای صادقانه این است که هر 7,697 بلوک دست‌کم primer دیده و بلوک‌های خوب تا سقف عمق 32 probe بررسی شده‌اند.

**حاشیه اندروید:** با بودجه 40,000، pass مربوط به split-coverage زودتر به سقف رزرو می‌رسد و truncate می‌شود؛ نرخ تشخیص split در اندروید پایین‌تر از معیار دسکتاپ (0.80) انتظار می‌رود. قرارداد شبیه‌سازی با پارامترهای دسکتاپ بسته شده است (بخش «اعتبارسنجی»)؛ این پیامد سقف بودجه مصوب است، نه نقص موتور.

## اعتبار بلوک‌ها (reputation)

نتایج هر run در فایل `data/block-reputation.json` ذخیره می‌شود تا run بعدی از صفر شروع نکند. برای هر بلوک نگه داشته می‌شود: تعداد تلاش و موفقیت، زمان آخرین مشاهده، حداکثر 4 candidate برتر و colo مشاهده‌شده.

- **Decay پیوسته:** شواهد با نیمه‌عمر `hard.reputationHalfLifeDays` (پیش‌فرض 14 روز) کم‌وزن می‌شوند. cutoff سختی وجود ندارد؛ رکورد قدیمی ناگهان حذف نمی‌شود، فقط وزنش به‌تدریج کم می‌شود.
- **سقف شواهد:** شمارنده ذخیره‌شده هر بلوک حداکثر `hard.reputationMaxStoredAttempts` (پیش‌فرض 64) تلاش است تا تاریخچه هیچ‌وقت بر شواهد تازه یک run غلبه نکند.
- **نردبان تازگی:** در شروع run، سن رکورد تعیین می‌کند بلوک چه primerای بدهکار است:
  - دیده‌شده در `hard.reputationSkipAgeDays` (پیش‌فرض 3) روز اخیر با شواهد کافی: primer رد می‌شود — 0 probe — و بلوک با همان prior وارد expansion می‌شود.
  - تا `hard.reputationConfirmAgeDays` (پیش‌فرض 21) روز: فقط 1 probe تأییدی؛ اگر همان fail شود، primer کامل اجرا می‌شود.
  - قدیمی‌تر، یا decayشده تا نزدیک صفر: primer کامل.
- **اثر عملی:** run روز بعد عملاً probe primerای خرج نمی‌کند و run هفتگی برای کل catalog حدود 7,697 probe تأییدی می‌خواهد، نه 23,091 probe primer کامل.
- reputation فقط وقتی merge و ذخیره می‌شود که run به‌صورت طبیعی کامل شود؛ run لغوشده یا abortشده فایل را دقیقاً همان‌طور که یافته بود باقی می‌گذارد.

## checkpoint و Resume

checkpoint موتور block-adaptive نسخه 4 است: به‌جای cursor ترتیبی، state سریال‌شده هر بلوک، شمارنده‌های بودجه و hash کاتالوگ (SHA-256 متن رنج‌ها) را نگه می‌دارد. Resume از همان state و زیر همان بودجه اصلی ادامه می‌دهد و توالی probeهای run ازسرگرفته‌شده با run بدون وقفه یکسان است.

- **checkpoint متعلق به موتور سازنده‌اش است.** checkpoint نسخه 3 (موتور legacy) همیشه تا انتها با همان موتور legacy تمام می‌شود، حتی اگر تنظیم `hard.engine` در این فاصله عوض شده باشد؛ این تنظیم فقط روی runهای تازه اثر دارد.
- اگر catalog از زمان checkpoint عوض شده باشد (hash متفاوت)، state بلوک‌ها با یک warning کنار گذاشته می‌شود، اما نتایج NDJSON، شمارنده‌ها و فهرست top حفظ می‌شوند.

## موتور legacy (range round-robin)

برای برگشتن به پیمایش قبلی، در فایل `data/settings.json` زیر کلید `hard` مقدار `engine` را روی `round-robin` بگذارید. این کلید ورودی منویی ندارد و فقط از فایل تنظیمات خوانده می‌شود. کلیدهای block-adaptive فقط وقتی خوانده می‌شوند که `engine` روی `blocks` باشد؛ در غیر این صورت inert هستند.

رفتار موتور legacy همان رفتار قبلی است:

1. **ترتیب range round-robin:** host اول رنج اول، host اول رنج دوم، تا آخرین رنج، بعد host دوم رنج اول و به همین ترتیب.
2. **اجرای parallel batched:** IPها در batchهای هم‌زمان بررسی می‌شوند — Windows/Linux پیش‌فرض 12 IP و Android/Termux پیش‌فرض 6 IP هم‌زمان، با سقف ایمنی runtime برابر 64 — پس یک IP timeout‌شده دیگر کل traversal را متوقف نمی‌کند.
3. **Fast screening:** sweep اصلی به‌طور پیش‌فرض برای هر IP یک WebSocket eligibility round واقعی اجرا می‌کند (`Hard screening rounds`).
4. **Early rejection:** اگر IP از نظر ریاضی دیگر نتواند به success threshold برسد، roundهای بی‌فایده بعدی اجرا نمی‌شوند؛ مثلاً با سه round و threshold برابر 60٪، بعد از دو شکست متوالی round سوم حذف می‌شود.
5. **Finalize مشترک:** همان delayed retry، بازبینی SPRT و تونل نهایی که در بخش 5 pipeline توضیح داده شد.

## فیلدهای گزارش

schema گزارش همچنان 10 است؛ تغییرات فقط افزایشی‌اند و فقط در runهای block-adaptive ظاهر می‌شوند. totals در run legacy دقیقاً شکل قبلی را نگه می‌دارند.

- `traversal: "block-adaptive"` در گزارش runهای block-adaptive و `"range-round-robin"` در runهای legacy
- totals جدید: `probesSpent` (کل probe خرج‌شده)، `primerProbes`، `expansionProbes`، `reserveProbes` (خرج split-coverage)، `blocksTotal`، `blocksPrimed`، `blocksExpanded`، `blocksExhausted`، `blocksByTier` (شمارش بلوک‌ها در سه tier ‏skip/confirm/full)، `blocksExtended`، `suspectsServed`، `blocksPromoted` و `blocksSplit`
- فیلد اختیاری `block` روی هر candidate که بلوک ‎/24‎ مبدأ آن را نشان می‌دهد و از screening تا گزارش نهایی حفظ می‌شود

## تنظیمات

از مسیر `Scan Settings` (مشترک بین هر دو موتور):

- `Hard concurrent IPs`: تعداد IPهای هم‌زمان در هر batch
- `Hard screening rounds`: تعداد roundهای screening برای هر probe
- `Hard finalist verification count`: تعداد candidateهایی که پیش از tunnel با SPRT بازبینی می‌شوند
- `Hard retry limit`: سقف صف delayed retry
- `Hard-save every N IPs`: فاصله checkpoint
- `Hard live top count`: تعداد نتایج برتر در snapshot زنده
- `Hard final top count`: سقف pool نهایی (پیش‌فرض 200)

کلیدهای موتور block-adaptive فقط در `data/settings.json` زیر `hard` قابل تنظیم‌اند:

- `engine`: ‏`blocks` (پیش‌فرض) یا `round-robin`
- `budgetProbes`: سقف کل probe (72,000 دسکتاپ / 40,000 اندروید)
- `primerPerBlock`: عمق primer هر بلوک (3)
- `banditExploration`: ضریب اکتشاف شاخص Wilson-UCB ‏(1)
- `maxDepthPerBlock`: سقف probe هر بلوک (32)
- `expansionWaveFactor` / `expansionChunk` / `rangeWaveCapFraction`: اندازه موج نسبت به concurrency ‏(10)، سقف probe هر بلوک در هر pass ‏(4) و سقف سهم هر رنج از یک موج (0.25)
- `poolPerBlock` / `recheckPerBlock`: سقف تنوع از هر بلوک در pool ‏(8) و در recheck ‏(4)
- `splitMaxDepth` / `splitAlpha` / `splitMinEffect`: عمق split ‏(2)، آستانه Fisher ‏(0.05) و حداقل اختلاف نرخ موفقیت (0.5)
- `splitReserveFraction` / `splitReserveAlpha`: سقف رزرو split-coverage از headroom بعد از primer ‏(0.85) و آستانه شل‌تر Fisher برای مرحله عمیق‌تر (0.25)
- `reputationSkipAgeDays` / `reputationConfirmAgeDays` / `reputationHalfLifeDays` / `reputationMaxStoredAttempts`: پنجره‌های نردبان تازگی (3 و 21 روز)، نیمه‌عمر decay ‏(14 روز) و سقف شواهد ذخیره‌شده هر بلوک (64)

## پیشنهاد تنظیمات

### Windows/Linux متعادل

```text
Hard concurrent IPs: 12
Hard screening rounds: 1
Hard finalist verification count: 20
```

### Android/Termux متعادل

```text
Hard concurrent IPs: 6
Hard screening rounds: 1
Hard finalist verification count: 12
```

در گوشی داغ یا ضعیف concurrency را به 3 یا 4 کاهش دهید. روی سیستم و اینترنت قوی می‌توان آن را مرحله‌ای به 16 یا 20 رساند، اما مقدار بالاتر همیشه نتیجه سریع‌تر یا دقیق‌تری نمی‌دهد.

## اعتبارسنجی (شبیه‌سازی)

موتور پیش از release روی یک catalog مجازی با probe جعلی و معیارهای از پیش ثبت‌شده (pre-registered) سنجیده شده است؛ هیچ ترافیک زنده‌ای در کار نبوده. شرح کامل معیارها و نتایج اندازه‌گیری‌شده در `docs/HARD-SCAN-REDESIGN.md` بخش 9 و تحلیل معیار split در `docs/HARD-SCAN-5B-ANALYSIS.md` آمده است. خلاصه نتایج:

- **Recall بلوک‌های برتر:** ‎1.000 برای موتور جدید در برابر 0.100 و 0.200 برای baselineهای هم‌بودجه
- **ایمنی primer:** ‎100٪ — هیچ بلوک برتری در primer حذف نشد
- **Split اشتباه:** بین 1.3٪ تا 2.2٪ بلوک‌های همگن (سقف مجاز 5٪)
- **شروع گرم:** run دوم با reputation به همان recall رسید با 45٪ probeهای run سرد
- **تشخیص split (معیار 5b):** ‎0.803 در seed اصلی harness — فقط یک بلوک بالاتر از آستانه 0.80؛ حاشیه این معیار باریک است. در seedهای جایگزین 0.820 و 0.918 اندازه‌گیری شد، پس عدد harness انتهای محافظه‌کارانه بازه است، نه یک seed خوش‌شانس.
- **قطعیت:** seed یکسان، توالی probe یکسان — hash ‏SHA-256 اجراهای تکراری برابر است

## توقف امن

با `Q` یا `Ctrl+C` شروع batch جدید متوقف می‌شود. batch کوچک جاری تمام می‌شود، سپس cursor و نتایج ذخیره و finalization اجرا می‌شود. در موتور block-adaptive، checkpoint state بلوک‌ها و شمارنده‌های بودجه را نگه می‌دارد و Resume فقط اختلاف را دوباره probe می‌کند. توجه: reputation در توقف دستی به‌روز نمی‌شود — فقط تکمیل طبیعی run آن را merge می‌کند.
