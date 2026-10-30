# Admin application incidents

All routes are under `/api/v1/admin/incidents`, require an active `ADMIN`
session, and use the standard `{ data, error, meta }` API envelope. Mutations
also require `X-Requested-With: XMLHttpRequest`.

## Application-wise queue

`GET /api/v1/admin/incidents?tab=pending|completed&page=1&pageSize=20`

Optional filters: `search`, `severity`, `type`, `stage`, `ownerId`,
`dateFrom`, and `dateTo`. Dates use `YYYY-MM-DD`; `dateTo` includes the full
UTC date. Matching incidents are grouped by their workflow-qualified source
reference, so multiple incidents produce one application row. Any open
incident keeps the application in the Pending tab, even if its other incidents
are resolved or closed.

The `data` value has this stable shape:

```json
{
  "applications": [{
    "workflowType": "LEGACY_APPLICATION",
    "applicationId": "507f1f77bcf86cd799439011",
    "applicationNumber": "APP-100",
    "institutionName": "Example Institute",
    "applicationType": "NEW",
    "currentStage": "SCRUTINY",
    "applicationStatus": "SUBMITTED",
    "incidentCount": 1,
    "highestSeverity": "HIGH",
    "earliestIncidentAt": "2026-10-29T10:00:00.000Z",
    "latestIncidentAt": "2026-10-29T10:00:00.000Z",
    "responsibleOfficer": { "id": "507f1f77bcf86cd799439012", "name": "Officer", "role": "SCRUTINY_OFFICER" },
    "pendingDurationMs": 3600000,
    "lastAction": null,
    "incidents": [{
      "id": "507f1f77bcf86cd799439099",
      "type": "STAGE_OVERDUE",
      "severity": "HIGH",
      "status": "OPEN",
      "stage": { "key": "scrutiny", "name": "Scrutiny" },
      "summary": "Stage is past its configured due date",
      "detectedAt": "2026-10-29T10:00:00.000Z",
      "dueAt": "2026-10-28T10:00:00.000Z",
      "resolvedAt": null,
      "responsibleOfficer": { "id": "507f1f77bcf86cd799439012", "name": "Officer", "role": "SCRUTINY_OFFICER" },
      "lastAction": { "action": "DETECTED", "at": "2026-10-29T10:00:00.000Z" }
    }]
  }],
  "summary": {
    "affectedApplications": 1,
    "pendingApplications": 1,
    "completedApplications": 0,
    "criticalOpenIncidents": 0
  },
  "page": 1,
  "pageSize": 20,
  "total": 1,
  "pages": 1
}
```

Summary counts cover the full filtered result, independent of the selected tab
and current page. `incidentCount` and `incidents` reflect the active filters.

## Detail and actions

`GET /api/v1/admin/incidents/:workflowType/:applicationId` accepts
`LEGACY_APPLICATION` or `CASE_RECORD` and returns `data.application`,
`data.incidents`, a timestamp-sorted `data.timeline`, and `data.historyComplete`.
The detail includes persisted incident source/evidence and event histories,
plus source stage history and audit entries when available. Timeline entries
identify their persisted source; no inferred workflow events are added.

`POST /api/v1/admin/incidents/:incidentId/actions` accepts:

```json
{
  "action": "REQUEST_CLARIFICATION",
  "note": "Please provide the missing signed record.",
  "targetUserId": "507f1f77bcf86cd799439012"
}
```

Actions are `REVIEW`, `NOTE`, `REQUEST_CLARIFICATION`, `ESCALATE`,
`CORRECTIVE_ACTION`, `RESOLVE`, `CLOSE`, and `REOPEN`. `NOTE` and clarification
require a note; escalation requires a note or reason; corrective action is
record-only and requires a note or result; resolution requires a meaningful
`resolutionSummary`; closing requires an already resolved incident; reopening
requires a meaningful `reason` and preserves all earlier events. Clarification
defaults to the current responsible owner when no recipient is supplied;
escalation defaults to an active administrator. Both actions enqueue an
in-app notification through `NotificationService`. Action events and their
status changes are audited.

`POST /api/v1/admin/incidents` manually reports a suspected issue. The body
requires `workflowType`, `applicationId`, `type`, `severity`, and `description`;
`applicationId` may be a record ObjectId, legacy `application_number`, or
`CaseRecord.caseNo`. `detectionSource` is `ADMIN_REPORTED`; `stageName`,
`responsibleUserId`, `sourceDetails`, and string `evidence` are optional.
Manual reports persist `source: "MANUAL"` and are audited. Application and
CaseRecord documents are never merged or mutated by incident actions.

Automated detectors can call the exported
`recordApplicationIncident({ workflowType, applicationId, dedupeKey, type,
severity, summary, ... })` from `src/modules/admin/incidents/service.js`.
`dedupeKey` should identify one detection cycle (for example, a stage and due
date); repeated calls update the same open incident without duplicating its
event history.
