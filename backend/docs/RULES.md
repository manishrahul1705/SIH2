# Rules and defaults

These settings are synthetic demo defaults except where marked REAL. The APH
describes the approval process and certain required documents; it does not set
the system's numeric confidence or reminder thresholds. Verify the current APH
before operational use. Rule defaults can be changed by an Administrator.

| Rule | Basis | Default / behavior |
|---|---|---|
| D1 | SYNTHETIC | Warn when detected document type differs from upload slot. |
| D2 | REAL document categories; SYNTHETIC set per type | Extension of approval demo requires lease deed, fire safety certificate, occupancy certificate, and affidavit slots. |
| D3 | SYNTHETIC | Confirmed issue date must not be in the future. |
| D4 | SYNTHETIC | Valid-to must be later than issue date or valid-from. |
| D5 | REAL validity requirement; SYNTHETIC check | Fire certificate valid-to must be today or later. |
| D6 | SYNTHETIC | Certificate number regex defaults to `^[A-Za-z0-9/-]{3,40}$`. |
| D7 | SYNTHETIC | Unconfirmed red fields require manual entry; amber fields require confirmation. |
| D8 | SYNTHETIC | Duplicate document/certificate is a warning when the caller provides duplicate context. |
| D9 | SYNTHETIC | Re-upload suggestion below mean OCR confidence 0.55. |
| L1 | SYNTHETIC | Lease end must follow lease start. |
| L2 | SYNTHETIC | Stated term and date range differ by at most one month. |
| L3 | REAL | Private lease deed registration must be explicitly confirmed by a person. |
| L4 | SYNTHETIC | Lease should cover the requested academic year through March 31. |
| L5 | SYNTHETIC, verify | Minimum term defaults to 30 years; confirm this figure against current APH. |
| L6 | SYNTHETIC | Expired before today => EXPIRED; at most 60 days => EXPIRING; else VALID. |
| W1-W5 | APH-derived process with configurable demo path | The configured path and authorized stage roles govern stage transitions; return transitions require a reason and only Bureau Officer records decisions. |
| W6 | SYNTHETIC | Max days: Scrutiny 10, re-scrutiny 7, EVC 15, SAC/SHC 10, Decision 7. |
| ZONES | SYNTHETIC | Green >= 0.85, amber >= 0.60, red below 0.60; issue-date red below 0.70. |
| ESCALATION | SYNTHETIC | Escalation interval defaults to 3 days. |

No unconfirmed AI output is used by these rules as a confirmed business value.
