# Hindi language review (#55), November 2026

Reviewer: AI reviewer (Claude), at the owner's request, in place of a human native speaker. A quick check of the
screens by staff at the pilot site is still recommended.

Scope: all 2,016 strings in `apps/web/lib/i18n/dictionaries/hi.json`, compared with `en.json` and
`docs/I18N-hi-glossary.md`. The standard was short, natural Hindi as cashiers, waiters and kitchen staff speak it:
common loanwords kept (KOT, GST, UPI, बिल, ऑर्डर, टेबल, सप्लायर…), correct gender and number, placeholders unchanged,
and no long button labels.

Result: **240 strings changed**, all other strings left as they were. No keys were added or removed.
The glossary was updated with the new term decisions.

| Code | Reason | Strings |
|---|---|---|
| G | Gender (टेबल/डिश feminine) | 9 |
| T | Glossary consistency | 69 |
| N | More natural staff Hindi | 94 |
| E | Wrong/misleading meaning | 36 |
| W | Fits UI layout / word order | 13 |
| L | Shorter label | 10 |
| O | Spelling consistency | 9 |

## Main decisions
- **टेबल is feminine** in everyday speech (टेबल खुली रहेगी, भरी हुई टेबल). The old text mixed masculine forms.
- **Price = कीमत** everywhere (the menu used both मूल्य and कीमत). मूल्य now means only "value" (स्टॉक मूल्य).
- **Supplier = सप्लायर**, not the textbook आपूर्तिकर्ता. "Vendor invoice" also uses सप्लायर.
- **API/backup/sync key = कुंजी.** "की" was ambiguous with the possessive (e.g. "की रद्द कर दी गई").
- **Approve = मंज़ूर**, kept separate from Accept = स्वीकार / स्वीकृत (both were स्वीकृत before).
- **Points = पॉइंट** (POS said अंक, settings said पॉइंट / पॉइंट्स). **Dish = डिश** (feminine), not व्यंजन.
- Clear errors fixed: Unpaid = अवैतनिक ("unsalaried") became भुगतान बाकी; Tally "To date" = अंतिम तारीख़ ("deadline")
  became तारीख़ तक; equipment "Retire" = सेवानिवृत्त (a person retiring) became इस्तेमाल बंद करें; "working summary" =
  कार्यकारी सारांश ("executive summary") became अनुमानित सारांश; audit "Entity" = इकाई clashed with Unit; flat discount "₹ Cash"
  read like a cash payment.
- Kiosk settings now quote the kiosk's own label (“पार्सल”, not “टेकअवे”). The referral help quotes the new loyalty label.
- Kitchen labels are shorter: बन रहा है (Preparing), तैयार हो गया (Mark ready), परोस दिया (Mark served).
- Spelling: plural endings use chandrabindu (श्रेणियाँ, कार्रवाइयाँ, शाखाएँ). रेस्तरां became रेस्टोरेंट, उदा. became जैसे, and पृष्ठ became पेज.

## Screenshot check
Not done in this pass. Docker Desktop was stopped on the review machine, so the locked browser QA
(`tests/i18n-hindi.spec.ts`, `tests/pages-smoke.spec.ts`) and the 1440 px / 375 px Hindi screenshots of POS, KDS,
tables, dashboard, menu, reports and settings could not run. Instead, the review compared the length of every nav,
tab, KDS and POS button label with the English text. The changes above only shorten or keep the length of those labels
(for example, बन रहा है replaces तैयार हो रहा है). No changed string is much longer than the text it replaces.
The existing `i18n-hindi.spec.ts` overflow checks for POS, KDS and tables should run in CI on this PR.


## All changes
| Key | Current | Proposed (applied) | Reason |
|---|---|---|---|
| `order.pricesIncludeTax` | मूल्य कर सहित हैं। स्टाफ़ जल्द ही आपके ऑर्डर की पुष्टि करेगा। | कीमतें कर सहित हैं। स्टाफ़ जल्द ही आपके ऑर्डर की पुष्टि करेगा। | Glossary consistency |
| `kiosk.review.taxIncluded` | मूल्य में {tax} शामिल है | कीमत में {tax} शामिल है | Glossary consistency |
| `kiosk.review.taxAdded` | मूल्य में {tax} शामिल नहीं है; यह कुल में जोड़ा जाता है | कीमत में {tax} शामिल नहीं है; यह कुल में जोड़ा जाता है | Glossary consistency |
| `pos.occupiedSuffix` | (भरा हुआ) | (भरी हुई) | Gender (टेबल/डिश feminine) |
| `pos.kitchen.preparing` | तैयार हो रहा है | बन रहा है | Shorter label |
| `pos.checkout.reprintSent` | री-प्रिंट भेजा गया — कागज़ पर REPRINT अंकित है | रीप्रिंट भेजा गया — कागज़ पर REPRINT छपा है | Glossary consistency |
| `pos.checkout.changeDue` | वापस करने योग्य राशि {amount} | वापसी {amount} | More natural staff Hindi |
| `pos.checkout.pointsRedeemed` | {count} अंक भुनाए गए | {count} पॉइंट रिडीम किए गए | Glossary consistency |
| `pos.checkout.noNeedToPay` | अभी भुगतान की ज़रूरत नहीं — दूसरे टेबल की मदद के लिए {back} दबाएं और इस टेबल का बिल बाद में यहीं से या टेबल पृष्ठ से बनाएं। | अभी भुगतान की ज़रूरत नहीं — दूसरी टेबल संभालने के लिए {back} दबाएं और इस टेबल का बिल बाद में यहीं से या टेबल पेज से बनाएं। | Gender (टेबल/डिश feminine) |
| `pos.checkout.lockedNote` | बिल चुकता होने तक छूट, टिप और अंक लॉक हैं। | बिल चुकता होने तक छूट, टिप और पॉइंट लॉक हैं। | Glossary consistency |
| `pos.checkout.discountFlat` | ₹ नकद | ₹ राशि | Wrong/misleading meaning |
| `pos.checkout.noDiscountRole` | आपकी भूमिका छूट लागू नहीं कर सकती। | आपकी भूमिका को छूट देने की अनुमति नहीं है। | More natural staff Hindi |
| `pos.checkout.redeemPoints` | लॉयल्टी अंक भुनाएं | लॉयल्टी पॉइंट रिडीम करें | Glossary consistency |
| `pos.checkout.partPayment` | आंशिक भुगतान — {amount} बाकी रहेगा और टेबल खुला रहेगा। | आंशिक भुगतान — {amount} बाकी रहेगा और टेबल खुली रहेगी। | Gender (टेबल/डिश feminine) |
| `pos.checkout.splitBetween` | इनके बीच बांटें | बिल बांटें | Fits UI layout / word order |
| `pos.checkout.guests` | मेहमान | मेहमानों में | Fits UI layout / word order |
| `pos.checkout.splitHint` | प्रति व्यक्ति {amount} — हर मेहमान का हिस्सा आंशिक भुगतान के रूप में दर्ज करें, या अलग से लेकर पूरे टेबल का भुगतान एक बार में पूरा करें। | प्रति व्यक्ति {amount} — हर मेहमान का हिस्सा आंशिक भुगतान के रूप में दर्ज करें, या अलग-अलग लेकर पूरी टेबल का भुगतान एक बार में पूरा करें। | Gender (टेबल/डिश feminine) |
| `pos.checkout.printBillTitle` | मेहमान के लिए बिल प्रिंट करता है। कुछ चार्ज नहीं होता और टेबल खुला रहता है। | मेहमान के लिए बिल प्रिंट करता है। कुछ चार्ज नहीं होता और टेबल खुली रहती है। | Gender (टेबल/डिश feminine) |
| `pos.checkout.loyalty` | लॉयल्टी ({points} अंक) | लॉयल्टी ({points} पॉइंट) | Glossary consistency |
| `pos.customerPts` | {count} अंक | {count} पॉइंट | Glossary consistency |
| `pos.kitchenWidget.preparing` | तैयार हो रहा है | बन रहा है | Shorter label |
| `pos.tablePicker.occupiedTap` | भरा हुआ — आइटम जोड़ने या बिल के लिए टैप करें | भरी हुई — आइटम जोड़ने या बिल के लिए टैप करें | Gender (टेबल/डिश feminine) |
| `pos.tablePicker.none` | इस शाखा के लिए अभी कोई टेबल सेट नहीं है। मैनेजर उन्हें टेबल में जोड़ सकता है। | इस शाखा के लिए अभी कोई टेबल सेट नहीं है। मैनेजर इन्हें टेबल पेज पर जोड़ सकते हैं। | More natural staff Hindi |
| `pos.tablePicker.floor` | मंज़िल | फ़्लोर | Glossary consistency |
| `pos.tablePicker.noneOnFloor` | इस मंज़िल पर अभी कोई टेबल नहीं है। | इस फ़्लोर पर अभी कोई टेबल नहीं है। | Glossary consistency |
| `pos.tablePicker.occupied` | भरा हुआ | भरी हुई | Gender (टेबल/डिश feminine) |
| `pos.scale.pricePerKg` | मूल्य / kg | कीमत / kg | Glossary consistency |
| `pos.scale.price` | मूल्य: | कीमत: | Glossary consistency |
| `pos.modifier.enterPrice` | {portion} पोर्शन का मूल्य दर्ज करें | {portion} पोर्शन की कीमत दर्ज करें | Glossary consistency |
| `pos.modifier.customLabelPlaceholder` | लेबल, उदा. क्वार्टर | लेबल, जैसे क्वार्टर | Glossary consistency |
| `pos.modifier.price` | मूल्य | कीमत | Glossary consistency |
| `pos.modifier.portionPriceAria` | {portion} पोर्शन का मूल्य | {portion} पोर्शन की कीमत | Glossary consistency |
| `kds.col.preparing` | तैयार हो रहा है | बन रहा है | Shorter label |
| `kds.ticket.markReady` | तैयार चिह्नित करें | तैयार हो गया | Shorter label |
| `kds.ticket.markServed` | परोसा गया चिह्नित करें | परोस दिया | Shorter label |
| `kds.priority.mark` | प्राथमिकता चिह्नित करें | प्राथमिकता दें | Shorter label |
| `kds.print.reprintTitle` | टिकट दोबारा प्रिंट करें (REPRINT चिह्नित) | टिकट दोबारा प्रिंट करें (REPRINT छपेगा) | More natural staff Hindi |
| `inv.tabs.suppliers` | आपूर्तिकर्ता | सप्लायर | More natural staff Hindi |
| `inv.col.reorderLevel` | पुनः ऑर्डर स्तर | री-ऑर्डर स्तर | More natural staff Hindi |
| `inv.col.supplier` | आपूर्तिकर्ता | सप्लायर | More natural staff Hindi |
| `inv.selectSupplier` | आपूर्तिकर्ता चुनें | सप्लायर चुनें | More natural staff Hindi |
| `inv.status.PENDING_APPROVAL` | अनुमोदन लंबित | मंज़ूरी बाकी | More natural staff Hindi |
| `inv.status.APPROVED` | अनुमोदित | मंज़ूर | Glossary consistency |
| `inv.status.CONVERTED` | परिवर्तित | PO बना | Wrong/misleading meaning |
| `inv.status.UNPAID` | अवैतनिक | भुगतान बाकी | Wrong/misleading meaning |
| `inv.markAs` | {status} चिह्नित करें | {status} मार्क करें | More natural staff Hindi |
| `inv.pr.subtitle` | स्टाफ़ द्वारा किए गए अनुरोध, PO बनने से पहले अनुमोदन की प्रतीक्षा में | स्टाफ़ के अनुरोध, PO बनने से पहले मंज़ूरी की प्रतीक्षा में | Glossary consistency |
| `inv.pr.notes` | टिप्पणियां | टिप्पणियाँ | Spelling consistency |
| `inv.quote.title` | आपूर्तिकर्ता कोटेशन | सप्लायर कोटेशन | More natural staff Hindi |
| `inv.quote.subtitle` | ऑर्डर से पहले आपूर्तिकर्ताओं के मूल्य की तुलना करें | ऑर्डर से पहले सप्लायरों की कीमतों की तुलना करें | Glossary consistency |
| `inv.quote.empty.body` | एक ही सामग्री के लिए दूसरों से तुलना करने हेतु आपूर्तिकर्ता का बताया मूल्य दर्ज करें। | एक ही सामग्री के लिए दूसरों से तुलना करने को सप्लायर की बताई कीमत दर्ज करें। | Glossary consistency |
| `inv.quote.dialogTitle` | आपूर्तिकर्ता कोटेशन दर्ज करें | सप्लायर कोटेशन दर्ज करें | More natural staff Hindi |
| `inv.quote.pricePerUnit` | मूल्य/इकाई | कीमत/इकाई | Glossary consistency |
| `inv.invoice.title` | विक्रेता इनवॉइस | सप्लायर इनवॉइस | Glossary consistency |
| `inv.invoice.subtitle` | ट्रैक करें कि आपूर्तिकर्ताओं ने कितना बिल किया और कितना चुकाया गया | ट्रैक करें कि सप्लायरों ने कितना बिल किया और कितना चुकाया गया | More natural staff Hindi |
| `inv.invoice.empty.title` | अभी कोई विक्रेता इनवॉइस नहीं | अभी कोई सप्लायर इनवॉइस नहीं | Glossary consistency |
| `inv.invoice.empty.body` | आपूर्तिकर्ता का भेजा इनवॉइस जोड़ें ताकि उस पर भुगतान ट्रैक किए जा सकें। | सप्लायर का भेजा इनवॉइस जोड़ें ताकि उस पर भुगतान ट्रैक किए जा सकें। | More natural staff Hindi |
| `inv.invoice.dialogTitle` | विक्रेता इनवॉइस जोड़ें | सप्लायर इनवॉइस जोड़ें | Glossary consistency |
| `inv.invoice.supplierOnInvoice` | इनवॉइस पर आपूर्तिकर्ता: {name} | इनवॉइस पर सप्लायर: {name} | More natural staff Hindi |
| `inv.invoice.addFailed` | आपूर्तिकर्ता इनवॉइस नहीं जोड़ा जा सका | सप्लायर इनवॉइस नहीं जोड़ा जा सका | More natural staff Hindi |
| `inv.po.empty.body` | आपूर्तिकर्ताओं को दिए ऑर्डर ट्रैक करना शुरू करने के लिए एक बनाएं। | सप्लायरों को दिए ऑर्डर ट्रैक करना शुरू करने के लिए एक बनाएं। | More natural staff Hindi |
| `inv.po.markSent` | भेजा गया चिह्नित करें | भेजा गया मार्क करें | More natural staff Hindi |
| `inv.po.markedSent` | आपूर्तिकर्ता को भेजा गया चिह्नित किया | सप्लायर को भेजा गया मार्क किया | More natural staff Hindi |
| `inv.receive.title` | {number} के विरुद्ध प्राप्ति | {number} का माल प्राप्त करें | More natural staff Hindi |
| `inv.supplier.new` | नया आपूर्तिकर्ता | नया सप्लायर | More natural staff Hindi |
| `inv.supplier.add` | आपूर्तिकर्ता जोड़ें | सप्लायर जोड़ें | More natural staff Hindi |
| `inv.supplier.addFailed` | आपूर्तिकर्ता नहीं जोड़ा जा सका | सप्लायर नहीं जोड़ा जा सका | More natural staff Hindi |
| `inv.suppliers.search` | आपूर्तिकर्ता खोजें… | सप्लायर खोजें… | More natural staff Hindi |
| `inv.suppliers.empty.title` | अभी कोई आपूर्तिकर्ता नहीं | अभी कोई सप्लायर नहीं | More natural staff Hindi |
| `inv.suppliers.empty.body` | पहला खरीद ऑर्डर बनाने से पहले आपूर्तिकर्ता जोड़ें। | पहला खरीद ऑर्डर बनाने से पहले सप्लायर जोड़ें। | More natural staff Hindi |
| `inv.perf.what` | आपूर्तिकर्ता का प्रदर्शन | सप्लायर का प्रदर्शन | More natural staff Hindi |
| `inv.adjust.reasonPlaceholder` | जैसे भौतिक गिनती में सुधार | जैसे असल गिनती के अनुसार सुधार | More natural staff Hindi |
| `inv.transfers.toBranch` | गंतव्य शाखा | किस शाखा में | More natural staff Hindi |
| `acct.error` | कुछ गलत हो गया | कुछ गड़बड़ हो गई | Glossary consistency |
| `acct.close.openingFloat` | शुरुआती फ़्लोट | शुरुआती कैश | More natural staff Hindi |
| `acct.close.balanced` | संतुलित | हिसाब बराबर | More natural staff Hindi |
| `acct.pl.payroll` | पेरोल (अंतिम रन) | पेरोल (फ़ाइनल रन) | Wrong/misleading meaning |
| `acct.gst.note` | इस अवधि के भुगतान किए गए ऑर्डर पर आधारित, हर बिल की छूट अनुपात में लागू करके। इसे कार्यकारी सारांश की तरह उपयोग करें; फ़ाइलिंग अपने अकाउंटेंट से पक्की करवाएँ। | इस अवधि के भुगतान हुए ऑर्डर पर आधारित, हर बिल की छूट अनुपात में लागू करके। इसे अनुमानित सारांश की तरह इस्तेमाल करें; फ़ाइलिंग अपने अकाउंटेंट से पक्की करवाएँ। | Wrong/misleading meaning |
| `acct.tally.from` | शुरू की तारीख़ | तारीख़ से | More natural staff Hindi |
| `acct.tally.to` | अंतिम तारीख़ | तारीख़ तक | Wrong/misleading meaning |
| `settings.general.loyalty.earn` | 1 पॉइंट कमाएँ प्रति | 1 पॉइंट के लिए खर्च | Fits UI layout / word order |
| `settings.general.loyalty.redeem` | 1 पॉइंट इतने में रिडीम होता है | 1 पॉइंट की कीमत | Fits UI layout / word order |
| `settings.general.referral.desc` | ग्राहक कोई डिश या अपना निजी लिंक शेयर करते हैं। पॉइंट तभी मिलते हैं जब नए ग्राहक की पहली खरीद का भुगतान हो जाए। पॉइंट का मूल्य ऊपर “1 पॉइंट इतने में रिडीम होता है” की राशि के अनुसार है (100 पॉइंट = {currency} 10 के लिए 0.10 दर्ज करें)। | ग्राहक कोई डिश या अपना निजी लिंक शेयर करते हैं। पॉइंट तभी मिलते हैं जब नए ग्राहक की पहली खरीद का भुगतान हो जाए। हर पॉइंट की कीमत ऊपर दी गई “1 पॉइंट की कीमत” जितनी है (100 पॉइंट = {currency} 10 के लिए 0.10 दर्ज करें)। | Fits UI layout / word order |
| `settings.general.web.makePrices` | कीमतें करें | वेबसाइट कीमतें | Fits UI layout / word order |
| `settings.general.web.cheaper` | सस्ता | सस्ती | Fits UI layout / word order |
| `settings.general.web.costlier` | महंगा | महँगी | Fits UI layout / word order |
| `settings.general.web.by` | द्वारा | किस आधार पर | Wrong/misleading meaning |
| `settings.general.discount.maxHelp` | 100 का मतलब कोई सीमा नहीं। मालिक, एडमिन और “कैशियर सीमा से अधिक छूट” अनुमति वाली भूमिकाएं इससे अधिक दे सकती हैं। | 100 का मतलब कोई सीमा नहीं। मालिक, एडमिन और “कैशियर सीमा से अधिक छूट” अनुमति वाली भूमिकाएँ इससे अधिक दे सकती हैं। | Spelling consistency |
| `settings.general.saveRestaurant` | रेस्तरां सहेजें | रेस्टोरेंट सहेजें | Glossary consistency |
| `settings.general.restaurantSaved` | रेस्तरां का विवरण सहेजा गया | रेस्टोरेंट का विवरण सहेजा गया | Glossary consistency |
| `settings.backup.subtitle` | रेस्तरां, शाखा और स्टाफ़ कॉन्फ़िगरेशन | रेस्टोरेंट, शाखा और स्टाफ़ कॉन्फ़िगरेशन | Glossary consistency |
| `settings.backup.s3.desc` | किसी भी S3-संगत बकेट में पूरे डेटाबेस और अपलोड फ़ाइलों का बैकअप। यह पूरे इंस्टेंस पर लागू है — इस सर्वर पर होस्ट हर रेस्तरां इसमें शामिल है, सिर्फ़ आपका नहीं। | किसी भी S3-संगत बकेट में पूरे डेटाबेस और अपलोड फ़ाइलों का बैकअप। यह पूरे इंस्टेंस पर लागू है — इस सर्वर पर होस्ट हर रेस्टोरेंट इसमें शामिल है, सिर्फ़ आपका नहीं। | Glossary consistency |
| `settings.backup.accessKey` | एक्सेस की आईडी | एक्सेस कुंजी आईडी | Wrong/misleading meaning |
| `settings.backup.secretKey` | सीक्रेट एक्सेस की | सीक्रेट एक्सेस कुंजी | Wrong/misleading meaning |
| `settings.backup.interval` | हर बैकअप (दिन) | कितने दिन में बैकअप | Fits UI layout / word order |
| `settings.backup.retain` | पिछले (बैकअप) रखें | कितने पिछले बैकअप रखें | Fits UI layout / word order |
| `settings.backup.keyLine` | की {key} · {source} | कुंजी {key} · {source} | Wrong/misleading meaning |
| `settings.backup.runsEvery` | हर बार चलता है | अंतराल | Wrong/misleading meaning |
| `settings.backup.runsEveryValue` | {count} दिन | हर {count} दिन | Wrong/misleading meaning |
| `settings.backup.keeps` | रखता है | रखे जाते हैं | Fits UI layout / word order |
| `settings.backup.col.actions` | कार्रवाइयां | कार्रवाइयाँ | Spelling consistency |
| `settings.security.cantScan` | स्कैन नहीं हो रहा? यह की मैन्युअली दर्ज करें: | स्कैन नहीं हो रहा? यह कुंजी मैन्युअली दर्ज करें: | Wrong/misleading meaning |
| `settings.verifactu.subtitle` | रेस्तरां, शाखा और स्टाफ़ कॉन्फ़िगरेशन | रेस्टोरेंट, शाखा और स्टाफ़ कॉन्फ़िगरेशन | Glossary consistency |
| `settings.verifactu.exportXml` | XML निर्यात करें | XML एक्सपोर्ट करें | Glossary consistency |
| `settings.apiKeys.subtitle` | रेस्तरां, शाखा और स्टाफ़ कॉन्फ़िगरेशन | रेस्टोरेंट, शाखा और स्टाफ़ कॉन्फ़िगरेशन | Glossary consistency |
| `settings.apiKeys.newKey` | नई की | नई कुंजी | Wrong/misleading meaning |
| `settings.apiKeys.col.key` | की | कुंजी | Wrong/misleading meaning |
| `settings.apiKeys.col.permissions` | अनुमतियां | अनुमतियाँ | Spelling consistency |
| `settings.apiKeys.col.actions` | कार्रवाइयां | कार्रवाइयाँ | Spelling consistency |
| `settings.apiKeys.keyRevoked` | की रद्द कर दी गई | कुंजी रद्द कर दी गई | Wrong/misleading meaning |
| `settings.apiKeys.revokeFailed` | की रद्द नहीं हो सकी | कुंजी रद्द नहीं हो सकी | Wrong/misleading meaning |
| `settings.apiKeys.personal.title` | व्यक्तिगत API कीज़ और MCP | व्यक्तिगत API कुंजियाँ और MCP | Wrong/misleading meaning |
| `settings.apiKeys.personal.revokeConfirm` | "{name}" रद्द करें? इस की का उपयोग करने वाली हर चीज़ तुरंत बंद हो जाएगी। | "{name}" रद्द करें? इस कुंजी का उपयोग करने वाली हर चीज़ तुरंत बंद हो जाएगी। | Wrong/misleading meaning |
| `settings.apiKeys.personal.empty` | अभी कोई व्यक्तिगत API की नहीं। | अभी कोई व्यक्तिगत API कुंजी नहीं। | Wrong/misleading meaning |
| `settings.apiKeys.integration.title` | इंटीग्रेशन API कीज़ | इंटीग्रेशन API कुंजियाँ | Wrong/misleading meaning |
| `settings.apiKeys.integration.rotateConfirm` | "{name}" बदलें? नई की इसकी जगह लेगी; अपनी वेबसाइट में उसे अपडेट करें, क्योंकि पुरानी की तुरंत बंद हो जाएगी। | "{name}" बदलें? नई कुंजी इसकी जगह लेगी; अपनी वेबसाइट में उसे अपडेट करें, क्योंकि पुरानी कुंजी तुरंत बंद हो जाएगी। | Wrong/misleading meaning |
| `settings.apiKeys.integration.rotateFailed` | की बदली नहीं जा सकी | कुंजी बदली नहीं जा सकी | Wrong/misleading meaning |
| `settings.apiKeys.integration.revokeConfirm` | "{name}" रद्द करें? इस की का उपयोग करने वाली कोई भी बाहरी वेबसाइट तुरंत बंद हो जाएगी। | "{name}" रद्द करें? इस कुंजी का उपयोग करने वाली कोई भी बाहरी वेबसाइट तुरंत बंद हो जाएगी। | Wrong/misleading meaning |
| `settings.apiKeys.integration.empty` | अभी कोई इंटीग्रेशन API की नहीं। | अभी कोई इंटीग्रेशन API कुंजी नहीं। | Wrong/misleading meaning |
| `settings.webhooks.subtitle` | रेस्तरां, शाखा और स्टाफ़ कॉन्फ़िगरेशन | रेस्टोरेंट, शाखा और स्टाफ़ कॉन्फ़िगरेशन | Glossary consistency |
| `settings.addStaff.branches` | शाखाएं | शाखाएँ | Spelling consistency |
| `settings.audit.colActor` | कर्ता | किसने | More natural staff Hindi |
| `settings.audit.colEntity` | इकाई | रिकॉर्ड | Wrong/misleading meaning |
| `settings.audit.pageOf` | पृष्ठ {page} / {totalPages} | पेज {page} / {totalPages} | Glossary consistency |
| `settings.createRole.label` | प्रदर्शित नाम | दिखने वाला नाम | More natural staff Hindi |
| `settings.editRole.label` | प्रदर्शित नाम | दिखने वाला नाम | More natural staff Hindi |
| `settings.integrationKey.namePlaceholder` | उदा. हमारी वेबसाइट का ऑर्डरिंग विजेट | जैसे हमारी वेबसाइट का ऑर्डरिंग विजेट | Glossary consistency |
| `settings.kioskCard.offerTakeaway` | “टेकअवे” विकल्प दिखाएं | “पार्सल” विकल्प दिखाएं | Wrong/misleading meaning |
| `settings.memberships.pointsMultiplier` | पॉइंट्स × | पॉइंट × | Glossary consistency |
| `settings.memberships.summary` | रैंक {rank} · {discount}% छूट · {multiplier}× पॉइंट्स · {duration} | रैंक {rank} · {discount}% छूट · {multiplier}× पॉइंट · {duration} | Glossary consistency |
| `settings.restore.warning` | यह इस इंस्टेंस के हर रेस्टोरेंट के लिए पूरे डेटाबेस और अपलोड की गई फ़ाइलों को {date} को लिए गए बैकअप की सामग्री से बदल देगा। इसे पूर्ववत नहीं किया जा सकता। | यह इस इंस्टेंस के हर रेस्टोरेंट के लिए पूरे डेटाबेस और अपलोड की गई फ़ाइलों को {date} को लिए गए बैकअप की सामग्री से बदल देगा। इसे वापस नहीं लिया जा सकता। | Glossary consistency |
| `settings.roles.confirmDelete` | "{label}" भूमिका हटाएं? इसे पूर्ववत नहीं किया जा सकता। | "{label}" भूमिका हटाएं? इसे वापस नहीं लिया जा सकता। | Glossary consistency |
| `settings.roles.granted` | {count} प्रदत्त | {count} दी गई | More natural staff Hindi |
| `settings.roles.intro` | पहले से दी गई भूमिकाएँ सामान्य स्टाफ़ प्रकारों को कवर करती हैं। डिस्प्ले स्क्रीन, वैलेट या होस्ट जैसी कस्टम भूमिका बनाएं, जिसमें ठीक वही अनुमतियाँ हों जो ज़रूरी हैं। | डिफ़ॉल्ट भूमिकाएँ सामान्य स्टाफ़ प्रकारों को कवर करती हैं। डिस्प्ले स्क्रीन, वैलेट या होस्ट जैसी कस्टम भूमिका बनाएं, जिसमें ठीक वही अनुमतियाँ हों जो ज़रूरी हैं। | More natural staff Hindi |
| `settings.roles.seeded` | पूर्व-निर्धारित | डिफ़ॉल्ट | More natural staff Hindi |
| `settings.roles.subtitle` | रेस्तरां, शाखा और स्टाफ़ कॉन्फ़िगरेशन | रेस्टोरेंट, शाखा और स्टाफ़ कॉन्फ़िगरेशन | Glossary consistency |
| `settings.staff.deleteConfirm` | {name} को हटाएं? इसे पूर्ववत नहीं किया जा सकता। | {name} को हटाएं? इसे वापस नहीं लिया जा सकता। | Glossary consistency |
| `settings.staff.disabled` | {name} अक्षम किया गया | {name} बंद किया गया | More natural staff Hindi |
| `settings.staff.enabled` | {name} सक्षम किया गया | {name} चालू किया गया | More natural staff Hindi |
| `settings.staff.subtitle` | रेस्तरां, शाखा और स्टाफ़ कॉन्फ़िगरेशन | रेस्टोरेंट, शाखा और स्टाफ़ कॉन्फ़िगरेशन | Glossary consistency |
| `settings.staffAccess.description` | {role} भूमिका से शुरू होता है। केवल इस व्यक्ति के लिए अलग-अलग अनुमतियाँ दें या रोकें। रोकना हमेशा प्राथमिक रहता है। | {role} भूमिका से शुरू होता है। केवल इस व्यक्ति के लिए अलग-अलग अनुमतियाँ दें या रोकें। दोनों हों तो रोक ही लागू होगी। | Wrong/misleading meaning |
| `settings.sync.lastSynced` | अंतिम सिंक: {when} · अपलोड के लिए प्रतीक्षित: {pending} | आख़िरी सिंक: {when} · अपलोड बाकी: {pending} | More natural staff Hindi |
| `settings.updates.confirmBody` | यह नवीनतम रिलीज़ खींचकर हर सेवा को दोबारा बनाएगा/रीस्टार्ट करेगा। रीस्टार्ट के दौरान ऐप कुछ देर उपलब्ध नहीं रहेगा — वापस आते ही यह पेज अपने आप रीलोड हो जाएगा। | यह नवीनतम रिलीज़ डाउनलोड करके हर सेवा को दोबारा बनाएगा/रीस्टार्ट करेगा। रीस्टार्ट के दौरान ऐप कुछ देर उपलब्ध नहीं रहेगा — वापस आते ही यह पेज अपने आप रीलोड हो जाएगा। | Wrong/misleading meaning |
| `team.leave.approve` | स्वीकृत करें | मंज़ूर करें | Glossary consistency |
| `team.run.finalized` | पेरोल अंतिम हो गया - समायोजन अब लॉक हैं | पेरोल फ़ाइनल हो गया - समायोजन अब लॉक हैं | Wrong/misleading meaning |
| `team.run.finalize` | अंतिम करें | फ़ाइनल करें | Wrong/misleading meaning |
| `team.run.markPaid` | भुगतान किया हुआ चिह्नित करें | भुगतान हुआ मार्क करें | Shorter label |
| `team.run.col.advance` | अग्रिम − | एडवांस − | More natural staff Hindi |
| `team.pay.runHint` | उपस्थिति के दर्ज घंटे और स्वीकृत अवैतनिक छुट्टी का उपयोग करता है, और अवधि की टिप को काम किए गए घंटों के अनुसार बाँटता है। | उपस्थिति के दर्ज घंटे और मंज़ूर बिना वेतन की छुट्टी का उपयोग करता है, और अवधि की टिप को काम किए गए घंटों के अनुसार बाँटता है। | More natural staff Hindi |
| `team.adjust.advance` | अग्रिम वसूली | एडवांस वसूली | More natural staff Hindi |
| `team.payDialog.title` | वेतन भुगतान किया हुआ चिह्नित करें | वेतन भुगतान हुआ मार्क करें | More natural staff Hindi |
| `team.slip.unpaidLeave` | अवैतनिक छुट्टी | बिना वेतन की छुट्टी | More natural staff Hindi |
| `tables.status.available` | उपलब्ध | खाली | Glossary consistency |
| `tables.editTile.saveError` | स्थिति सहेजी नहीं जा सकी | जगह सहेजी नहीं जा सकी | Wrong/misleading meaning |
| `tables.waitlist.partySize` | समूह का आकार | कितने लोग | More natural staff Hindi |
| `reservations.manageBooking` | बुकिंग प्रबंधित करें | बुकिंग संभालें | More natural staff Hindi |
| `reservations.status.confirmed` | पुष्ट | कन्फ़र्म | More natural staff Hindi |
| `reservations.status.completed` | पूर्ण | पूरा हुआ | More natural staff Hindi |
| `giftCards.status.disabled` | अक्षम | बंद | More natural staff Hindi |
| `giftCards.done` | पूर्ण | हो गया | Glossary consistency |
| `acct.exp.status.approved` | स्वीकृत | मंज़ूर | Glossary consistency |
| `acct.exp.approvals.title` | स्वीकृति की प्रतीक्षा में | मंज़ूरी की प्रतीक्षा में | Glossary consistency |
| `acct.exp.approvals.empty` | कोई खर्च स्वीकृति की प्रतीक्षा में नहीं है। | कोई खर्च मंज़ूरी की प्रतीक्षा में नहीं है। | Glossary consistency |
| `acct.exp.approvals.approve` | स्वीकृत करें | मंज़ूर करें | Glossary consistency |
| `acct.exp.approvals.approved` | खर्च स्वीकृत हुआ | खर्च मंज़ूर हुआ | Glossary consistency |
| `acct.exp.approvals.rejected` | खर्च अस्वीकृत हुआ | खर्च अस्वीकार किया गया | More natural staff Hindi |
| `acct.exp.threshold.title` | स्वीकृति सीमा | मंज़ूरी सीमा | Glossary consistency |
| `acct.exp.threshold.help` | इस राशि से अधिक के खर्च को स्वीकृति चाहिए। स्वीकृतियां बंद करने के लिए खाली छोड़ें। | इस राशि से ज़्यादा के खर्च को मंज़ूरी चाहिए। मंज़ूरी बंद करने के लिए खाली छोड़ें। | Glossary consistency |
| `acct.exp.threshold.saved` | स्वीकृति सीमा सहेजी गई | मंज़ूरी सीमा सहेजी गई | Glossary consistency |
| `inv.unit.preview` | बराबर {quantity} {unit} | {quantity} {unit} के बराबर | Fits UI layout / word order |
| `inv.return.help` | माल आपूर्तिकर्ता को वापस भेजें। क्रेडिट का मूल्य सर्वर द्वारा प्राप्त लागत पर तय होता है। | माल सप्लायर को वापस भेजें। क्रेडिट का मूल्य सर्वर द्वारा प्राप्त लागत पर तय होता है। | More natural staff Hindi |
| `inv.return.list` | वापसियां | वापसी | More natural staff Hindi |
| `menu.subtitle` | श्रेणियां, आइटम और कीमतें | श्रेणियाँ, आइटम और कीमतें | Spelling consistency |
| `menu.subtitleViewOnly` | श्रेणियां, आइटम और कीमतें (केवल देखने के लिए) | श्रेणियाँ, आइटम और कीमतें (केवल देखने के लिए) | Spelling consistency |
| `menu.categories` | श्रेणियां | श्रेणियाँ | Spelling consistency |
| `menu.deleteCategoryConfirm` | "{name}" श्रेणी हटाएं? इसे वापस नहीं किया जा सकता। | "{name}" श्रेणी हटाएं? इसे वापस नहीं लिया जा सकता। | Glossary consistency |
| `menu.comboComponents` | कॉम्बो के घटक | कॉम्बो के आइटम | More natural staff Hindi |
| `menu.item.priceExcl` | मूल्य (कर रहित) | कीमत (कर रहित) | Glossary consistency |
| `menu.item.priceIncl` | मूल्य (कर सहित) | कीमत (कर सहित) | Glossary consistency |
| `menu.item.halfPrice` | हाफ़ पोर्शन का मूल्य (वैकल्पिक) | हाफ़ पोर्शन की कीमत (वैकल्पिक) | Glossary consistency |
| `menu.item.halfPriceHelp` | सेट करने पर POS हाफ़ / फ़ुल / कस्टम पूछेगा। ऊपर का मूल्य फ़ुल पोर्शन का है। | सेट करने पर POS हाफ़ / फ़ुल / कस्टम पूछेगा। ऊपर की कीमत फ़ुल पोर्शन की है। | Glossary consistency |
| `menu.bulk.title` | सभी मूल्य बदलें | सभी कीमतें बदलें | Glossary consistency |
| `menu.bulk.help` | प्रतिशत दर्ज करें। धनात्मक संख्या से मूल्य बढ़ते हैं, ऋणात्मक संख्या से घटते हैं (जैसे 10 यानी 10% अधिक, −5 यानी 5% कम)। जो बिल पहले से खुले या भुगतान हो चुके हैं, उनमें पुराना मूल्य ही रहेगा। | प्रतिशत दर्ज करें। प्लस संख्या से कीमतें बढ़ती हैं, माइनस संख्या से घटती हैं (जैसे 10 यानी 10% ज़्यादा, −5 यानी 5% कम)। जो बिल पहले से खुले हैं या जिनका भुगतान हो चुका है, उनमें पुरानी कीमत ही रहेगी। | More natural staff Hindi |
| `menu.bulk.percent` | प्रतिशत परिवर्तन | प्रतिशत बदलाव | More natural staff Hindi |
| `menu.bulk.which` | कौन से व्यंजन | कौन-सी डिश | Glossary consistency |
| `menu.bulk.allDishes` | सभी व्यंजन | सभी डिश | Glossary consistency |
| `menu.bulk.willChange` | {total} में से {count} व्यंजन बदलेंगे। | {total} में से {count} डिश बदलेंगी। | Glossary consistency |
| `menu.bulk.preview` | पूर्वावलोकन | प्रीव्यू | More natural staff Hindi |
| `menu.bulk.apply` | {count} व्यंजनों पर लागू करें | {count} डिश पर लागू करें | Glossary consistency |
| `menu.bulk.updated` | {count} व्यंजन अपडेट किए गए | {count} डिश अपडेट की गईं | Glossary consistency |
| `menu.combo.dialogTitle` | {name} — कॉम्बो घटक | {name} — कॉम्बो के आइटम | More natural staff Hindi |
| `menu.combo.empty` | अभी कोई घटक नहीं — यह आइटम सामान्य मेन्यू आइटम की तरह बिकता है। कॉम्बो बनाने के लिए घटक जोड़ें। | अभी कोई आइटम नहीं — यह सामान्य मेन्यू आइटम की तरह बिकता है। कॉम्बो बनाने के लिए आइटम जोड़ें। | More natural staff Hindi |
| `menu.combo.add` | घटक जोड़ें | आइटम जोड़ें | More natural staff Hindi |
| `menu.combo.saved` | {name} के कॉम्बो घटक सहेजे गए | {name} के कॉम्बो आइटम सहेजे गए | More natural staff Hindi |
| `menu.combo.saveFailed` | कॉम्बो घटक नहीं सहेजे जा सके | कॉम्बो आइटम नहीं सहेजे जा सके | More natural staff Hindi |
| `menu.stock.comboNote` | कॉम्बो अपने घटक आइटमों के ज़रिए स्टॉक घटाते हैं। हर घटक पर ट्रैकिंग सेट करें। | कॉम्बो अपने आइटमों के ज़रिए स्टॉक घटाते हैं। हर आइटम पर ट्रैकिंग सेट करें। | More natural staff Hindi |
| `session.idle.title` | क्या आप अभी भी हैं? | क्या आप अभी भी यहाँ हैं? | Wrong/misleading meaning |
| `dashboard.customize` | अनुकूलित करें | कस्टमाइज़ करें | More natural staff Hindi |
| `dashboard.kpi.revenue` | आज की आय | आज की बिक्री | More natural staff Hindi |
| `dashboard.kpi.occupiedTables` | भरे हुए टेबल | भरी हुई टेबल | Gender (टेबल/डिश feminine) |
| `dashboard.tables.available` | उपलब्ध | खाली | Glossary consistency |
| `dashboard.tables.occupied` | भरा हुआ | भरी हुई | Gender (टेबल/डिश feminine) |
| `dashboard.kitchen.preparing` | तैयार हो रहा है | बन रहा है | Shorter label |
| `dashboard.channels.subtitle` | आज, स्वयं ऑर्डर बनाम स्टाफ़ द्वारा दर्ज | आज, ग्राहक के ख़ुद किए ऑर्डर बनाम स्टाफ़ के दर्ज किए ऑर्डर | More natural staff Hindi |
| `dashboard.chart.revenue` | आय — पिछले {days} दिन | बिक्री — पिछले {days} दिन | More natural staff Hindi |
| `dashboard.chart.revenueEmpty` | पिछले {days} दिनों में अभी तक कोई भुगतान किया ऑर्डर नहीं। | पिछले {days} दिनों में अभी तक कोई भुगतान हुआ ऑर्डर नहीं। | More natural staff Hindi |
| `dashboard.chart.waste` | खाद्य बर्बादी की लागत — पिछले {days} दिन | खाने की बर्बादी की लागत — पिछले {days} दिन | More natural staff Hindi |
| `dashboard.custom.title` | अपना डैशबोर्ड अनुकूलित करें | अपना डैशबोर्ड कस्टमाइज़ करें | More natural staff Hindi |
| `dashboard.custom.region` | डैशबोर्ड अनुकूलित करें | डैशबोर्ड कस्टमाइज़ करें | More natural staff Hindi |
| `dashboard.custom.restore` | डिफ़ॉल्ट बहाल करें | डिफ़ॉल्ट पर लौटाएं | More natural staff Hindi |
| `dashboard.widget.attention` | ध्यान देने योग्य | ध्यान दें | Shorter label |
| `dashboard.widget.charts` | आय और बर्बादी के चार्ट | बिक्री और बर्बादी के चार्ट | More natural staff Hindi |
| `reports.subtitle` | तारीख़ से फ़िल्टर करें, प्रिंट करें, Excel, PDF या CSV में निर्यात करें, या शेड्यूल पर ईमेल करें | तारीख़ से फ़िल्टर करें, प्रिंट करें, Excel, PDF या CSV में एक्सपोर्ट करें, या शेड्यूल पर ईमेल करें | Glossary consistency |
| `reports.heat.revenue` | आय | बिक्री | More natural staff Hindi |
| `reports.sched.frequency` | आवृत्ति | कितनी बार | More natural staff Hindi |
| `reports.sched.whenDaily` | हर दिन · बीता कल | हर दिन · पिछला दिन | More natural staff Hindi |
| `reports.sched.to` | प्रति: {list} | किसे: {list} | Wrong/misleading meaning |
| `reports.sched.lastSent` | अंतिम बार भेजा गया {when} | आख़िरी बार भेजा गया {when} | More natural staff Hindi |
| `operations.eq.interval` | सर्विस हर (दिन) | कितने दिन में सर्विस | Fits UI layout / word order |
| `operations.eq.lastServiced` | अंतिम सर्विस | आख़िरी सर्विस | More natural staff Hindi |
| `operations.eq.overdue` | विलंबित | देर हो गई | More natural staff Hindi |
| `operations.eq.dueSoon` | जल्द देय | जल्द होनी है | More natural staff Hindi |
| `operations.eq.last` | अंतिम {date} | आख़िरी {date} | More natural staff Hindi |
| `operations.eq.retire` | सेवानिवृत्त करें | इस्तेमाल बंद करें | Wrong/misleading meaning |
| `operations.eq.retireConfirm` | {name} को सेवानिवृत्त करें? | {name} का इस्तेमाल बंद करें? | Wrong/misleading meaning |
| `operations.doc.body` | विषय-वस्तु | मुख्य टेक्स्ट | More natural staff Hindi |
| `operations.cat.sop` | एसओपी | SOP | Glossary consistency |
| `operations.files.attachAria` | फ़ाइल संलग्न करें | फ़ाइल अटैच करें | More natural staff Hindi |
| `operations.files.attach` | फ़ाइल संलग्न करें | फ़ाइल अटैच करें | More natural staff Hindi |
| `operations.files.attached` | फ़ाइल संलग्न की गई | फ़ाइल अटैच की गई | More natural staff Hindi |
| `reports.variance.filter` | सामग्री या आपूर्तिकर्ता फ़िल्टर करें | सामग्री या सप्लायर फ़िल्टर करें | More natural staff Hindi |
| `reports.variance.highlight` | इस सीमा पर हाइलाइट करें ± | हाइलाइट करें ± | Shorter label |
| `pos.gatewayQr.staleOld` | {old} वाला वह QR समाप्त होने तक अभी भी भुगतान लेने योग्य है, इसलिए अभी नया नहीं बनाया जा सकता। | {old} वाले उस QR से एक्सपायर होने तक भुगतान हो सकता है, इसलिए अभी नया QR नहीं बन सकता। | More natural staff Hindi |
| `pos.gatewayQr.expired` | भुगतान होने से पहले यह QR समाप्त हो गया। | भुगतान होने से पहले यह QR एक्सपायर हो गया। | More natural staff Hindi |
| `pos.gatewayQr.overrideOn` | किसी और तरीके से भुगतान लिया जा रहा है। अगर QR से भी भुगतान हो गया, तो उसे रिफ़ंड के लिए चिह्नित किया जाएगा। | किसी और तरीके से भुगतान लिया जा रहा है। अगर QR से भी भुगतान हो गया, तो उसे रिफ़ंड के लिए मार्क किया जाएगा। | More natural staff Hindi |
| `inv.reorder.title` | पुनः ऑर्डर सुझाव | री-ऑर्डर सुझाव | More natural staff Hindi |
| `inv.reorder.subtitle` | लक्ष्य स्टॉक पर या उससे नीचे के आइटम, आपूर्तिकर्ता के अनुसार समूहित। मात्राएं संपादित करें, फिर अनुरोध बनाएं। | लक्ष्य स्टॉक पर या उससे नीचे के आइटम, सप्लायर के अनुसार। मात्रा बदलें, फिर अनुरोध बनाएं। | More natural staff Hindi |
| `inv.reorder.noSupplier` | कोई पसंदीदा आपूर्तिकर्ता नहीं | कोई पसंदीदा सप्लायर नहीं | More natural staff Hindi |
| `inv.reorder.empty` | अभी कुछ भी पुनः ऑर्डर करने की ज़रूरत नहीं है। | अभी कुछ भी री-ऑर्डर करने की ज़रूरत नहीं है। | More natural staff Hindi |
| `acct.petty.fromTill` | नकद टिल दराज़ से लिया गया | नकद गल्ले से लिया गया | Glossary consistency |
