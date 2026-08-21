# BJA Join Interview - Setup Guide

מה נבנה: ראיון קבלה אוטומטי בטלגרם שכותב ישירות לגיליון BJA Member Database, עם אישור/דחייה של אדמין, אימות אנושי למועמדים חשודים, וטיפול במסורבים.

## 1. Supabase (חד פעמי)

הריצו את `supabase/applicants.sql` ב-SQL Editor של Supabase.

## 2. חשבון שירות של Google (חד פעמי, כ-5 דקות)

1. היכנסו ל-https://console.cloud.google.com עם חשבון הגוגל של BJA
2. צרו פרויקט חדש (או השתמשו בקיים), שם מוצע: `bja-bot`
3. תפריט > APIs & Services > Library > חפשו "Google Sheets API" > Enable
4. תפריט > IAM & Admin > Service Accounts > Create Service Account
   - שם: `bja-bot`, ללא הרשאות פרויקט, Done
5. לחצו על החשבון שנוצר > Keys > Add Key > Create new key > JSON > הקובץ יורד למחשב
6. פתחו את קובץ ה-JSON:
   - `client_email` הולך ל-`GOOGLE_SERVICE_ACCOUNT_EMAIL`
   - `private_key` הולך ל-`GOOGLE_PRIVATE_KEY` (להשאיר את ה-\n כמו שהם)
7. **חשוב**: פתחו את הגיליון BJA Member Database > Share > הוסיפו את כתובת
   ה-`client_email` כ-**Editor**

## 3. משתני סביבה (Netlify)

הוסיפו ב-Site settings > Environment variables:

```
SHEET_ID=10_QMwOOOgKjafay2zgwWQkZytM3gpM1ymRCOt5wLG40
SHEET_TAB=Members
GOOGLE_SERVICE_ACCOUNT_EMAIL=...
GOOGLE_PRIVATE_KEY=...
```

## 4. הגדרות טלגרם (חד פעמי)

1. בכל אחת מארבע הקבוצות: Group Settings > Invite Links > ערכו את הלינק
   הקיים והדליקו **Request Admin Approval** (או צרו לינק חדש עם אישור).
   הלינקים שבקוד (`GROUP_LINKS` ב-bot.js) צריכים להיות לינקים במצב אישור.
2. ודאו שהבוט אדמין בכל קבוצה עם הרשאת **Add Members** (בשביל לאשר בקשות).
3. רעננו את ה-webhook כך שיכלול בקשות הצטרפות:

```
https://api.telegram.org/bot<TOKEN>/setWebhook?url=<NETLIFY_URL>/api/bot&allowed_updates=["message","callback_query","chat_join_request"]
```

## 5. איך זה עובד

- משתמש לוחץ על לינק קבוצה > טלגרם שולח בקשת הצטרפות > הבוט פותח ראיון בפרטי (7 שאלות, עברית, כפתורים)
- בסיום: כרטיס מסכם בערוץ האדמינים עם ✅ אישור / ⛔ דחייה / 📋 השלמה ידנית
- אישור: המועמד נכנס לקבוצה + שורה נכתבת לגיליון (ID לפי ותק, Join Date, Platform=Telegram אוטומטית)
- דחייה: המשתמש מופנה ל-@maor_c, בקשות חוזרות נדחות אוטומטית
- אשר בדיעבד: המסורב מקבל לינק, בכניסה הבאה מאושר אוטומטית והשורה נכתבת מהתשובות השמורות
- השלמה ידנית: האדמין עונה על השאלות החסרות בשם המועמד בצ'אט הפרטי שלו עם הבוט (לביטול: /cancel)
- דילוג על טלפון או על "פרטים נוספים" מסמן את המועמד ל"דורש אימות" (לינקדאין / סושיאל / שיחה קולית)

## 6. מה לא נשבר

כל הפיצ'רים הקיימים נשארו: שאלות אנונימיות עם אישור אדמין, פידבק, צור קשר, עדכון פרטי טייס, פאנל אדמין, חסימות.
