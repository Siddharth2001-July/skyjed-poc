# samples/

Put the Word (`.docx`) and PDF files you want in the register here. Every file in this folder is loaded on the API's first start (or after `npm run reset`).

`samples.json` is optional. It gives a file a friendlier title, risk rating and review frequency:

```json
{
  "My_Letter.docx": { "title": "Savings rate change letter", "risk": "Medium", "frequencyMonths": 12 }
}
```

Files without an entry get a title from their file name, `Medium` risk and a 12-month review cycle.

This folder is git-ignored, so documents you add here are never committed.
