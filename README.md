# skilllondon-vacancies

Live engineering apprenticeship and FE college vacancies for **[skilllondon.com/vacancies](https://skilllondon.com/vacancies)**.

Every day at 06:00 UTC, a GitHub Action runs `scripts/update-vacancies.js`, which:

- fetches Route 9 (Engineering and Manufacturing) listings from **GOV.UK Find an Apprenticeship**
- fetches engineering, electrical and computing roles in FE colleges from **GOV.UK Teaching Vacancies**
- removes closed listings and writes `vacancies.json`

The website reads `vacancies.json` straight from this repo, so the site never needs redeploying for vacancy updates.

To refresh by hand, go to **Actions → Update vacancies daily → Run workflow**.

All listings are public data from GOV.UK services.
