import { Badge, Card } from "../components/ui/primitives";

function policyStatus(status) {
  if (status === "signed_off") return "Signed off";
  return status || "Unknown";
}

export default function PolicyLive({ data }) {
  const policies = data.policy.versions;
  return <div className="policy-cards">
    {policies.length === 0
      ? <Card title="Policy versions"><p className="muted">No policy versions are available.</p></Card>
      : policies.map((policy) => <Card key={policy._id} title={`Policy ${policy.version}`}>
        <Badge variant={policy.status === "Signed off" ? "success" : policy.status === "draft" ? "warning" : "neutral"}>{policyStatus(policy.status)}</Badge>
        {policy.signedOffAt && <p className="muted">Signed off {new Date(policy.signedOffAt).toLocaleString()}</p>}
        {policy.notes && <p>{policy.notes}</p>}
        <h3>Application routes</h3>
        {Object.entries(policy.routes || {}).length
          ? <div className="table-wrap"><table className="data-table"><thead><tr><th>Application type</th><th>Stages</th></tr></thead><tbody>
            {Object.entries(policy.routes).map(([type, route]) => <tr key={type}><td>{type}</td><td>{Array.isArray(route) ? route.join(" → ") : "No route configured"}</td></tr>)}
          </tbody></table></div>
          : <p className="muted">No routes are configured for this version.</p>}
        <h3>Checklist requirements</h3>
        {policy.checklist?.length
          ? <div className="table-wrap"><table className="data-table"><thead><tr><th>Document</th><th>Type</th><th>Tracked</th><th>Validity required</th></tr></thead><tbody>
            {policy.checklist.map((item, index) => <tr key={item.slotId || index}><td>{item.label || item.slotId || "Unnamed requirement"}</td><td>{item.kind || "—"}</td><td>{item.tracked ? "Yes" : "No"}</td><td>{item.hasValidity ? "Yes" : "No"}</td></tr>)}
          </tbody></table></div>
          : <p className="muted">No checklist requirements are configured for this version.</p>}
      </Card>)}
  </div>;
}
