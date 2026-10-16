'use strict';
/* بيانات تجريبية للنموذج فقط — مش بيانات المحل الحقيقية. */
const DATA = (() => {
  // مولّد أرقام ثابت عشان الأرقام (والـ IMEI) تفضل هي هي كل مرة
  let seed = 16102026;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  const luhnDigit = (body) => {
    let sum = 0;
    for (let i = 0; i < body.length; i++) {
      let d = body.charCodeAt(body.length - 1 - i) - 48;
      if (i % 2 === 0) { d *= 2; if (d > 9) d -= 9; }
      sum += d;
    }
    return String((10 - (sum % 10)) % 10);
  };
  const makeImei = (tac) => { let s = tac; while (s.length < 14) s += Math.floor(rnd() * 10); return s + luhnDigit(s); };

  const users = [
    { id: 'u1', name: 'بيتر', role: 'owner', pin: '1111', color: '#1d4f91' },
    { id: 'u2', name: 'يوسف', role: 'seller', pin: '2222', color: '#0f6e5a' },
    { id: 'u3', name: 'مارينا', role: 'seller', pin: '3333', color: '#8a3b78' },
  ];

  // التصنيفات: رئيسية، وتحت «إكسسوارات» تصنيفات فرعية (parent).
  // «الأكثر مبيعًا» و«الكل» ثابتين في شاشة البيع. الأسماء والترتيب والإظهار وإضافة تصنيف جديد من الإعدادات.
  const categories = [
    { id: 'phones', name: 'موبايلات جديدة', icon: 'smartphone' },
    { id: 'used', name: 'مستعمل', icon: 'recycle' },
    { id: 'acc', name: 'إكسسوارات', icon: 'package' },
    { id: 'cases', name: 'جرابات', icon: 'shield', parent: 'acc' },
    { id: 'screens', name: 'اسكرينات', icon: 'layers', parent: 'acc' },
    { id: 'chargers', name: 'شواحن', icon: 'plug-zap', parent: 'acc' },
    { id: 'cables', name: 'كابلات ووصلات', icon: 'cable', parent: 'acc' },
    { id: 'audio', name: 'سماعات', icon: 'headphones', parent: 'acc' },
    { id: 'power', name: 'باور بانك وميموري', icon: 'battery-charging', parent: 'acc' },
    { id: 'car', name: 'حوامل', icon: 'car', parent: 'acc' },
    { id: 'smart', name: 'ساعات ذكية', icon: 'watch' },
  ];

  const P = (id, cat, name, price, cost, o = {}) => ({
    id, cat, name, price, cost, stock: 0, serial: false, warranty: 0, icon: 'package', kw: '', sold: 0, min: 5, sku: '', ...o,
  });
  // stock = كل الأجهزة اللي في المحل. units = اللي متسجّل لها IMEI، والباقي (noImei) اتسلّم بالعدد من غير IMEI
  const phone = (id, name, price, cost, tac, units, sold, kw, colors, storage, noImei = 0) =>
    P(id, 'phones', name, price, cost, { serial: true, warranty: 12, icon: 'smartphone', tac, units, stock: units + noImei, sold, kw, colors, storage, min: 2 });
  const used = (id, name, price, cost, tac, units, sold, kw, colors, storage, grade) =>
    P(id, 'used', name, price, cost, { serial: true, warranty: 1, icon: 'recycle', tac, units, stock: units, sold, kw, colors, storage, grade, min: 1 });

  const products = [
    phone('p1', 'Samsung Galaxy A16 128GB', 9250, 8600, '35286715', 4, 22, 'سامسونج جالاكسي جلاكسي', ['أسود', 'رمادي', 'أخضر فاتح'], '128GB، رام 6GB'),
    phone('p2', 'Samsung Galaxy A26 256GB', 13999, 12950, '35469322', 3, 11, 'سامسونج جالاكسي جلاكسي', ['أسود', 'أبيض'], '256GB، رام 8GB'),
    phone('p3', 'Samsung Galaxy A56 256GB', 21499, 19900, '35733118', 1, 5, 'سامسونج جالاكسي جلاكسي', ['رمادي'], '256GB، رام 8GB'),
    phone('p4', 'Redmi 14C 128GB', 6299, 5800, '86793706', 3, 18, 'ريدمي ردمي شاومي شاومى xiaomi', ['أسود', 'أزرق', 'أخضر'], '128GB، رام 4GB', 2),
    phone('p5', 'Redmi Note 14 256GB', 10999, 10150, '86811207', 3, 9, 'ريدمي ردمي نوت شاومي xiaomi', ['أسود', 'بنفسجي'], '256GB، رام 8GB'),
    phone('p6', 'OPPO A3x 128GB', 6499, 5950, '86283905', 2, 7, 'اوبو أوبو', ['أزرق', 'أحمر'], '128GB، رام 4GB'),
    phone('p7', 'realme C75 256GB', 8299, 7650, '86754805', 3, 8, 'ريلمي ريل مي', ['ذهبي', 'أسود'], '256GB، رام 8GB'),
    phone('p8', 'Honor X8c 256GB', 11499, 10600, '86920106', 2, 6, 'هونر هونور', ['أسود', 'أبيض'], '256GB، رام 8GB'),
    phone('p9', 'Infinix Hot 50 256GB', 6799, 6200, '35693212', 1, 10, 'انفينكس انفنكس هوت', ['أسود', 'أخضر'], '256GB، رام 8GB', 2),
    phone('p10', 'iPhone 16 128GB', 57500, 54800, '35391811', 1, 2, 'ايفون آيفون ابل آبل apple', ['أسود'], '128GB'),
    phone('p11', 'Tecno Spark 30 128GB', 5999, 5500, '35118876', 0, 6, 'تكنو تيكنو سبارك', ['أسود', 'أبيض'], '128GB، رام 4GB', 2),
    used('u1', 'iPhone 13 128GB مستعمل فئة A', 21500, 19000, '35305611', 1, 3, 'ايفون آيفون مستعمل ابل', ['أزرق'], '128GB', 'فئة A'),
    used('u2', 'Samsung Galaxy S22 مستعمل فئة B', 12500, 10800, '35062919', 1, 2, 'سامسونج جالاكسي مستعمل', ['أسود'], '128GB، رام 8GB', 'فئة B'),
    used('u3', 'Redmi Note 12 مستعمل فئة A', 4900, 4000, '86455904', 2, 4, 'ريدمي ردمي شاومي مستعمل', ['رمادي', 'أزرق'], '128GB، رام 6GB', 'فئة A'),
    P('a1', 'cases', 'جراب سيليكون شفاف', 120, 35, { stock: 64, sold: 180, icon: 'shield', kw: 'جراب كفر كفرات cover case سيليكون', sku: '6223001234560', min: 15 }),
    P('a2', 'screens', 'اسكرينة زجاج 9D', 100, 25, { stock: 118, sold: 210, icon: 'layers', kw: 'اسكرينه سكرينة سكرينه لزقة جلاس glass حماية شاشة', sku: '6223001234577', min: 20 }),
    P('a3', 'screens', 'اسكرينة نانو مط', 150, 40, { stock: 37, sold: 45, icon: 'layers', kw: 'اسكرينه سكرينة نانو مات', sku: '6223001234584', min: 10 }),
    P('a4', 'chargers', 'شاحن سامسونج 25 وات أصلي', 650, 480, { stock: 14, sold: 40, warranty: 3, icon: 'plug-zap', kw: 'شاحن سامسونج سريع samsung charger 25w', sku: '8806094920001', min: 5 }),
    P('a5', 'chargers', 'شاحن أنكر 20 وات', 799, 610, { stock: 9, sold: 16, warranty: 6, icon: 'plug-zap', kw: 'انكر انكير anker شاحن', sku: '0194644098001', min: 4 }),
    P('a6', 'cables', 'كابل تايب سي لتايب سي', 150, 60, { stock: 52, sold: 95, icon: 'cable', kw: 'كابل كيبل وصلة type c usb c تايب سى', sku: '6223001234591', min: 10 }),
    P('a7', 'cables', 'كابل لايتنينج للآيفون', 220, 90, { stock: 4, sold: 30, icon: 'cable', kw: 'كابل كيبل ايفون آيفون lightning لايتننج', sku: '6223001234607', min: 6 }),
    P('a8', 'audio', 'سماعة سلك تايب سي', 180, 85, { stock: 21, sold: 30, icon: 'headphones', kw: 'سماعه هاندفري handsfree سلك', sku: '6223001234614', min: 6 }),
    P('a9', 'audio', 'سماعة بلوتوث Lenovo LP40', 450, 300, { stock: 12, sold: 25, warranty: 3, icon: 'headphones', kw: 'سماعه بلوتوث لينوفو ايربودز earbuds', sku: '6971234500402', min: 4 }),
    P('a10', 'audio', 'إيربودز برو (هاي كوبي)', 750, 520, { stock: 3, sold: 14, warranty: 1, icon: 'headphones', kw: 'ايربودز ايربود airpods سماعه', sku: '6223001234621', min: 4 }),
    P('a11', 'power', 'باور بانك 10000 مللي', 850, 640, { stock: 8, sold: 12, warranty: 6, icon: 'battery-charging', kw: 'باوربانك باور بنك شاحن متنقل power bank', sku: '6971234511002', min: 3 }),
    P('a12', 'power', 'كارت ميموري 64 جيجا', 320, 220, { stock: 15, sold: 10, warranty: 12, icon: 'memory-stick', kw: 'ميموري ذاكره ذاكرة كارت sd', sku: '0619659188001', min: 4 }),
    P('a13', 'car', 'حامل موبايل للعربية', 250, 140, { stock: 6, sold: 5, icon: 'car', kw: 'حامل عربيه عربية سياره', sku: '6223001234638', min: 2 }),
    P('a14', 'cables', 'وصلة OTG تايب سي', 60, 20, { stock: 30, sold: 22, icon: 'cable', kw: 'otg او تي جي وصله', sku: '6223001234645', min: 5 }),
    P('a15', 'cases', 'جراب جلد فليب', 180, 70, { stock: 22, sold: 26, icon: 'shield', kw: 'جراب كفر فليب جلد flip cover', sku: '6223001234652', min: 6 }),
    P('a16', 'screens', 'اسكرينة برايفسي', 200, 60, { stock: 18, sold: 20, icon: 'layers', kw: 'اسكرينه سكرينة خصوصيه خصوصية برايفسى privacy', sku: '6223001234669', min: 6 }),
    P('a17', 'chargers', 'شاحن عربية 2 مخرج', 280, 170, { stock: 7, sold: 9, warranty: 3, icon: 'car', kw: 'شاحن عربيه عربية سياره car charger', sku: '6223001234676', min: 3 }),
    P('a18', 'audio', 'سماعة رأس بلوتوث', 650, 430, { stock: 5, sold: 6, warranty: 3, icon: 'headphones', kw: 'سماعه راس هيدفون هيد فون headphone بلوتوث', sku: '6971234500419', min: 2 }),
    P('a19', 'car', 'حامل مغناطيس للتابلوه', 190, 95, { stock: 9, sold: 7, icon: 'car', kw: 'حامل مغناطيس مغناطيسي عربيه تابلوه', sku: '6223001234683', min: 3 }),
    P('s1', 'smart', 'ساعة ذكية T900 Ultra', 950, 650, { stock: 6, sold: 8, warranty: 3, icon: 'watch', kw: 'ساعه سمارت ووتش smart watch', sku: '6971234522008', min: 2 }),
    P('s2', 'smart', 'Xiaomi Smart Band 9', 1850, 1520, { stock: 4, sold: 3, warranty: 12, icon: 'watch', kw: 'شاومي باند سوار ذكي اسورة mi band', sku: '6941812790001', min: 2 }),
  ];

  // وحدات الأجهزة: كل جهاز بالـ IMEI بتاعه وتكلفته الفعلية
  const units = [];
  const recv = ['2026-09-21', '2026-09-28', '2026-10-03', '2026-10-09', '2026-10-14'];
  for (const p of products) {
    if (!p.serial) continue;
    for (let i = 0; i < p.units; i++) {
      units.push({
        imei: makeImei(p.tac), imei2: makeImei(p.tac), pid: p.id,
        color: p.colors[i % p.colors.length], storage: p.storage,
        condition: p.cat === 'used' ? p.grade : 'جديد',
        battery: p.cat === 'used' ? 82 + Math.floor(rnd() * 14) : null,
        customs: p.cat === 'used' ? 'مسجّل في تليفوني' : null,
        cost: p.cost + Math.round((rnd() - 0.5) * 20) * 10,
        received: recv[Math.floor(rnd() * recv.length)], status: 'in',
      });
    }
    delete p.units;
  }

  const customers = [
    { id: 'c1', name: 'محمد عبد الله', phone: '01012345678', balance: 0, visits: 7 },
    { id: 'c2', name: 'سارة أحمد', phone: '01123456789', balance: 0, visits: 3 },
    { id: 'c3', name: 'مينا جرجس', phone: '01287654321', balance: 1500, visits: 12 },
    { id: 'c4', name: 'أحمد سمير', phone: '01555123456', balance: 0, visits: 2 },
    { id: 'c5', name: 'ورشة الأمل (تاجر)', phone: '01099887766', balance: 3200, visits: 25 },
    { id: 'c6', name: 'نورهان خالد', phone: '01244556677', balance: 0, visits: 4 },
    { id: 'c7', name: 'كريم مصطفى', phone: '01011122233', balance: 0, visits: 1 },
  ];

  // محافظ المحل (للخدمات وللتحصيل). الحدود الموثّقة بس: فودافون كاش وإنستاباي
  const wallets = [
    { id: 'vf', name: 'فودافون كاش', number: '01001234567', balance: 18450, limitDay: 60000, usedToday: 18500, color: '#e60000' },
    { id: 'et', name: 'اتصالات كاش', number: '01112345678', balance: 6200, usedToday: 4000, color: '#719e19' },
    { id: 'or', name: 'أورنج كاش', number: '01223456789', balance: 4750, usedToday: 2500, color: '#ff7900' },
    { id: 'we', name: 'وي باي', number: '01559876543', balance: 2100, usedToday: 0, color: '#5c2d91' },
    { id: 'ip', name: 'إنستاباي', number: 'mobilestore@instapay', balance: 25300, limitDay: 70000, usedToday: 9000, color: '#3b2a85' },
  ];

  const payMethods = [
    { id: 'cash', name: 'كاش', icon: 'banknote' },
    { id: 'vf', name: 'فودافون كاش', icon: 'wallet' },
    { id: 'instapay', name: 'إنستاباي', icon: 'zap' },
    { id: 'card', name: 'فيزا / ميزة', icon: 'credit-card' },
    { id: 'install', name: 'تقسيط', icon: 'calendar-clock' },
    { id: 'credit', name: 'آجل', icon: 'notebook-pen' },
  ];
  const installProviders = ['valU', 'سهولة', 'Sympl', 'حالًا', 'كونتكت'];

  const operators = [
    { id: 'vf', name: 'فودافون', color: '#e60000' },
    { id: 'or', name: 'أورنج', color: '#ff7900' },
    { id: 'et', name: 'اتصالات', color: '#719e19' },
    { id: 'we', name: 'WE', color: '#5c2d91' },
  ];
  const cardValues = [10, 15, 25, 50, 100, 200];
  const billTypes = [
    { id: 'net', name: 'إنترنت أرضي', icon: 'wifi' },
    { id: 'land', name: 'تليفون أرضي', icon: 'phone' },
    { id: 'elec', name: 'كهرباء', icon: 'zap' },
    { id: 'water', name: 'مياه', icon: 'droplets' },
    { id: 'gas', name: 'غاز', icon: 'flame' },
  ];

  const repairStatuses = [
    { id: 'received', name: 'استلام', icon: 'package-plus' },
    { id: 'diagnosing', name: 'فحص', icon: 'search' },
    { id: 'waiting', name: 'مستني قطعة / موافقة', icon: 'clock' },
    { id: 'ready', name: 'جاهز للتسليم', icon: 'circle-check' },
    { id: 'delivered', name: 'اتسلّم', icon: 'check-check' },
  ];
  const repairIssues = ['شاشة', 'بطارية', 'سوكت شحن', 'فلاتة شحن', 'فلاتة باور', 'كاميرا', 'بصمة', 'سوفت وير', 'مياه'];
  const repairs = [
    { no: 'R-1052', device: 'Samsung Galaxy A12', issue: 'مياه، مش بيفتح', customer: 'كريم مصطفى', phone: '01011122233', status: 'received', estimate: 0, deposit: 0, due: 'بكره', tech: 'م. حسن', at: '10:05 ص' },
    { no: 'R-1051', device: 'iPhone 11', issue: 'تغيير شاشة', customer: 'أحمد سمير', phone: '01555123456', status: 'received', estimate: 2800, deposit: 500, due: 'النهارده 6 م', tech: 'م. حسن', at: '9:40 ص' },
    { no: 'R-1050', device: 'Samsung Galaxy A32', issue: 'سوكت شحن', customer: 'نورهان خالد', phone: '01244556677', status: 'diagnosing', estimate: 350, deposit: 0, due: 'النهارده 4 م', tech: 'م. حسن', at: 'امبارح' },
    { no: 'R-1049', device: 'Redmi Note 10', issue: 'بطارية بتفصل', customer: 'محمد عبد الله', phone: '01012345678', status: 'waiting', estimate: 650, deposit: 200, due: 'بكره', tech: 'م. حسن', at: 'امبارح', note: 'مستني البطارية من المورد' },
    { no: 'R-1048', device: 'OPPO A57', issue: 'سوفت وير: فورمات وتحديث', customer: 'سارة أحمد', phone: '01123456789', status: 'ready', estimate: 150, deposit: 0, due: 'النهارده', tech: 'يوسف', at: '11:15 ص' },
    { no: 'R-1047', device: 'iPhone XR', issue: 'كاميرا خلفية', customer: 'مينا جرجس', phone: '01287654321', status: 'ready', estimate: 1200, deposit: 300, due: 'النهارده', tech: 'م. حسن', at: 'امبارح' },
    { no: 'R-1046', device: 'Honor X7', issue: 'شاشة', customer: 'ورشة الأمل (تاجر)', phone: '01099887766', status: 'delivered', estimate: 1900, deposit: 1900, due: 'امبارح', tech: 'م. حسن', at: 'امبارح' },
    { no: 'R-1045', device: 'Infinix Hot 30', issue: 'فلاتة باور', customer: 'أحمد سمير', phone: '01555123456', status: 'delivered', estimate: 400, deposit: 400, due: 'امبارح', tech: 'م. حسن', at: 'امبارح' },
  ];

  // الوردية الحالية: المتوقع في الدرج = 1000 + 11730 + 4040 − 2970 − 150 − 1300 = 12350
  const shift = {
    no: 142, opened: '9:00 ص', by: 'يوسف', opening: 1000, cashSales: 11730, servicesIn: 4040, servicesOut: 2970,
    expenses: [{ name: 'شاي وقهوة', amount: 50 }, { name: 'مواصلات توصيل', amount: 100 }], ownerDraw: 1300,
  };

  const dash = {
    today: { sales: 38420, invoices: 46, profit: 4870, services: 17, servicesFee: 215, yesterday: 34300,
      bySeller: { u1: 13210, u2: 14830, u3: 10380 }, countBySeller: { u1: 11, u2: 21, u3: 14 } },
    week: [21300, 33950, 28400, 41200, 36780, 52100, 38420],
    pay: [
      { name: 'كاش', v: 58 }, { name: 'فودافون كاش', v: 17 }, { name: 'إنستاباي', v: 11 },
      { name: 'تقسيط', v: 8 }, { name: 'فيزا / ميزة', v: 6 },
    ],
    top: [
      ['اسكرينة زجاج 9D', 31, 3100], ['جراب سيليكون شفاف', 24, 2880], ['كابل تايب سي لتايب سي', 12, 1800],
      ['Redmi 14C 128GB', 3, 18897], ['Samsung Galaxy A16 128GB', 2, 18500],
    ],
    recent: [
      { no: 10452, at: '12:41 م', seller: 'يوسف', sellerId: 'u2', customer: 'نقدي', method: 'كاش', total: 270 },
      { no: 10451, at: '12:18 م', seller: 'مارينا', sellerId: 'u3', customer: 'سارة أحمد', method: 'إنستاباي', total: 10999 },
      { no: 10450, at: '11:52 ص', seller: 'يوسف', sellerId: 'u2', customer: 'نقدي', method: 'كاش', total: 100 },
      { no: 10449, at: '11:30 ص', seller: 'بيتر', sellerId: 'u1', customer: 'مينا جرجس', method: 'تقسيط (valU)', total: 21499 },
      { no: 10448, at: '11:02 ص', seller: 'مارينا', sellerId: 'u3', customer: 'نقدي', method: 'فودافون كاش', total: 650 },
    ],
  };

  const devices = [
    { name: 'موبايل بيتر', model: 'Samsung Galaxy A56', online: true, last: 'متصل دلوقتي' },
    { name: 'موبايل يوسف', model: 'Redmi Note 14', online: true, last: 'متصل دلوقتي' },
  ];

  /* ===== سجل المبيعات (تجريبي): فواتير 14 شهر بأصنافها (من أول الشهر من 13 شهر لحد النهارده) =====
     التقارير والموبايل وشاشة المبيعات بيحسبوا كلهم من السجل ده (analytics.js)، والبيعات الجديدة بتتضاف عليه.
     مولّد لوحده عشان الـ IMEI والأرقام اللي فوق ما تتغيّرش. المحل بيفتح 9 الصبح ويقفل 11 بالليل، والنهارده لحد الساعة دلوقتي.
     فيه نمو على السنة ومواسم السوق المصري، عشان مقارنات الشهور يبقى ليها معنى. */
  // آخر الاستلامات (تجريبي). المورد اسم بيكتبه المحل من غير سجل موردين، زي البرنامج الحقيقي (receive_stock)
  const receipts = [
    { no: 41, at: new Date(Date.now() - 9 * 864e5), supplier: 'الأمل للموبايلات', by: 'u1', lines: [{ pid: 'p1', qty: 3, cost: 8600, imeis: [] }, { pid: 'p4', qty: 4, cost: 5800, imeis: [] }] },
    { no: 42, at: new Date(Date.now() - 5 * 864e5), supplier: 'المصرية للإكسسوارات', by: 'u2', lines: [{ pid: 'a1', qty: 40, cost: 35, imeis: [] }, { pid: 'a2', qty: 60, cost: 25, imeis: [] }] },
    { no: 43, at: new Date(Date.now() - 2 * 864e5), supplier: 'النور للتوزيع', by: 'u1', lines: [{ pid: 'a6', qty: 30, cost: 60, imeis: [] }] },
  ];
  const history = (() => {
    let hs = 20261016;
    const hr = () => { hs = (hs * 1103515245 + 12345) % 2147483648; return hs / 2147483648; };
    const weighted = (list) => { const tot = list.reduce((a, p) => a + p.sold + 2, 0); let r = hr() * tot; for (const p of list) { r -= p.sold + 2; if (r <= 0) return p; } return list[list.length - 1]; };
    const imeiOf = (tac) => { let x = tac; while (x.length < 14) x += Math.floor(hr() * 10); return x + luhnDigit(x); };
    const newPhones = products.filter((p) => p.cat === 'phones'), usedPhones = products.filter((p) => p.cat === 'used');
    const accs = products.filter((p) => !p.serial), addOns = accs.filter((p) => p.cat === 'cases' || p.cat === 'screens');
    const sellerOf = () => { const r = hr(); return r < 0.42 ? 'u2' : r < 0.75 ? 'u3' : 'u1'; };
    const unitLine = (p) => ({ pid: p.id, name: p.name, cat: p.cat, qty: 1, price: p.price, cost: p.cost, imei: imeiOf(p.tac), warranty: p.warranty });
    const itemLine = (p, qty = 1) => ({ pid: p.id, name: p.name, cat: p.cat, qty, price: p.price, cost: p.cost, imei: null, warranty: p.warranty });
    const out = [], now = new Date(), OPEN = 9 * 60, CLOSE = 23 * 60;
    const first = new Date(now.getFullYear(), now.getMonth() - 13, 1), DAYS = Math.round((new Date(now.getFullYear(), now.getMonth(), now.getDate()) - first) / 864e5);
    // المواسم: [عدد الفواتير، نسبة الموبايلات]. العيدين بتواريخهم لكل سنة، والباقي بيتكرر كل سنة بنفس الأيام
    const FITR = ['2025-03-30', '2026-03-20', '2027-03-09', '2028-02-26'], ADHA = ['2025-06-06', '2026-05-27', '2027-05-16', '2028-05-05'];
    const near = (day, list) => { let best = 999; for (const e of list) { const [y, m, dd] = e.split('-').map(Number); const k = Math.round((day - new Date(y, m - 1, dd)) / 864e5); if (Math.abs(k) < Math.abs(best)) best = k; } return best; };
    const season = (day) => {
      const f = near(day, FITR), a = near(day, ADHA), md = (day.getMonth() + 1) * 100 + day.getDate();
      if (f >= -10 && f <= 2) return [1.3, 1.7];        // قبل عيد الفطر والعيد: هدايا وعيدية
      if (f >= -30 && f < -10) return [0.93, 0.9];      // رمضان
      if (f > 2 && f <= 20) return [0.88, 0.8];         // بعد العيد
      if (a >= -10 && a <= 2) return [1.18, 1.3];       // عيد الأضحى
      if (md >= 912 && md <= 1003) return [1.12, 1];    // المدارس
      if (md >= 1120 && md <= 1130) return [1.15, 1.3]; // الجمعة البيضا
      if (md >= 1224 || md <= 107) return [1.06, 1.1];  // راس السنة وعيد الميلاد
      if (md >= 801 && md <= 820) return [1.1, 1.4];    // نتيجة الثانوية العامة
      return [1, 1];
    };
    for (let back = DAYS; back >= 0; back--) {
      const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() - back);
      const end = back === 0 ? Math.min(CLOSE, now.getHours() * 60 + now.getMinutes()) : CLOSE;
      if (end <= OPEN) continue;
      const busy = day.getDay() === 4 || day.getDay() === 5 ? 9 : 0;
      const [rush, gift] = season(day), grow = 0.86 + 0.14 * (1 - back / DAYS); // المحل بيكبر: من 86% أول السجل لحد 100% النهارده
      const n = Math.round((34 + Math.floor(hr() * 15) + busy) * rush * grow * (end - OPEN) / (CLOSE - OPEN));
      // الوقت بالثانية ومترتّب بالثانية: الرقم الأكبر عمره ما يبقى قبل الأصغر
      const secs = Array.from({ length: n }, () => OPEN * 60 + Math.floor(hr() * (end - OPEN) * 60)).sort((a, b) => a - b);
      for (const sec of secs) {
        const lines = [], r = hr();
        if (r < 0.1 * gift) { lines.push(unitLine(weighted(newPhones))); if (hr() < 0.6) lines.push(itemLine(weighted(addOns))); }
        else if (r < 0.1 * gift + 0.03) lines.push(unitLine(weighted(usedPhones)));
        else { const k = hr() < 0.7 ? 1 : hr() < 0.8 ? 2 : 3; for (let i = 0; i < k; i++) { const p = weighted(accs); const ex = lines.find((l) => l.pid === p.id); if (ex) ex.qty++; else lines.push(itemLine(p, hr() < 0.15 ? 2 : 1)); } }
        const phone = lines.some((l) => l.imei);
        const sub = lines.reduce((a, l) => a + l.price * l.qty, 0);
        const disc = phone && hr() < 0.15 ? 50 * (1 + Math.floor(hr() * 5)) : !phone && sub >= 300 && hr() < 0.04 ? 20 : 0;
        const total = sub - disc, profit = lines.reduce((a, l) => a + (l.price - l.cost) * l.qty, 0) - disc;
        const cust = hr() < (phone ? 0.6 : 0.1) ? customers[Math.floor(hr() * customers.length)].id : null;
        const pr = hr(); let method = pr < 0.6 ? 'cash' : pr < 0.75 ? 'vf' : pr < 0.85 ? 'instapay' : pr < 0.93 ? 'card' : phone ? 'install' : 'cash';
        if (method === 'cash' && cust && hr() < 0.06) method = 'credit';
        const payments = [{ method, amount: total, provider: method === 'install' ? installProviders[Math.floor(hr() * installProviders.length)] : '' }];
        if (method === 'cash' && total >= 1000 && hr() < 0.08) { const part = Math.round((total * (0.3 + hr() * 0.4)) / 10) * 10; payments[0].amount = total - part; payments.push({ method: 'vf', amount: part, provider: '' }); }
        const at = new Date(day); at.setHours(Math.floor(sec / 3600), Math.floor(sec / 60) % 60, sec % 60);
        out.push({ no: 0, at, sellerId: sellerOf(), customerId: cust, lines, disc, total, profit, payments });
      }
    }
    // الترقيم بالترتيب من 1001، وأول فاتورة في الجلسة بعد آخر واحدة (app.js: S.nextNo)
    out.forEach((x, i) => { x.no = 1001 + i; });
    return out;
  })();

  return {
    users, categories, products, units, customers, wallets, payMethods, installProviders, operators, cardValues,
    billTypes, repairStatuses, repairIssues, repairs, shift, dash, devices, history, receipts, makeImei, luhnDigit,
  };
})();
