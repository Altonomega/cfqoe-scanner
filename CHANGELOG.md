# Changelog

## Unreleased

### Changed
- موتور Hard Deep Scan به‌صورت پیش‌فرض block-adaptive شد: catalog در واحد بلوک‌های ‎/24‎ پیمایش می‌شود — primer سه‌پروبی برای هر بلوک، pass محدود split-coverage، موج‌های expansion با شاخص Wilson-UCB و split آماری (Fisher) تا ‎/26‎ — با سقف بودجه 72,000 probe در دسکتاپ و 40,000 در اندروید. موتور قبلی range round-robin با کلید `hard.engine` در تنظیمات قابل انتخاب است و checkpointهای نسخه 3 همیشه با همان موتور legacy تمام می‌شوند.
- اعتبار بلوک‌ها بین runها در `data/block-reputation.json` نگه داشته می‌شود (decay پیوسته با نیمه‌عمر 14 روز و نردبان تازگی skip/confirm/full) تا runهای بعدی primer بلوک‌های تازه‌دیده‌شده را رد کنند یا با یک probe تأییدی از آن بگذرند.
- checkpoint اسکن Hard برای runهای block-adaptive نسخه 4 شد. گزارش (schema همچنان 10) فیلدهای افزایشی گرفت: `traversal`، totals بلوکی (از جمله `probesSpent` و `blocksSplit`) و فیلد اختیاری `block` روی هر candidate. totals در runهای legacy بدون تغییر باقی ماندند.

## 0.8.5

### Changed
- خروجی Full Scan در ترمینال‌های باریک برای هر finalist اندازه‌گیری‌شده، جزئیات Transfer، Streaming، Load، downlink، uplink، RPM، added RTT، shaping، jitter، loss، POP، traffic و عامل دقیق محدودکننده را نمایش می‌دهد.
- این نسخه فقط نمایش نتیجه را غنی‌تر می‌کند و هیچ threshold، وزن، نمونه‌گیری یا فرمول امتیازدهی را تغییر نمی‌دهد.

## 0.8.4

### Fixed
- بودجه Full Scan متعادل و timeout latency محدود شد.
- `load.partial` از warning تعاملی به debug منتقل شد.
- تنظیمات نسخه ۶ به نسخه ۷ مهاجرت می‌کنند و مقادیر سفارشی حفظ می‌شوند.

## 0.8.3

- رفع ورود کانفیگ VLESS در Termux، calibration، traffic caps، WebSocket validation و report schema 9.
