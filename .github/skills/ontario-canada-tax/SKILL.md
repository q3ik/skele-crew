# Ontario, Canada Tax Skill

> Jurisdiction: Ontario, Canada. Entity type: Canadian-Controlled Private Corporation (CCPC).
> Sole founder — no employees; payroll remittances are not applicable.

## Tax Rates

<!-- PROTECTED: legal-compliance -->
### HST (Harmonized Sales Tax)
- Combined federal + provincial rate: **13%** (5% GST + 8% Ontario PST component)
- Applicable to: most goods and services supplied in Ontario
- Small supplier threshold: $30,000 CAD in annual worldwide taxable supplies (below this, registration is optional but recommended once exceeded)
- Input Tax Credits (ITCs): HST paid on business expenses is fully recoverable as an ITC against HST collected

### Federal Corporate Income Tax (T2)
- General corporate rate: 15% federal + 11.5% Ontario provincial = **26.5% combined**
- Small Business Deduction (SBD) rate for CCPC active business income up to $500,000: **9% federal + 3.2% Ontario = 12.2% combined**
- SBD limit: $500,000 CAD of active business income per fiscal year
- Capital gains inclusion rate: 50% of capital gain included in income (effective rate: ~6.1% / ~13.25% combined on gains)
<!-- END PROTECTED: legal-compliance -->

## Filing Calendar

<!-- PROTECTED: legal-compliance -->
| Filing | Frequency | Period | Due Date | Portal |
|--------|-----------|--------|----------|--------|
| HST return (quarterly) | Quarterly | Q1: Jan 1 – Mar 31 | April 30 | CRA My Business Account |
| HST return (quarterly) | Quarterly | Q2: Apr 1 – Jun 30 | July 31 | CRA My Business Account |
| HST return (quarterly) | Quarterly | Q3: Jul 1 – Sep 30 | October 31 | CRA My Business Account |
| HST return (quarterly) | Quarterly | Q4: Oct 1 – Dec 31 | January 31 (following year) | CRA My Business Account |
| T2 Corporate Income Tax return | Annual | Fiscal year end | 6 months after fiscal year end | CRA T2 e-file via certified software |
| T2 balance owing | Annual | Fiscal year end | 3 months after fiscal year end (CCPC eligible for SBD) | CRA My Business Account |
| T2 instalment payments | If applicable | N/A | Monthly (if instalment threshold exceeded) | CRA My Business Account |

**Knowledge-graph deadline entity format:**
```json
{"type":"entity","name":"deadline:YYYY-QN:hst-filing","entityType":"deadline","observations":["due: YYYY-MM-DD","owner: accountant","status: pending","type: tax","jurisdiction: ontario-canada","filing: hst-quarterly","retention: permanent"]}
```
```json
{"type":"entity","name":"deadline:YYYY:t2-return","entityType":"deadline","observations":["due: YYYY-MM-DD","owner: accountant","status: pending","type: tax","jurisdiction: ontario-canada","filing: t2-annual","retention: permanent"]}
```
<!-- END PROTECTED: legal-compliance -->

## Invoice Requirements

<!-- PROTECTED: legal-compliance -->
All invoices issued by q3ik must include:
- [ ] Sequential invoice number
- [ ] Date of issue (YYYY-MM-DD)
- [ ] Seller legal name: q3ik (or full registered business name)
- [ ] Seller mailing address (Ontario, Canada)
- [ ] Seller HST registration number (format: 123456789 RT 0001)
- [ ] Client name and mailing address
- [ ] Clear description of goods or services supplied
- [ ] Subtotal (before HST)
- [ ] HST rate (13%) and HST dollar amount
- [ ] Total amount (CAD)
- [ ] Payment terms and due date

**Note**: For supplies over $150 CAD, a "full invoice" format is required by CRA; for supplies $30–$149.99, a "simplified invoice" with HST registration number is sufficient.
<!-- END PROTECTED: legal-compliance -->

## Deductible Expense Categories

The following are common deductible business expenses for a sole-founder CCPC in Ontario (confirm with a CPA before filing):

- **Software subscriptions** — 100% deductible if exclusively for business (e.g., GitHub Copilot, Sentry, Supabase, Cloudflare)
- **Hardware** — Capital Cost Allowance (CCA) Class 10 (30%) or Class 50 (55% for computers/servers); full-year rule applies
- **Home office** — Pro-rated by area (business-use area ÷ total home area); eligible: heat, electricity, internet, maintenance
- **Internet and phone** — Business-use portion only; document business-vs-personal split
- **Professional services** — Legal, accounting, consulting fees (100% deductible)
- **Domain names and hosting** — 100% deductible as business expenses
- **Advertising and marketing** — 100% deductible (social media tools, ad spend)
- **Bank fees and interest** — Business account fees and loan interest are deductible
- **Education and training** — Directly related to the business (courses, books, conferences)
- **Travel** — Business-purpose travel (document purpose, destination, receipts)
- **Meals and entertainment** — 50% deductible; must document business purpose and attendees

**ITC eligibility**: HST paid on all the above categories is generally recoverable as an ITC on the quarterly HST return.

## Overdue Filing Protocol

When a deadline entity has `status: pending` and `due` date is in the past:

1. Update the deadline entity status to `overdue` in `memory/knowledge-graph.jsonl`
2. Add an entry to the **🔴 Overdue** section of `BOARD.md` in this format:

```
| [Filing type] — [period] | Accountant | [due date] | [days overdue] days |
```

3. Write a lesson entity to the knowledge graph:
```json
{"type":"entity","name":"lesson:YYYY-MM-DD:overdue-[filing-type]","entityType":"lesson","observations":["category: tax-compliance","summary: [filing] overdue since [due date]","action: human must file immediately via CRA portal","source: accountant-agent"]}
```

4. All escalations are advisory only — **human must file**; agent cannot submit filings.

## Key Reference Links

- CRA My Business Account: https://www.canada.ca/en/revenue-agency/services/e-services/e-services-businesses/business-account.html
- HST filing portal: https://www.canada.ca/en/revenue-agency/services/tax/businesses/topics/gst-hst-businesses/file-return.html
- T2 corporate return: https://www.canada.ca/en/revenue-agency/services/tax/businesses/topics/corporations/corporation-income-tax-return.html
- Ontario corporate tax: https://www.ontario.ca/page/corporation-tax
- CRA instalment guide: https://www.canada.ca/en/revenue-agency/services/tax/businesses/topics/corporations/corporation-payments.html
